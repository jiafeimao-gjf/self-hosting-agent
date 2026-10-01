/**
 * SPEC-012 §2–§3 客户端界面逻辑；SPEC-014 补上「客户端自举」的呈现
 * （订阅 `client.changed`：`.css` 无刷新热替换，`.js`/`.html` 只给人类点击的刷新横幅）。
 *
 * 分工：
 *
 * - 本文件上半部分是**纯函数**（消息 / 工具摘要 / 时间线 / 快照归一化 → HTML 字符串），
 *   不碰 DOM，`node --test` 里可以直接 import 断言（UI-008）；
 * - 下半部分 `boot()` 只做连线：EventSource 订阅 `/api/stream`、四个 SSE 事件、
 *   三个 POST 端点、把渲染结果塞进 DOM（UI-006 / UI-007）。
 *
 * 沙箱是架构的一环：Agent 给的 HTML 只进 `<iframe sandbox="allow-scripts" srcdoc>`，
 * 收到 `document` 事件时**只更新 srcdoc**，宿主页面绝不刷新。
 */

import { escapeHtml, renderViewSpec } from './renderer.js';

/** 连接状态 → 中文文案 */
export const CONNECTION_LABELS = {
  connecting: '连接中…',
  open: '已连接',
  reconnecting: '重连中…',
  closed: '已断开',
};

/** 事件时间线最多保留多少条 */
export const MAX_TIMELINE = 80;

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
  if (name.startsWith('ui.') || name.startsWith('surface')) return 'info';
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
  return {
    version,
    html: typeof doc.html === 'string' ? doc.html : '',
    scopes: toArray(doc.scopes),
    agents: toArray(state.agents ?? state.processes ?? state.agentTable),
    tasks: toArray(state.tasks ?? state.taskboard ?? state.board),
    messages: toArray(state.messages ?? state.conversation ?? state.chat),
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
  };

  // 沙箱的首次加载完成后，把首帧期间攒下的 html 补画上（否则会被初始加载覆盖）
  dom.surface.addEventListener('load', () => {
    state.iframeLoaded = true;
    if (state.pendingHtml === null) return;
    const html = state.pendingHtml;
    state.pendingHtml = null;
    dom.surface.srcdoc = html;
    state.painted = true;
  });

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
      state.pendingHtml = html; // 等 load 事件来了再补
      return;
    }
    dom.surface.srcdoc = html;
    state.painted = true;
  }

  function applyState(raw) {
    const snapshot = normalizeState(raw);
    state.version = snapshot.version;
    setSurface(snapshot.html, snapshot.version);

    dom.agents.innerHTML = snapshot.agents.map(renderAgentRow).join('') || '<div class="empty">暂无 Agent</div>';
    dom.tasks.innerHTML = snapshot.tasks.map(renderTaskRow).join('') || '<div class="empty">暂无任务</div>';

    // SPEC-014 §4：客户端源码列表。缺 sources 字段就显示空态，不炸。
    const sources = normalizeSources(raw);
    dom.sources.innerHTML = sources.map(renderSourceRow).join('') || '<div class="empty">暂无客户端源码</div>';

    const events = snapshot.events.slice(-MAX_TIMELINE).reverse();
    dom.timeline.innerHTML = events.map(renderTimelineItem).join('');

    dom.messages.innerHTML = projectMessages(snapshot.messages).map(renderMessage).join('');
    dom.messages.scrollTop = dom.messages.scrollHeight;
  }

  function applyFrame(payload) {
    const envelope = isRecord(payload) ? payload : {};
    const frame = isRecord(envelope.frame) ? envelope.frame : envelope;
    const agent = textOf(frame.agent ?? envelope.agent) || 'agent';
    const type = textOf(frame.t);

    if (type === 'agent.thinking') {
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

  function send() {
    const text = dom.input.value.trim();
    if (text.length === 0) return;
    appendMessage(renderMessage({ kind: 'human', agent: '人类', text }));
    dom.input.value = '';
    void post('/api/message', { text });
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

  dom.interrupt.addEventListener('click', () => {
    void post('/api/interrupt', { reason: '人类夺权' });
  });

  dom.rollback.addEventListener('click', () => {
    const answer = window.prompt('回滚到哪个界面版本？', String(Math.max(0, state.version - 1)));
    if (answer === null) return;
    const version = Number.parseInt(answer.trim(), 10);
    if (!Number.isInteger(version) || version < 0) {
      appendMessage(renderMessage({ kind: 'error', agent: '宿主', text: `无效的版本号：${answer}` }));
      return;
    }
    void post('/api/rollback', { version });
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

  setConnection('connecting');
  const source = new EventSource('/api/stream');
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
