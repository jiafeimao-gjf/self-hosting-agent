import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COMMAND_HINT_TEXT,
  DEFAULT_CONVERSATION,
  EMPTY_CONVERSATIONS_TEXT,
  EMPTY_FILES_TEXT,
  TRUNCATED_TEXT,
  canDeleteConversation,
  commandActionOf,
  commandRequest,
  createConversationSwitcher,
  createWorkspacePanel,
  deleteConversationUrl,
  formatBytes,
  formatMtime,
  isCommandText,
  normalizeCommandResult,
  normalizeConversationList,
  normalizeWorkspaceFile,
  normalizeWorkspaceList,
  renderCommandResult,
  renderConversationOptions,
  renderFileList,
  renderFileRow,
  routeForText,
  streamUrl,
  withConversation,
  workspaceFileUrl,
  workspaceUrl,
} from '../src/client/conversations.js';

/**
 * SPEC-020 多对话 / `/` 命令 + SPEC-021 工作空间「文件」页签的客户端测试。
 *
 * 纯逻辑（路由拼装 / 列表归一化 / 命令结果渲染 / 文件模型）直接 import 断言；
 * 控制器用假 DOM + 假 request 做行为测试；DOM 接线沿用既有 UI-006 / BROWSER-011 的
 * 做法：读源码结构断言。`conversations.js` 在 Node 里 import 无副作用。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.join(here, '..', 'src', 'client');

function readClient(name: string): string {
  return fs.readFileSync(path.join(clientDir, name), 'utf8');
}

const indexHtml = readClient('index.html');
const styleCss = readClient('style.css');
const appJs = readClient('app.js');

interface AppModule {
  shouldApplySurface(input: { nextHtml: unknown; prevHtml: unknown; painted: unknown; force?: boolean }): boolean;
  MAX_COMMAND_LOG: number;
}

/** app.js 是浏览器端 ESM：Node 里 import 无副作用，纯函数可直接断言 */
const appUrl = new URL('../src/client/app.js', import.meta.url).href;
const app = (await import(appUrl)) as unknown as AppModule;

interface HttpResult {
  status: number;
  ok: boolean;
  data: unknown;
}

/** 假 request：记录每次调用的路径 / 方法 / 请求体，按 handler 返回固定响应 */
function fakeRequest(handler: (path: string, init?: { method?: string; body?: unknown }) => HttpResult | null) {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const request = async (p: string, init?: { method?: string; body?: unknown }) => {
    calls.push({ path: p, method: init?.method ?? 'GET', body: init?.body });
    return handler(p, init);
  };
  return { calls, request };
}

// @spec CONV-004
test('对话切换器：列出全部对话并标出 active，新建 / 删除都走冻结契约', async () => {
  // 归一化：active 标出、每条带标题与消息数、默认对话不可删
  const list = normalizeConversationList({
    ok: true,
    active: 'c1',
    conversations: [
      { id: 'default', title: '默认对话', messages: 12 },
      { id: 'c1', title: '预算改造', messages: 3, createdAt: '2026-10-02T00:00:00.000Z' },
      { id: 'bad id', title: '坏 id' },
    ],
  });
  assert.equal(list.active, 'c1');
  assert.equal(list.conversations.length, 3);
  assert.equal(list.conversations[0].deletable, false, '默认对话不可删');
  assert.equal(list.conversations[1].deletable, true);
  assert.equal(list.conversations[2].id, DEFAULT_CONVERSATION, '非法 id 退化为 default，不拼进 URL');
  assert.equal(list.conversations[0].messages, 12);

  const options = renderConversationOptions(list);
  assert.ok(options.includes('value="c1" selected'), 'active 必须选中');
  assert.ok(options.includes('默认对话（12 条）'), '下拉要显示标题与消息数');
  assert.ok(options.includes('预算改造（3 条）'));
  assert.ok(
    renderConversationOptions({ conversations: [] }).includes(EMPTY_CONVERSATIONS_TEXT),
    '一个对话都没有时给空态选项，而不是空下拉',
  );

  // 删除：默认对话不可删；地址是 /api/conversations/<id>
  assert.equal(canDeleteConversation('default'), false);
  assert.equal(canDeleteConversation('c2'), true);
  assert.equal(deleteConversationUrl('c2'), '/api/conversations/c2');

  // 控制器：load → create → remove（假 DOM + 假 request）
  let payload: unknown = {
    ok: true,
    active: 'c1',
    conversations: [
      { id: 'default', title: '默认对话', messages: 12 },
      { id: 'c1', title: '预算改造', messages: 3 },
    ],
  };
  const select: any = { innerHTML: '', value: '' };
  const removeButton: any = { disabled: false };
  const status: any = { textContent: '' };
  const switched: string[] = [];
  const { calls, request } = fakeRequest((p, init) => {
    const method = init?.method ?? 'GET';
    if (p === '/api/conversations' && method === 'GET') return { status: 200, ok: true, data: payload };
    if (p === '/api/conversations' && method === 'POST') {
      return { status: 200, ok: true, data: { ok: true, conversation: { id: 'c2', title: '新对话' } } };
    }
    if (p === '/api/conversations/c2' && method === 'DELETE') return { status: 200, ok: true, data: { ok: true } };
    return { status: 404, ok: false, data: { error: 'not found' } };
  });
  const switcher = createConversationSwitcher({
    nodes: { select, create: { disabled: false }, remove: removeButton, status },
    request,
    onSwitch: (id) => switched.push(id),
  });

  const loaded = await switcher.load();
  assert.equal(loaded?.active, 'c1');
  assert.equal(switcher.getActive(), 'c1');
  assert.ok(select.innerHTML.includes('预算改造'));
  assert.equal(removeButton.disabled, false, '非默认对话可以删');

  // 新建：body 形状 `{title}`，返回后切到新对话
  payload = {
    ok: true,
    active: 'c2',
    conversations: [
      { id: 'default', title: '默认对话', messages: 12 },
      { id: 'c1', title: '预算改造', messages: 3 },
      { id: 'c2', title: '新对话', messages: 0 },
    ],
  };
  const created = await switcher.create('新对话');
  assert.equal(created?.id, 'c2');
  const posted = calls.find((call) => call.method === 'POST');
  assert.deepEqual(posted?.body, { title: '新对话' });
  assert.ok(switched.includes('c2'), '新建后必须切到新对话');

  // 删除：走 DELETE /api/conversations/<id>，删完跟着服务端的 active 走
  payload = { ok: true, active: 'default', conversations: [{ id: 'default', title: '默认对话', messages: 12 }] };
  assert.equal(await switcher.remove('c2'), true);
  assert.equal(calls.find((call) => call.method === 'DELETE')?.path, '/api/conversations/c2');
  assert.equal(switcher.getActive(), 'default');
  assert.equal(removeButton.disabled, true, '默认对话的删除按钮必须禁用');

  // 默认对话不可删：连请求都不发
  const before = calls.length;
  assert.equal(await switcher.remove('default'), false);
  assert.equal(calls.length, before);

  // DOM 与接线
  for (const id of ['conversation-select', 'conversation-new', 'conversation-delete', 'conversation-status']) {
    assert.ok(indexHtml.includes(`id="${id}"`), `index.html 缺少 #${id}`);
  }
  assert.ok(indexHtml.includes('data-panel-tab="files"'), '右栏要有第三个「文件」页签');
  assert.ok(styleCss.includes('.conversation-switcher'));
  assert.ok(styleCss.includes('#conversation-delete:disabled'));
  assert.ok(appJs.includes('createConversationSwitcher('), 'app.js 只负责实例化切换器');
  assert.ok(appJs.includes('switcher.load()'));
  assert.ok(appJs.includes('switcher.create('));
  assert.ok(appJs.includes('switcher.remove('));
  assert.ok(appJs.includes('switcher.switchTo('));
});

// @spec CONV-006
test('每个对话一条独立 SSE：切换时关旧流、按新 id 重开，事件不串扰', () => {
  // 每个 id 一条独立地址：A 的流不可能收到 B 的事件
  assert.equal(streamUrl('default'), '/api/stream');
  assert.equal(streamUrl('c1'), '/api/stream?conversation=c1');
  assert.equal(streamUrl('c2'), '/api/stream?conversation=c2');
  assert.notEqual(streamUrl('c1'), streamUrl('c2'));

  // 「其余所有路由都接受 ?conversation=<id>」：省略即 default（向后兼容）
  assert.equal(withConversation('/api/state', 'c1'), '/api/state?conversation=c1');
  assert.equal(withConversation('/api/message', 'default'), '/api/message');
  assert.equal(withConversation('/api/command', 'c1'), '/api/command?conversation=c1');
  assert.equal(workspaceUrl('c1'), '/api/workspace?conversation=c1');
  // 非法 id 绝不拼进 URL（防路径注入）
  assert.equal(withConversation('/api/state', '../etc'), '/api/state');
  assert.equal(withConversation('/api/state', 'c1/../../x'), '/api/state');
  assert.equal(streamUrl('C1'), '/api/stream');

  // app.js：切换即「关旧流 + 按新 id 重开」
  assert.ok(appJs.includes('function closeStream('));
  assert.ok(appJs.includes('currentStream.close()'), '旧 EventSource 必须显式关闭，不留泄漏');
  assert.ok(appJs.includes('function openStream('));
  assert.ok(appJs.includes("new EventSource('/api/stream')"), '默认对话仍走省略形态');
  assert.ok(appJs.includes('new EventSource(streamUrl(activeConversation))'), '非默认对话带 conversation');
  assert.ok(appJs.includes('closeStream();'), '开新流之前先关旧流');
  assert.ok(
    appJs.includes('currentStream = source'),
    '当前流由 openStream 按对话持有 —— 不能再是一条启动时固定的流',
  );
  assert.ok(appJs.includes('switching = true'), '切换要有互斥，避免两股流同时活着');
  // 新的流必须把全部事件都重新订阅上（切完对话功能不能残废）
  for (const type of ['state', 'frame', 'document', 'done', 'client.changed', 'browser', 'settings']) {
    assert.ok(appJs.includes(`addEventListener('${type}'`), `新流缺少 ${type} 事件处理`);
  }
});

// @spec CONV-007
test('切走再切回：本地绘制缓存作废并重新拉取该对话的 state，界面文档原样重画', async () => {
  // 行为侧：同一份 html 在「缓存已作废」时必须重画——切换就是靠这条生效的
  assert.equal(app.shouldApplySurface({ nextHtml: '<p>v1</p>', prevHtml: '<p>v1</p>', painted: true }), false);
  assert.equal(
    app.shouldApplySurface({ nextHtml: '<p>v1</p>', prevHtml: '', painted: false }),
    true,
    '切回旧对话时，内容相同的界面文档也必须重画',
  );

  // 控制器：切到 B 再切回 A，每次都上报，下拉选中态跟着走
  const select: any = { innerHTML: '', value: '' };
  const switched: string[] = [];
  const switcher = createConversationSwitcher({
    nodes: { select, remove: { disabled: false }, status: { textContent: '' } },
    request: async () => ({
      status: 200,
      ok: true,
      data: {
        ok: true,
        active: 'default',
        conversations: [
          { id: 'default', title: '默认对话', messages: 1 },
          { id: 'c2', title: '另一个对话', messages: 4 },
        ],
      },
    }),
    onSwitch: (id) => switched.push(id),
  });
  await switcher.load();
  switcher.switchTo('c2');
  switcher.switchTo('default');
  assert.deepEqual(switched, ['c2', 'default']);
  assert.equal(switcher.getActive(), 'default');
  assert.equal(select.value, 'default');

  // 接线：切换 = 关旧流 + 重开流 + 重新拉该对话的 state + 三个区域与文件列表全部重画
  assert.ok(appJs.includes('async function switchConversation('));
  assert.ok(appJs.includes("requestJson(scoped('/api/state')"), '切换后要按新对话拉一次 state');
  assert.ok(appJs.includes("state.html = ''"), '本地界面缓存必须作废');
  assert.ok(appJs.includes('state.painted = false'), '否则相同文档不会重画');
  assert.ok(appJs.includes('dom.messages.innerHTML = '), '对话流整体重建');
  assert.ok(appJs.includes('browserPanel.applyDocument(null)'), '浏览器文档也要重画，不沿用旧对话的');
  assert.ok(appJs.includes('workspacePanel.clear()'));
  assert.ok(appJs.includes('await workspacePanel.reload('));
  assert.equal(/location\.reload|location\.href =/.test(appJs), false, '切换绝不刷新页面');
});

// @spec CMD-001
test('/help 走命令通道，output 渲染成与人类 / Agent 消息不同款的系统消息', () => {
  assert.equal(isCommandText('/help'), true);
  assert.equal(routeForText('/help'), 'command');
  assert.equal(routeForText('  /help  '), 'command');
  assert.equal(routeForText('帮我 /help 一下'), 'message', '只有开头是 / 才算命令');
  assert.deepEqual(commandRequest('/help'), { text: '/help' });

  const html = renderCommandResult(
    { ok: true, command: 'help', output: '/help /clear /history /new /list /switch /files /cat' },
    '/help',
  );
  assert.ok(html.startsWith('<li class="msg msg-system is-ok"'), `系统消息形状不对：${html}`);
  assert.ok(html.includes('data-command="help"'));
  assert.ok(html.includes('cmd-echo'), '要回显人类的原始输入');
  assert.ok(html.includes('cmd-output'));
  assert.ok(html.includes('/clear'));
  assert.ok(styleCss.includes('.msg-system'), '系统消息必须与人类 / Agent 消息不同色');

  // 命令结果的转义：output 是不可信文本
  const payload = '<img src=x onerror=alert(1)>';
  const escaped = renderCommandResult({ ok: true, command: 'help', output: payload }, '/help');
  assert.equal(escaped.includes('<img src=x'), false);
  assert.ok(escaped.includes('&lt;img src=x onerror=alert(1)&gt;'));

  // app.js：命令走 /api/command，普通输入仍走 /api/message（前缀路由只有一处）
  assert.ok(appJs.includes("scoped('/api/command')"));
  assert.ok(appJs.includes("scoped('/api/message')"));
  assert.ok(appJs.includes('if (isCommandText(text))'));
  assert.ok(appJs.includes('renderCommandResult('));
  assert.ok(appJs.includes('appendMessage(html)'), '命令结果要进对话流');
  // 输入以 / 开头时的可见提示
  assert.ok(indexHtml.includes('id="command-hint"'));
  assert.ok(indexHtml.includes(COMMAND_HINT_TEXT));
  assert.ok(appJs.includes('updateCommandHint'));
  assert.ok(appJs.includes("addEventListener('input', updateCommandHint)"));
  assert.ok(styleCss.includes('.command-hint'));
});

// @spec CMD-004
test('命令 action：switch / created 切到目标对话，cleared 只重画当前对话', async () => {
  assert.deepEqual(commandActionOf({ type: 'switch', conversation: 'c2' }), { type: 'switch', conversation: 'c2' });
  assert.deepEqual(commandActionOf({ type: 'created', conversation: 'c7' }), { type: 'created', conversation: 'c7' });
  assert.deepEqual(commandActionOf({ type: 'cleared' }), { type: 'cleared', conversation: '' });
  assert.equal(commandActionOf({ type: 'switch' }), null, 'switch 没有目标就当没有 action，不许切到空');
  assert.equal(commandActionOf({ type: 'switch', conversation: '../x' }), null);
  assert.equal(commandActionOf({ type: 'nope', conversation: 'c1' }), null);
  assert.equal(commandActionOf(null), null);

  const result = normalizeCommandResult({
    ok: true,
    command: 'new',
    output: '已新建对话 c7',
    action: { type: 'created', conversation: 'c7' },
  });
  assert.equal(result.action?.type, 'created');
  assert.equal(result.action?.conversation, 'c7');
  assert.ok(renderCommandResult(result, '/new 预算').includes('已新建对话 c7'));

  // app.js 按 action 分派：switch / created → switchConversation；cleared → redrawAll
  assert.ok(appJs.includes("action.type === 'switch' || action.type === 'created'"));
  assert.ok(appJs.includes('await switchConversation(action.conversation)'));
  assert.ok(appJs.includes("action.type === 'cleared'"));
  assert.ok(appJs.includes('runCommand(text)'));
  // 切换是重开流，不是刷新页面
  assert.ok(appJs.includes('closeStream();'));
});

// @spec CMD-005
test('未知命令绝不发给模型：任何 / 前缀都走 /api/command，失败结果也渲染成可见系统消息', () => {
  for (const text of ['/bogus', '/switch', '/', '/unknown a b']) {
    assert.equal(isCommandText(text), true);
    assert.equal(routeForText(text), 'command', `${text} 必须走命令通道`);
  }
  // 参数原样交给服务端（客户端不解析命令，保持「哑」）
  assert.deepEqual(commandRequest('/new a b c'), { text: '/new a b c' });

  const failed = renderCommandResult(
    { ok: false, command: 'bogus', output: '未知命令：bogus（用 /help 看看有哪些）' },
    '/bogus',
  );
  assert.ok(failed.includes('is-fail'), '失败要有可见的失败样式');
  assert.ok(failed.includes('未知命令'));
  assert.ok(failed.includes('bogus'));
  // 服务端连 output 都没给：也要有可见文案，绝不白屏
  assert.ok(renderCommandResult({ ok: false, command: 'bogus' }, '/bogus').includes('命令执行失败'));
  // 服务端把原因放在 error（真实形状：`/api/command` 失败是 400 + {ok:false,error}），不能丢
  const usage = renderCommandResult({ ok: false, command: 'switch', output: '', error: '用法：/switch <id>' }, '/switch');
  assert.ok(usage.includes('用法：/switch &lt;id&gt;'), '失败原因必须显示出来');
  assert.equal(normalizeCommandResult({ ok: false, error: 'NOT_A_COMMAND' }).error, 'NOT_A_COMMAND');

  // send() 的分支顺序：命令在发消息之前收口，命令文本永远到不了 /api/message
  const sendBody = appJs.slice(appJs.indexOf('function send()'), appJs.indexOf('dom.composer.addEventListener'));
  assert.ok(sendBody.includes('isCommandText(text)'));
  assert.ok(sendBody.includes('runCommand(text)'));
  assert.ok(sendBody.includes('return;'));
  assert.ok(
    sendBody.indexOf('runCommand(text)') < sendBody.indexOf("post(scoped('/api/message')"),
    '命令分支必须排在 /api/message 之前',
  );
});

// @spec WS-010
test('文件页签：列表只给元信息，点击才动态加载内容，纯文本渲染且空态 / 错误态 / 截断态可见', async () => {
  // 列表归一化：**绝不带 content**（WS-007 / WS-010 的动态加载）
  const list = normalizeWorkspaceList({
    ok: true,
    root: '/ws',
    files: [
      { path: 'a.md', bytes: 120, mtime: '2026-10-02T13:00:00.000Z', content: '不该出现在列表里的秘密' },
      { path: 'sub/b.json', bytes: 2048, mtime: 'bad-time' },
    ],
  });
  assert.equal(list.files.length, 2);
  assert.equal(list.root, '/ws');
  assert.equal(Object.prototype.hasOwnProperty.call(list.files[0], 'content'), false, '列表只给元信息');
  const rows = renderFileList(list);
  assert.equal(rows.includes('不该出现在列表里的秘密'), false, '列表 HTML 绝不能夹带文件内容');
  assert.ok(rows.includes('data-file-path="a.md"'));
  assert.ok(rows.includes('120 B'));
  assert.ok(rows.includes('2.0 KB'));
  assert.equal(formatBytes(120), '120 B');
  assert.equal(formatBytes(null), '—');
  assert.equal(formatMtime('bad-time'), 'bad-time');
  // 路径是不可信输入：进 DOM 必须转义
  const evil = renderFileRow({ path: '"><img src=x onerror=alert(1)>', bytes: 1, mtime: '' });
  assert.equal(evil.includes('<img src=x'), false);
  assert.ok(evil.includes('&lt;img src=x onerror=alert(1)&gt;'));

  // 控制器：列表阶段只碰 /api/workspace；内容只在 openFile 时加载
  const listNode: any = { innerHTML: '' };
  const emptyNode: any = { hidden: false, textContent: '' };
  const statusNode: any = { textContent: '', dataset: { tone: '' } };
  let contentText = '';
  const contentNode: any = {
    get textContent() {
      return contentText;
    },
    set textContent(value: string) {
      contentText = value;
    },
    set innerHTML(_value: string) {
      throw new Error('文件内容绝不当 HTML 插入');
    },
  };
  const calls: string[] = [];
  const answers: Record<string, HttpResult> = {
    [workspaceUrl('c1')]: {
      status: 200,
      ok: true,
      data: { ok: true, root: '/ws', files: [{ path: 'a.md', bytes: 120, mtime: '' }] },
    },
    [workspaceFileUrl('c1', 'a.md')]: {
      status: 200,
      ok: true,
      data: { ok: true, path: 'a.md', bytes: 120, content: '第一行\n第二行', truncated: true },
    },
  };
  const panel = createWorkspacePanel({
    nodes: { list: listNode, empty: emptyNode, status: statusNode, content: contentNode },
    request: async (p: string) => {
      calls.push(p);
      return answers[p] ?? { status: 500, ok: false, data: { error: 'boom' } };
    },
  });

  const loaded = await panel.reload('c1');
  assert.equal(loaded?.files.length, 1);
  assert.deepEqual(calls, [workspaceUrl('c1')], '列表阶段绝不能请求文件内容');
  assert.ok(listNode.innerHTML.includes('a.md'));
  assert.equal(emptyNode.hidden, false, '还没点开文件时给提示，而不是一块空白');
  assert.ok(emptyNode.textContent.length > 0);

  // 点击文件：**这时才**加载内容，且只走 textContent
  const file = await panel.openFile('a.md');
  assert.deepEqual(calls, [workspaceUrl('c1'), workspaceFileUrl('c1', 'a.md')]);
  assert.equal(file?.content, '第一行\n第二行');
  assert.equal(contentText, '第一行\n第二行', '内容必须落在 textContent 上');
  assert.equal(emptyNode.hidden, true);
  assert.ok(statusNode.textContent.includes(TRUNCATED_TEXT), '截断要有可见提示');
  assert.equal(statusNode.dataset.tone, 'warning');
  assert.equal(normalizeWorkspaceFile({ content: 42 }).content, '', '坏 content 退化为空串，不冒充');

  // 列表加载失败：可见原因 + 不抛异常
  const badList: any = { innerHTML: '' };
  const badEmpty: any = { hidden: false, textContent: '' };
  const badStatus: any = { textContent: '', dataset: { tone: '' } };
  const badPanel = createWorkspacePanel({
    nodes: { list: badList, empty: badEmpty, status: badStatus, content: { textContent: '' } },
    request: async () => ({ status: 500, ok: false, data: { error: 'WORKSPACE_FULL' } }),
  });
  assert.equal(await badPanel.reload('c1'), null);
  assert.ok(badStatus.textContent.includes('WORKSPACE_FULL'), '失败原因必须可见');
  assert.equal(badStatus.dataset.tone, 'danger');
  assert.equal(badEmpty.hidden, false);

  // 单文件加载失败：内容清空 + 可见错误，不 throwing
  const failNodes = {
    list: { innerHTML: '' },
    empty: { hidden: true, textContent: '' },
    status: { textContent: '', dataset: { tone: '' } },
    content: { textContent: '旧内容' },
  } as any;
  const failPanel = createWorkspacePanel({
    nodes: failNodes,
    request: async () => ({ status: 404, ok: false, data: { error: 'PATH_ESCAPE' } }),
  });
  assert.equal(await failPanel.openFile('../../etc/passwd'), null);
  assert.equal(failNodes.content.textContent, '', '失败时必须清掉旧内容');
  assert.ok(failNodes.status.textContent.includes('PATH_ESCAPE'));

  // 网络层失败（request 抛 / 返回 null）也不抛异常
  const netPanel = createWorkspacePanel({
    nodes: { list: { innerHTML: '' }, empty: { hidden: true }, status: { textContent: '' }, content: { textContent: '' } },
    request: async () => null,
  });
  assert.equal(await netPanel.reload('c1'), null);
  assert.equal(await netPanel.openFile('a.md'), null);

  // 空态：工作空间没有文件
  const emptyNodes: any = { list: { innerHTML: '' }, empty: { hidden: true, textContent: '' }, status: { textContent: '', dataset: {} }, content: { textContent: '' } };
  const emptyPanel = createWorkspacePanel({
    nodes: emptyNodes,
    request: async () => ({ status: 200, ok: true, data: { ok: true, root: '/ws', files: [] } }),
  });
  assert.deepEqual((await emptyPanel.reload('c2'))?.files, []);
  assert.equal(emptyNodes.empty.hidden, false);
  assert.equal(emptyNodes.empty.textContent, EMPTY_FILES_TEXT);
  assert.ok(indexHtml.includes(EMPTY_FILES_TEXT), 'index.html 的空态文案必须与常量一致');

  // 切对话：清空列表与内容（旧对话的文件不能留在屏幕上）
  panel.clear();
  assert.equal(listNode.innerHTML, '');
  assert.equal(contentText, '');
  assert.equal(emptyNode.hidden, false);

  // DOM 结构：第三个页签 + 列表 / 空态 / 状态行 / 内容区，默认隐藏
  for (const id of ['panel-files', 'file-list', 'file-empty', 'file-status', 'file-content', 'file-root']) {
    assert.ok(indexHtml.includes(`id="${id}"`), `index.html 缺少 #${id}`);
  }
  assert.match(indexHtml, /id="panel-files"[^>]*hidden/);
  assert.ok(styleCss.includes('.file-row'));
  assert.ok(styleCss.includes('.file-empty'));
  assert.ok(styleCss.includes('.file-content'));

  // app.js 接线：控制器 + 页签懒加载；文件内容绝不当 HTML 插入
  assert.ok(appJs.includes('createWorkspacePanel('));
  assert.ok(appJs.includes('workspacePanel.reload('));
  assert.ok(appJs.includes('workspacePanel.openFile('));
  assert.ok(appJs.includes("target === 'files'"));
  assert.equal(appJs.includes('fileContent.innerHTML'), false);
});
