import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ClientSource } from '../src/orchestrator/client-source.ts';
import { runClientSelfTest } from '../src/orchestrator/self-test.ts';
import { TeamRunner } from '../src/orchestrator/team.ts';
import { ClientSession } from '../src/server/session.ts';
import { ApprovalGate } from '../src/kernel/approval.ts';
import { EventLog } from '../src/eventlog/log.ts';
import type { SelfTestResult } from '../src/orchestrator/self-test.ts';

const CSS_V1 = ':root {\n  --accent: #22d3ee;\n}\n';
const CSS_V2 = ':root {\n  --accent: #f472b6;\n}\n';

interface Workspace {
  dir: string;
  root: string;
  historyDir: string;
}

function workspace(): Workspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-client-self-'));
  const root = path.join(dir, 'client');
  const historyDir = path.join(dir, 'history');
  fs.mkdirSync(root, { recursive: true });
  // 真实的客户端目录一定住在 type:module 的项目里，夹具也一样
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }, null, 2), 'utf8');
  fs.writeFileSync(path.join(root, 'style.css'), CSS_V1, 'utf8');
  fs.writeFileSync(path.join(root, 'app.js'), 'export const version = 1;\n', 'utf8');
  return { dir, root, historyDir };
}

const passing = async (): Promise<SelfTestResult> => ({
  ok: true,
  checks: [{ name: 'fake', ok: true, detail: 'ok' }],
  output: '',
});

function sourceFor(ws: Workspace, selfTest: (input: { changed: string[] }) => Promise<SelfTestResult> = passing, log?: EventLog): ClientSource {
  return new ClientSource({
    root: ws.root,
    historyDir: ws.historyDir,
    projectRoot: process.cwd(),
    selfTest,
    ...(log === undefined ? {} : { log }),
  });
}

// @spec SELF-001
test('写作用域：src/client 之外一律拒绝，且不落盘', async () => {
  const ws = workspace();
  const source = sourceFor(ws);

  // 注意：`src/server/x.ts` 这种路径在可写根目录内部，属于合法子目录——
  // 真正的护栏是「根目录 = src/client」，所以逃逸只能从根往外走。
  for (const outside of ['../server/http-server.ts', 'a/../../escape.css', '/etc/passwd', '..', './..']) {
    const result = await source.write(outside, 'pwned', { reason: '越界尝试' });
    assert.equal(result.ok, false, `${outside} 必须被拒绝`);
    assert.equal(result.ok === false && result.error.code, 'OUT_OF_SCOPE', `${outside} 的错误码`);
  }

  assert.equal(fs.existsSync(path.join(ws.dir, 'escape.css')), false);
  assert.equal(fs.existsSync(path.join(ws.root, 'src')), false, '不能凭空造出越界目录');

  const inside = await source.write('theme.css', 'body { color: red }\n', { reason: '合法' });
  assert.equal(inside.ok, true);
  assert.equal(fs.existsSync(path.join(ws.root, 'theme.css')), true);
});

// @spec SELF-002
test('read 同样受作用域与存在性约束', () => {
  const ws = workspace();
  const source = sourceFor(ws);

  const ok = source.read('style.css');
  assert.equal(ok.ok, true);
  assert.equal(ok.ok === true && ok.value.content, CSS_V1);
  assert.equal(ok.ok === true && ok.value.bytes, Buffer.byteLength(CSS_V1));

  const missing = source.read('nope.css');
  assert.equal(missing.ok === false && missing.error.code, 'NOT_FOUND');

  const outside = source.read('../package.json');
  assert.equal(outside.ok === false && outside.error.code, 'OUT_OF_SCOPE');
});

// @spec SELF-003
test('list 返回可改文件、字节数与版本数', async () => {
  const ws = workspace();
  const source = sourceFor(ws);
  await source.write('style.css', CSS_V2, { reason: '换色' });

  const listed = source.list();
  assert.equal(listed.ok, true);
  const files = listed.ok ? listed.value : [];
  const css = files.find((file) => file.path === 'style.css');
  assert.ok(css, 'style.css 应当在清单里');
  assert.equal(css?.bytes, Buffer.byteLength(CSS_V2));
  assert.equal(css?.versions, 1);
  assert.equal(files.some((file) => file.path === 'app.js'), true);
});

// @spec SELF-004
test('写入成功：内容更新、版本 +1、历史留快照', async () => {
  const ws = workspace();
  const source = sourceFor(ws);

  const result = await source.write('style.css', CSS_V2, { reason: '改成粉色', author: 'lead' });
  assert.equal(result.ok, true);
  assert.equal(result.ok === true && result.value.version, 1);
  assert.equal(result.ok === true && result.value.created, false);
  assert.equal(fs.readFileSync(path.join(ws.root, 'style.css'), 'utf8'), CSS_V2);

  const history = source.history('style.css');
  assert.equal(history.ok === true && history.value.length, 1);
  const record = history.ok ? history.value[0] : undefined;
  assert.equal(record?.reason, '改成粉色');
  assert.equal(record?.author, 'lead');
  assert.equal(record?.selfTest, 'passed');
  assert.equal(record?.content, CSS_V2, '历史里要留内容快照，回滚才有依据');
});

// @spec SELF-005
test('diff 给出人可读差异（增删行与内容）', async () => {
  const ws = workspace();
  const source = sourceFor(ws);
  await source.write('style.css', CSS_V2, { reason: '换色' });

  const diff = source.diff('style.css');
  assert.equal(diff.ok, true);
  const value = diff.ok ? diff.value : undefined;
  assert.equal(value?.from, 0);
  assert.equal(value?.to, 1);
  assert.equal(value?.added, 1);
  assert.equal(value?.removed, 1);
  assert.match(String(value?.diff), /- \s*--accent: #22d3ee;/);
  assert.match(String(value?.diff), /\+ \s*--accent: #f472b6;/);
});

// @spec SELF-006
test('自检不通过 → 逐字节回滚，且不进历史', async () => {
  const ws = workspace();
  const log = new EventLog({ dir: path.join(ws.dir, 'events') });
  const source = sourceFor(
    ws,
    async () => ({ ok: false, checks: [{ name: 'fake', ok: false, detail: '故意失败' }], output: '故意失败' }),
    log,
  );

  const result = await source.write('style.css', CSS_V2, { reason: '会失败' });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.code, 'SELF_TEST_FAILED');
  assert.equal(fs.readFileSync(path.join(ws.root, 'style.css'), 'utf8'), CSS_V1, '必须与写入前逐字节一致');

  const history = source.history('style.css');
  assert.equal(history.ok === true && history.value.length, 0, '没通过就不该留下版本');

  const rejected = log.read().filter((event) => event.type === 'client.write.rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]?.path, 'style.css');
});

// @spec SELF-007
test('语法错误被真的语法自检拦下并回滚（用生产实现，不是假 selfTest）', async () => {
  const ws = workspace();
  const source = new ClientSource({
    root: ws.root,
    historyDir: ws.historyDir,
    projectRoot: process.cwd(),
    selfTest: (input) =>
      runClientSelfTest({
        projectRoot: process.cwd(),
        clientRoot: ws.root,
        changed: input.changed,
        runProjectTests: false,
      }),
  });

  const result = await source.write('app.js', 'export const broken = ;\n', { reason: '写坏它' });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.code, 'SELF_TEST_FAILED');
  assert.match(String(result.ok === false ? result.error.message : ''), /语法|Syntax|Unexpected/);
  assert.equal(
    fs.readFileSync(path.join(ws.root, 'app.js'), 'utf8'),
    'export const version = 1;\n',
    '坏语法不许留在磁盘上',
  );
});

// @spec SELF-008
test('client.write 过审批门：默认拒绝时不写文件', async () => {
  const ws = workspace();
  const runner = new TeamRunner({
    dir: path.join(ws.dir, 'run'),
    log: new EventLog({ dir: path.join(ws.dir, 'run-events') }),
    approval: new ApprovalGate(), // 默认拒绝
    clientSource: sourceFor(ws),
  });

  try {
    await runner.runLead({
      prompt: '改一下配色',
      script: [
        { toolCalls: [{ id: 'w1', name: 'client.write', args: { path: 'style.css', content: CSS_V2, reason: '换色' } }] },
        { text: '被拒了', done: true },
      ],
    });

    assert.equal(fs.readFileSync(path.join(ws.root, 'style.css'), 'utf8'), CSS_V1, '审批不过不能落盘');
    const result = runner.log.read().find((event) => event.type === 'host.tool.result' && event.tool === 'client.write');
    assert.equal(result?.ok, false);
    assert.match(String(result?.error), /审批被拒绝/);
  } finally {
    await runner.reclaim();
  }
});

// @spec SELF-009
test('审计：成功写入写 client.write，失败写入写 client.write.rejected', async () => {
  const ws = workspace();
  const log = new EventLog({ dir: path.join(ws.dir, 'audit') });
  let allow = true;
  const source = sourceFor(
    ws,
    async () =>
      allow
        ? { ok: true, checks: [], output: '' }
        : { ok: false, checks: [], output: '自检失败' },
    log,
  );

  await source.write('style.css', CSS_V2, { reason: '第一次', author: 'lead' });
  allow = false;
  await source.write('style.css', ':root{--accent:#000}', { reason: '第二次' });

  const events = log.read();
  const wrote = events.filter((event) => event.type === 'client.write');
  const rejected = events.filter((event) => event.type === 'client.write.rejected');
  assert.equal(wrote.length, 1);
  assert.equal(wrote[0]?.reason, '第一次');
  assert.equal(wrote[0]?.author, 'lead');
  assert.equal(wrote[0]?.selfTest, 'passed');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]?.reason, '第二次');
});

// @spec SELF-010
test('revert 回到上一版，并留下回滚记录', async () => {
  const ws = workspace();
  const log = new EventLog({ dir: path.join(ws.dir, 'revert') });
  const source = sourceFor(ws, passing, log);

  await source.write('style.css', CSS_V2, { reason: '换色' });
  const reverted = source.revert('style.css');
  assert.equal(reverted.ok, true);
  assert.equal(reverted.ok === true && reverted.value.restoredFrom, 1, '撤销的是 v1 那次写入');

  assert.equal(fs.readFileSync(path.join(ws.root, 'style.css'), 'utf8'), CSS_V1);
  assert.equal(log.read().some((event) => event.type === 'client.revert'), true);
});

// @spec SELF-011
test('广播：写入触发 client.changed，且 state.sources 同步更新', async () => {
  const ws = workspace();
  const session = new ClientSession({
    dir: path.join(ws.dir, 'session'),
    clientRoot: ws.root,
    selfTest: passing,
    approval: new ApprovalGate({ policy: () => 'allow_once' }),
    lead: {
      script: [
        { toolCalls: [{ id: 'w1', name: 'client.write', args: { path: 'style.css', content: CSS_V2, reason: '换成粉色' } }] },
        { text: '改完了', done: true },
      ],
    },
  });

  const events: Array<{ type: string; data: unknown }> = [];
  session.onEvent((event) => events.push({ type: event.type, data: event.data }));

  try {
    session.send('把配色换成粉色');
    const deadline = Date.now() + 20000;
    while (!events.some((event) => event.type === 'client.changed') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const changed = events.find((event) => event.type === 'client.changed');
    assert.ok(changed, '必须广播 client.changed');
    const payload = changed?.data as { kind: string; path: string; version: number; selfTest: string };
    assert.equal(payload.kind, 'write');
    assert.equal(payload.path, 'style.css');
    assert.equal(payload.version, 1);
    assert.equal(payload.selfTest, 'passed');

    const sources = session.state().sources;
    assert.equal(sources.some((file) => file.path === 'style.css' && file.versions === 1), true);
  } finally {
    await session.close();
  }
});

// @spec SELF-012
test('无变化写入是幂等的：不产生新版本', async () => {
  const ws = workspace();
  const source = sourceFor(ws);

  const first = await source.write('style.css', CSS_V2, { reason: '换色' });
  assert.equal(first.ok, true);

  const again = await source.write('style.css', CSS_V2, { reason: '再写一遍一模一样的内容' });
  assert.equal(again.ok, true);
  assert.equal(again.ok === true && again.value.unchanged, true);
  assert.equal(again.ok === true && again.value.version, 1, '版本不该前进');

  assert.equal(source.history('style.css').ok === true && (source.history('style.css') as { value: unknown[] }).value.length, 1);
});

// @spec SELF-013
test('append 模式在末尾追加，且同样走自检门禁', async () => {
  const ws = workspace();
  let lastChanged: string[] = [];
  const source = sourceFor(ws, async (input) => {
    lastChanged = input.changed;
    return passing();
  });

  const appended = await source.write('style.css', ':root { --accent: #f472b6; }\n', {
    reason: '追加主题覆盖',
    append: true,
  });
  assert.equal(appended.ok, true);
  assert.deepEqual(lastChanged, ['style.css'], '追加也要过自检');

  const content = fs.readFileSync(path.join(ws.root, 'style.css'), 'utf8');
  assert.equal(content, `${CSS_V1}:root { --accent: #f472b6; }\n`);
  assert.equal(content.startsWith(CSS_V1), true, '原内容必须保留');

  // 追加后自检失败 → 回滚成追加前的样子
  const failing = sourceFor(ws, async () => ({ ok: false, checks: [], output: '不行' }));
  const rejected = await failing.write('style.css', 'body{}\n', { reason: '这次会失败', append: true });
  assert.equal(rejected.ok, false);
  assert.equal(fs.readFileSync(path.join(ws.root, 'style.css'), 'utf8'), content);
});
