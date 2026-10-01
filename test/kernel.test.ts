import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EventLog } from '../src/eventlog/log.ts';
import { AgentPool } from '../src/kernel/pool.ts';
import { ApprovalGate } from '../src/kernel/approval.ts';
import { ProtocolError } from '../src/protocol/frames.ts';
import type { Frame } from '../src/protocol/frames.ts';
import type { AgentProcess } from '../src/kernel/pool.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures');

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agent-client-${prefix}-`));
}

function waitForFrame(handle: AgentProcess, predicate: (frame: Frame) => boolean, timeoutMs = 15000): Promise<Frame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`等待帧超时：${handle.stderr.slice(-400)}`));
    }, timeoutMs);
    const off = handle.onFrame((frame) => {
      if (!predicate(frame)) return;
      clearTimeout(timer);
      off();
      resolve(frame);
    });
  });
}

// @spec KERN-001
// @spec ARCH-003
test('spawn 拉起独立子进程：pid 与宿主不同，能读到子进程发出的帧', async () => {
  const pool = new AgentPool();
  const handle = pool.spawn({ agentId: 'lead', logDir: tempDir('kern1') });
  try {
    assert.ok(typeof handle.pid === 'number' && handle.pid > 0, '必须有 pid');
    assert.notEqual(handle.pid, process.pid, '必须是独立进程而不是宿主自己');

    const boot = await waitForFrame(handle, (frame) => frame.t === 'loop.state');
    assert.equal(boot.state, 'idle');
  } finally {
    await pool.shutdown();
  }
});

// @spec KERN-002
test('宿主 send(human.message) 后子进程跑完 Loop 并回传 loop.done', async () => {
  const pool = new AgentPool();
  const handle = pool.spawn({ agentId: 'lead', logDir: tempDir('kern2') });
  try {
    const thinking = waitForFrame(handle, (frame) => frame.t === 'agent.thinking');
    const toolCall = waitForFrame(handle, (frame) => frame.t === 'tool.call');
    const patch = waitForFrame(handle, (frame) => frame.t === 'ui.patch');
    const done = waitForFrame(handle, (frame) => frame.t === 'loop.done');

    handle.send({ t: 'human.message', text: '把预算显示成进度条' });

    assert.match(String((await thinking).text), /把预算显示成进度条/);
    assert.equal((await toolCall).name, 'budget');
    assert.equal((await patch).scope, 'surface.sidebar');
    assert.equal((await done).reason, 'completed');
  } finally {
    await pool.shutdown();
  }
});

// @spec KERN-003
test('一个 Agent 一个进程：两个 Agent 的 pid 不同', async () => {
  const pool = new AgentPool();
  const lead = pool.spawn({ agentId: 'lead', logDir: tempDir('kern3a') });
  const mate = pool.spawn({ agentId: 'teammate:frontend', logDir: tempDir('kern3b') });
  try {
    assert.ok(lead.pid && mate.pid);
    assert.notEqual(lead.pid, mate.pid);
    assert.equal(pool.list().length, 2);
    assert.throws(() => pool.spawn({ agentId: 'lead' }), /已经在运行/);
  } finally {
    await pool.shutdown();
  }
});

// @spec KERN-004
test('发送非法帧被拦截并抛 ProtocolError，脏帧不进管道', async () => {
  const pool = new AgentPool();
  const handle = pool.spawn({ agentId: 'lead', logDir: tempDir('kern4') });
  try {
    assert.throws(() => handle.send({ t: '不存在的帧' } as never), (err: unknown) => err instanceof ProtocolError);
    assert.throws(() => handle.send({ t: 'human.message' } as never), (err: unknown) => err instanceof ProtocolError);
  } finally {
    await pool.shutdown();
  }
});

// @spec KERN-005
test('interrupt 后子进程在最近一个 boundary 收尾，并保持存活', async () => {
  const pool = new AgentPool();
  const handle = pool.spawn({ agentId: 'lead', logDir: tempDir('kern5'), stepDelayMs: 150 });
  try {
    const done = waitForFrame(handle, (frame) => frame.t === 'loop.done');
    handle.send({ t: 'human.message', text: '慢慢来' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    handle.interrupt('human_took_over');

    const result = await done;
    assert.equal(result.reason, 'interrupted');
    assert.equal(handle.alive, true, '中断的是这一轮 Run，不是进程');
  } finally {
    await pool.shutdown();
  }
});

// @spec KERN-006
test('kill 立即终止子进程，exited 报告信号', async () => {
  const pool = new AgentPool();
  const handle = pool.spawn({ agentId: 'idle', entry: path.join(fixtures, 'idle-agent.ts') });
  try {
    assert.equal(handle.alive, true);
    handle.kill('SIGTERM');
    const info = await handle.exited;
    assert.equal(info.signal, 'SIGTERM');
    assert.equal(handle.alive, false);
  } finally {
    await pool.shutdown();
  }
});

// @spec KERN-007
test('子进程崩溃不影响宿主，exited 报告退出码', async () => {
  const pool = new AgentPool();
  const handle = pool.spawn({ agentId: 'crasher', entry: path.join(fixtures, 'crash-agent.ts') });
  try {
    const info = await handle.exited;
    assert.equal(info.code, 3);
    assert.equal(handle.alive, false);
    // 宿主还活着，池子还能继续干活
    assert.equal(pool.get('crasher'), undefined);
    const healthy = pool.spawn({ agentId: 'lead', logDir: tempDir('kern7') });
    assert.ok(healthy.pid);
  } finally {
    await pool.shutdown();
  }
});

// @spec KERN-008
test('审批门默认拒绝；allow_always 之后同动作自动放行；历史可查', async () => {
  const request = { id: 'a1', action: 'install_dependency', risk: 'medium' as const, agentId: 'lead' };

  const strict = new ApprovalGate();
  assert.equal(await strict.request(request), 'deny');
  assert.equal(strict.last?.source, 'default_deny');

  const permissive = new ApprovalGate({ policy: () => 'allow_always' });
  assert.equal(await permissive.request(request), 'allow_always');
  assert.equal(permissive.isAllowed('install_dependency'), true);
  assert.equal(await permissive.request({ ...request, id: 'a2' }), 'allow_always');
  assert.equal(permissive.last?.source, 'allowlist');
  assert.equal(permissive.history.length, 2);

  const onceOnly = new ApprovalGate({ policy: () => 'allow_once' });
  assert.equal(await onceOnly.request(request), 'allow_once');
  assert.equal(onceOnly.isAllowed('install_dependency'), false);
});

// @spec KERN-009
test('子进程的每一帧都写进事件日志（审计）', async () => {
  const log = new EventLog({ dir: tempDir('kern9') });
  const pool = new AgentPool({ log });
  const handle = pool.spawn({ agentId: 'lead', logDir: tempDir('kern9b') });
  try {
    const done = waitForFrame(handle, (frame) => frame.t === 'loop.done');
    handle.send({ t: 'human.message', text: '审计我' });
    await done;
    await new Promise((resolve) => setTimeout(resolve, 50));

    const frames = log.read().filter((event) => event.type === 'agent.frame');
    assert.ok(frames.length >= 6, `应当记录到足够多的帧，实际 ${frames.length}`);
    assert.ok(log.read().some((event) => event.type === 'agent.spawn'));
  } finally {
    await pool.shutdown();
  }
});

// @spec KERN-011
test('模型端口可切换：AGENT_MODEL=http 时子进程走真 HTTP 端口（本机假服务）', async () => {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
    });
    req.on('end', () => {
      requests.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '你好，我是真模型端口' } }],
          usage: { total_tokens: 7 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  const pool = new AgentPool();
  const handle = pool.spawn({
    agentId: 'lead',
    logDir: tempDir('kern11'),
    env: {
      AGENT_MODEL: 'http',
      AGENT_BASE_URL: `http://127.0.0.1:${port}/v1`,
      AGENT_API_KEY: 'test-key',
      AGENT_MODEL_NAME: 'fake-model',
    },
  });

  try {
    const thinking = waitForFrame(handle, (frame) => frame.t === 'agent.thinking');
    const done = waitForFrame(handle, (frame) => frame.t === 'loop.done');
    handle.send({ t: 'human.message', text: '你好' });

    assert.match(String((await thinking).text), /真模型端口/);
    assert.equal((await done).reason, 'completed');
    assert.equal(requests.length, 1, '应当真的发了 HTTP 请求');
    assert.match(requests[0] as string, /fake-model/);
  } finally {
    await pool.shutdown();
    server.close();
  }
});

// @spec KERN-010
test('进程退出后 exited 只 resolve 一次，alive 为 false，池中被清理', async () => {
  const pool = new AgentPool();
  const handle = pool.spawn({ agentId: 'idle2', entry: path.join(fixtures, 'idle-agent.ts') });
  handle.kill('SIGKILL');
  const first = await handle.exited;
  const second = await handle.exited;
  assert.deepEqual(first, second);
  assert.equal(handle.alive, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pool.get('idle2'), undefined);
  await pool.shutdown();
});
