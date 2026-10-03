import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BrowserHost, MAX_EVENT_BYTES, MAX_HTML_BYTES } from '../src/browser/document.ts';
import { BOOTSTRAP_SCRIPT, BRIDGE_CHANNEL, OFFLINE_CSP, composeDocument } from '../src/browser/bootstrap.ts';
import { createHostTools } from '../src/orchestrator/host-tools.ts';
import type { HostTool, HostRuntime } from '../src/orchestrator/host-tools.ts';
import { ConversationRegistry } from '../src/server/conversations.ts';
import { ViewDocument } from '../src/surface/document.ts';
import { SurfaceIngest } from '../src/surface/ingest.ts';
import { TaskBoard } from '../src/taskboard/board.ts';
import { Mailbox } from '../src/mailbox/mailbox.ts';
import { ApprovalGate } from '../src/kernel/approval.ts';
import { EventLog } from '../src/eventlog/log.ts';
import { ClientSession } from '../src/server/session.ts';
import { startServer } from '../src/server/http-server.ts';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agent-client-browser-${prefix}-`));
}

function bridgeMessage(extra: Record<string, unknown>): Record<string, unknown> {
  return { __ac: 1, channel: BRIDGE_CHANNEL, ...extra };
}

// @spec BROWSER-001
test('render 独立渲染任意 HTML：版本号自成一路，不影响 View Spec 界面文档', () => {
  const browser = new BrowserHost();
  const document = new ViewDocument();
  const ingest = new SurfaceIngest({ document });

  // 先让界面文档前进一版，证明两条线互不干扰
  const surfaceResult = ingest.ingest({
    scope: 'surface.main',
    op: 'upsert',
    spec: { type: 'text', text: '来自 View Spec' },
  });
  assert.equal(surfaceResult.ok, true);
  const surfaceVersion = document.snapshot().version;

  const first = browser.render({ html: '<h1>营收看板</h1>', title: '营收' });
  assert.equal(first.ok, true);
  const second = browser.render({ html: '<p>第二版</p>' });
  assert.equal(second.ok, true);
  assert.equal(second.ok === true && second.version, 2, '浏览器版本号独立递增');
  assert.equal(second.ok === true && second.title, '未命名文档', '没给标题要有默认值');

  assert.equal(document.snapshot().version, surfaceVersion, '浏览器渲染不得推进 View Spec 版本');
  assert.deepEqual(document.scopes(), ['surface.main'], 'View Spec 的 scope 不受浏览器影响');
  assert.equal(document.getScope('surface.main')?.type, 'text');

  const current = browser.current();
  assert.equal(current?.version, 2);
  assert.match(String(current?.html), /第二版/);
  assert.equal(browser.version(), 2);
});

// @spec BROWSER-002
test('空 HTML / 非字符串 / 超过字节上限一律拒绝，错误码明确', () => {
  const browser = new BrowserHost();

  const empty = browser.render({ html: '   ' });
  assert.equal(empty.ok === false && empty.code, 'INVALID_ARGS');

  const wrongType = browser.render({ html: 42 as unknown as string });
  assert.equal(wrongType.ok === false && wrongType.code, 'INVALID_ARGS');

  const tooLarge = browser.render({ html: 'x'.repeat(MAX_HTML_BYTES + 1) });
  assert.equal(tooLarge.ok === false && tooLarge.code, 'HTML_TOO_LARGE');
  if (tooLarge.ok === false) assert.match(tooLarge.reason, new RegExp(String(MAX_HTML_BYTES)));

  assert.equal(browser.current(), undefined, '被拒绝的渲染不该产生文档');
  assert.equal(browser.version(), 0);
});

// @spec BROWSER-003
test('组合文档：碎片补成完整文档、完整文档就地注入，两种情况都带桥', () => {
  const fragment = composeDocument({ html: '<button data-ac-emit="导出">导出</button>', title: '报表' });
  assert.ok(fragment.startsWith('<!doctype html>'), '碎片要补成完整文档');
  assert.ok(fragment.includes('<title>报表</title>'));
  assert.ok(fragment.includes('data-agent-client-bridge'), '必须注入桥脚本');
  assert.ok(fragment.includes(BOOTSTRAP_SCRIPT));
  assert.ok(fragment.includes('data-ac-emit="导出"'));

  const full = composeDocument({
    html: '<!doctype html><html><head><title>作者写的标题</title></head><body><p>hi</p></body></html>',
    title: '不该覆盖',
  });
  assert.ok(full.includes('<title>作者写的标题</title>'), '完整文档要尊重作者结构，不覆盖标题');
  assert.ok(full.includes('<p>hi</p>'));
  assert.ok(full.includes('data-agent-client-bridge'));
  // 桥必须落在 </body> 之前，否则文档里的脚本可能晚于桥执行
  assert.ok(full.indexOf('data-agent-client-bridge') < full.indexOf('</body>'));

  // 标题里的 HTML 必须转义，不能让它撑破文档结构
  const escaped = composeDocument({ html: '<p>x</p>', title: '"><script>alert(1)</script>' });
  assert.equal(escaped.includes('<script>alert(1)</script>'), false);
});

// @spec BROWSER-004
test('默认断网（CSP），显式 allowNetwork 才放开', () => {
  const offline = composeDocument({ html: '<p>x</p>' });
  assert.ok(offline.includes(OFFLINE_CSP));
  assert.match(offline, /default-src 'none'/);
  assert.match(offline, /script-src 'unsafe-inline'/);

  const online = composeDocument({ html: '<p>x</p>', allowNetwork: true });
  assert.equal(online.includes('Content-Security-Policy'), false, '放行网络时不该再注入离线 CSP');
  assert.ok(online.includes('data-agent-client-bridge'), '放行网络也要保留桥');

  // 完整文档里也要注入 CSP，且尽量靠前
  const full = composeDocument({ html: '<!doctype html><html><head><title>t</title></head><body>x</body></html>' });
  assert.ok(full.includes(OFFLINE_CSP));
  assert.ok(full.indexOf('Content-Security-Policy') < full.indexOf('<title>'));
});

// @spec BROWSER-005
test('事件入口硬校验：kind 白名单 / name / 超限，逐条拒绝', () => {
  const browser = new BrowserHost();

  assert.equal(browser.acceptEvent('不是对象').ok, false);
  assert.equal(browser.acceptEvent(null).ok, false);
  assert.equal(browser.acceptEvent({}).ok, false);
  assert.equal(browser.acceptEvent({ kind: 'emit', name: 'x' }).ok, true, '合法事件要放过');

  // kind 白名单
  const unknown = browser.acceptEvent({ kind: 'exec', name: 'x' });
  assert.equal(unknown.ok === false && unknown.code, 'BAD_EVENT');

  // emit 必须有 name
  assert.equal(browser.acceptEvent({ kind: 'emit' }).ok, false);
  assert.equal(browser.acceptEvent({ kind: 'emit', name: '   ' }).ok, false);
  assert.equal(browser.acceptEvent({ kind: 'emit', name: 'x'.repeat(129) }).ok, false);

  // payload 必须可序列化且不超限
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(browser.acceptEvent({ kind: 'emit', name: 'x', payload: circular }).ok, false);
  const huge = browser.acceptEvent({ kind: 'emit', name: 'x', payload: { blob: 'y'.repeat(MAX_EVENT_BYTES) } });
  assert.equal(huge.ok === false && huge.code, 'BAD_EVENT');

  // log / error 必须有 text
  assert.equal(browser.acceptEvent({ kind: 'log' }).ok, false);
  assert.equal(browser.acceptEvent({ kind: 'error', text: 'boom' }).ok, true);
  assert.equal(browser.acceptEvent({ kind: 'ready', title: '报表' }).ok, true);

  // 被拒绝的不能进事件流
  assert.deepEqual(browser.events().map((event) => event.kind), ['emit', 'error', 'ready']);
});

// @spec BROWSER-005
test('窗口消息形态多一层信封校验：缺 __ac / channel 不对一律拒绝', () => {
  const browser = new BrowserHost();

  // 信封校验**只在窗口边界**：HTTP 入口按契约只收事件本体
  assert.equal(browser.acceptBridge({ kind: 'emit', name: 'x' }).ok, false, '缺桥标记要拒');
  assert.equal(browser.acceptBridge({ __ac: 1, channel: 'evil', kind: 'emit', name: 'x' }).ok, false);
  assert.equal(browser.acceptBridge({ __ac: 1, channel: BRIDGE_CHANNEL, kind: 'emit', name: 'x' }).ok, true);
  // 过了信封仍要走同一套本体校验
  assert.equal(browser.acceptBridge({ __ac: 1, channel: BRIDGE_CHANNEL, kind: 'exec', name: 'x' }).ok, false);

  // HTTP 入口（acceptEvent）不看信封：客户端按冻结契约只发 {kind,name,payload}
  assert.equal(
    browser.acceptEvent({ kind: 'emit', name: '页面已加载', payload: { ready: true } }).ok,
    true,
    '客户端剥掉信封之后必须仍能被受理，否则整条回流链路断在宿主这一侧',
  );
});

// @spec BROWSER-006
test('声明式交互：桥监听 click 与 submit，读取 data-ac-emit / data-ac-payload', () => {
  assert.match(BOOTSTRAP_SCRIPT, /'click'/);
  assert.match(BOOTSTRAP_SCRIPT, /'submit'/);
  assert.match(BOOTSTRAP_SCRIPT, /data-ac-emit/);
  assert.match(BOOTSTRAP_SCRIPT, /data-ac-payload/);
  // 提交要把表单字段一起带上，否则「人类填了什么」就丢了
  assert.match(BOOTSTRAP_SCRIPT, /fields/);
  assert.match(BOOTSTRAP_SCRIPT, /querySelectorAll\('\[name\]'\)/);
  // 捕获阶段监听：文档里 stopPropagation 挡不住上报
  assert.match(BOOTSTRAP_SCRIPT, /true,\s*\n\s*\);/);
});

// @spec BROWSER-007
test('命令式交互与日志：AgentClient.emit/log 与 console/error 转发', () => {
  assert.match(BOOTSTRAP_SCRIPT, /window\.AgentClient = \{/);
  assert.match(BOOTSTRAP_SCRIPT, /emit: function \(name, payload\)/);
  assert.match(BOOTSTRAP_SCRIPT, /log: function \(\)/);
  for (const level of ['log', 'info', 'warn', 'error']) {
    assert.ok(BOOTSTRAP_SCRIPT.includes(`'${level}'`), `console.${level} 应当被转发`);
  }
  assert.match(BOOTSTRAP_SCRIPT, /window\.addEventListener\("error"/);
  assert.match(BOOTSTRAP_SCRIPT, /unhandledrejection/);
  // 每一次 postMessage 都必须被 try/catch 包住：文档里的异常不该把宿主搞挂
  assert.match(BOOTSTRAP_SCRIPT, /try \{\s*\n\s*var out = \{ __ac: MARK/);
  // 非对象 payload 要包成 {value:…}，否则过不了严格的帧校验
  assert.match(BOOTSTRAP_SCRIPT, /function normalize\(value\)/);
  assert.match(BOOTSTRAP_SCRIPT, /return \{ value: value === undefined \? null : value \};/);
});

// @spec BROWSER-008
test('浏览器面板的入口是「打开 HTML 文件」：非 HTML / 不存在 / 越界都被拒', async () => {
  const root = tempDir('open');
  const registry = new ConversationRegistry({
    root,
    open: (id, dir) => new ClientSession({ dir, id, lead: { script: [{ text: 'ok', done: true }] } }),
  });
  const session = registry.get('default');
  session.runner.workspace.write({ path: 'report.html', content: '<h1>营收</h1>' });
  session.runner.workspace.write({ path: 'notes.md', content: '# 笔记' });

  const opened = session.openInBrowser('report.html');
  assert.equal(opened.ok, true, `打开 HTML 应当成功：${opened.error ?? ''}`);
  assert.equal(opened.path, 'report.html');

  const doc = session.state().browser;
  assert.ok(doc, '打开之后状态里必须有浏览器文档');
  assert.equal(doc?.path, 'report.html', '要记下来源文件，界面上才显示得出"正在看哪个文件"');
  assert.equal(doc?.title, 'report.html');
  assert.match(String(doc?.html), /data-agent-client-bridge/, '发给客户端的必须是组合好的文档');

  // 只渲染 HTML：别的文件不该进浏览器（它们是给人读的文本）
  const notHtml = session.openInBrowser('notes.md');
  assert.equal(notHtml.ok, false);
  assert.match(String(notHtml.error), /NOT_HTML/);

  const missing = session.openInBrowser('nope.html');
  assert.equal(missing.ok, false);
  assert.match(String(missing.error), /NOT_FOUND/);

  const escape = session.openInBrowser('../../etc/passwd.html');
  assert.equal(escape.ok, false);
  assert.match(String(escape.error), /PATH_ESCAPE/);

  const empty = session.openInBrowser('');
  assert.equal(empty.ok, false);
  assert.match(String(empty.error), /BAD_PATH/);

  // 打开新文件会让版本号前进（同一个面板，换一份文档）
  session.runner.workspace.write({ path: 'second.html', content: '<p>二</p>' });
  const second = session.openInBrowser('second.html');
  assert.equal(second.ok, true);
  assert.equal(second.version, 2);
  assert.equal(session.state().browser?.path, 'second.html');
});

// @spec BROWSER-013
test('Agent 不再有「往界面塞 HTML」的工具：browser.render 已移除', () => {
  const names = createHostTools().map((tool) => tool.name);
  assert.equal(names.includes('browser.render'), false, 'browser.render 必须从工具表里消失');
  assert.equal(
    names.some((name) => name.startsWith('browser.')),
    false,
    '浏览器不该再有任何 Agent 可调的工具——入口只有"打开人指定的 HTML 文件"',
  );
  // 能力还在：渲染引擎、桥、沙箱一个都没少
  const browser = new BrowserHost();
  assert.equal(browser.render({ html: '<p>hi</p>', title: 't' }).ok, true);
  assert.match(String(browser.current()?.html), /data-agent-client-bridge/);

  // 子进程也不该再声明这个工具
  const source = fs.readFileSync(new URL('../src/runtime/agent-main.ts', import.meta.url), 'utf8');
  assert.equal(source.includes('browser.render'), false, '子进程的工具自述里不许再有它');
});

// @spec BROWSER-009
test('人类交互回流：合法事件落日志并投给 Lead，非法事件 400 且不落日志', async () => {
  const session = new ClientSession({
    dir: tempDir('event'),
    lead: { script: [{ text: '收到你的点击', done: true }] },
  });
  const server = await startServer({ session, port: 0 });

  try {
    // 非法：缺桥标记 → 400，且不写事件日志
    const rejected = await fetch(`${server.url}/api/browser/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'emit', name: 'x', payload: { blob: 'z'.repeat(20000) } }),
    });
    assert.equal(rejected.status, 400);
    const rejectedBody = (await rejected.json()) as { ok: boolean; error?: string };
    assert.equal(rejectedBody.ok, false);
    assert.match(String(rejectedBody.error), /BAD_EVENT/);
    assert.equal(
      session.state().events.some((event) => event.type === 'browser.event'),
      false,
      '被拒绝的事件不得落日志',
    );

    // 合法：走完整链路
    const accepted = await fetch(`${server.url}/api/browser/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // 关键：用**客户端真实会发的形状**（剥掉信封），而不是桥的原始消息
      body: JSON.stringify({ kind: 'emit', name: '导出 CSV', payload: { fmt: 'csv' } }),
    });
    assert.equal(accepted.status, 200);

    const logged = session.state().events.filter((event) => event.type === 'browser.event');
    assert.equal(logged.length, 1, '人类交互必须留痕');
    assert.match(logged[0]?.summary ?? '', /导出 CSV/);

    // 并且要真的送到 Lead 手上
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (session.state().messages.some((item) => item.body.includes('浏览器交互'))) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(
      session.state().messages.some((item) => item.body.includes('导出 CSV')),
      true,
      'Lead 必须收到人类在浏览器里的动作，否则它无从反应',
    );
  } finally {
    await server.close();
    await session.close();
  }
});

// @spec BROWSER-012
test('端到端：Agent 写 HTML 文件 → 人打开渲染 → 点击回流给 Agent', async () => {
  const session = new ClientSession({
    dir: tempDir('e2e'),
    lead: {
      script: [
        // 第一轮：Agent 把带交互的界面**写成文件**（不再是往面板里塞 HTML）
        {
          toolCalls: [
            {
              id: 'c1',
              name: 'workspace.write',
              args: { path: 'board.html', content: '<button data-ac-emit="导出">导出</button>' },
            },
          ],
        },
        { text: '已写成 board.html，你在文件里点一下就能看到', done: true },
        // 第二轮：收到人类点击后的回复
        { text: '你点了导出，这就去生成', done: true },
      ],
    },
  });
  const server = await startServer({ session, port: 0 });

  try {
    await fetch(`${server.url}/api/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '给我一个导出按钮' }),
    });

    // 等文件真的落盘
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && session.runner.workspace.list().length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(session.runner.workspace.list().map((file) => file.path), ['board.html']);

    // 人在「文件」里点「在浏览器打开」→ 走 HTTP，与界面同一条路
    const opened = await fetch(`${server.url}/api/browser/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'board.html' }),
    });
    assert.equal(opened.status, 200);

    const doc = session.state().browser;
    assert.equal(doc?.path, 'board.html');
    assert.match(String(doc?.html), /data-ac-emit="导出"/);
    assert.match(String(doc?.html), /data-agent-client-bridge/, '发给客户端的一定是组合好的文档');

    // 桥回流：人在页面里点了那个按钮
    const response = await fetch(`${server.url}/api/browser/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'emit', name: '导出', payload: { fmt: 'csv' } }),
    });
    assert.equal(response.status, 200);

    const deadline2 = Date.now() + 20000;
    while (Date.now() < deadline2) {
      if (session.state().messages.some((item) => item.body.includes('这就去生成'))) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(
      session.state().messages.some((item) => item.body.includes('这就去生成')),
      true,
      'Agent 必须基于人类的点击继续干活',
    );
  } finally {
    await server.close();
    await session.close();
  }
});

// 顺带守住：宿主侧依赖（TaskBoard/Mailbox/ApprovalGate/EventLog）在这场测试里也要能共存
void TaskBoard;
void Mailbox;
void ApprovalGate;
void EventLog;

// @spec BROWSER-010
test('子进程收到 browser.event 帧后，把它作为人类来源的消息注入本轮上下文', async () => {
  const { AgentPool } = await import('../src/kernel/pool.ts');
  const { EventLog } = await import('../src/eventlog/log.ts');
  const { projectConversation } = await import('../src/runtime/conversation.ts');

  const dir = tempDir('child');
  const pool = new AgentPool();
  try {
    const handle = pool.spawn({
      agentId: 'lead',
      logDir: dir,
      env: { AGENT_MODEL: 'demo' },
    });

    const done = new Promise<void>((resolve) => {
      handle.onFrame((frame) => {
        if (frame.t === 'loop.done') resolve();
      });
    });

    // 直接投一条 browser.event 帧，模拟「人类点了导出」
    handle.send({
      t: 'browser.event',
      name: '导出 CSV',
      payload: { fmt: 'csv' },
      source: 'human',
    });
    await done;

    const events = new EventLog({ dir }).read();
    assert.equal(
      events.some((event) => event.type === 'browser.event.received'),
      true,
      '子进程要留下收到浏览器交互的痕迹',
    );

    // 关键：它必须进入对话上下文，且来源是 human（Agent 才会当回事）
    const conversation = projectConversation(events);
    const injected = conversation.find((item) => item.text.includes('浏览器交互'));
    assert.ok(injected, `对话投影里必须有这条交互：${JSON.stringify(conversation.map((item) => item.text))}`);
    assert.equal(injected?.role, 'human', '必须标成人类来源，不能当成系统噪音');
    assert.match(String(injected?.text), /导出 CSV/);
    assert.match(String(injected?.text), /csv/);
  } finally {
    await pool.shutdown();
  }
});
