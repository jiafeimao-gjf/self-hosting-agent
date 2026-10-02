import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { COMPONENT_SPECS } from '../src/surface/viewspec.ts';
import type { ViewSpec } from '../src/surface/viewspec.ts';
import {
  COMPONENT_TYPES,
  MAX_VIEW_DEPTH,
  escapeHtml,
  renderFragment,
  renderViewSpec,
} from '../src/client/renderer.js';
import { shouldApplySurface } from '../src/client/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.join(here, '..', 'src', 'client');

function readClient(name: string): string {
  return fs.readFileSync(path.join(clientDir, name), 'utf8');
}

const indexHtml = readClient('index.html');
const styleCss = readClient('style.css');
const appJs = readClient('app.js');
const rendererJs = readClient('renderer.js');

/**
 * app.js 是浏览器端的 ESM：在 Node 里 import 不应该有任何副作用（不碰 DOM），
 * 这样纯函数部分才能被直接断言。用动态 URL 导入，绕开 TS 对 .js 缺声明的解析。
 */
interface AppSnapshot {
  version: number;
  html: string;
  scopes: unknown[];
  agents: Record<string, unknown>[];
  tasks: Record<string, unknown>[];
  messages: unknown[];
  events: unknown[];
}

interface AppModule {
  CONNECTION_LABELS: Record<string, string>;
  MAX_TIMELINE: number;
  toneOfEvent(type: unknown): string;
  summarizeToolCall(call: unknown): { agent: string; name: string; detail: string };
  renderToolCallLine(call: unknown, result: unknown): string;
  renderMessage(message: unknown): string;
  renderTimelineItem(event: unknown): string;
  renderAgentRow(agent: unknown): string;
  renderTaskRow(task: unknown): string;
  projectMessages(messages: unknown): unknown[];
  normalizeState(raw: unknown): AppSnapshot;
}

const appUrl = new URL('../src/client/app.js', import.meta.url).href;
const app = (await import(appUrl)) as unknown as AppModule;

/** 每个组件类型的合法样例：组件表加一行，这里也必须加一行 */
const COMPONENT_SAMPLES: Record<string, ViewSpec> = {
  panel: { type: 'panel', title: '预算', children: [{ type: 'text', text: '还有 42%' }] },
  text: { type: 'text', text: '一段文本', tone: 'muted' },
  progress: { type: 'progress', label: '上下文预算', value: 0.42, tone: 'info' },
  action: { type: 'action', label: '重试一次', emit: 'retry', tone: 'danger' },
  list: { type: 'list', title: '待办', items: ['写规格', '写测试'], tone: 'default' },
  kv: { type: 'kv', title: '指标', pairs: [{ key: 'tokens', value: '12k' }] },
  columns: { type: 'columns', children: [{ type: 'badge', text: '就绪' }] },
  badge: { type: 'badge', text: '运行中', tone: 'success' },
};

// @spec UI-001
test('renderer.js 是纯 ESM 纯函数模块：四个导出齐全且不触碰 DOM', () => {
  assert.equal(typeof renderViewSpec, 'function');
  assert.equal(typeof renderFragment, 'function');
  assert.equal(typeof escapeHtml, 'function');
  assert.ok(Array.isArray(COMPONENT_TYPES), 'COMPONENT_TYPES 必须是数组');
  assert.equal(COMPONENT_TYPES.length, 8);

  // 纯函数：同样输入两次调用结果一致；且本测试能 import 它本身就是证据
  const sample = COMPONENT_SAMPLES.panel as ViewSpec;
  assert.equal(renderFragment(sample), renderFragment(sample));
  assert.equal(renderViewSpec(sample), renderViewSpec(sample));
  assert.ok(rendererJs.startsWith('/**'), 'renderer.js 应当有说明性文件头');

  // 不得触碰 DOM / 浏览器全局：否则 Node 里 import 就会炸
  for (const banned of ['document.', 'window.', 'localStorage', 'querySelector', 'innerHTML', 'addEventListener']) {
    assert.equal(rendererJs.includes(banned), false, `renderer.js 不该出现 ${banned}`);
  }

  // ESM 导出必须是静态的具名导出（浏览器原生模块直接用）
  for (const name of ['export const COMPONENT_TYPES', 'export function escapeHtml', 'export function renderFragment', 'export function renderViewSpec']) {
    assert.ok(rendererJs.includes(name), `renderer.js 缺少 ${name}`);
  }
});

// @spec UI-002
test('组件词汇表与 src/surface/viewspec.ts 的 COMPONENT_SPECS 完全一致，8 种组件都有实现', () => {
  // 漂移门禁：服务端加了组件，浏览器端必须跟上（顺序也必须一致）
  assert.deepEqual([...COMPONENT_TYPES], Object.keys(COMPONENT_SPECS));
  for (const type of Object.keys(COMPONENT_SPECS)) {
    assert.ok(COMPONENT_TYPES.includes(type), `客户端缺少组件 ${type}`);
    assert.ok(typeof COMPONENT_SPECS[type as keyof typeof COMPONENT_SPECS].summary === 'string');
  }
  assert.equal(COMPONENT_TYPES.includes('sparkline'), false, '未经服务端声明的组件不得混进词汇表');

  for (const type of COMPONENT_TYPES) {
    const sample = COMPONENT_SAMPLES[type];
    assert.ok(sample, `缺少 ${type} 的样例`);
    const html = renderFragment(sample);
    assert.equal(html.includes('data-unknown-component'), false, `${type} 被当成未知组件`);
    assert.equal(html.includes('data-invalid-spec'), false, `${type} 被当成非法节点`);
    assert.ok(html.includes(`ac-${type}`), `${type} 的渲染输出缺少 ac-${type} 标记`);
  }
});

// @spec UI-003
test('renderViewSpec 输出自包含 HTML，renderFragment 输出片段，文本与属性全部转义', () => {
  assert.equal(escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(escapeHtml('<b>')), '&amp;lt;b&amp;gt;');

  const page = renderViewSpec({ type: 'progress', label: '上下文预算', value: 0.42, tone: 'info' });
  assert.ok(page.startsWith('<!doctype html>'), '应当是完整文档');
  assert.ok(page.includes('<html lang="zh-CN">'));
  assert.ok(page.includes('<style>'));
  assert.ok(page.includes('--ac-accent'), '自包含：令牌变量内联在 <style> 里');
  assert.ok(page.includes('--ac-font-family'), '字体栈也必须内联，不能依赖外部字体');
  assert.ok(page.includes('上下文预算'));
  assert.ok(page.includes('width:42%'));
  assert.ok(page.includes('aria-valuenow="0.42"'));
  assert.equal(/https?:\/\//.test(page), false, '自包含产物不得引用远程资源');

  const fragment = renderFragment({ type: 'badge', text: '就绪' });
  assert.equal(fragment.includes('<!doctype html>'), false, '片段不带文档外壳');
  assert.ok(fragment.includes('>就绪</span>'));

  // 注入：script 标签与属性越界都必须被转义挡住
  const payload = '<script>alert("x")</script>';
  const emit = '" onmouseover="alert(1)';
  const html = renderViewSpec({
    type: 'panel',
    title: payload,
    children: [
      { type: 'text', text: payload },
      { type: 'action', label: payload, emit },
      { type: 'list', items: [payload] },
      { type: 'kv', pairs: [{ key: payload, value: payload }] },
    ],
  });
  assert.equal(html.includes('<script>'), false);
  assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'));
  assert.ok(html.includes('data-emit="&quot; onmouseover=&quot;alert(1)"'), '属性值必须转义');
  assert.equal(html.includes('onmouseover="alert(1)"'), false);

  // 内联 style 必须是 kebab-case（驼峰属性名浏览器会直接忽略）
  assert.ok(html.includes('flex-direction:column'));
  assert.ok(html.includes('justify-content:space-between'));
  assert.equal(html.includes('flexDirection'), false);
});

// @spec UI-004
test('未知组件与非法节点降级为占位块：不抛异常、不白屏、兄弟组件照常渲染', () => {
  const html = renderFragment({
    type: 'panel',
    children: [
      { type: 'sparkline', series: [1, 2, 3] },
      { type: 'text', text: '我还在' },
    ],
  });
  assert.ok(html.includes('data-unknown-component="sparkline"'));
  assert.ok(html.includes('未知组件'));
  assert.ok(html.includes('我还在'), '未知组件不能中断兄弟组件');
  assert.equal(html.includes('data-invalid-spec'), false);

  const weird: unknown[] = [null, undefined, 42, 'panel', true, [], {}, { type: 42 }, { type: '不存在' }];
  assert.doesNotThrow(() => {
    for (const value of weird) {
      renderFragment(value);
      renderViewSpec(value);
    }
  });
  assert.ok(renderFragment(null).includes('data-invalid-spec="true"'));
  assert.ok(renderFragment({ type: 42 }).includes('data-unknown-component'));

  // 超深嵌套：降级为占位块，绝不爆栈
  let deep: unknown = { type: 'text', text: '最深处' };
  for (let i = 0; i < MAX_VIEW_DEPTH + 2; i += 1) deep = { type: 'panel', children: [deep] };
  const tooDeep = renderFragment(deep);
  assert.ok(tooDeep.includes('data-invalid-spec="true"'));
  assert.equal(tooDeep.includes('最深处'), false);

  // 循环引用同样不能炸
  const cyclic: Record<string, unknown> = { type: 'panel', children: [] };
  (cyclic.children as unknown[]).push(cyclic);
  assert.doesNotThrow(() => renderFragment(cyclic));
});

// @spec UI-005
test('index.html + style.css 是离线深色单页，四区与必需元素齐全', () => {
  for (const [name, text] of [
    ['index.html', indexHtml],
    ['style.css', styleCss],
    ['app.js', appJs],
    ['renderer.js', rendererJs],
  ] as [string, string][]) {
    assert.equal(/https?:\/\//.test(text), false, `${name} 不得引用远程资源`);
  }
  assert.equal(/@import/.test(styleCss), false, '不得用 @import 引远程字体');
  assert.equal(/<link[^>]+href="(?!\/style\.css)/.test(indexHtml), false, '只允许引用本地 /style.css');

  // 深色科技风：背景、青色 / 紫色强调、中文字体栈
  assert.ok(styleCss.includes('#05060a'), '背景色必须是 #05060a');
  assert.ok(styleCss.includes('#22d3ee'), '缺少青色强调 #22d3ee');
  assert.ok(styleCss.includes('#a78bfa'), '缺少紫色强调 #a78bfa');
  assert.ok(styleCss.includes('PingFang SC'), '中文字体栈必须含 PingFang SC');
  assert.ok(styleCss.includes('grid-template-areas'), '四区用 grid 分区');
  assert.ok(/\.msg-human\s*\{[^}]*align-self:\s*flex-end/.test(styleCss), '人类消息靠右');
  assert.ok(/\.msg-thinking\s*\{[^}]*align-self:\s*flex-start/.test(styleCss), 'Agent 思考靠左');

  // 离线单页只引这三个静态资源
  assert.ok(indexHtml.includes('<link rel="stylesheet" href="/style.css"'));
  assert.ok(indexHtml.includes('<script type="module" src="/app.js">'));

  for (const id of [
    'conn',
    'version',
    'rollback',
    'interrupt',
    'messages',
    'composer',
    'input',
    'surface',
    'surface-version',
    'agents',
    'tasks',
    'timeline',
  ]) {
    assert.ok(indexHtml.includes(`id="${id}"`), `index.html 缺少 #${id}`);
  }

  // 顶部栏 / 对话 / 界面面板 / 检查器
  assert.ok(indexHtml.includes('class="topbar"'));
  assert.ok(indexHtml.includes('zone-chat'));
  assert.ok(indexHtml.includes('zone-surface'));
  assert.ok(indexHtml.includes('zone-inspector'));
});

// @spec UI-006
test('界面面板是 sandbox iframe srcdoc，document 事件只更新 srcdoc 而不刷新页面', () => {
  assert.ok(/<iframe[^>]*id="surface"[^>]*sandbox="allow-scripts"/.test(indexHtml), '沙箱必须允许脚本');
  assert.ok(/<iframe[^>]*id="surface"[^>]*srcdoc=""/.test(indexHtml));

  // 逐条检查**真实的 sandbox 属性**，而不是 grep 全文：
  // 注释里写明「绝不开 allow-same-origin」也应当被允许（那是安全约束的说明，不是配置）。
  const sandboxAttrs = indexHtml.match(/sandbox="[^"]*"/g) ?? [];
  assert.equal(sandboxAttrs.length >= 2, true, '界面面板与内置浏览器各有一个沙箱');
  for (const attr of sandboxAttrs) {
    const flags = attr.slice('sandbox="'.length, -1).split(/\s+/).filter((x) => x !== '');
    assert.deepEqual(flags, ['allow-scripts'], `沙箱只允许 allow-scripts，实际是 ${attr}`);
    assert.equal(/allow-same-origin/.test(attr), false, 'allow-scripts + allow-same-origin 等于沙箱失效');
  }

  assert.ok(appJs.includes("new EventSource('/api/stream')"));
  assert.ok(appJs.includes("addEventListener('document'"));
  assert.ok(appJs.includes('dom.surface.srcdoc = html'), 'document 事件只更新 srcdoc');
  // 老实现这里是 `html !== state.html`（内容没变就不重写）——正是它让首帧永久空白的：
  // 首帧被 iframe 初始加载覆盖后，缓存却认定「画过了」。现在改成强制重画 + 看画没画上。
  assert.ok(appJs.includes('force: true'), 'document 事件必须强制重画，不猜缓存');
  assert.ok(appJs.includes('shouldApplySurface('), '要不要画由纯函数判定，可被测试守住');
  assert.ok(appJs.includes('dom.version.textContent'), '版本号要跟着 document 事件前进');
  assert.ok(appJs.includes('dom.surfaceVersion.textContent'));

  for (const banned of ['location.reload', 'location.href =', 'document.write', 'window.open']) {
    assert.equal(appJs.includes(banned), false, `不刷新页面 / 不新开窗口：不得出现 ${banned}`);
  }
  // 服务端 html 优先，只有拿到 View Spec 时才在浏览器端渲染
  assert.ok(appJs.includes("typeof data.html === 'string'"));
  assert.ok(appJs.includes('renderViewSpec('));
});

// @spec UI-007
test('app.js 订阅 /api/stream 处理四类事件，并用 POST 调 message / interrupt / rollback', () => {
  for (const type of ['state', 'frame', 'document', 'done']) {
    assert.ok(appJs.includes(`addEventListener('${type}'`), `缺少 ${type} 事件处理`);
  }
  for (const endpoint of ['/api/message', '/api/interrupt', '/api/rollback']) {
    assert.ok(appJs.includes(`'${endpoint}'`), `缺少端点 ${endpoint}`);
  }
  assert.ok(appJs.includes("method: 'POST'"));
  assert.ok(appJs.includes("headers: { 'content-type': 'application/json' }"));
  assert.ok(appJs.includes("dom.input.addEventListener('keydown'"), '回车发送');
  assert.ok(appJs.includes('window.prompt'), '回滚要能指定版本号');
  assert.equal(appJs.includes('location.reload'), false);

  // 连接状态四态
  for (const status of ['connecting', 'open', 'reconnecting', 'closed']) {
    assert.ok(Object.prototype.hasOwnProperty.call(app.CONNECTION_LABELS, status), `缺少连接状态 ${status}`);
  }

  // 在 Node 里 import 无副作用，快照归一化对缺字段的坏输入退化为空
  const snapshot = app.normalizeState({
    document: { version: 3, html: '<p>预算</p>', scopes: ['surface.main'] },
    processes: [{ id: 'lead', pid: 9800, alive: true }],
    taskboard: [{ id: 'task_19', status: 'completed' }],
    conversation: [{ from: 'human', body: '把预算显示成进度条' }],
    events: [{ type: 'ui.patch' }],
  });
  assert.equal(snapshot.version, 3);
  assert.equal(snapshot.html, '<p>预算</p>');
  assert.equal(snapshot.agents.length, 1);
  assert.equal(snapshot.tasks.length, 1);
  assert.equal(snapshot.messages.length, 1);
  assert.equal(snapshot.events.length, 1);

  const empty = app.normalizeState(null);
  assert.deepEqual(empty, { version: 0, html: '', scopes: [], agents: [], tasks: [], messages: [], events: [] });
  assert.deepEqual(app.projectMessages('不是数组'), []);
});

// @spec UI-009
test('首帧不会被吞：没画上就必须再画，document 事件强制重画', () => {
  // 空 html 不画
  assert.equal(shouldApplySurface({ nextHtml: '', prevHtml: '', painted: false }), false);

  // 新内容且还没画上 → 画
  assert.equal(shouldApplySurface({ nextHtml: '<p>a</p>', prevHtml: '', painted: false }), true);

  // 内容没变但**从没画上**（首帧被初始加载覆盖的情形）→ 仍然要画，这是这个 bug 的要害
  assert.equal(shouldApplySurface({ nextHtml: '<p>a</p>', prevHtml: '<p>a</p>', painted: false }), true);

  // 内容没变且确实画上了 → 不重复画
  assert.equal(shouldApplySurface({ nextHtml: '<p>a</p>', prevHtml: '<p>a</p>', painted: true }), false);

  // Agent 明确改了界面 → 强制重画
  assert.equal(shouldApplySurface({ nextHtml: '<p>a</p>', prevHtml: '<p>a</p>', painted: true, force: true }), true);

  // 客户端必须等 iframe 首次加载完成后再补画，**并且**不能只依赖那个事件：
  // 如果 load 在挂监听之前就发生过，pendingHtml 会永远落不了地（面板一直空）。
  const appSource = readClient('app.js');
  assert.match(appSource, /addEventListener\('load'/);
  assert.match(appSource, /pendingHtml/);
  assert.match(appSource, /iframeLoaded/);
  assert.match(appSource, /requestAnimationFrame\(\(\) => flushPendingSurface\(\)\)/, '必须有错过 load 事件时的兜底补画');
});

// @spec UI-008
test('对话流：人类靠右、thinking 靠左、工具调用是可读摘要行，所有文本都转义', () => {
  const human = app.renderMessage({ kind: 'human', agent: '人类', text: '把预算做成进度条' });
  assert.ok(human.startsWith('<li class="msg msg-human">'));
  assert.ok(human.includes('人类'));
  const thinking = app.renderMessage({ kind: 'thinking', agent: 'lead', text: '先建任务再改界面' });
  assert.ok(thinking.includes('msg-thinking'));
  assert.ok(thinking.includes('lead'));
  assert.ok(app.renderMessage({ kind: 'error', agent: 'lead', text: '模型不可用' }).includes('msg-error'));

  // 工具调用摘要行：谁 · 调了什么 · ok/失败
  const running = app.renderToolCallLine({ id: 'l1', agent: 'lead', name: 'task.create', args: { id: 'task_19' } }, null);
  assert.ok(running.includes('lead'));
  assert.ok(running.includes('task.create'));
  assert.ok(running.includes('调用中'));
  assert.ok(running.includes('is-pending'));
  assert.ok(running.includes('task_19'), '摘要里应带上关键参数');

  const done = app.renderToolCallLine({ id: 'l1', agent: 'lead', name: 'task.create' }, { ok: true });
  assert.ok(done.includes('is-ok'));
  assert.ok(done.includes('>ok<'));

  const failed = app.renderToolCallLine({ id: 'l1', agent: 'lead', name: 'task.create' }, { ok: false, error: '模型不可用' });
  assert.ok(failed.includes('is-fail'));
  assert.ok(failed.includes('失败'));
  assert.ok(failed.includes('模型不可用'));

  // 时间线按类型上色
  assert.equal(app.toneOfEvent('ui.patch'), 'info');
  assert.equal(app.toneOfEvent('host.tool.call'), 'warning');
  assert.equal(app.toneOfEvent('message.received'), 'strong');
  assert.equal(app.toneOfEvent('agent.exit'), 'danger');
  assert.equal(app.toneOfEvent('loop.step'), 'muted');
  const event = app.renderTimelineItem({ type: 'ui.patch', agent: 'lead', ts: '2026-10-01T17:28:10.800Z' });
  assert.ok(event.includes('tone-info'));
  assert.ok(event.includes('data-event-type="ui.patch"'));

  // 检查器：进程表与任务板
  assert.ok(app.renderAgentRow({ id: 'lead', pid: 9800, alive: true }).includes('存活'));
  assert.ok(app.renderAgentRow({ id: 'teammate:ui', pid: 9801, alive: false }).includes('已退出'));
  assert.ok(app.renderTaskRow({ id: 'task_19', subject: '预算进度条', status: 'completed', owner: 'teammate:ui' }).includes('status-completed'));

  // 转义：所有进入 DOM 的文本
  const payload = '<img src=x onerror=alert(1)>';
  const escaped = app.renderMessage({ kind: 'human', agent: '人类', text: payload });
  assert.equal(escaped.includes('<img src=x'), false);
  assert.ok(escaped.includes('&lt;img src=x onerror=alert(1)&gt;'));

  const tool = app.renderToolCallLine({ id: '"><b>', agent: payload, name: 'x" y', args: { '<k>': '<v>' } }, { ok: false, error: '<b>炸' });
  assert.equal(tool.includes('<b>'), false);
  assert.ok(tool.includes('&lt;b&gt;'));
  assert.equal(app.renderAgentRow({ id: payload, pid: 1, alive: true }).includes('<img src=x'), false);
  assert.equal(app.renderTaskRow({ id: payload, subject: payload, status: 'x', owner: payload }).includes('<img src=x'), false);
  assert.equal(app.renderTimelineItem({ type: payload, agent: payload, ts: '' }).includes('<img src=x'), false);
});

// @spec UI-010
test('忙碌指示：Agent 干活时有可见反馈并显示已等待秒数，收工时收掉', () => {
  // 标记必须存在（真模型一轮可能几十秒，没有它人类会以为卡死）
  assert.match(indexHtml, /id="busy"/);
  assert.match(indexHtml, /id="busy-text"/);
  assert.match(styleCss, /\.busy-dot/);
  assert.match(styleCss, /@keyframes busy-pulse/);

  // 用服务端的 busySince 算「已等 N 秒」，而不是只放一个静态图标
  assert.match(appJs, /busySince/);
  assert.match(appJs, /setInterval\(paint, 1000\)/);
  assert.match(appJs, /已 \$\{seconds\}s/);

  // 一轮结束必须收掉，不等下一次 state
  assert.match(appJs, /setBusy\(\{ busy: false \}\)/);
  assert.match(appJs, /dom\.busy\.hidden = true/);

  // 连接字符串也不许出现远程资源（离线单页）
  assert.equal(/https?:\/\//.test(styleCss), false);
});

// @spec UI-011
test('检查器可最小化：只切属性、不刷页面，状态记在 localStorage', () => {
  // 标题栏上要有一个真正的按钮（键盘天然可达），并且声明它控制谁
  assert.match(indexHtml, /id="inspector-toggle"/);
  assert.match(indexHtml, /aria-expanded="true"/);
  assert.match(indexHtml, /aria-controls="inspector-body"/);
  assert.match(indexHtml, /id="inspector-body"/);
  assert.match(indexHtml, /id="inspector-toggle-label"/);

  // 收起 = 给 .grid 加 data-inspector，CSS 据此把下半区压成 auto 并藏起内容
  assert.match(appJs, /applyInspectorCollapsed/);
  assert.match(appJs, /setAttribute\('data-inspector', 'collapsed'\)/);
  assert.match(appJs, /removeAttribute\('data-inspector'\)/);
  assert.match(appJs, /aria-expanded/);
  assert.match(styleCss, /\.grid\[data-inspector='collapsed'\]/);
  assert.match(styleCss, /#inspector-body\s*\{\s*display:\s*none/);

  // 与「切到浏览器就把上半区加高」那条规则不能打架：折叠规则必须特异性更高、
  // 且排在它之后，否则收起时检查器那一行仍会白占一半高度（真机上发生过）
  const browserRuleAt = styleCss.indexOf(".grid:has(.zone-surface[data-active-panel='browser'])");
  const collapsedRuleAt = styleCss.indexOf(".grid[data-inspector='collapsed']:has(.zone-inspector)");
  assert.ok(browserRuleAt >= 0 && collapsedRuleAt >= 0, '两条规则都要在');
  assert.ok(collapsedRuleAt > browserRuleAt, '折叠规则要排在浏览器加高规则之后');
  assert.match(styleCss, /\.grid\[data-inspector='collapsed'\]:has\(/);

  // 记住选择，但绝不整页刷新
  assert.match(appJs, /localStorage\.setItem\(INSPECTOR_KEY/);
  assert.match(appJs, /localStorage\.getItem\(INSPECTOR_KEY/);
  assert.equal(appJs.includes('location.reload'), false);

  // 收起态不能把四个卡片从 DOM 里删掉——只隐藏，展开后原样回来
  assert.match(indexHtml, /id="agents"/);
  assert.match(indexHtml, /id="tasks"/);
  assert.match(indexHtml, /id="timeline"/);
  assert.match(indexHtml, /id="sources"/);
});
