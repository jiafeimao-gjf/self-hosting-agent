import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BROWSER_CHANNEL,
  BROWSER_EVENT_PATH,
  BROWSER_KINDS,
  EMPTY_BROWSER_TITLE,
  MAX_EVENT_TEXT,
  acceptBrowserEvent,
  browserDocFromState,
  browserErrorText,
  browserStatus,
  createBrowserPanel,
  describeBrowserEvent,
  describePayload,
  normalizeBrowserDoc,
  normalizeBrowserMessage,
  renderBrowserEvent,
  shouldPaintBrowser,
  toBrowserEventRequest,
} from '../src/client/browser.js';

/**
 * SPEC-019 客户端浏览器面板。
 *
 * 纯逻辑（文档归一化 / 来源校验 / 消息白名单 / POST 请求体 / 展示文案）直接 import 断言；
 * DOM 接线沿用既有 UI-006 / UI2-006 / UI3-001 的做法：读源码结构断言。
 * `browser.js` 在 Node 里 import 无副作用——它连 `document` 都不碰（DOM 由 app.js 注入）。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.join(here, '..', 'src', 'client');

function readClient(name: string): string {
  return fs.readFileSync(path.join(clientDir, name), 'utf8');
}

const indexHtml = readClient('index.html');
const styleCss = readClient('style.css');
const appJs = readClient('app.js');
const browserJs = readClient('browser.js');

/** 一个假的 iframe window：来源校验只做对象身份比较，用普通对象就能测 */
const IFRAME_WINDOW = { label: 'browser-iframe' };
const OTHER_WINDOW = { label: 'other-window' };

// @spec BROWSER-011
test('浏览器面板是独立的第二个沙箱：只开 allow-scripts，与界面面板并存，已有 id 不变', () => {
  // 两个 iframe 都只开 allow-scripts；同时开 allow-same-origin 等于沙箱失效
  assert.match(indexHtml, /<iframe[^>]*id="surface"[^>]*sandbox="allow-scripts"/, '界面面板的沙箱不能被动过');
  assert.match(indexHtml, /<iframe[^>]*id="browser"[^>]*sandbox="allow-scripts"/, '浏览器面板必须有沙箱');
  assert.equal(/allow-same-origin/.test(indexHtml), false, '绝不给同源权限');

  // 并存：两个面板容器 + 切换控件；浏览器面板默认隐藏，但 DOM 里始终在（不是按需创建）
  assert.ok(indexHtml.includes('id="panel-surface"'), '界面面板容器');
  assert.ok(indexHtml.includes('id="panel-browser"'), '浏览器面板容器');
  assert.ok(indexHtml.includes('data-panel-tab="browser"'), '缺少面板切换控件');
  assert.ok(indexHtml.includes('role="tablist"'));
  assert.match(indexHtml, /id="panel-browser"[^>]*hidden/, '浏览器面板默认隐藏');

  // 现有 DOM id 一个都不能动（已有测试在断言它们）
  for (const id of [
    'surface',
    'surface-version',
    'messages',
    'busy',
    'busy-text',
    'composer',
    'input',
    'agents',
    'tasks',
    'timeline',
    'sources',
  ]) {
    assert.ok(indexHtml.includes(`id="${id}"`), `index.html 缺少 #${id}`);
  }

  // 接线：订阅 browser 事件、应用 /api/state 字段、只更新 srcdoc、只认本 iframe 的 window
  assert.ok(appJs.includes("source.addEventListener('browser'"), '必须订阅 browser SSE 事件');
  assert.ok(appJs.includes('browserPanel.applyDocument('), 'browser 事件进浏览器面板');
  assert.ok(appJs.includes('browserPanel.applyState(raw)'), '/api/state 的 browser 字段也要应用');
  assert.ok(appJs.includes("addEventListener('message'"), 'postMessage 必须接线');
  assert.ok(appJs.includes('browserPanel.handleMessage(event)'));
  assert.ok(appJs.includes('createBrowserPanel('), 'app.js 只负责实例化面板');
  assert.ok(browserJs.includes('iframe.contentWindow'), '来源校验要拿本 iframe 的 window');
  assert.ok(browserJs.includes('event.source !== win'), '来源不对就丢弃');
  assert.ok(browserJs.includes('iframe.srcdoc'), '文档只进 srcdoc，宿主页面不刷新');
  assert.equal(/allow-same-origin/.test(browserJs), false);
  assert.equal(/\bdocument\./.test(browserJs), false, 'browser.js 不直接碰 document（Node 里可 import）');
  assert.equal(/location\.reload|location\.href =/.test(browserJs), false, '不得刷新页面');

  // 样式与空态
  assert.ok(styleCss.includes('.panel-tabs'));
  assert.ok(styleCss.includes('.panel-body[hidden]'), '两个面板靠 hidden 切换显隐');
  assert.ok(styleCss.includes('.browser-empty'));
});

// @spec BROWSER-011
test('桥消息只认本 iframe 的 window + __ac 标记 + 通道 + kind 白名单，其余一律丢弃', () => {
  const valid = { __ac: 1, channel: BROWSER_CHANNEL, kind: 'emit', name: '导出', payload: { fmt: 'csv' } };

  assert.deepEqual(acceptBrowserEvent({ source: IFRAME_WINDOW, data: valid }, IFRAME_WINDOW), {
    kind: 'emit',
    name: '导出',
    payload: { fmt: 'csv' },
  });

  // 来源不对：别的 window / 别的 iframe / iframe 还没就绪 / 事件本身不是对象
  assert.equal(acceptBrowserEvent({ source: OTHER_WINDOW, data: valid }, IFRAME_WINDOW), null);
  assert.equal(acceptBrowserEvent({ source: IFRAME_WINDOW, data: valid }, OTHER_WINDOW), null);
  assert.equal(acceptBrowserEvent({ source: IFRAME_WINDOW, data: valid }, null), null);
  assert.equal(acceptBrowserEvent({ source: IFRAME_WINDOW, data: valid }, undefined), null);
  assert.equal(acceptBrowserEvent(null, IFRAME_WINDOW), null);
  assert.equal(acceptBrowserEvent('不是事件', IFRAME_WINDOW), null);

  // 标记 / 通道 / kind 白名单
  assert.equal(normalizeBrowserMessage({ ...valid, __ac: 2 }), null);
  assert.equal(normalizeBrowserMessage({ ...valid, __ac: '1' }), null);
  assert.equal(normalizeBrowserMessage({ ...valid, __ac: undefined }), null);
  assert.equal(normalizeBrowserMessage({ ...valid, channel: 'other' }), null);
  assert.equal(normalizeBrowserMessage({ ...valid, kind: 'navigate' }), null);
  assert.equal(normalizeBrowserMessage(null), null);

  // 桥会额外发 ready（白名单外）：静默忽略，不当错误
  const ready = { __ac: 1, channel: BROWSER_CHANNEL, kind: 'ready', title: '文档' };
  assert.equal(normalizeBrowserMessage(ready), null);
  assert.equal(acceptBrowserEvent({ source: IFRAME_WINDOW, data: ready }, IFRAME_WINDOW), null);

  // emit 必须有 name；payload 必须能被 JSON 序列化
  assert.equal(normalizeBrowserMessage({ ...valid, name: '   ' }), null);
  assert.equal(normalizeBrowserMessage({ ...valid, name: 42 }), null);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(normalizeBrowserMessage({ ...valid, payload: cyclic }), null);

  assert.deepEqual([...BROWSER_KINDS], ['emit', 'log', 'error']);
});

// @spec BROWSER-011
test('面板显示文档标题与版本；没有文档时是空态，坏输入不报错', () => {
  const status = browserStatus({ version: 3, title: '预算看板', html: '<!doctype html><p>x</p>', allowNetwork: false });
  assert.equal(status.hasDoc, true);
  assert.equal(status.title, '预算看板');
  assert.equal(status.versionLabel, 'v3');
  assert.equal(status.html, '<!doctype html><p>x</p>');

  // 没有文档 → 空态：标题是人话、版本 v0，不显示 undefined
  for (const raw of [null, undefined, {}, { html: '' }, { html: 42 }, { version: '2', title: {} }]) {
    const empty = browserStatus(raw);
    assert.equal(empty.hasDoc, false);
    assert.equal(empty.title, EMPTY_BROWSER_TITLE);
    assert.equal(empty.versionLabel, 'v0');
    assert.equal(empty.html, '');
  }

  // 有 html 但没标题 / 没版本 → 不冒充
  const untitled = browserStatus({ html: '<p>hi</p>' });
  assert.equal(untitled.hasDoc, true);
  assert.equal(untitled.title, '未命名文档');
  assert.equal(untitled.versionLabel, 'v0');

  // DOM 侧：标题 / 版本有独立节点，用 textContent 写入（不拼 HTML）
  assert.ok(indexHtml.includes('id="browser-title"'));
  assert.ok(indexHtml.includes('id="browser-version"'));
  assert.ok(indexHtml.includes('id="browser-empty"'));
  assert.ok(browserJs.includes('nodes.title.textContent'));
  assert.ok(browserJs.includes('nodes.version.textContent'));
  assert.ok(browserJs.includes('nodes.empty.hidden'));

  // 坏输入绝不抛异常
  assert.doesNotThrow(() => {
    for (const raw of [null, undefined, 42, 'x', true, [], { version: NaN, title: [] }]) {
      normalizeBrowserDoc(raw);
      browserStatus(raw);
      renderBrowserEvent(raw);
    }
  });
});

// @spec BROWSER-011
test('首帧与空态：没画上就要再画，没有文档就清空沙箱而不是沿用旧内容', () => {
  assert.equal(shouldPaintBrowser({ nextHtml: '', prevHtml: '', painted: false }), false);
  assert.equal(shouldPaintBrowser({ nextHtml: '<p>a</p>', prevHtml: '', painted: false }), true);
  // 内容没变但从没画上（首帧被 iframe 初始加载覆盖）→ 仍然要画
  assert.equal(shouldPaintBrowser({ nextHtml: '<p>a</p>', prevHtml: '<p>a</p>', painted: false }), true);
  assert.equal(shouldPaintBrowser({ nextHtml: '<p>a</p>', prevHtml: '<p>a</p>', painted: true }), false);
  assert.equal(shouldPaintBrowser({ nextHtml: '<p>a</p>', prevHtml: '<p>a</p>', painted: true, force: true }), true);

  // /api/state 没有 browser 字段 → 保持现状（不误清空 SSE 送来的文档）
  assert.equal(browserDocFromState({ document: {} }), null);
  assert.equal(browserDocFromState(null), null);
  assert.equal(browserDocFromState({ browser: null })?.hasDoc, false);
  assert.equal(browserDocFromState({ browser: { version: 2, title: 't', html: '<p>x</p>' } })?.version, 2);

  // 控制器结构：等 load 后补画 + rAF 兜底 + 空态清 srcdoc
  assert.ok(browserJs.includes('flushPendingBrowser'));
  assert.ok(browserJs.includes('pendingHtml'));
  assert.ok(browserJs.includes("addEventListener('load'"));
  assert.ok(browserJs.includes('requestAnimationFrame('), '错过 load 事件时必须兜底补画');
  assert.ok(browserJs.includes("write('')"), '空态要清空沙箱');
  assert.equal(typeof createBrowserPanel, 'function');
});

// @spec BROWSER-006
test('声明式交互：桥上报的 emit（data-ac-emit / data-ac-payload）原样转成 POST /api/browser/event', () => {
  assert.equal(BROWSER_EVENT_PATH, '/api/browser/event');

  // 元素上写 data-ac-emit="导出" data-ac-payload='{"fmt":"csv"}'，点击后桥上来的就是这条
  const declarative = { __ac: 1, channel: BROWSER_CHANNEL, kind: 'emit', name: '导出', payload: { fmt: 'csv' } };
  assert.deepEqual(acceptBrowserEvent({ source: IFRAME_WINDOW, data: declarative }, IFRAME_WINDOW), {
    kind: 'emit',
    name: '导出',
    payload: { fmt: 'csv' },
  });

  // 转发的是事件本身，不是 postMessage 信封：__ac / channel 不许泄进请求体
  const body = toBrowserEventRequest(normalizeBrowserMessage(declarative));
  assert.deepEqual(body, { kind: 'emit', name: '导出', payload: { fmt: 'csv' } });
  assert.equal(Object.prototype.hasOwnProperty.call(body, '__ac'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'channel'), false);

  // submit 类事件会带 fields；payload 缺失退化为 {}
  assert.deepEqual(toBrowserEventRequest({ kind: 'emit', name: '保存' }), { kind: 'emit', name: '保存', payload: {} });
  // 缺 name / 空白 name 一律不许转发
  assert.equal(toBrowserEventRequest({ kind: 'emit', payload: { a: 1 } }), null);
  assert.equal(toBrowserEventRequest({ kind: 'emit', name: '   ' }), null);

  // 网络层在 browser.js 里发 POST，app.js 只把 window message 接进来
  assert.ok(browserJs.includes('request(BROWSER_EVENT_PATH'));
  assert.ok(browserJs.includes("method: 'POST'"));
  assert.ok(appJs.includes('browserPanel.handleMessage(event)'));
  assert.ok(appJs.includes("addEventListener('message'"));
});

// @spec BROWSER-007
test('命令式与日志转发：emit / log / error 三类消息都转成 POST，进 DOM 的文本全部转义', () => {
  const wire = (kind: string, extra: Record<string, unknown>) => ({
    __ac: 1,
    channel: BROWSER_CHANNEL,
    kind,
    ...extra,
  });

  // AgentClient.emit('导出', {fmt:'csv'}) 与声明式走同一条路
  assert.deepEqual(
    acceptBrowserEvent(
      { source: IFRAME_WINDOW, data: wire('emit', { name: '导出', payload: { fmt: 'csv' } }) },
      IFRAME_WINDOW,
    ),
    { kind: 'emit', name: '导出', payload: { fmt: 'csv' } },
  );

  // AgentClient.log / console.log（桥额外带 level，冻结契约只转发 text）/ window.onerror
  const log = acceptBrowserEvent({ source: IFRAME_WINDOW, data: wire('log', { text: '加载完成', level: 'warn' }) }, IFRAME_WINDOW);
  assert.deepEqual(log, { kind: 'log', text: '加载完成' });
  assert.deepEqual(acceptBrowserEvent({ source: IFRAME_WINDOW, data: wire('error', { text: 'boom' }) }, IFRAME_WINDOW), {
    kind: 'error',
    text: 'boom',
  });

  // 空文本不转发（服务端也会拒，客户端先挡）
  assert.equal(toBrowserEventRequest({ kind: 'log', text: '' }), null);
  assert.equal(toBrowserEventRequest({ kind: 'error' }), null);
  assert.equal(normalizeBrowserMessage(wire('log', { text: '' })), null);

  // 人话
  assert.equal(describeBrowserEvent({ kind: 'emit', name: '导出', payload: { fmt: 'csv' } }), '浏览器交互：导出（{"fmt":"csv"}）');
  assert.equal(describeBrowserEvent({ kind: 'log', text: 'hi' }), '浏览器日志：hi');
  assert.equal(describeBrowserEvent({ kind: 'error', text: 'boom' }), '浏览器出错：boom');
  assert.equal(describeBrowserEvent(null), '');

  // 文档里的文本是不可信输入：进 DOM 必须转义
  const payload = '<img src=x onerror=alert(1)>';
  const emitHtml = renderBrowserEvent({ kind: 'emit', name: payload, payload: { note: payload } });
  assert.ok(emitHtml.includes('data-browser-event="emit"'));
  assert.equal(emitHtml.includes('<img src=x'), false);
  assert.ok(emitHtml.includes('&lt;img src=x onerror=alert(1)&gt;'));

  const errorHtml = renderBrowserEvent({ kind: 'error', text: payload });
  assert.equal(errorHtml.includes('<img src=x'), false);
  assert.ok(errorHtml.includes('tone-danger'));

  // 长文本截断而不是刷屏
  const long = 'x'.repeat(MAX_EVENT_TEXT + 50);
  assert.ok(describeBrowserEvent({ kind: 'log', text: long }).length < long.length);
  assert.equal(describePayload({}), '');
  assert.equal(describePayload('不是对象'), '');

  // 服务端拒绝要说人话
  assert.equal(browserErrorText({ error: 'BAD_EVENT: 事件必须是对象' }, 400), 'BAD_EVENT: 事件必须是对象');
  assert.equal(browserErrorText(null, 500), 'HTTP 500');
});

// @spec BROWSER-011
// @spec BROWSER-007
test('面板控制器接上假 DOM：只有本 iframe 的消息才变成 POST，来源不对完全静默', async () => {
  const win = { label: 'browser-iframe' };
  const listeners: Record<string, Array<() => void>> = {};
  const iframe: any = {
    srcdoc: '',
    contentWindow: win,
    addEventListener(type: string, handler: () => void) {
      (listeners[type] ??= []).push(handler);
    },
  };
  const title: any = { textContent: '' };
  const version: any = { textContent: '' };
  const empty: any = { hidden: false };
  const lastEvent: any = { innerHTML: '' };
  const requests: Array<{ path: string; init: any }> = [];
  const forwarded: unknown[] = [];

  const panel = createBrowserPanel({
    nodes: { iframe, title, version, empty, lastEvent },
    request: async (p, init) => {
      requests.push({ path: p, init });
      return { ok: true, status: 200, data: { ok: true } };
    },
    onForwarded: (body) => forwarded.push(body),
  });

  // 模拟 iframe 首次加载完成：之后文档可以直接写进 srcdoc
  listeners.load[0]();

  // 标题 / 版本 / 空态 / srcdoc 一起更新，html 原样进沙箱（不加工）
  panel.applyDocument({ version: 3, title: '预算看板', html: '<!doctype html><p>x</p>' }, { force: true });
  assert.equal(title.textContent, '预算看板');
  assert.equal(version.textContent, 'v3');
  assert.equal(empty.hidden, true);
  assert.equal(iframe.srcdoc, '<!doctype html><p>x</p>');

  // 本 iframe 的日志 → 一次 POST，请求体是冻结契约的形状
  assert.equal(
    panel.handleMessage({ source: win, data: { __ac: 1, channel: BROWSER_CHANNEL, kind: 'log', text: '加载完成' } }),
    true,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/api/browser/event');
  assert.equal(requests[0].init.method, 'POST');
  assert.deepEqual(requests[0].init.body, { kind: 'log', text: '加载完成' });
  assert.deepEqual(forwarded, [{ kind: 'log', text: '加载完成' }]);
  assert.ok(lastEvent.innerHTML.includes('浏览器日志：加载完成'));

  // 别的 window / 没有桥标记 → 一律丢弃，连请求都不发
  assert.equal(
    panel.handleMessage({ source: { label: 'other' }, data: { __ac: 1, channel: BROWSER_CHANNEL, kind: 'log', text: 'x' } }),
    false,
  );
  assert.equal(panel.handleMessage({ source: win, data: { hello: 'world' } }), false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(requests.length, 1, '被丢弃的消息不得转发');

  // 没有文档 → 清空沙箱 + 回到空态，不沿用上一份内容
  panel.applyDocument(null);
  assert.equal(iframe.srcdoc, '');
  assert.equal(empty.hidden, false);
  assert.equal(title.textContent, EMPTY_BROWSER_TITLE);
  assert.equal(version.textContent, 'v0');
  assert.equal(panel.isPainted(), false);
});

