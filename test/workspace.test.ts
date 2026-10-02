import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MAX_FILE_BYTES, WorkspaceStore, resolveInside } from '../src/workspace/store.ts';
import { ConversationRegistry } from '../src/server/conversations.ts';
import { ClientSession } from '../src/server/session.ts';
import { startServer } from '../src/server/http-server.ts';
import { createHostTools } from '../src/orchestrator/host-tools.ts';
import type { HostRuntime } from '../src/orchestrator/host-tools.ts';
import type { BrowserHost } from '../src/browser/document.ts';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agent-client-ws-${prefix}-`));
}

function runtimeFor(workspace: WorkspaceStore): HostRuntime {
  return { workspace, browser: {} as BrowserHost } as unknown as HostRuntime;
}

async function callTool(name: string, args: Record<string, unknown>, runtime: HostRuntime) {
  const tool = createHostTools().find((candidate) => candidate.name === name);
  assert.ok(tool, `${name} 必须存在`);
  return (tool as { run: (a: Record<string, unknown>, r: HostRuntime, c: string) => Promise<{ ok: boolean; result?: string; error?: string }> }).run(
    args,
    runtime,
    'lead',
  );
}

// @spec WS-001
test('工作空间落在 <dir>/conversations/<id>/workspace 下，首次写入时自动创建', () => {
  const root = tempDir('root');
  const registry = new ConversationRegistry({
    root,
    open: (id, dir) => new ClientSession({ dir, id }),
  });
  const session = registry.get('c1');

  assert.equal(session.runner.workspace.root, path.join(root, 'conversations', 'c1', 'workspace'));
  assert.equal(fs.existsSync(session.runner.workspace.root), false, '还没写就不该建目录');

  session.runner.workspace.write({ path: 'a/b.md', content: 'hi' });
  assert.equal(fs.existsSync(path.join(session.runner.workspace.root, 'a', 'b.md')), true);
});

// @spec WS-002
test('write 返回字节数；append 是追加而不是覆盖', () => {
  const workspace = new WorkspaceStore({ root: tempDir('write') });

  const first = workspace.write({ path: 'log.txt', content: '第一行\n' });
  assert.equal(first.ok, true);
  assert.equal(first.ok === true && first.bytes, Buffer.byteLength('第一行\n', 'utf8'));

  const second = workspace.write({ path: 'log.txt', content: '第二行\n', append: true });
  assert.equal(second.ok, true);
  assert.equal(workspace.read({ path: 'log.txt' }).ok === true && (workspace.read({ path: 'log.txt' }) as { content: string }).content, '第一行\n第二行\n');

  const overwrite = workspace.write({ path: 'log.txt', content: '只有这行' });
  assert.equal(overwrite.ok, true);
  assert.equal((workspace.read({ path: 'log.txt' }) as { content: string }).content, '只有这行');
});

// @spec WS-003
test('路径穿越一律拒绝：.. / 绝对路径 / 盘符 / 深挖', () => {
  const root = tempDir('escape');
  const workspace = new WorkspaceStore({ root });

  for (const bad of [
    '../outside.txt',
    'a/../../outside.txt',
    '/etc/passwd',
    'C:/windows/system32',
    'a/../../../b',
    './../x',
    'nested/./../../x',
  ]) {
    const result = workspace.write({ path: bad, content: 'x' });
    assert.equal(result.ok, false, `${bad} 必须被拒绝`);
    assert.equal(result.ok === false && (result.code === 'PATH_ESCAPE' || result.code === 'BAD_PATH'), true);
  }

  // 根目录外确实什么都没有
  assert.equal(fs.existsSync(path.join(path.dirname(root), 'outside.txt')), false);

  const resolved = resolveInside(root, 'ok/here.md');
  assert.equal(resolved.ok, true);
  assert.equal(resolved.ok === true && resolved.rel, 'ok/here.md');
  // 规则是「一律拒绝」，不做归一化猜测：`a/../c.md` 其实落在根内，也照样拒。
  // 宁可让 Agent 重写一个干净路径，也不给路径解析留任何想象空间。
  const wouldNormalize = resolveInside(root, 'a/../c.md');
  assert.equal(wouldNormalize.ok, false, '含 .. 一律拒绝，不做归一化猜测');
  // 而 `.` 段是无害的，归一化掉
  const dotted = resolveInside(root, 'a/./c.md');
  assert.equal(dotted.ok === true && dotted.rel, 'a/c.md');
});

// @spec WS-004
test('被拒绝的写入不留任何副作用', () => {
  const root = tempDir('noside');
  const workspace = new WorkspaceStore({ root });
  workspace.write({ path: 'keep.txt', content: '原内容' });

  const rejected = workspace.write({ path: '../escape.txt', content: '恶意' });
  assert.equal(rejected.ok, false);
  assert.equal(fs.existsSync(path.join(path.dirname(root), 'escape.txt')), false, '越界文件不能出现');

  const tooBig = workspace.write({ path: 'keep.txt', content: 'x'.repeat(MAX_FILE_BYTES + 1) });
  assert.equal(tooBig.ok === false && tooBig.code, 'WORKSPACE_FULL');
  assert.equal((workspace.read({ path: 'keep.txt' }) as { content: string }).content, '原内容', '被拒的写入不能改动已有文件');
});

// @spec WS-005
test('单文件与总量超限都拒绝，且不写半个文件', () => {
  const root = tempDir('full');
  const workspace = new WorkspaceStore({ root });

  const tooBig = workspace.write({ path: 'big.bin', content: 'x'.repeat(MAX_FILE_BYTES + 1) });
  assert.equal(tooBig.ok === false && tooBig.code, 'WORKSPACE_FULL');
  assert.equal(fs.existsSync(path.join(root, 'big.bin')), false, '超限不能留下半个文件');

  // 总量上限：写满 4MB 之后再写就该被拒
  const chunk = 'y'.repeat(200 * 1024);
  let written = 0;
  for (let i = 0; i < 40; i += 1) {
    const result = workspace.write({ path: `chunk-${i}.txt`, content: chunk });
    if (!result.ok) break;
    written += 1;
  }
  assert.ok(written < 40, '总量到顶之后必须开始拒绝');
  // 剩下的一点余量允许小文件，但再来一大块就必须被拒
  const anotherChunk = workspace.write({ path: 'overflow.txt', content: chunk });
  assert.equal(anotherChunk.ok === false && anotherChunk.code, 'WORKSPACE_FULL');
  assert.equal(fs.existsSync(path.join(root, 'overflow.txt')), false, '超限不能留下半个文件');
});

// @spec WS-006
test('read：不存在的文件报 NOT_FOUND；超大文件截断并标记', () => {
  const root = tempDir('read');
  const workspace = new WorkspaceStore({ root });

  const missing = workspace.read({ path: 'nope.md' });
  assert.equal(missing.ok === false && missing.code, 'NOT_FOUND');

  fs.mkdirSync(path.join(root, 'dir'), { recursive: true });
  const asDirectory = workspace.read({ path: 'dir' });
  assert.equal(asDirectory.ok === false && asDirectory.code, 'IS_DIRECTORY');

  // 直接在磁盘上放一个大于读取上限的文件（绕过 write 的单文件上限）
  const big = path.join(root, 'big.txt');
  fs.writeFileSync(big, 'q'.repeat(200 * 1024), 'utf8');
  const read = workspace.read({ path: 'big.txt' });
  assert.equal(read.ok, true);
  assert.equal(read.ok === true && read.truncated, true, '必须标记被截断');
  assert.equal(read.ok === true && read.bytes, 200 * 1024, 'bytes 是真实大小');
  assert.ok(read.ok === true && read.content.length < 200 * 1024);
});

// @spec WS-007
test('list 只给元信息，不返回文件内容', () => {
  const workspace = new WorkspaceStore({ root: tempDir('list') });
  workspace.write({ path: 'a.md', content: '秘密内容 SECRET-42' });
  workspace.write({ path: 'sub/b.md', content: 'x' });

  const files = workspace.list();
  assert.deepEqual(files.map((file) => file.path).sort(), ['a.md', 'sub/b.md']);
  for (const file of files) {
    assert.equal(Object.keys(file).sort().join(','), 'bytes,mtime,path', '列表项只能是元信息');
  }
  assert.equal(JSON.stringify(files).includes('SECRET-42'), false, '列表不得夹带内容');
});

// @spec WS-008
test('HTTP：列表只给元信息，内容按需加载；/api/state 里不含文件内容', async () => {
  const root = tempDir('http');
  const registry = new ConversationRegistry({
    root,
    open: (id, dir) => new ClientSession({ dir, id }),
  });
  const session = registry.get('default');
  session.runner.workspace.write({ path: 'note.md', content: '按需加载才看得到 SECRET-7' });

  const server = await startServer({ session, registry, port: 0 });
  try {
    const listing = (await (await fetch(`${server.url}/api/workspace`)).json()) as {
      files: Array<{ path: string; bytes: number }>;
    };
    assert.deepEqual(listing.files.map((file) => file.path), ['note.md']);
    assert.equal(JSON.stringify(listing).includes('SECRET-7'), false, '列表接口不得返回内容');

    const state = (await (await fetch(`${server.url}/api/state`)).json()) as Record<string, unknown>;
    assert.equal(JSON.stringify(state).includes('SECRET-7'), false, '状态快照不得夹带文件内容');

    const loaded = (await (await fetch(`${server.url}/api/workspace/file?path=note.md`)).json()) as {
      content: string;
      truncated: boolean;
    };
    assert.match(loaded.content, /SECRET-7/);
    assert.equal(loaded.truncated, false);
  } finally {
    await server.close();
    await registry.closeAll();
  }
});

// @spec WS-009
test('HTTP 越界路径返回 400，且不泄漏根目录之外的信息', async () => {
  const root = tempDir('http-escape');
  const registry = new ConversationRegistry({ root, open: (id, dir) => new ClientSession({ dir, id }) });
  const session = registry.get('default');
  session.runner.workspace.write({ path: 'ok.md', content: 'fine' });

  // 在根目录之外放一个"诱饵"文件，确认读不到
  const outside = path.join(path.dirname(session.runner.workspace.root), 'outside.txt');
  fs.writeFileSync(outside, 'OUTSIDE-SECRET', 'utf8');

  const server = await startServer({ session, registry, port: 0 });
  try {
    for (const evil of ['../outside.txt', '../../etc/passwd', '/etc/passwd']) {
      const response = await fetch(`${server.url}/api/workspace/file?path=${encodeURIComponent(evil)}`);
      assert.equal(response.status, 400, `${evil} 必须 400`);
      const body = await response.text();
      assert.equal(body.includes('OUTSIDE-SECRET'), false, '响应里不能出现根目录之外的内容');
      assert.equal(body.includes('root:'), false, '也不该回显真实路径');
    }
  } finally {
    await server.close();
    await registry.closeAll();
  }
});

// @spec WS-011
test('工作空间按对话隔离：A 写的文件在 B 里看不到', async () => {
  const root = tempDir('isolate');
  const registry = new ConversationRegistry({ root, open: (id, dir) => new ClientSession({ dir, id }) });

  const a = registry.get('default');
  const b = registry.create('B');
  const sessionB = registry.get(b.id);

  a.runner.workspace.write({ path: 'a-only.md', content: 'A 的' });
  sessionB.runner.workspace.write({ path: 'b-only.md', content: 'B 的' });

  assert.deepEqual(a.runner.workspace.list().map((file) => file.path), ['a-only.md']);
  assert.deepEqual(sessionB.runner.workspace.list().map((file) => file.path), ['b-only.md']);

  const server = await startServer({ session: a, registry, port: 0 });
  try {
    const listingB = (await (await fetch(`${server.url}/api/workspace?conversation=${b.id}`)).json()) as {
      files: Array<{ path: string }>;
    };
    assert.deepEqual(listingB.files.map((file) => file.path), ['b-only.md'], 'B 的文件列表里不能出现 A 的文件');
  } finally {
    await server.close();
    await registry.closeAll();
  }
});

// @spec WS-002
test('宿主工具 workspace.write/read/list 走的是同一套校验', async () => {
  const workspace = new WorkspaceStore({ root: tempDir('tools') });
  const runtime = runtimeFor(workspace);

  const write = await callTool('workspace.write', { path: 'report.md', content: '# 报告' }, runtime);
  assert.equal(write.ok, true);
  assert.deepEqual(JSON.parse(String(write.result)), { path: 'report.md', bytes: Buffer.byteLength('# 报告', 'utf8') });

  const read = await callTool('workspace.read', { path: 'report.md' }, runtime);
  assert.equal(read.ok, true);
  assert.equal((JSON.parse(String(read.result)) as { content: string }).content, '# 报告');

  const list = await callTool('workspace.list', {}, runtime);
  assert.equal(list.ok, true);
  assert.deepEqual((JSON.parse(String(list.result)) as { files: Array<{ path: string }> }).files.map((f) => f.path), ['report.md']);

  const escape = await callTool('workspace.write', { path: '../x.md', content: 'x' }, runtime);
  assert.equal(escape.ok, false);
  assert.match(String(escape.error), /PATH_ESCAPE/);

  const badArgs = await callTool('workspace.write', { path: 'x.md' }, runtime);
  assert.equal(badArgs.ok, false);
  assert.match(String(badArgs.error), /INVALID_ARGS/);
});
