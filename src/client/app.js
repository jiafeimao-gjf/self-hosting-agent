/**
 * SPEC-012 §2–§3 客户端界面逻辑。
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
  };

  const state = {
    version: 0,
    html: '',
    /** 已发出但还没回填结果的 tool.call：id → { call, node } */
    tools: new Map(),
  };

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

  /** 只更新沙箱 iframe 的 srcdoc —— 宿主页面永远不刷新 */
  function setSurface(html, version) {
    if (typeof version === 'number' && Number.isFinite(version)) state.version = version;
    dom.version.textContent = `v${state.version}`;
    dom.surfaceVersion.textContent = `v${state.version}`;
    if (typeof html === 'string' && html.length > 0 && html !== state.html) {
      state.html = html;
      dom.surface.srcdoc = html;
    }
  }

  function applyState(raw) {
    const snapshot = normalizeState(raw);
    state.version = snapshot.version;
    setSurface(snapshot.html, snapshot.version);

    dom.agents.innerHTML = snapshot.agents.map(renderAgentRow).join('') || '<div class="empty">暂无 Agent</div>';
    dom.tasks.innerHTML = snapshot.tasks.map(renderTaskRow).join('') || '<div class="empty">暂无任务</div>';

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
    setSurface(html, typeof data.version === 'number' ? data.version : state.version);
    pushTimeline({ type: 'ui.document', agent: 'surface', ts: new Date().toISOString() });
  }

  function applyDone(payload) {
    const data = isRecord(payload) ? payload : {};
    const reason = textOf(data.reason);
    const text = reason === 'interrupted' ? '本轮已被人类中断' : reason.length > 0 ? `本轮结束：${reason}` : '本轮结束';
    appendMessage(renderMessage({ kind: 'done', agent: '系统', text }));
    pushTimeline({ type: `loop.done.${reason || 'ok'}`, agent: 'kernel', ts: new Date().toISOString() });
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
