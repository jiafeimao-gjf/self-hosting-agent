import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ConversationRegistry, CONVERSATION_ID_PATTERN } from '../src/server/conversations.ts';
import { COMMANDS, helpText, parseCommand, runCommand } from '../src/server/commands.ts';
import { ClientSession } from '../src/server/session.ts';
import { startServer } from '../src/server/http-server.ts';
import type { RunningServer } from '../src/server/http-server.ts';
import { EventLog } from '../src/eventlog/log.ts';
import { projectConversation } from '../src/runtime/conversation.ts';
import type { SpawnAgentOptions } from '../src/orchestrator/team.ts';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agent-client-conv-${prefix}-`));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 一个会画界面的剧本：确定性、不需要模型 */
function renderingLead(text = '画好了'): SpawnAgentOptions {
  return {
    script: [
      {
        toolCalls: [
          {
            id: 'c1',
            name: 'ui.render',
            args: { scope: 'surface.main', op: 'upsert', spec: { type: 'text', text: '来自 A 的界面' } },
          },
        ],
      },
      { text, done: true },
    ],
  };
}

function makeRegistry(root: string, lead: SpawnAgentOptions = { script: [{ text: '收到', done: true }] }) {
  return new ConversationRegistry({
    root,
    open: (id, dir) =>
      new ClientSession({ dir, id, title: id === 'default' ? '默认对话' : id, lead }),
  });
}

interface SseClient {
  events: Array<{ event: string; data: unknown }>;
  waitFor(predicate: (event: { event: string; data: unknown }) => boolean, timeoutMs?: number): Promise<{ event: string; data: unknown }>;
  close(): void;
}

async function openSse(url: string): Promise<SseClient> {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal, headers: { accept: 'text/event-stream' } });
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('没有 SSE 响应体');
  const events: Array<{ event: string; data: unknown }> = [];
  const decoder = new TextDecoder();
  void (async () => {
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let separator = buffer.indexOf('\n\n');
        while (separator >= 0) {
          const chunk = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          separator = buffer.indexOf('\n\n');
          if (chunk.startsWith(':')) continue;
          let name = 'message';
          const dataLines: string[] = [];
          for (const line of chunk.split('\n')) {
            if (line.startsWith('event:')) name = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          }
          if (dataLines.length === 0) continue;
          try {
            events.push({ event: name, data: JSON.parse(dataLines.join('\n')) });
          } catch {
            /* 忽略坏块 */
          }
        }
      }
    } catch {
      /* abort */
    }
  })();
  return {
    events,
    async waitFor(predicate, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = events.find(predicate);
        if (hit !== undefined) return hit;
        if (Date.now() >= deadline) throw new Error(`等待 SSE 超时，已收到：${events.map((e) => e.event).join(',')}`);
        await sleep(20);
      }
    },
    close: () => controller.abort(),
  };
}

async function postJson(url: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

async function withRegistryServer(
  fn: (ctx: { registry: ConversationRegistry; server: RunningServer; root: string }) => Promise<void>,
  lead: SpawnAgentOptions = { script: [{ text: '收到', done: true }] },
): Promise<void> {
  const root = tempDir('root');
  const registry = makeRegistry(root, lead);
  const server = await startServer({ session: registry.get('default'), registry, port: 0 });
  try {
    await fn({ registry, server, root });
  } finally {
    await server.close();
    await registry.closeAll();
  }
}

// @spec CONV-001
test('注册表按 id 惰性开门：同 id 同实例，不同 id 不同实例，目录在 conversations/<id> 下', () => {
  const root = tempDir('lazy');
  const registry = makeRegistry(root);

  const a1 = registry.get('default');
  const a2 = registry.get('default');
  assert.equal(a1 === a2, true, '同一个 id 必须拿到同一个实例，否则文档与子进程会被开成两份');

  const b = registry.get('c9');
  assert.notEqual(a1, b);
  assert.equal(fs.existsSync(path.join(root, 'conversations', 'default', 'meta.json')), true);
  assert.equal(b.dir, path.join(root, 'conversations', 'c9'));
  assert.equal(registry.dirFor('c9'), path.join(root, 'conversations', 'c9'));
});

// @spec CONV-002
test('新建对话：合法 id、默认标题、冲突自动避让', () => {
  const root = tempDir('create');
  const registry = makeRegistry(root);

  const first = registry.create();
  assert.match(first.id, CONVERSATION_ID_PATTERN);
  assert.equal(first.title, '新对话', '省略标题要给默认标题');

  const second = registry.create('  营收分析  ');
  assert.equal(second.title, '营收分析', '标题要去掉首尾空白');
  assert.notEqual(second.id, first.id, 'id 冲突必须避让，绝不覆盖已有对话');
  assert.equal(registry.exists(first.id), true);
  assert.equal(registry.exists(second.id), true);

  const third = registry.create();
  assert.notEqual(third.id, first.id);
  assert.notEqual(third.id, second.id);
});

// @spec CONV-003
test('非法 id 一律拒绝：超长、大写、.. 、路径分隔符', () => {
  const root = tempDir('bad');
  const registry = makeRegistry(root);

  for (const bad of ['..', '../x', 'a/b', 'A', 'A-B', 'x'.repeat(33), 'a b', '', 'c1/', '中文']) {
    assert.equal(ConversationRegistry.isValidId(bad), false, `${bad} 不该被当成合法 id`);
    assert.throws(() => registry.dirFor(bad), /非法对话 id/);
  }
  for (const good of ['default', 'c1', 'a-b_c', 'x'.repeat(32)]) {
    assert.equal(ConversationRegistry.isValidId(good), true, `${good} 应当是合法 id`);
  }
});

// @spec CONV-004
test('对话列表 / 新建 / 删除：active 跟着走，默认对话不可删', async () => {
  await withRegistryServer(async ({ server }) => {
    const before = (await (await fetch(`${server.url}/api/conversations`)).json()) as {
      active: string;
      conversations: Array<{ id: string; title: string }>;
    };
    assert.equal(before.active, 'default');
    assert.equal(before.conversations.some((item) => item.id === 'default'), true);

    const created = await postJson(`${server.url}/api/conversations`, { title: '测试对话' });
    assert.equal(created.status, 200);
    const id = String((created.json.conversation as { id: string }).id);

    const after = (await (await fetch(`${server.url}/api/conversations`)).json()) as {
      active: string;
      conversations: Array<{ id: string }>;
    };
    assert.equal(after.active, id, '新建之后 active 指向新对话');
    assert.equal(after.conversations.some((item) => item.id === id), true);

    const removed = await fetch(`${server.url}/api/conversations/${id}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    const final = (await (await fetch(`${server.url}/api/conversations`)).json()) as { conversations: Array<{ id: string }> };
    assert.equal(final.conversations.some((item) => item.id === id), false);

    const protectedDefault = await fetch(`${server.url}/api/conversations/default`, { method: 'DELETE' });
    assert.equal(protectedDefault.status, 400, '默认对话不可删');
  });
});

// @spec CONV-005
test('不传 conversation 时所有路由作用在 default 上（向后兼容）', async () => {
  await withRegistryServer(async ({ server, registry }) => {
    const sent = await postJson(`${server.url}/api/message`, { text: '不带参数的消息' });
    assert.equal(sent.status, 202);

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (registry.get('default').state().messages.length > 0) break;
      await sleep(50);
    }
    const state = (await (await fetch(`${server.url}/api/state`)).json()) as { conversation: { id: string }; messages: unknown[] };
    assert.equal(state.conversation.id, 'default');
    assert.equal(state.messages.length > 0, true, '不带 ?conversation 也要真的作用在默认对话上');
  });
});

// @spec CONV-006
test('对话之间的事件流互不串扰', async () => {
  await withRegistryServer(async ({ server }) => {
    const created = await postJson(`${server.url}/api/conversations`, { title: 'B' });
    const bId = String((created.json.conversation as { id: string }).id);

    const streamA = await openSse(`${server.url}/api/stream?conversation=default`);
    const streamB = await openSse(`${server.url}/api/stream?conversation=${bId}`);
    try {
      await postJson(`${server.url}/api/message?conversation=default`, { text: '只给 A 的消息' });

      await streamA.waitFor((event) => event.event === 'done');
      assert.equal(streamA.events.some((event) => event.event === 'frame'), true, 'A 的流应当收到帧');

      // 给 B 一点时间；B 的流可以有建连时的初始快照，但绝不能有 A 的帧/收工事件
      await sleep(300);
      const bTraffic = streamB.events.filter((event) => event.event === 'frame' || event.event === 'done');
      assert.deepEqual(bTraffic, [], `B 的流不该收到 A 的流量，实际：${JSON.stringify(bTraffic)}`);
    } finally {
      streamA.close();
      streamB.close();
    }
  });
});

// @spec CONV-007
test('切换对话不丢状态：A 的界面文档切走再切回来原样还在', async () => {
  await withRegistryServer(
    async ({ server }) => {
      const created = await postJson(`${server.url}/api/conversations`, { title: 'B' });
      const bId = String((created.json.conversation as { id: string }).id);

      await postJson(`${server.url}/api/message?conversation=default`, { text: '给 A 画个界面' });
      const deadline = Date.now() + 20000;
      let aState = (await (await fetch(`${server.url}/api/state?conversation=default`)).json()) as {
        document: { version: number; html: string };
      };
      while (Date.now() < deadline && aState.document.version === 0) {
        await sleep(50);
        aState = (await (await fetch(`${server.url}/api/state?conversation=default`)).json()) as typeof aState;
      }
      assert.equal(aState.document.version > 0, true, 'A 应当渲染出界面文档');
      const htmlA = aState.document.html;

      // 切到 B，再切回 A
      await fetch(`${server.url}/api/state?conversation=${bId}`);
      const backToA = (await (await fetch(`${server.url}/api/state?conversation=default`)).json()) as typeof aState;
      assert.equal(backToA.document.version, aState.document.version, '切回来版本号不该变');
      assert.equal(backToA.document.html, htmlA, '切回来内容要一模一样');
    },
    renderingLead(),
  );
});

// @spec CONV-008
test('删除对话会回收它的 Agent 子进程，不留孤儿', async () => {
  await withRegistryServer(async ({ server }) => {
    const created = await postJson(`${server.url}/api/conversations`, { title: '待删' });
    const id = String((created.json.conversation as { id: string }).id);

    await postJson(`${server.url}/api/message?conversation=${id}`, { text: '起一个子进程' });
    const deadline = Date.now() + 20000;
    let pid: number | undefined;
    while (Date.now() < deadline) {
      const state = (await (await fetch(`${server.url}/api/state?conversation=${id}`)).json()) as {
        agents: Array<{ id: string; pid?: number }>;
      };
      pid = state.agents.find((agent) => agent.id === 'lead')?.pid;
      if (pid !== undefined) break;
      await sleep(50);
    }
    assert.ok(pid, '子进程应当已经起来');

    await fetch(`${server.url}/api/conversations/${id}`, { method: 'DELETE' });
    await sleep(500);

    let alive = true;
    try {
      process.kill(pid as number, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, `删除对话后子进程 ${pid} 必须被回收`);
  });
});

// @spec CMD-001
test('/help 列出全部命令，且表里没有幽灵命令', () => {
  const text = helpText();
  for (const command of COMMANDS) {
    assert.ok(text.includes(`/${command.name}`), `${command.name} 必须出现在帮助里`);
  }

  // 反向：帮助里出现的每个命令都必须真的能跑（不能报「未知命令」）
  const root = tempDir('help');
  const registry = makeRegistry(root);
  const session = registry.get('default');
  for (const command of COMMANDS) {
    const probe = command.name === 'switch' ? '/switch default' : `/${command.name}`;
    const result = runCommand(probe, { session, registry });
    assert.notEqual(result.error, `未知命令：/${command.name}（用 /help 看可用命令）`, `${command.name} 不该是幽灵命令`);
  }
});

// @spec CMD-002
test('/clear 清空显示与上下文，但磁盘上的历史一个字都不删', async () => {
  await withRegistryServer(async ({ server, registry }) => {
    await postJson(`${server.url}/api/message`, { text: '清空之前说的话' });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (registry.get('default').state().messages.some((item) => item.body.includes('清空之前'))) break;
      await sleep(50);
    }
    const session = registry.get('default');
    const logFile = path.join(session.dir, 'events', 'events.jsonl');
    const sizeBefore = fs.statSync(logFile).size;
    assert.equal(session.state().messages.some((item) => item.body.includes('清空之前')), true);

    const cleared = await postJson(`${server.url}/api/command`, { text: '/clear' });
    assert.equal(cleared.status, 200);
    assert.deepEqual(cleared.json.action, { type: 'cleared' });

    const after = session.state();
    assert.equal(after.messages.some((item) => item.body.includes('清空之前')), false, '可见对话必须清空');
    assert.equal(fs.statSync(logFile).size >= sizeBefore, true, '磁盘日志不能因此变短');
    assert.equal(
      session.runner.log.read().some((event) => event.type === 'conversation.cleared'),
      true,
      '要留下清空标记',
    );

    // Agent 侧：子进程自己的日志也要有边界（帧是异步过管道的，等它落地）
    const waitUntil = Date.now() + 8000;
    while (Date.now() < waitUntil && !session.runner.agentEvents('lead').some((event) => event.type === 'conversation.cleared')) {
      await sleep(50);
    }
    const leadLog = session.runner.agentEvents('lead');
    assert.equal(leadLog.some((event) => event.type === 'conversation.cleared'), true, '子进程也要写边界');
    assert.deepEqual(
      projectConversation(leadLog).filter((item) => item.text.includes('清空之前')),
      [],
      '清空之后，Agent 的上下文里不该再看到清空前的对话',
    );
  });
});

// @spec CMD-003
test('/history 真的落盘，/history list 能列出来', async () => {
  await withRegistryServer(async ({ server, registry }) => {
    await postJson(`${server.url}/api/message`, { text: '这条要进历史' });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && registry.get('default').messageCount() === 0) await sleep(50);

    const saved = await postJson(`${server.url}/api/command`, { text: '/history' });
    assert.equal(saved.status, 200);
    const output = String(saved.json.output);
    const matched = /(\/[^\s]+\.md)/.exec(output);
    assert.ok(matched, `输出里应当有真实路径：${output}`);
    const file = matched[1] as string;
    assert.equal(fs.existsSync(file), true, '导出的文件必须真的存在');
    assert.match(fs.readFileSync(file, 'utf8'), /这条要进历史/);

    const listed = await postJson(`${server.url}/api/command`, { text: '/history list' });
    assert.match(String(listed.json.output), /\.md/);

    // HTTP 也能按需加载历史文件
    const name = path.basename(file);
    const loaded = await fetch(`${server.url}/api/history/file?name=${encodeURIComponent(name)}`);
    assert.equal(loaded.status, 200);
    const body = (await loaded.json()) as { content: string };
    assert.match(body.content, /这条要进历史/);

    // 路径穿越必须被挡住
    const evil = await fetch(`${server.url}/api/history/file?name=${encodeURIComponent('../../etc/passwd')}`);
    assert.equal(evil.status, 400);
  });
});

// @spec CMD-004
test('/new 新建并切换、/list 列出、/switch 切换，并通过 action 告知客户端', async () => {
  await withRegistryServer(async ({ server }) => {
    const created = await postJson(`${server.url}/api/command`, { text: '/new 营收分析' });
    assert.equal(created.status, 200);
    assert.equal((created.json.action as { type: string }).type, 'created');
    const id = String((created.json.action as { conversation: string }).conversation);

    const listed = await postJson(`${server.url}/api/command`, { text: '/list' });
    assert.match(String(listed.json.output), /营收分析/);

    const switched = await postJson(`${server.url}/api/command`, { text: '/switch default' });
    assert.deepEqual(switched.json.action, { type: 'switch', conversation: 'default' });

    const back = await postJson(`${server.url}/api/command`, { text: `/switch ${id}` });
    assert.deepEqual(back.json.action, { type: 'switch', conversation: id });
  });
});

// @spec CMD-005
test('未知命令明确报错，且绝不被当成消息送给模型', async () => {
  await withRegistryServer(async ({ server, registry }) => {
    const before = registry.get('default').state();
    const result = await postJson(`${server.url}/api/command`, { text: '/不存在的命令' });
    assert.equal(result.status, 400);
    assert.equal(result.json.ok, false);
    assert.match(String(result.json.error), /未知命令/);

    await sleep(200);
    const after = registry.get('default').state();
    assert.equal(after.messages.length, before.messages.length, '未知命令不得产生任何消息');
    assert.equal(
      registry.get('default').runner.log.read().some((event) => event.type === 'mail.message'),
      false,
      '不得留下投递给 Agent 的邮件记录',
    );
  });
});

// @spec CMD-006
test('命令完全不依赖模型：脚本模型下也能跑通全部命令', () => {
  const root = tempDir('nomodel');
  const registry = makeRegistry(root, { script: [{ text: '不该被调用', done: true }] });
  const session = registry.get('default');

  for (const text of ['/help', '/list', '/whoami', '/files', '/history list', '/clear', '/new 测试']) {
    const result = runCommand(text, { session, registry });
    assert.equal(result.ok, true, `${text} 应当成功：${result.error ?? ''}`);
  }
  // 全程没有产生任何投递给 Agent 的消息
  assert.equal(session.runner.log.read().some((event) => event.type === 'mail.message'), false);
});

// @spec CMD-007
test('参数处理明确：/switch 缺参数报错，/new 以剩余文本为标题', () => {
  const root = tempDir('args');
  const registry = makeRegistry(root);
  const session = registry.get('default');

  const missing = runCommand('/switch', { session, registry });
  assert.equal(missing.ok, false);
  assert.match(String(missing.error), /用法/);

  const badId = runCommand('/switch ../../etc', { session, registry });
  assert.equal(badId.ok, false);

  const created = runCommand('/new 营收 分析 报告', { session, registry });
  assert.equal(created.ok, true);
  assert.match(String(created.output), /营收 分析 报告/);

  const unknown = runCommand('/switch nope', { session, registry });
  assert.equal(unknown.ok, false);
  assert.match(String(unknown.error), /没有这个对话/);
});

// @spec CMD-007
test('parseCommand 只认行首斜杠，其余当普通消息', () => {
  assert.equal(parseCommand('你好'), undefined);
  assert.equal(parseCommand('问一下 /help 是什么意思'), undefined, '斜杠不在行首就当普通消息');
  assert.deepEqual(parseCommand('  /help'), { name: 'help', args: '' }, '行首空格宽容掉，避免手滑');
  assert.deepEqual(parseCommand('/help'), { name: 'help', args: '' });
  assert.deepEqual(parseCommand('/SWITCH default'), { name: 'switch', args: 'default' });
  assert.deepEqual(parseCommand('/new  a  b '), { name: 'new', args: 'a  b' });
  assert.deepEqual(parseCommand('/'), { name: '', args: '' });
});

// 顺带：EventLog 在对话目录下的落点符合预期
void EventLog;

// @spec CLI-013
test('清空边界必须分别作用于两份日志：宿主 seq 涨得快也不能吃掉子进程的回复', async () => {
  const dir = tempDir('boundary');
  const log = new EventLog({ dir: path.join(dir, 'events') });
  const session = new ClientSession({
    dir,
    log,
    lead: { script: [{ text: '答复一', done: true }, { text: '答复二', done: true }] },
  });

  const waitFor = async (text: string): Promise<void> => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (session.state().messages.some((item) => item.body.includes(text))) return;
      await sleep(50);
    }
  };

  try {
    await session.send('第一问');
    await waitFor('答复一');
    assert.equal(session.state().messages.some((item) => item.body.includes('答复一')), true);

    // 把宿主日志的 seq 推高：真模型下一轮会产生大量宿主事件，宿主号段远快于子进程
    for (let i = 0; i < 80; i += 1) log.append({ type: 'noise', i });

    session.clear();
    await session.send('第二问');
    await waitFor('答复二');

    const messages = session.state().messages;
    assert.equal(
      messages.some((item) => item.body.includes('答复二')),
      true,
      `清空之后再来的回复必须还在（两份日志的 seq 是独立号段，不能用同一个边界过滤）：${JSON.stringify(messages.map((m) => m.body.slice(0, 12)))}`,
    );
    assert.equal(messages.some((item) => item.body.includes('答复一')), false, '清空前的回复该被清掉');
  } finally {
    await session.close();
  }
});
