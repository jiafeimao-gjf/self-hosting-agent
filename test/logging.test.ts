import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLogger, formatRecord } from '../src/log/logger.ts';
import type { LogRecord } from '../src/log/logger.ts';
import { AgentPool, AgentProcess } from '../src/kernel/pool.ts';
import { EventLog } from '../src/eventlog/log.ts';
import { ClientSession } from '../src/server/session.ts';
import { startServer } from '../src/server/http-server.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures');

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agent-client-log-${prefix}-`));
}

function collector(): { records: LogRecord[]; sink: (record: LogRecord) => void } {
  const records: LogRecord[] = [];
  return { records, sink: (record) => records.push(record) };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// @spec DIAG-001
test('记录器按级别过滤，每条含 ts/level/scope/message 且可带结构化 data', () => {
  const dir = tempDir('level');
  const { records, sink } = collector();
  const logger = createLogger({ dir, level: 'warn', sink });

  logger.debug('这条该被丢掉');
  logger.info('这条也该被丢掉');
  logger.warn('值得注意', { agent: 'lead' });
  logger.error('出事了');

  assert.deepEqual(records.map((record) => record.level), ['warn', 'error'], '低于阈值的不能进 sink');
  assert.equal(records[0]?.message, '值得注意');
  assert.deepEqual(records[0]?.data, { agent: 'lead' });
  assert.equal(typeof records[0]?.ts, 'string');
  assert.equal(Number.isNaN(Date.parse(String(records[0]?.ts))), false);

  // 落盘也是同样的内容，且是 JSONL
  const lines = fs.readFileSync(path.join(dir, 'app.log'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal((JSON.parse(lines[0] as string) as LogRecord).level, 'warn');
  assert.equal(formatRecord(records[0] as LogRecord).includes('值得注意'), true);

  // scope 可派生
  const child = logger.child('agent:lead');
  child.error('子作用域');
  assert.equal(records[records.length - 1]?.scope, 'agent:lead');
});

// @spec DIAG-002
test('记日志失败不影响主流程：目录建不出来就退化为内存日志，调用方不抛异常', () => {
  const { records, sink } = collector();
  // 构造一个建不出目录的场景：父级是个文件，不是目录
  const dir = tempDir('bad');
  fs.writeFileSync(path.join(dir, 'blocked'), 'x', 'utf8');
  const file = path.join(dir, 'blocked', 'app.log');

  const logger = createLogger({ file, sink });
  assert.doesNotThrow(() => logger.info('写不进去也得继续'));
  assert.deepEqual(records.map((record) => record.message), ['写不进去也得继续'], 'sink 仍然要收到');
  assert.equal(logger.file(), undefined, '建不出目录时应当明确退化成内存模式');
  assert.equal(logger.read().length, 1, '内存兜底要留得住最后几条');
});

// @spec DIAG-003
test('子进程 stderr 被消费：逐行写进诊断日志并带 agent 标签', async () => {
  const { records, sink } = collector();
  const logger = createLogger({ level: 'debug', sink });
  const pool = new AgentPool({ logger });

  try {
    const handle = pool.spawn({ agentId: 'crasher', entry: path.join(fixtures, 'crash-agent.ts') });
    await handle.exited;
    await sleep(50); // stderr 是异步管道，等它流完

    const fromChild = records.filter((record) => record.scope === 'agent:crasher');
    assert.equal(fromChild.length > 0, true, '子进程 stderr 以前没有任何订阅者，现在必须被记下来');
    assert.equal(
      fromChild.some((record) => record.message.includes('即将崩溃')),
      true,
      `实际收到：${JSON.stringify(fromChild.map((record) => record.message))}`,
    );
  } finally {
    await pool.shutdown();
  }
});

// @spec DIAG-004
test('stderr 缓冲有上限：只留尾部，长会话不会无限增长', async () => {
  const pool = new AgentPool();
  try {
    const handle = pool.spawn({ agentId: 'noisy', entry: path.join(fixtures, 'noisy-agent.ts') });
    await handle.exited;
    await sleep(50);

    assert.ok(
      handle.stderr.length <= AgentProcess.STDERR_KEEP_BYTES,
      `缓冲必须封顶（实际 ${handle.stderr.length} > ${AgentProcess.STDERR_KEEP_BYTES}）`,
    );
    assert.match(handle.stderr, /最后一行/, '保留的应当是尾部');
  } finally {
    await pool.shutdown();
  }
});

// @spec DIAG-005
test('HTTP 访问日志：记录 method/path/status/耗时，4xx 记 warn', async () => {
  const { records, sink } = collector();
  const logger = createLogger({ level: 'debug', sink });
  const session = new ClientSession({
    dir: tempDir('http-log'),
    lead: { script: [{ text: 'hi', done: true }] },
  });
  const server = await startServer({ session, port: 0, logger: logger.child('http') });

  try {
    await fetch(`${server.url}/api/state`);
    await fetch(`${server.url}/api/不存在的接口`);
    await sleep(50);

    const ok = records.find((record) => record.message === '请求完成');
    assert.ok(ok, '成功请求要有访问日志');
    assert.equal(ok?.data?.method, 'GET');
    assert.equal(ok?.data?.path, '/api/state');
    assert.equal(ok?.data?.status, 200);
    assert.equal(typeof ok?.data?.ms, 'number');

    const denied = records.find((record) => record.message === '请求被拒');
    assert.ok(denied, '4xx 要记 warn');
    assert.equal(denied?.level, 'warn');
    assert.equal(denied?.data?.status, 404);
  } finally {
    await server.close();
    await session.close();
  }
});

// @spec DIAG-006
test('崩溃兜底：父子进程都注册了 uncaughtException / unhandledRejection', () => {
  const root = path.resolve(here, '..');
  for (const relative of ['src/runtime/agent-main.ts', 'src/cli.ts']) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    assert.match(source, /process\.on\('uncaughtException'/, `${relative} 缺 uncaughtException 兜底`);
    assert.match(source, /process\.on\('unhandledRejection'/, `${relative} 缺 unhandledRejection 兜底`);
    assert.match(source, /\.error\(/, `${relative} 的兜底要写进诊断日志，而不是只打一段没人看的堆栈`);
  }
});

// @spec DIAG-007
test('启动时上报事件日志的损坏行，不再静默跳过', () => {
  const dir = tempDir('issues');
  const log = new EventLog({ dir });
  log.append({ type: 'good', i: 1 });
  fs.appendFileSync(path.join(dir, 'events.jsonl'), '{ 半行没写完\n', 'utf8');

  const session = new ClientSession({ dir: tempDir('issues-session'), log });
  const warnings = session.logger.read().filter((record) => record.level === 'warn');
  assert.equal(
    warnings.some((record) => String(record.message).includes('损坏行')),
    true,
    'EventLog.issues() 以前只有测试在读，启动时必须报一次',
  );
});

// @spec DIAG-008
test('事件日志可按 maxBytes 轮转：滚到 .1，磁盘不会无限增长', () => {
  const dir = tempDir('rotate');
  const log = new EventLog({ dir, maxBytes: 400 });

  for (let i = 0; i < 40; i += 1) {
    const result = log.append({ type: 'tick', i, padding: 'x'.repeat(40) });
    assert.equal(result.ok, true, '轮转不该让写入失败');
  }

  const file = path.join(dir, 'events.jsonl');
  const rotated = `${file}.1`;
  assert.equal(fs.existsSync(rotated), true, '超过上限应当滚出一代归档');
  assert.ok(fs.statSync(file).size <= 400 * 2, '当前文件不该继续无限增长');
  assert.ok(fs.statSync(rotated).size > 0, '归档里要有内容');

  // 默认（不给 maxBytes）不轮转：既有语义不变
  const plainDir = tempDir('rotate-off');
  const plain = new EventLog({ dir: plainDir });
  for (let i = 0; i < 200; i += 1) plain.append({ type: 'tick', i, padding: 'x'.repeat(40) });
  assert.equal(fs.existsSync(path.join(plainDir, 'events.jsonl.1')), false, '默认不开轮转');
});
