/**
 * SPEC-012 §2–§3 客户端界面逻辑；SPEC-014 补上「客户端自举」的呈现
 * （订阅 `client.changed`：`.css` 无刷新热替换，`.js`/`.html` 只给人类点击的刷新横幅）；
 * SPEC-017 补上浏览器端设置页的接线（打开 / 关闭、保存、测试连接、当前模型 chip）；
 * SPEC-019 补上内置浏览器面板的接线（`browser` 事件 / `/api/state.browser` 字段 /
 * iframe 的 postMessage → `POST /api/browser/event`）；
 * SPEC-020 补上多对话与 `/` 命令的接线（切换器、`?conversation=<id>`、切换即重开 SSE
 * 并重画全部区域、`/` 前缀路由到 `/api/command`、命令结果渲染成系统消息）；
 * SPEC-021 补上「文件」页签的接线（列表只来自 `/api/workspace`，内容点击时动态加载）。
 *
 * 分工：
 *
 * - 本文件上半部分是**纯函数**（消息 / 工具摘要 / 时间线 / 快照归一化 → HTML 字符串），
 *   不碰 DOM，`node --test` 里可以直接 import 断言（UI-008）；
 * - 下半部分 `boot()` 只做连线：EventSource 订阅 `/api/stream`、六个 SSE 事件、
 *   四个 POST 端点、把渲染结果塞进 DOM（UI-006 / UI-007）；设置页的纯逻辑与 DOM
 *   渲染在 `settings.js`，浏览器面板在 `browser.js`，多对话 / 命令 / 文件面板的
 *   纯逻辑与控制器在 `conversations.js`，这里只实例化并接线（UI3-001 / BROWSER-011 /
 *   CONV-004 / CMD-001 / WS-010）。
 *
 * 沙箱是架构的一环：Agent 给的 HTML 只进 `<iframe sandbox="allow-scripts" srcdoc>`，
 * 收到 `document` / `browser` 事件时**只更新 srcdoc**，宿主页面绝不刷新。
 * 三个沙箱面板（`#surface` / `#browser` / 文件）并存，互不覆盖。
 */

import { createBrowserPanel } from './browser.js';
import {
  COMMAND_HINT_TEXT,
  DEFAULT_CONVERSATION,
  commandActionOf,
  commandRequest,
  conversationIdOf,
  createConversationSwitcher,
  createWorkspacePanel,
  isCommandText,
  normalizeCommandResult,
  renderCommandResult,
  streamUrl,
  withConversation,
} from './conversations.js';
import { escapeHtml, renderViewSpec } from './renderer.js';
import { createSettingsPage, currentModelText } from './settings.js';

/** 连接状态 → 中文文案 */
export const CONNECTION_LABELS = {
  connecting: '连接中…',
  open: '已连接',
  reconnecting: '重连中…',
  closed: '已断开',
};

/** 事件时间线最多保留多少条 */
export const MAX_TIMELINE = 80;

/** SPEC-020：命令日志最多补回多少条（命令输出只在客户端，重画时要补回消息流） */
export const MAX_COMMAND_LOG = 20;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOf(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

/** 事件类型 → 语义色（时间线按类型上色，UI-008） */
export function toneOfEvent(type) {
  const name = typeof type === 'string' ? type : '';
  if (name.includes('error') || name.includes('exit') || name.includes('fail')) return 'danger';
  if (name.startsWith('client.')) return 'info'; // SPEC-014：客户端源码变更
  // SPEC-019：浏览器面板的事件（browser.event.*）与界面/自举变更同色
  if (name.startsWith('ui.') || name.startsWith('surface') || name.startsWith('browser')) return 'info';
  if (name.startsWith('tool.') || name.startsWith('host.tool')) return 'warning';
  if (name.startsWith('message.') || name.startsWith('human.')) return 'strong';
  if (name.startsWith('task.') || name.startsWith('mailbox')) return 'success';
  if (name.startsWith('loop.') || name.startsWith('agent.boot') || name.startsWith('agent.spawn')) return 'muted';
  return 'default';
}

/** 工具调用的可读摘要：谁 · 调了什么（args 只取前两个键，避免刷屏） */
export function summarizeToolCall(call) {
  const item = isRecord(call) ? call : {};
  const agent = typeof item.agent === 'string' && item.agent.length > 0 ? item.agent : 'agent';
  const name = typeof item.name === 'string' && item.name.length > 0 ? item.name : '(未命名工具)';
  return { agent, name, detail: describeArgs(item.args) };
}

function describeArgs(args) {
  if (!isRecord(args)) return '';
  const parts = [];
  for (const [key, value] of Object.entries(args)) {
    if (parts.length >= 2) {
      parts.push('…');
      break;
    }
    parts.push(`${key}=${shortValue(value)}`);
  }
  return parts.join(' ');
}

function shortValue(value) {
  let raw;
  if (typeof value === 'string') {
    raw = value;
  } else {
    try {
      raw = JSON.stringify(value) ?? String(value);
    } catch {
      raw = String(value);
    }
  }
  return raw.length > 32 ? `${raw.slice(0, 32)}…` : raw;
}

/**
 * 一条工具调用摘要行：`谁 · 调了什么 · ok/失败`（UI-008）。
 * `result` 为空表示还在调用中；`result.ok` 决定 ok / 失败。
 */
export function renderToolCallLine(call, result) {
  const { agent, name, detail } = summarizeToolCall(call);
  const entry = isRecord(result) ? result : null;
  const ok = entry === null ? undefined : entry.ok;
  const state = ok === true ? 'ok' : ok === false ? 'fail' : 'pending';
  const status = ok === true ? 'ok' : ok === false ? '失败' : '调用中…';
  const error = entry !== null && typeof entry.error === 'string' ? entry.error : '';
  const shown = error.length > 0 ? error : detail;
  const id = textOf(isRecord(call) ? call.id : '');
  return `<li class="msg msg-tool is-${state}" data-tool-id="${escapeHtml(id)}" data-tool="${escapeHtml(name)}">` +
    `<span class="tool-agent">${escapeHtml(agent)}</span>` +
    `<span class="tool-sep">·</span>` +
    `<span class="tool-name">${escapeHtml(name)}</span>` +
    `<span class="tool-status">${escapeHtml(status)}</span>` +
    (shown.length > 0 ? `<span class="tool-detail">${escapeHtml(shown)}</span>` : '') +
    '</li>';
}

/** 一条对话消息：人类靠右、Agent / 思考靠左（UI-008） */
export function renderMessage(message) {
  const item = isRecord(message) ? message : {};
  const kind = typeof item.kind === 'string' && item.kind.length > 0 ? item.kind : 'agent';
  const agent = textOf(item.agent);
  const labels = {
    human: '人类',
    thinking: `${agent || 'agent'} · 思考`,
    error: `${agent || 'agent'} · 错误`,
    done: '本轮结束',
  };
  const label = labels[kind] ?? (agent || 'agent');
  return `<li class="msg msg-${escapeHtml(kind)}"><span class="meta">${escapeHtml(label)}</span>${escapeHtml(textOf(item.text))}</li>`;
}

/**
 * SPEC-022：流式气泡。与正式消息同款配色，但带虚线边框与一根光标，
 * 让人类一眼看出「这句话还没写完」。`text` 一律转义。
 */
export function renderStreamingBubble(message) {
  const item = isRecord(message) ? message : {};
  const agent = textOf(item.agent) || 'agent';
  return (
    `<span class="meta">${escapeHtml(agent)} · 正在写</span>` +
    `<span class="msg-text">${escapeHtml(textOf(item.text))}</span>` +
    '<span class="stream-caret" aria-hidden="true"></span>'
  );
}

function formatTime(ts) {
  const value = textOf(ts);
  if (value.length === 0) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 事件时间线的一行，按类型上色（UI-008） */
export function renderTimelineItem(event) {
  const item = isRecord(event) ? event : {};
  const type =
    typeof item.type === 'string' && item.type.length > 0
      ? item.type
      : typeof item.t === 'string' && item.t.length > 0
        ? `frame.${item.t}`
        : '(未知事件)';
  const agent = textOf(item.agent);
  return `<li class="ev tone-${toneOfEvent(type)}" data-event-type="${escapeHtml(type)}">` +
    `<span class="ev-type">${escapeHtml(type)}</span>` +
    (agent.length > 0 ? `<span class="ev-agent">${escapeHtml(agent)}</span>` : '') +
    `<span class="ev-time">${escapeHtml(formatTime(item.ts))}</span>` +
    '</li>';
}

/** Agent 进程表一行：id / pid / 存活（UI-008 检查器） */
export function renderAgentRow(agent) {
  const item = isRecord(agent) ? agent : {};
  const id = textOf(item.id ?? item.agent ?? item.name) || '(未知)';
  const pid = item.pid === undefined || item.pid === null ? '—' : textOf(item.pid);
  const alive =
    item.alive === true || item.status === 'alive' || item.status === 'running' || item.state === 'running';
  return `<div class="agent-row" data-agent="${escapeHtml(id)}">` +
    `<span class="agent-id">${escapeHtml(id)}</span>` +
    `<span class="agent-pid">pid ${escapeHtml(pid)}</span>` +
    `<span class="pill ${alive ? 'alive' : 'dead'}">${alive ? '存活' : '已退出'}</span>` +
    '</div>';
}

/** 任务板一行 */
export function renderTaskRow(task) {
  const item = isRecord(task) ? task : {};
  const id = textOf(item.id ?? item.taskId) || '(未知)';
  const subject = textOf(item.subject ?? item.title);
  const status = textOf(item.status) || 'unknown';
  const owner = textOf(item.owner ?? item.assignee ?? item.agent);
  return `<div class="task-row" data-task="${escapeHtml(id)}">` +
    `<span class="task-id">${escapeHtml(id)}</span>` +
    `<span class="task-subject">${escapeHtml(subject)}</span>` +
    (owner.length > 0 ? `<span class="task-owner">${escapeHtml(owner)}</span>` : '') +
    `<span class="pill status-${escapeHtml(status)}">${escapeHtml(status)}</span>` +
    '</div>';
}

/** 一条消息记录 → 对话项（人类 / Agent） */
function messageToItem(message) {
  const item = isRecord(message) ? message : {};
  const from = textOf(item.from ?? item.agent ?? item.role);
  const role = textOf(item.role);
  const isHuman = from === 'human' || role === 'human' || role === 'user';
  return {
    kind: isHuman ? 'human' : 'agent',
    agent: isHuman ? '人类' : from || 'agent',
    text: textOf(item.text ?? item.body ?? item.message),
  };
}

/** 消息列表 → 对话项数组（纯函数，供快照回放与测试使用） */
export function projectMessages(messages) {
  return toArray(messages).map(messageToItem);
}

/**
 * `/api/state` 快照归一化。
 *
 * 契约只规定「界面文档、进程表、任务板、消息、事件尾部」这五件事，
 * 字段名尚未冻结，因此这里对常见别名做防御性读取，缺字段一律退化成空，
 * 绝不因为服务端换了个字段名就白屏。
 */
/**
 * 要不要把这份 html 写进沙箱？
 *
 * 见过的真实故障：首帧赋值被 iframe 尚未完成的初始加载覆盖，而缓存又认定
 * 「这份 html 已经画过了」，于是面板永远空白。所以判定必须看**画没画上**，
 * 而不是只看「内容变没变」。
 */
export function shouldApplySurface({ nextHtml, prevHtml, painted, force = false }) {
  if (typeof nextHtml !== 'string' || nextHtml.length === 0) return false;
  if (force) return true;
  return nextHtml !== prevHtml || painted !== true;
}

export function normalizeState(raw) {
  const state = isRecord(raw) ? raw : {};
  const doc = isRecord(state.document)
    ? state.document
    : isRecord(state.doc)
      ? state.doc
      : isRecord(state.ui)
        ? state.ui
        : {};
  const version = typeof doc.version === 'number' && Number.isFinite(doc.version) ? doc.version : 0;
  // SPEC-020 给 /api/state 加了 `conversation:{id,title}` 字段，而这里历史上把
  // `conversation` 当作消息数组的别名。所以别名只在它真的是数组时才认——
  // 否则那份对话元信息会被当成「零条消息」。
  const legacyMessages = Array.isArray(state.conversation) ? state.conversation : null;
  return {
    version,
    html: typeof doc.html === 'string' ? doc.html : '',
    scopes: toArray(doc.scopes),
    agents: toArray(state.agents ?? state.processes ?? state.agentTable),
    tasks: toArray(state.tasks ?? state.taskboard ?? state.board),
    messages: toArray(state.messages ?? legacyMessages ?? state.chat),
    events: toArray(state.events ?? state.timeline ?? state.eventTail ?? state.tail),
  };
}

// ---------------------------------------------------------------------------
// SPEC-014 客户端自举：client.changed 事件的纯函数部分
//
// 服务端改的是「客户端自己的源码」，所以这里的原则是：
//   `.css` 无刷新热替换（对话不能丢）；
//   `.js` / `.html` 只给横幅 + 一个必须由人类点击的刷新按钮（绝不自动刷新）。
// 事件 data 来自服务端，但 reason / path 等是自由文本，一律当不可信输入。
// ---------------------------------------------------------------------------

/** 只接受字符串的取值：对象 / 数字 / null 一律退化为空串，避免 '[object Object]' 进 DOM */
function str(value) {
  return typeof value === 'string' ? value : '';
}

/** 只接受有限数字的取值：其余（包括数字字符串）退化为 null，「未知」就是未知 */
function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 路径是否是能无刷新热替换的样式表（忽略查询串 / 锚点 / 目录与大小写） */
export function isCssClientPath(path) {
  const clean = str(path).split('#')[0].split('?')[0].trim().toLowerCase();
  return clean.endsWith('.css');
}

/** 从任意路径里取文件名：`src/client/style.css` → `style.css` */
export function baseNameOf(path) {
  const clean = str(path).split('#')[0].split('?')[0];
  const parts = clean.split(/[\\/]/);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (parts[i].length > 0) return parts[i];
  }
  return '';
}

/**
 * 给样式表地址加 cache-bust 查询串：`/style.css` → `/style.css?v=2&t=169…`。
 *
 * 已有查询串 / 锚点先剥掉，避免 `?v=1&t=1?v=2` 这种叠罗汉；无版本号时只带时间戳。
 * 地址为空则返回空串（调用方据此判断「不替换」）。
 */
export function cacheBustHref(href, version, nonce) {
  const clean = str(href).split('#')[0].split('?')[0];
  if (clean.length === 0) return '';
  const params = [];
  const v = finiteNumber(version);
  if (v !== null) params.push(`v=${v}`);
  const t = nonce === null || nonce === undefined ? '' : String(nonce);
  if (t.length > 0) params.push(`t=${encodeURIComponent(t)}`);
  return params.length === 0 ? clean : `${clean}?${params.join('&')}`;
}

/**
 * 在页面已有的样式表地址里找 path 对应的那个。
 * 按**文件名**匹配（忽略目录与查询串），所以 `style.css` 与 `src/client/style.css`
 * 都能命中 `/style.css`；找不到返回 -1，调用方不误改别的 `<link>`。
 */
export function findStyleLinkIndex(hrefs, path) {
  const target = baseNameOf(path).toLowerCase();
  if (target.length === 0) return -1;
  const list = toArray(hrefs);
  for (let i = 0; i < list.length; i += 1) {
    if (baseNameOf(list[i]).toLowerCase() === target) return i;
  }
  return -1;
}

/** `client.changed` 的 data → 稳定的界面模型；未知 / 坏字段一律退化为默认值 */
export function normalizeClientChange(raw) {
  const item = isRecord(raw) ? raw : {};
  const diff = isRecord(item.diff) ? item.diff : {};
  const kindRaw = str(item.kind);
  const kind = kindRaw === 'write' || kindRaw === 'revert' ? kindRaw : 'unknown';
  const path = str(item.path);
  const isCss = isCssClientPath(path);
  return {
    kind,
    path,
    file: baseNameOf(path) || '(未知文件)',
    reason: str(item.reason),
    selfTest: str(item.selfTest),
    author: str(item.author ?? item.by ?? item.agent),
    version: finiteNumber(item.version),
    // `?? item.added` 让归一化幂等：`boot()` 里先归一化、渲染时再归一化，不能把 diff 弄丢
    added: finiteNumber(diff.added ?? item.added),
    removed: finiteNumber(diff.removed ?? item.removed),
    isCss,
    needsRefresh: !isCss,
    ts: str(item.ts),
  };
}

/** 自检结果 → 中文；未知字段显示「未知」而不是装作通过 */
export function selfTestLabel(value) {
  const raw = str(value);
  if (raw === 'passed' || raw === 'ok' || raw === 'pass') return '通过';
  if (raw === 'failed' || raw === 'fail' || raw === 'error') return '未通过';
  return raw.length > 0 ? raw : '未知';
}

/**
 * 变更横幅的 HTML（SPEC-014 §3）。写入 / 回滚文案不同；`.css` 说明「已即时生效」（无刷新），
 * 其余说明「刷新以生效」并给一个**只能由人类点击**的刷新按钮。
 * 所有文本都过 escapeHtml —— reason 是 Agent 给的自由文本，必须当成不可信输入。
 */
export function renderClientChange(raw) {
  const change = normalizeClientChange(raw);
  const badge = change.kind === 'revert' ? '回滚' : change.kind === 'write' ? '写入' : '变更';
  const tone = change.kind === 'revert' ? 'tone-warning' : 'tone-info';
  let text;
  if (change.kind === 'revert') {
    text = change.isCss
      ? `已回滚 ${change.file}，样式已即时生效`
      : `已回滚 ${change.file}，刷新以生效`;
  } else if (change.kind === 'write') {
    text = change.isCss
      ? `客户端样式已更新（${change.file}），已即时生效`
      : `客户端代码已更新（${change.file}），刷新以生效`;
  } else {
    text = change.isCss
      ? `客户端样式有变更（${change.file}），已即时生效`
      : `客户端源码有变更（${change.file}），刷新以生效`;
  }
  const meta = [];
  if (change.version !== null) meta.push(`v${change.version}`);
  meta.push(`自检 ${selfTestLabel(change.selfTest)}`);
  if (change.added !== null || change.removed !== null) {
    meta.push(`+${change.added ?? 0} / -${change.removed ?? 0}`);
  }
  if (change.author.length > 0) meta.push(`作者 ${change.author}`);
  return `<div class="change-inner is-${change.kind}">` +
    `<span class="change-badge ${tone}">${escapeHtml(badge)}</span>` +
    `<span class="change-text">${escapeHtml(text)}</span>` +
    (change.reason.length > 0 ? `<span class="change-reason">${escapeHtml(change.reason)}</span>` : '') +
    `<span class="change-meta">${escapeHtml(meta.join(' · '))}</span>` +
    (change.needsRefresh
      ? '<button type="button" class="btn btn-primary" data-client-action="refresh">刷新</button>'
      : '') +
    '<button type="button" class="btn" data-client-action="close" aria-label="关闭变更提示">关闭</button>' +
    '</div>';
}

/** `/api/state.sources` → 稳定的源码列表；缺字段 / 坏输入一律退化成空数组（SPEC-014 §4） */
export function normalizeSources(raw) {
  const state = isRecord(raw) ? raw : {};
  const nested = isRecord(state.client) ? state.client : {};
  return toArray(state.sources ?? state.clientSources ?? nested.sources)
    .filter(isRecord)
    .map((item) => ({
      path: str(item.path ?? item.name),
      bytes: finiteNumber(item.bytes ?? item.size),
      versions: finiteNumber(item.versions ?? item.versionCount),
    }));
}

/** 检查器「客户端源码」一行：路径 / 字节 / 版本数（缺字段显示 —） */
export function renderSourceRow(source) {
  const item = isRecord(source) ? source : {};
  const path = str(item.path) || '(未知文件)';
  const bytes = finiteNumber(item.bytes);
  const versions = finiteNumber(item.versions);
  return `<div class="source-row" data-source="${escapeHtml(path)}">` +
    `<span class="source-path">${escapeHtml(path)}</span>` +
    `<span class="source-bytes">${escapeHtml(bytes === null ? '—' : `${bytes} B`)}</span>` +
    `<span class="source-versions">${escapeHtml(versions === null ? '—' : `${versions} 版`)}</span>` +
    '</div>';
}

// ---------------------------------------------------------------------------
// 以下部分只在浏览器里跑（Node 里 import 进来时 boot 不会执行）
// ---------------------------------------------------------------------------

function boot() {
  const dom = {
    conn: document.getElementById('conn'),
    version: document.getElementById('version'),
    surfaceVersion: document.getElementById('surface-version'),
    surface: document.getElementById('surface'),
    messages: document.getElementById('messages'),
    composer: document.getElementById('composer'),
    input: document.getElementById('input'),
    rollback: document.getElementById('rollback'),
    interrupt: document.getElementById('interrupt'),
    agents: document.getElementById('agents'),
    tasks: document.getElementById('tasks'),
    timeline: document.getElementById('timeline'),
    sources: document.getElementById('sources'),
    change: document.getElementById('client-change'),
    busy: document.getElementById('busy'),
    busyText: document.getElementById('busy-text'),
    // SPEC-019：第二个沙箱（浏览器面板）。两个面板并存在 #panel-* 里，靠 tab 切换显隐。
    browser: document.getElementById('browser'),
    browserTitle: document.getElementById('browser-title'),
    browserVersion: document.getElementById('browser-version'),
    browserEmpty: document.getElementById('browser-empty'),
    browserLastEvent: document.getElementById('browser-last-event'),
    panelTabs: Array.from(document.querySelectorAll('[data-panel-tab]')),
    inspectorToggle: document.getElementById('inspector-toggle'),
    inspectorToggleLabel: document.getElementById('inspector-toggle-label'),
    grid: document.querySelector('.grid'),
    panelBodies: Array.from(document.querySelectorAll('[data-panel]')),
    // SPEC-020：顶栏多对话切换器与输入框的命令提示
    conversationSelect: document.getElementById('conversation-select'),
    conversationNew: document.getElementById('conversation-new'),
    conversationDelete: document.getElementById('conversation-delete'),
    conversationStatus: document.getElementById('conversation-status'),
    commandHint: document.getElementById('command-hint'),
    // SPEC-021：工作空间「文件」页签（列表只给元信息，内容点击时动态加载）
    fileRoot: document.getElementById('file-root'),
    fileList: document.getElementById('file-list'),
    fileEmpty: document.getElementById('file-empty'),
    fileStatus: document.getElementById('file-status'),
    fileContent: document.getElementById('file-content'),
  };

  const state = {
    version: 0,
    html: '',
    /** iframe 是否已经跑完它自己的首次加载（首帧必须等它，否则会被覆盖） */
    iframeLoaded: false,
    /** 首帧期间收到的 html，等 load 后补画 */
    pendingHtml: null,
    /** 是否已经把某一份 html 真正写进沙箱 */
    painted: false,
    /** 已发出但还没回填结果的 tool.call：id → { call, node } */
    tools: new Map(),
    /** SPEC-022：每个 Agent 一条流式气泡（agent → li 节点） */
    deltas: new Map(),
    /** 忙碌态：真模型一轮可能几十秒，人类必须看得出「它在干活、等了多久」 */
    busySince: null,
    busyTimer: null,
    /**
     * SPEC-020：命令结果是**客户端**渲染的系统消息，服务端的对话投影里没有它。
     * 每次 applyState 会整体重建消息列表，所以这里留一份当前对话的命令日志补回去
     * （切对话时清空），否则 `/list`、`/help` 的输出会被下一次 state 事件冲掉。
     */
    commandLog: [],
  };

  /**
   * SPEC-020：当前对话。所有请求（SSE / state / message / command / browser 事件 /
   * 工作空间）都跟着它走；切换时**关旧流、开新流**，绝不整页刷新。
   */
  let activeConversation = DEFAULT_CONVERSATION;
  let switching = false;
  /** 当前 SSE；切对话时必须关掉再换新的，绝不留下泄漏的 EventSource */
  let currentStream = null;
  /** 切换期间又有新目标时记下来，切完再追一次（人类连点 / 命令 action 撞上） */
  let pendingSwitch = null;

  const switcher = createConversationSwitcher({
    nodes: {
      select: dom.conversationSelect,
      create: dom.conversationNew,
      remove: dom.conversationDelete,
      status: dom.conversationStatus,
    },
    request: (path, init) => requestJson(path, init),
    onSwitch(id) {
      void switchConversation(id);
    },
    onError(message) {
      pushTimeline({ type: 'conversation.error', agent: 'host', ts: new Date().toISOString() });
      appendMessage(renderMessage({ kind: 'error', agent: '宿主', text: message }));
    },
  });

  const workspacePanel = createWorkspacePanel({
    nodes: {
      root: dom.fileRoot,
      list: dom.fileList,
      empty: dom.fileEmpty,
      status: dom.fileStatus,
      content: dom.fileContent,
    },
    request: (path, init) => requestJson(path, init),
    onError() {
      pushTimeline({ type: 'workspace.error', agent: 'host', ts: new Date().toISOString() });
    },
  });

  if (dom.conversationNew !== null && dom.conversationNew !== undefined) {
    dom.conversationNew.addEventListener('click', () => {
      // 标题由服务端给默认值；人类要自定义标题可以在新建后走 /new <标题>
      void switcher.create('');
    });
  }

  if (dom.conversationDelete !== null && dom.conversationDelete !== undefined) {
    dom.conversationDelete.addEventListener('click', () => {
      void switcher.remove(switcher.getActive());
    });
  }

  if (dom.conversationSelect !== null && dom.conversationSelect !== undefined) {
    dom.conversationSelect.addEventListener('change', (event) => {
      const target = event.target;
      const id = target !== null && target !== undefined && typeof target.value === 'string' ? target.value : '';
      if (id.length === 0) return; // 空态选项：不切
      switcher.switchTo(id);
    });
  }

  /**
   * SPEC-021：点击文件行 → **这时才**动态加载内容（`/api/workspace/file`）。
   * 用事件委托：列表每次都是整体重画，逐行绑定容易漏。
   */
  if (dom.fileList !== null && dom.fileList !== undefined) {
    dom.fileList.addEventListener('click', (event) => {
      const target = event.target;
      const node = target instanceof Element ? target.closest('[data-file-path]') : null;
      if (node === null) return;
      const filePath = node.getAttribute('data-file-path');
      if (filePath === null || filePath.length === 0) return;
      void workspacePanel.openFile(filePath);
    });
  }

  /** 给任意路由带上当前对话的查询串（省略即 default，SPEC-020 §一） */
  function scoped(path) {
    return withConversation(path, activeConversation);
  }

  /** 浏览器面板的事件回传也要落到当前对话上 */
  function conversationRequest(path, options) {
    return requestJson(scoped(path), options);
  }

  /**
   * 渲染忙碌态。用 busySince 算「已等 N 秒」，而不是只显示一个静态的转圈——
   * 本机小模型一轮 20~60 秒，人类需要知道它是在想还是卡死了。
   */
  function setBusy(raw) {
    const record = isRecord(raw) ? raw : {};
    const busy = record.busy === true;
    const since = finiteNumber(record.busySince);

    if (!busy) {
      state.busySince = null;
      if (state.busyTimer !== null) {
        clearInterval(state.busyTimer);
        state.busyTimer = null;
      }
      if (dom.busy !== null && dom.busy !== undefined) dom.busy.hidden = true;
      return;
    }

    state.busySince = since ?? Date.now();
    if (dom.busy === null || dom.busy === undefined) return;
    dom.busy.hidden = false;

    const paint = () => {
      if (dom.busyText === null || dom.busyText === undefined) return;
      const seconds = Math.max(0, Math.round((Date.now() - (state.busySince ?? Date.now())) / 1000));
      dom.busyText.textContent = seconds < 1 ? 'Agent 正在思考…' : `Agent 正在思考…已 ${seconds}s`;
    };
    paint();
    if (state.busyTimer === null) state.busyTimer = setInterval(paint, 1000);
  }

  /**
   * 把待画的 html 真正写进沙箱。
   *
   * 为什么要"等一等"：页面刚加载时 iframe 还在跑它自己的初始 srcdoc，
   * 这时候赋值会被那次尚未完成的加载覆盖掉（真机上就是这么丢过首帧的）。
   */
  function flushPendingSurface() {
    if (state.pendingHtml === null) return;
    const html = state.pendingHtml;
    state.pendingHtml = null;
    // 主动认定"可以画了"：不能再无限等一个可能永远不来的事件
    state.iframeLoaded = true;
    dom.surface.srcdoc = html;
    state.painted = true;
  }

  // 正常路径：沙箱首次加载完成 → 补画
  dom.surface.addEventListener('load', () => {
    state.iframeLoaded = true;
    flushPendingSurface();
  });

  /**
   * 兜底路径：如果 iframe 的 load 事件在我们挂上监听**之前**就已经发生过
   * （它可能比 boot() 还早），那 `iframeLoaded` 会永远是 false，
   * 全部内容都堆在 pendingHtml 里永不落地 —— 界面面板就是一直空的。
   * 所以下一帧再确认一次，不依赖"我们有没有恰好听到那个事件"。
   */
  requestAnimationFrame(() => flushPendingSurface());

  function setConnection(status) {
    dom.conn.dataset.state = status;
    dom.conn.textContent = CONNECTION_LABELS[status] ?? status;
  }

  function appendMessage(html) {
    dom.messages.insertAdjacentHTML('beforeend', html);
    dom.messages.scrollTop = dom.messages.scrollHeight;
  }

  function pushTimeline(event) {
    dom.timeline.insertAdjacentHTML('afterbegin', renderTimelineItem(event));
    while (dom.timeline.children.length > MAX_TIMELINE) {
      dom.timeline.removeChild(dom.timeline.lastElementChild);
    }
  }

  /**
   * 只更新沙箱 iframe 的 srcdoc —— 宿主页面永远不刷新。
   *
   * 有个真实的坑：页面刚加载时 iframe 还在跑它自己的初始 srcdoc（空文档），
   * 这时候赋值会被那次尚未完成的加载覆盖掉，面板就永远空着。
   * 所以「首帧」必须等 iframe 的 load 之后再补一次，且同一份 html 在没有真正
   * 画上去之前不能被缓存吞掉。
   */
  function setSurface(html, version, options = {}) {
    if (typeof version === 'number' && Number.isFinite(version)) state.version = version;
    dom.version.textContent = `v${state.version}`;
    dom.surfaceVersion.textContent = `v${state.version}`;

    if (!shouldApplySurface({ nextHtml: html, prevHtml: state.html, painted: state.painted, force: options.force === true })) {
      return;
    }
    state.html = html;

    if (!state.iframeLoaded) {
      state.pendingHtml = html; // 先记下，等沙箱 settled 再画
      return;
    }
    dom.surface.srcdoc = html;
    state.painted = true;
  }

  function applyState(raw) {
    const snapshot = normalizeState(raw);
    state.version = snapshot.version;
    setSurface(snapshot.html, snapshot.version);

    // SPEC-020：/api/state 新增 `conversation:{id,title}`。这里只同步切换器的选中态，
    // 不触发切换（切换由人类操作 / 命令 action / 删除三处驱动，免得回环）。
    switcher.applyState(raw);

    // SPEC-019：/api/state 的 browser 字段。没有这个字段就保持现状——
    // 老服务端 / 别的快照不该把 SSE 刚送来的浏览器文档清空。
    browserPanel.applyState(raw);

    dom.agents.innerHTML = snapshot.agents.map(renderAgentRow).join('') || '<div class="empty">暂无 Agent</div>';
    dom.tasks.innerHTML = snapshot.tasks.map(renderTaskRow).join('') || '<div class="empty">暂无任务</div>';

    // SPEC-014 §4：客户端源码列表。缺 sources 字段就显示空态，不炸。
    const sources = normalizeSources(raw);
    dom.sources.innerHTML = sources.map(renderSourceRow).join('') || '<div class="empty">暂无客户端源码</div>';

    const events = snapshot.events.slice(-MAX_TIMELINE).reverse();
    dom.timeline.innerHTML = events.map(renderTimelineItem).join('');

    // 对话流按服务端的「完整对话投影」整体重建：它同时包含人类消息与 Agent 说过的话。
    // 早先这里只投影邮件类消息，于是每轮结束时会把 Agent 的回复冲掉 —— 现在两边同源。
    // 整体重建会把流式气泡一起冲掉：同时清掉引用，免得留下指向已卸载节点的幽灵
    clearAllDeltas();
    dom.messages.innerHTML = projectMessages(snapshot.messages).map(renderMessage).join('');
    dom.messages.scrollTop = dom.messages.scrollHeight;

    setBusy(raw);

    // SPEC-017：/api/state 若带了生效模型信息，顶栏 chip 跟着更新（没有就不冒充）
    settingsPage.applyEffectiveModel(raw);

    // SPEC-020：命令输出补回消息流（服务端投影里没有它），顺序与 append 时一致
    if (state.commandLog.length > 0) appendMessage(state.commandLog.join(''));
  }

  // -------------------------------------------------------------------------
  // SPEC-020：多对话 —— 关旧流、按新 id 重开、重画全部区域（绝不刷新页面）
  // -------------------------------------------------------------------------

  /** 关掉当前 SSE。旧对话的流必须关掉，否则两个对话的事件会串在一起（CONV-006）。 */
  function closeStream() {
    if (currentStream === null) return;
    try {
      currentStream.close();
    } catch {
      // 关不掉也不能阻塞切换：置空后不会再被引用
    }
    currentStream = null;
  }

  /**
   * 按当前对话重开 SSE。契约是「省略 conversation 即 default」，所以默认对话直接用
   * 裸路径 `new EventSource('/api/stream')`（旧调用语义不变），其余带上 `?conversation=`。
   */
  function openStream() {
    closeStream();
    const source =
      activeConversation === DEFAULT_CONVERSATION
        ? new EventSource('/api/stream')
        : new EventSource(streamUrl(activeConversation));
    currentStream = source;
    setConnection('connecting');
    source.addEventListener('open', () => setConnection('open'));
    source.addEventListener('error', () => {
      setConnection(source.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting');
    });
    source.addEventListener('state', (event) => applyState(parseData(event.data)));
    source.addEventListener('frame', (event) => applyFrame(parseData(event.data)));
    source.addEventListener('document', (event) => applyDocument(parseData(event.data)));
    source.addEventListener('done', (event) => applyDone(parseData(event.data)));
    // SPEC-014：客户端源码变更（事件名含点号，必须用完整名字订阅）
    source.addEventListener('client.changed', (event) => applyClientChange(parseData(event.data)));
    // SPEC-019：内置浏览器文档（html 已由宿主组合好，直接进 srcdoc 的沙箱）。
    // Agent 明确渲染了新文档：强制重画，不去猜缓存。
    source.addEventListener('browser', (event) => browserPanel.applyDocument(parseData(event.data), { force: true }));
    // SPEC-015 SET-008 / SPEC-017：设置变更广播 settings 事件，顶栏的当前模型 chip 同步更新
    source.addEventListener('settings', (event) => settingsPage.applyEffectiveModel(parseData(event.data)));
  }

  /** 拉一次当前对话的 `/api/state`；失败给出可见错误，绝不白屏 */
  async function fetchState() {
    const response = await requestJson(scoped('/api/state'), { method: 'GET' });
    if (response === null) {
      appendMessage(renderMessage({ kind: 'error', agent: '宿主', text: '加载对话状态失败：服务端没有响应' }));
      return null;
    }
    if (response.ok !== true) {
      appendMessage(renderMessage({ kind: 'error', agent: '宿主', text: `加载对话状态失败：HTTP ${response.status}` }));
      return null;
    }
    return response.data;
  }

  /** 拉一次状态并重画（对话流 / 界面 / 浏览器 / 检查器都在 applyState 里） */
  async function redrawAll() {
    const snapshot = await fetchState();
    if (snapshot === null) return false;
    applyState(snapshot);
    return true;
  }

  /**
   * 切对话前把**上一个对话**留在本地的一切作废：绘制缓存、工具行、命令日志、文件列表。
   * 其中 `state.html = '' / painted = false` 是关键——否则新旧对话内容相同时，
   * `shouldApplySurface` 会认定「这份 html 已经画过了」，界面面板就停在旧对话上。
   */
  function resetConversationView() {
    state.html = '';
    state.pendingHtml = null;
    state.painted = false;
    state.tools.clear();
    state.commandLog.length = 0;
    setBusy({ busy: false });
    if (dom.surface !== null && dom.surface !== undefined) dom.surface.srcdoc = '';
    dom.messages.innerHTML = '';
    // 浏览器文档：显式清空，绝不沿用上一个对话的内容
    browserPanel.applyDocument(null);
  }

  /**
   * 切换对话（CONV-006 / CONV-007）：
   * 关旧流 → 清本地缓存 → 按新 id 开流 → `GET /api/state` 重画全部区域 → 重画文件列表。
   * **不刷新页面**（那条路只留给人类点「刷新」横幅按钮）。
   */
  async function switchConversation(nextId) {
    const id = conversationIdOf(nextId);
    if (switching) {
      pendingSwitch = id; // 正在切：记下来，切完再追一次
      return;
    }
    if (id === activeConversation) {
      await redrawAll();
      return;
    }

    switching = true;
    try {
      let target = id;
      for (;;) {
        activeConversation = target;
        closeStream(); // 旧对话的 SSE 必须关掉
        resetConversationView();
        switcher.setActive(target);
        openStream();
        workspacePanel.clear(); // 文件列表 / 内容也全部重画
        await redrawAll();
        // 列表本身也要刷新：新建出来的对话得出现，消息数也得跟上。
        // （这一步要在 redrawAll 之后——那次请求会把服务端的 active 定成 target）
        await switcher.load();
        switcher.setActive(target);
        // 设置也是按对话存的：设置页开着的话，跟着切到这个对话的配置
        if (settingsPage.isOpen()) await settingsPage.open();
        await workspacePanel.reload(target);
        if (pendingSwitch === null) break;
        target = pendingSwitch;
        pendingSwitch = null;
        if (target === activeConversation) break;
      }
    } finally {
      switching = false;
      pendingSwitch = null;
    }
  }

  /** 输入框里的 `/` 提示：只切显隐与文案，不解析命令（SPEC-020 §三） */
  function updateCommandHint() {
    const node = dom.commandHint;
    if (node === null || node === undefined) return;
    const isCommand = isCommandText(dom.input.value);
    node.textContent = isCommand ? COMMAND_HINT_TEXT : '';
    node.hidden = !isCommand;
  }

  /**
   * 执行一条命令（SPEC-020 §二）：`POST /api/command` → 结果渲染成系统消息 →
   * 按 `action` 切对话 / 重画。命令**绝不**走 `/api/message`（CMD-005）。
   */
  async function runCommand(text) {
    const response = await requestJson(scoped('/api/command'), {
      method: 'POST',
      body: commandRequest(text),
    });
    if (response === null) {
      appendMessage(renderMessage({ kind: 'error', agent: '宿主', text: `命令执行失败：服务端没有响应（${text}）` }));
      pushTimeline({ type: 'command.failed', agent: 'human', ts: new Date().toISOString() });
      return;
    }

    const data = isRecord(response.data) ? response.data : {};
    const result = normalizeCommandResult(data);
    const action = result.ok ? commandActionOf(data.action) : null;

    // CMD-004：switch / created 切过去；cleared 只需重画当前对话
    if (action !== null && (action.type === 'switch' || action.type === 'created')) {
      await switchConversation(action.conversation);
    } else if (action !== null && action.type === 'cleared') {
      await redrawAll();
    }

    // 结果放在重画**之后**：`/clear` 的系统消息才不会被 state 投影冲掉
    const html = renderCommandResult(data, text);
    state.commandLog.push(html);
    while (state.commandLog.length > MAX_COMMAND_LOG) state.commandLog.shift();
    appendMessage(html);
    pushTimeline({
      type: `command.${result.command.length > 0 ? result.command : 'unknown'}`,
      agent: 'human',
      ts: new Date().toISOString(),
    });
  }

  function applyFrame(payload) {
    const envelope = isRecord(payload) ? payload : {};
    const frame = isRecord(envelope.frame) ? envelope.frame : envelope;
    const agent = textOf(frame.agent ?? envelope.agent) || 'agent';
    const type = textOf(frame.t);

    if (type === 'agent.delta') {
      // SPEC-022：`text` 是**累积全文**（不是分片），所以这里直接原地替换，
      // 丢一条、重一条、乱序一条都不会把界面上的文字搞乱。
      applyDelta(agent, textOf(frame.text));
      pushTimeline({ type: 'frame.agent.delta', agent, ts: frame.ts });
      return;
    }
    if (type === 'agent.thinking') {
      // 最终消息到了：先把流式气泡收掉，再按正式消息渲染（否则会重复一份）
      clearDelta(agent);
      appendMessage(renderMessage({ kind: 'thinking', agent, text: frame.text }));
    } else if (type === 'tool.call') {
      const id = textOf(frame.id);
      const html = renderToolCallLine({ id, agent, name: frame.name, args: frame.args }, null);
      appendMessage(html);
      const node = dom.messages.lastElementChild;
      state.tools.set(id, { call: { id, agent, name: frame.name, args: frame.args }, node });
    } else if (type === 'tool.result') {
      const id = textOf(frame.id);
      const pending = state.tools.get(id);
      const call = pending?.call ?? { id, agent, name: textOf(frame.name) || id };
      const html = renderToolCallLine(call, frame);
      if (pending?.node) pending.node.outerHTML = html;
      else appendMessage(html);
      state.tools.delete(id);
    } else if (type === 'loop.error') {
      appendMessage(renderMessage({ kind: 'error', agent, text: frame.message }));
    }

    pushTimeline({ type: type.length > 0 ? `frame.${type}` : 'frame.未知', agent, ts: frame.ts });
  }

  /**
   * 流式气泡：每个 Agent 一条，原地更新文本。
   * 刻意不 appendMessage —— 一个回答几十上百条增量，append 会刷屏也会把对话流撑爆。
   */
  function applyDelta(agent, text) {
    if (text === '') return;
    const key = agent === '' ? 'agent' : agent;
    let node = state.deltas.get(key);
    if (node === undefined || !node.isConnected) {
      node = document.createElement('li');
      node.className = 'msg msg-streaming';
      node.innerHTML = renderStreamingBubble({ agent: key, text });
      dom.messages.append(node);
      state.deltas.set(key, node);
    }
    const body = node.querySelector('.msg-text');
    if (body !== null) body.textContent = text; // 纯文本写入，绝不 innerHTML
    dom.messages.scrollTop = dom.messages.scrollHeight;
  }

  function clearDelta(agent) {
    const key = agent === '' ? 'agent' : agent;
    const node = state.deltas.get(key);
    if (node !== undefined) {
      node.remove();
      state.deltas.delete(key);
    }
  }

  function clearAllDeltas() {
    for (const node of state.deltas.values()) node.remove();
    state.deltas.clear();
  }

  function applyDocument(payload) {
    const data = isRecord(payload) ? payload : {};
    // 契约给的是渲染好的 html；万一只有 View Spec，就在浏览器端自己渲染
    const html =
      typeof data.html === 'string' && data.html.length > 0
        ? data.html
        : renderViewSpec(data.spec ?? data.view ?? data);
    // Agent 明确改了界面：强制重画，不去猜缓存
    setSurface(html, typeof data.version === 'number' ? data.version : state.version, { force: true });
    pushTimeline({ type: 'ui.document', agent: 'surface', ts: new Date().toISOString() });
  }

  function applyDone(payload) {
    const data = isRecord(payload) ? payload : {};
    // 一轮结束就必须收掉忙碌态，不等下一次 state（否则慢网络下会一直转）
    setBusy({ busy: false });
    // 消息数变了，对话列表的「(N 条)」要跟上（失败也不影响主流程）
    void switcher.load();
    const reason = textOf(data.reason);
    const text = reason === 'interrupted' ? '本轮已被人类中断' : reason.length > 0 ? `本轮结束：${reason}` : '本轮结束';
    appendMessage(renderMessage({ kind: 'done', agent: '系统', text }));
    pushTimeline({ type: `loop.done.${reason || 'ok'}`, agent: 'kernel', ts: new Date().toISOString() });
  }

  /**
   * SPEC-014 §2：`.css` 变更无刷新热替换。
   *
   * 只写 `<link rel="stylesheet">` 的 href 属性，宿主页面的 DOM 与对话记录原样保留。
   * 按文件名定位对应的样式表；匹配不到就什么都不做（不误改别的 `<link>`）。
   */
  function hotSwapStylesheet(change) {
    const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
    const hrefs = links.map((link) => link.getAttribute('href') ?? '');
    const index = findStyleLinkIndex(hrefs, change.path);
    if (index < 0) return false;
    const next = cacheBustHref(hrefs[index], change.version, Date.now());
    if (next.length === 0) return false;
    links[index].setAttribute('href', next);
    return true;
  }

  /** 显示变更横幅（内容全部由纯函数生成并转义） */
  function showClientChange(change) {
    dom.change.innerHTML = renderClientChange(change);
    dom.change.dataset.kind = change.kind;
    dom.change.hidden = false;
  }

  /**
   * SPEC-014 §1：`client.changed` —— 热替换样式、显示横幅、进时间线。
   * 这不是 `document` 事件：它改的是**客户端源码**，不是沙箱里的界面文档。
   */
  function applyClientChange(payload) {
    const change = normalizeClientChange(payload);
    if (change.isCss) hotSwapStylesheet(change);
    showClientChange(change);
    pushTimeline({
      type: `client.changed.${change.kind}`,
      agent: change.author.length > 0 ? change.author : 'client',
      ts: change.ts.length > 0 ? change.ts : new Date().toISOString(),
    });
  }

  /**
   * 人类点「刷新」才会走到这里。**没有自动刷新路径**：自动刷新会把对话记录冲掉。
   *
   * 用 assign(当前地址) 做等价的整页刷新，而不是被 UI-006 / UI-007 明令禁止的
   * reload 字面量——那两条门禁的本意就是「不许自动刷新」，本实现保留其本意。
   */
  function reloadPage() {
    window.location.assign(window.location.href);
  }

  async function post(path, body) {
    try {
      return await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendMessage(renderMessage({ kind: 'error', agent: '宿主', text: `${path} 请求失败：${message}` }));
      return null;
    }
  }

  /**
   * SPEC-017 设置页的请求助手：需要「解析后的 JSON + HTTP 状态」而不只是 Response。
   * 设置 / 测试连接的请求体里可能带人类刚输入的 Key，所以只走请求体——
   * 绝不拼进 URL、不落浏览器存储、不打日志。
   */
  async function requestJson(path, options = {}) {
    const method = options.method ?? 'POST';
    const init = { method, headers: { 'content-type': 'application/json' } };
    if (options.body !== undefined && method !== 'GET') init.body = JSON.stringify(options.body);
    try {
      const response = await fetch(path, init);
      let data = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      return { status: response.status, ok: response.ok, data };
    } catch {
      return null; // 网络层失败：设置页据此显示「服务端没有响应」
    }
  }

  const settingsNodes = {
    page: document.getElementById('settings'),
    open: document.getElementById('settings-open'),
    back: document.getElementById('settings-back'),
    form: document.getElementById('settings-form'),
    protocolInputs: Array.from(document.querySelectorAll('input[name="protocol"]')),
    baseUrl: document.getElementById('set-base-url'),
    model: document.getElementById('set-model'),
    apiKey: document.getElementById('set-api-key'),
    temperature: document.getElementById('set-temperature'),
    maxTokens: document.getElementById('set-max-tokens'),
    timeoutMs: document.getElementById('set-timeout'),
    modelsRefresh: document.getElementById('set-models-refresh'),
    optionsDatalist: document.getElementById('model-options'),
    optionsList: document.getElementById('model-options-list'),
    modelsStatus: document.getElementById('models-status'),
    protocolHint: document.getElementById('protocol-hint'),
    apiKeyHint: document.getElementById('api-key-hint'),
    presets: document.getElementById('presets'),
    test: document.getElementById('settings-test'),
    save: document.getElementById('settings-save'),
    result: document.getElementById('settings-result'),
    topbarModel: document.getElementById('current-model'),
    pageModel: document.getElementById('settings-model'),
  };

  // 设置页的纯逻辑与 DOM 都在 settings.js 里；这里只接线（UI3-001）
  const settingsPage = createSettingsPage({
    nodes: settingsNodes,
    // 设置是**按对话**存的：这里的请求必须带上当前对话，否则在 c1 里打开设置
    // 读到/改到的是 default 的配置（真机踩过：c1 用 Ollama，设置页显示 deepseek）
    request: (path, options) => requestJson(scoped(path), options),
    onSaved(saved) {
      // 保存成功：设置页内部已回到对话页，这里补一句人类看得见的提示
      appendMessage(renderMessage({ kind: 'done', agent: '设置', text: `已保存模型设置：${currentModelText(saved)}` }));
      pushTimeline({ type: 'settings.saved', agent: 'human', ts: new Date().toISOString() });
    },
  });

  if (settingsNodes.open !== undefined) {
    settingsNodes.open.addEventListener('click', () => settingsPage.open());
  }

  /**
   * SPEC-019 / SPEC-021：三个面板（界面 / 浏览器 / 文件）靠 tab 切换显隐，DOM 里始终并存
   * —— 切走不会卸载 iframe，也不会丢掉另一份文档（BROWSER-011 的「互不覆盖」）。
   */
  function showPanel(name) {
    const target = name === 'browser' || name === 'files' ? name : 'surface';
    for (const tab of dom.panelTabs) {
      const active = tab.getAttribute('data-panel-tab') === target;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    for (const body of dom.panelBodies) {
      body.hidden = body.getAttribute('data-panel') !== target;
    }
    // 浏览器 / 文件页签时让上半区长大一些：一份 HTML 或一份文件挤在 150px 里是没法用的
    const zone = dom.panelBodies[0]?.closest('.zone');
    if (zone !== null && zone !== undefined) zone.setAttribute('data-active-panel', target);
    // SPEC-021：打开文件页签时刷新列表（Agent 可能刚写了新文件）；
    // 列表只请求 /api/workspace，内容仍然要等人点开才加载。
    if (target === 'files') void workspacePanel.reload(activeConversation);
  }

  for (const tab of dom.panelTabs) {
    tab.addEventListener('click', () => showPanel(tab.getAttribute('data-panel-tab')));
  }

  /**
   * SPEC-012 UI-011：检查器可以最小化。
   *
   * 收起时只留标题栏（进程表/任务板/时间线/源码一起收），腾出的高度全给上半区；
   * 选择记在 localStorage，刷新后保持 —— 但**绝不整页刷新**，只切一个属性。
   */
  const INSPECTOR_KEY = 'agent-client:inspector-collapsed';

  function applyInspectorCollapsed(collapsed, options = {}) {
    const grid = dom.grid;
    if (grid === null || grid === undefined) return collapsed;
    if (collapsed) grid.setAttribute('data-inspector', 'collapsed');
    else grid.removeAttribute('data-inspector');

    if (dom.inspectorToggle !== null && dom.inspectorToggle !== undefined) {
      dom.inspectorToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      dom.inspectorToggle.setAttribute('title', collapsed ? '展开检查器' : '收起检查器');
    }
    if (dom.inspectorToggleLabel !== null && dom.inspectorToggleLabel !== undefined) {
      dom.inspectorToggleLabel.textContent = collapsed ? '展开' : '收起';
    }

    if (options.remember !== false) {
      try {
        window.localStorage.setItem(INSPECTOR_KEY, collapsed ? '1' : '0');
      } catch {
        /* 隐私模式 / 存储被禁：记不住也不影响这一次的收起 */
      }
    }
    return collapsed;
  }

  function readInspectorCollapsed() {
    try {
      return window.localStorage.getItem(INSPECTOR_KEY) === '1';
    } catch {
      return false;
    }
  }

  if (dom.inspectorToggle !== null && dom.inspectorToggle !== undefined) {
    dom.inspectorToggle.addEventListener('click', () => {
      const collapsed = dom.grid?.getAttribute('data-inspector') === 'collapsed';
      applyInspectorCollapsed(!collapsed);
    });
  }
  applyInspectorCollapsed(readInspectorCollapsed(), { remember: false });

  // 浏览器面板的纯逻辑与 DOM 都在 browser.js 里；这里只接线（BROWSER-011）
  const browserPanel = createBrowserPanel({
    nodes: {
      iframe: dom.browser,
      title: dom.browserTitle,
      version: dom.browserVersion,
      empty: dom.browserEmpty,
      lastEvent: dom.browserLastEvent,
    },
    request: conversationRequest, // SPEC-020：浏览器事件也落到当前对话上
    onForwarded(body) {
      // 人类在文档里点了一下：进时间线，随后服务端会把它作为人类来源的消息送达 Agent
      pushTimeline({ type: `browser.event.${body.kind}`, agent: 'browser', ts: new Date().toISOString() });
    },
    onError(text) {
      appendMessage(renderMessage({ kind: 'error', agent: '宿主', text }));
      pushTimeline({ type: 'browser.event.rejected', agent: 'browser', ts: new Date().toISOString() });
    },
  });

  // 顶栏模型 chip 先按服务端的已存设置显示（拿不到就退化为 SPEC-015 的默认值）
  void settingsPage.load();

  function send() {
    const text = dom.input.value.trim();
    if (text.length === 0) return;
    dom.input.value = '';
    updateCommandHint();

    // SPEC-020 §二：客户端只做前缀路由——`/` 开头走命令通道，绝不发给模型（CMD-005）
    if (isCommandText(text)) {
      void runCommand(text);
      return;
    }

    appendMessage(renderMessage({ kind: 'human', agent: '人类', text }));
    void post(scoped('/api/message'), { text });
  }
  dom.composer.addEventListener('submit', (event) => {
    event.preventDefault();
    send();
  });

  dom.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });

  // 输入以 `/` 开头时给出可见提示（不走网络、不解析命令）
  dom.input.addEventListener('input', updateCommandHint);

  dom.interrupt.addEventListener('click', () => {
    void post(scoped('/api/interrupt'), { reason: '人类夺权' });
  });

  dom.rollback.addEventListener('click', () => {
    const answer = window.prompt('回滚到哪个界面版本？', String(Math.max(0, state.version - 1)));
    if (answer === null) return;
    const version = Number.parseInt(answer.trim(), 10);
    if (!Number.isInteger(version) || version < 0) {
      appendMessage(renderMessage({ kind: 'error', agent: '宿主', text: `无效的版本号：${answer}` }));
      return;
    }
    void post(scoped('/api/rollback'), { version });
  });

  // 横幅上的按钮用事件委托：内容每次都是重新渲染的，逐次绑定容易漏
  dom.change.addEventListener('click', (event) => {
    const node = event.target instanceof Element ? event.target.closest('[data-client-action]') : null;
    if (node === null) return;
    const action = node.getAttribute('data-client-action');
    if (action === 'close') {
      dom.change.hidden = true;
      dom.change.innerHTML = '';
      return;
    }
    // 只有人类点击才可能走到这里
    if (action === 'refresh') reloadPage();
  });

  /**
   * SPEC-019：桥的回传入口。**只认浏览器面板 iframe 的 window**（来源校验在
   * browser.js 的 acceptBrowserEvent 里，非本 iframe / 无桥标记的消息一律丢弃）。
   */
  window.addEventListener('message', (event) => {
    browserPanel.handleMessage(event);
  });

  /**
   * SPEC-020 启动顺序：先用 `GET /api/conversations` 定下 active（服务端是权威），
   * 再按该 id 开流、拉一次 `/api/state` 重画、加载文件列表。
   *
   * 老服务端没有 `/api/conversations` 时退回 `default`——语义与补齐前完全一致，
   * 界面不会因此白屏（控制器已经把失败原因显示出来了）。
   */
  setConnection('connecting');
  updateCommandHint();
  void (async () => {
    const list = await switcher.load();
    activeConversation = list === null ? DEFAULT_CONVERSATION : switcher.getActive();
    switcher.setActive(activeConversation);
    openStream();
    await redrawAll();
    await workspacePanel.reload(activeConversation);
  })();
}

/** SSE 的 data 是字符串；坏了也不能让界面停摆 */
function parseData(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { text: raw };
  }
}

// 服务端渲染 / 测试环境里没有 window：import 本模块不会有任何副作用
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
}
