/**
 * SPEC-020 多对话与 `/` 常用命令、SPEC-021 工作空间「文件」页签的客户端逻辑。
 *
 * 分工与 `app.js` / `settings.js` / `browser.js` 一致：
 *
 * - 上半部分是**纯函数**：路由拼装（`?conversation=<id>`）、对话列表归一化、
 *   命令结果归一化与渲染、工作空间文件列表 / 文件内容归一化、展示文案。
 *   不碰 DOM、不碰网络，`node --test` 里 import 进来没有副作用，可以直接断言。
 * - 下半部分两个控制器 `createConversationSwitcher()` / `createWorkspacePanel()`
 *   只做 DOM 接线，由 `app.js` 在浏览器里实例化（依赖注入 request，Node 里也能测）。
 *
 * 三条硬底线（SPEC-020 §三 / SPEC-021 §四）：
 *
 * 1. **切换对话不刷新页面**：关旧 EventSource、按新 id 重开、再拉一次 `/api/state`
 *    重画全部区域（这条在 `app.js` 里接线，本模块只提供 URL 与列表模型）。
 * 2. **文件内容按需加载**：`/api/workspace` 只给元信息，内容只在点击时走
 *    `/api/workspace/file`；列表里绝不夹带 `content`。
 * 3. **文件内容只走 `textContent`**：内容是不可信纯文本，绝不 `innerHTML`。
 *    只有「列表元信息」与「下拉选项」才拼 HTML，且所有文本都过 `escapeHtml`。
 */

import { escapeHtml } from './renderer.js';

// ---------------------------------------------------------------------------
// SPEC-020 §一：HTTP 契约里的固定值
// ---------------------------------------------------------------------------

/** 省略 `conversation` 时的对话 id（契约：省略即 default） */
export const DEFAULT_CONVERSATION = 'default';

/** 对话集合：`GET` 列出 / `POST` 新建 */
export const CONVERSATIONS_PATH = '/api/conversations';

/** 命令端点：输入以 `/` 开头时走这里（SPEC-020 §二） */
export const COMMAND_PATH = '/api/command';

/** 工作空间列表端点（SPEC-021 §三）：只返回元信息 */
export const WORKSPACE_PATH = '/api/workspace';

/** 工作空间单文件端点（SPEC-021 §三）：按需加载内容 */
export const WORKSPACE_FILE_PATH = '/api/workspace/file';

/** 缺标题时的对话框面文案 */
export const DEFAULT_CONVERSATION_TITLE = '默认对话';

/** 输入以 `/` 开头时的可见提示 */
export const COMMAND_HINT_TEXT = '回车执行命令';

/** 一个对话都没有时的空态文案 */
export const EMPTY_CONVERSATIONS_TEXT = '暂无对话';

/** 工作空间没有任何文件时的空态文案（与 index.html 的默认文本一致） */
export const EMPTY_FILES_TEXT = '工作空间暂无文件';

/** 有文件但还没点开时的提示 */
export const NO_FILE_SELECTED_TEXT = '点击左侧文件查看内容';

/** 加载中的可见文案（不许白屏） */
export const LOADING_TEXT = '加载中…';

/** 文件被服务端截断时的提示（WS-010 的「截断态」） */
export const TRUNCATED_TEXT = '内容过大，已截断';

// ---------------------------------------------------------------------------
// 基础取值：坏输入一律退化成安全值，绝不抛异常
// ---------------------------------------------------------------------------

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value) {
  return typeof value === 'string' ? value : '';
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function writeText(node, text) {
  if (node === null || node === undefined) return;
  node.textContent = str(text);
}

// ---------------------------------------------------------------------------
// 对话 id 与路由拼装
// ---------------------------------------------------------------------------

/**
 * id 规则（SPEC-020 §一）：`[a-z0-9][a-z0-9_-]{0,31}`，由服务端生成。
 *
 * 客户端只做**防守性**校验：服务端真给了不合规的 id，宁可退回 `default`，
 * 也不把 `..` / 路径分隔符这类东西拼进 URL。
 */
export function isConversationId(raw) {
  return typeof raw === 'string' && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(raw);
}

/** 任意输入 → 合法对话 id；空 / 非法一律退化为 `default` */
export function conversationIdOf(raw) {
  const value = str(raw).trim();
  return isConversationId(value) ? value : DEFAULT_CONVERSATION;
}

/**
 * 给任意路由带上 `?conversation=<id>`（SPEC-020 §一：所有既有路由都接受它）。
 *
 * `default` 走**省略形态**，这样旧调用与旧测试的语义原样不变（向后兼容）。
 * 已有查询串时用 `&` 追加；空路径返回空串（调用方据此判断「不请求」）。
 */
export function withConversation(path, id) {
  const base = str(path).split('#')[0];
  if (base.length === 0) return '';
  const conversation = conversationIdOf(id);
  if (conversation === DEFAULT_CONVERSATION) return base;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}conversation=${encodeURIComponent(conversation)}`;
}

/**
 * SSE 地址（SPEC-020 §一）：`/api/stream?conversation=<id>`。
 * 每个对话一条独立的流，事件互不串扰（CONV-006）。
 */
export function streamUrl(id) {
  const conversation = conversationIdOf(id);
  if (conversation === DEFAULT_CONVERSATION) return '/api/stream';
  return `/api/stream?conversation=${encodeURIComponent(conversation)}`;
}

/** 工作空间列表地址：`/api/workspace?conversation=<id>` */
export function workspaceUrl(id) {
  return withConversation(WORKSPACE_PATH, id);
}

/** SPEC-019：浏览器面板的打开地址。**必须带对话**，否则服务端会回落到默认对话，
 * 在别的对话的工作空间里找不到文件（真 bug：c2 里的 universe.html 报 NOT_FOUND）。 */
export const BROWSER_OPEN_PATH = '/api/browser/open';

export function browserOpenUrl(id) {
  return withConversation(BROWSER_OPEN_PATH, id);
}

/**
 * 工作空间单文件地址：`/api/workspace/file?conversation=<id>&path=<p>`。
 * `path` 是不可信输入，必须 `encodeURIComponent`。
 */
export function workspaceFileUrl(id, path) {
  const base = withConversation(WORKSPACE_FILE_PATH, id);
  if (base.length === 0) return '';
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}path=${encodeURIComponent(str(path))}`;
}

// ---------------------------------------------------------------------------
// 对话列表归一化（GET /api/conversations、POST /api/conversations、/api/state）
// ---------------------------------------------------------------------------

export function normalizeConversation(raw) {
  const item = isRecord(raw) ? raw : {};
  const rawId = str(item.id).trim();
  const id = isConversationId(rawId) ? rawId : DEFAULT_CONVERSATION;
  const title = str(item.title).trim();
  return {
    id,
    title: title.length > 0 ? title : id === DEFAULT_CONVERSATION ? DEFAULT_CONVERSATION_TITLE : id,
    createdAt: str(item.createdAt),
    lastActiveAt: str(item.lastActiveAt),
    messages: finiteNumber(item.messages) ?? 0,
    /** 默认对话不可删（SPEC-020 §一） */
    deletable: id !== DEFAULT_CONVERSATION,
  };
}

/** `{ok, active, conversations}` → `{active, conversations}`；坏输入退化为空列表 */
export function normalizeConversationList(raw) {
  const payload = isRecord(raw) ? raw : {};
  const conversations = toArray(payload.conversations).map(normalizeConversation);
  const active = conversationIdOf(payload.active);
  return { active, conversations };
}

/**
 * `POST /api/conversations` 的响应 → 新对话；形状与 `/api/state.conversation` 相同。
 * 没有可用的 id 时返回 null（调用方据此走「重新拉列表」的兜底路径）。
 */
export function conversationFromState(raw) {
  const payload = isRecord(raw) ? raw : {};
  if (!isRecord(payload.conversation)) return null;
  const id = str(payload.conversation.id).trim();
  if (!isConversationId(id)) return null;
  const title = str(payload.conversation.title).trim();
  return { id, title: title.length > 0 ? title : id };
}

/** 同 `conversationFromState`：语义化的别名，给新建对话的响应读代码用 */
export function createdConversation(raw) {
  return conversationFromState(raw);
}

/** 默认对话不可删（客户端先挡一道，服务端仍会拒） */
export function canDeleteConversation(raw) {
  return conversationIdOf(raw) !== DEFAULT_CONVERSATION;
}

/** `DELETE /api/conversations/<id>` 的地址 */
export function deleteConversationUrl(raw) {
  return `${CONVERSATIONS_PATH}/${encodeURIComponent(conversationIdOf(raw))}`;
}

/** `POST /api/conversations` 的请求体：标题可省（省略时给 `{}`，由服务端给默认标题） */
export function newConversationRequest(title) {
  const value = str(title).trim();
  return value.length > 0 ? { title: value } : {};
}

/** 下拉选项的文案：标题 + 消息数（SPEC-020 §三：显示标题与消息数） */
export function conversationOptionLabel(raw) {
  const conversation = normalizeConversation(raw);
  return `${conversation.title}（${conversation.messages} 条）`;
}

/**
 * 下拉选项 HTML：标出 active。文本全部转义（对话标题是不可信输入）。
 * 一个对话都没有时给一条禁用的空态选项，而不是留一个空下拉。
 */
export function renderConversationOptions(raw) {
  const payload = isRecord(raw) ? raw : {};
  const conversations = toArray(payload.conversations).map(normalizeConversation);
  if (conversations.length === 0) {
    return `<option value="" disabled selected>${escapeHtml(EMPTY_CONVERSATIONS_TEXT)}</option>`;
  }
  const active = conversationIdOf(payload.active);
  return conversations
    .map((conversation) => {
      const selected = conversation.id === active ? ' selected' : '';
      return `<option value="${escapeHtml(conversation.id)}"${selected}>${escapeHtml(conversationOptionLabel(conversation))}</option>`;
    })
    .join('');
}

// ---------------------------------------------------------------------------
// `/` 命令（SPEC-020 §二）：客户端只做前缀路由与结果渲染
// ---------------------------------------------------------------------------

/** 输入是否以 `/` 开头（前后空白先剥掉） */
export function isCommandText(text) {
  return str(text).trim().startsWith('/');
}

/** 前缀路由：`/` 开头 → `'command'`，否则 `'message'`（CMD-001 / CMD-005） */
export function routeForText(text) {
  return isCommandText(text) ? 'command' : 'message';
}

/** `POST /api/command` 的请求体：原样把整段文本交给服务端解析（含标题等参数） */
export function commandRequest(text) {
  return { text: str(text) };
}

/**
 * `action` 归一化（SPEC-020 §二）：只认 `switch` / `created` / `cleared`。
 * `switch` / `created` 必须带目标对话，否则当没有 action（宁可不切，也不切到空）。
 */
export function commandActionOf(raw) {
  const item = isRecord(raw) ? raw : {};
  const type = str(item.type);
  if (type !== 'switch' && type !== 'created' && type !== 'cleared') return null;
  const conversation = str(item.conversation).trim();
  if (type === 'cleared') return { type, conversation: conversation.length > 0 ? conversation : '' };
  if (!isConversationId(conversation)) return null;
  return { type, conversation };
}

/** `{ok, command, output, action?}` → 稳定模型；坏输入退化为「失败且无输出」 */
export function normalizeCommandResult(raw) {
  const item = isRecord(raw) ? raw : {};
  return {
    ok: item.ok === true,
    command: str(item.command).trim(),
    output: str(item.output),
    // 失败时服务端把原因放在 `error`（例如 `用法：/switch <id>`），不能丢
    error: str(item.error),
    action: commandActionOf(item.action),
  };
}

/**
 * 客户端文件每次刷新都从磁盘读，**服务端进程却还停在启动时的那份代码**。
 * 于是新界面打在旧服务端上会拿到 404 / 405 —— 这时说「服务端是旧版本，重启一下」
 * 比甩一个 METHOD_NOT_ALLOWED 有用得多。
 */
export function isStaleServer(status) {
  return status === 404 || status === 405;
}

export const STALE_SERVER_TEXT = '服务端是旧版本（没有多对话接口）：重启 npm run serve 之后再试';

/** 这些是「没有信息量」的通用错误：出现它们说明不是业务拒绝，而是路由/方法都不认识 */
const GENERIC_SERVER_ERROR = /^(METHOD_NOT_ALLOWED|NOT_FOUND|BAD_REQUEST)$/;

/**
 * 服务端错误 / 网络失败 → 可读中文；对话 / 文件 / 命令三条路径共用同一套规则。
 *
 * 优先级刻意如此：**服务端给的具体诊断优先**（`PATH_ESCAPE` 这类不能被版本提示盖掉），
 * 只有当 404/405 配上一句没有信息量的通用错误时，才判定为前后端版本漂移。
 */
function serverErrorText(raw, status) {
  const item = isRecord(raw) ? raw : {};
  const direct = str(item.error) || str(item.message) || str(item.reason);
  if (direct.length > 0 && !GENERIC_SERVER_ERROR.test(direct.trim())) return direct;
  if (isStaleServer(status)) return STALE_SERVER_TEXT;
  if (direct.length > 0) return direct;
  if (typeof status === 'number' && Number.isFinite(status) && status > 0) return `HTTP ${status}`;
  return '服务端没有返回可读信息';
}

/** 命令失败 / 网络失败 → 可读中文 */
export function commandErrorText(raw, status) {
  return serverErrorText(raw, status);
}

/**
 * 命令结果 → **系统消息** HTML（CMD-001 / CMD-004 / CMD-005）。
 *
 * 与人类 / Agent 消息不同色（`.msg-system`），`output` 是给人看的纯文本，
 * 一律 `escapeHtml`；失败时带 `is-fail`，绝不白屏。
 * `commandText` 是人类的原始输入（例如 `/cat a.md`），回显出来便于对照。
 */
export function renderCommandResult(raw, commandText = '') {
  const result = normalizeCommandResult(raw);
  const echo = str(commandText).trim();
  const reason = result.output.length > 0 ? result.output : result.error;
  const output =
    reason.length > 0
      ? reason
      : result.ok
        ? '（命令执行完毕，服务端没有输出）'
        : '命令执行失败，服务端没有给出原因';
  const state = result.ok ? 'is-ok' : 'is-fail';
  return `<li class="msg msg-system ${state}" data-command="${escapeHtml(result.command)}">` +
    '<span class="meta">命令</span>' +
    (echo.length > 0 ? `<code class="cmd-echo">${escapeHtml(echo)}</code>` : '') +
    `<pre class="cmd-output">${escapeHtml(output)}</pre>` +
    '</li>';
}

// ---------------------------------------------------------------------------
// SPEC-021 工作空间：列表只给元信息，内容按需加载
// ---------------------------------------------------------------------------

/** 一条文件元信息：**只有** path / bytes / mtime，绝不带 content（WS-007 / WS-010） */
export function normalizeWorkspaceFileEntry(raw) {
  const item = isRecord(raw) ? raw : {};
  return {
    path: str(item.path).trim(),
    bytes: finiteNumber(item.bytes),
    mtime: str(item.mtime),
  };
}

/** `GET /api/workspace` → `{root, files:[{path,bytes,mtime}]}`；坏输入退化为空列表 */
export function normalizeWorkspaceList(raw) {
  const payload = isRecord(raw) ? raw : {};
  const files = toArray(payload.files)
    .map(normalizeWorkspaceFileEntry)
    .filter((file) => file.path.length > 0);
  return { root: str(payload.root), files };
}

/** `GET /api/workspace/file` → `{path, bytes, content, truncated}`；content 缺失退化为空串 */
export function normalizeWorkspaceFile(raw) {
  const item = isRecord(raw) ? raw : {};
  return {
    path: str(item.path).trim(),
    bytes: finiteNumber(item.bytes),
    content: str(item.content),
    truncated: item.truncated === true,
  };
}

/** 字节数 → 人话；未知显示 `—` 而不是 `NaN B` */
export function formatBytes(bytes) {
  const value = finiteNumber(bytes);
  if (value === null) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/** 修改时间 → `YYYY-MM-DD HH:mm`；认不出来的原样显示，空显示 `—` */
export function formatMtime(raw) {
  const value = str(raw);
  if (value.length === 0) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 文件列表的一行：**只有元信息**，`path` 是不可信输入必须转义。
 * `content` 永远不会出现在这里（它在点击时单独加载）。
 */
/** SPEC-019：浏览器面板只渲染 HTML 文件，列表里给这类文件一个可点的入口 */
export function isHtmlPath(path) {
  const clean = str(path).split('#')[0].split('?')[0].trim().toLowerCase();
  return clean.endsWith('.html') || clean.endsWith('.htm');
}

export function renderFileRow(raw) {
  const file = normalizeWorkspaceFileEntry(raw);
  const path = file.path.length > 0 ? file.path : '(未知文件)';
  const open =
    isHtmlPath(path)
      ? `<span class="file-action" data-browse-path="${escapeHtml(path)}" title="在内置浏览器里渲染" role="button" tabindex="0">在浏览器打开</span>`
      : '';
  return `<button type="button" class="file-row" data-file-path="${escapeHtml(path)}" title="${escapeHtml(path)}">` +
    `<span class="file-path">${escapeHtml(path)}</span>` +
    open +
    `<span class="file-bytes">${escapeHtml(formatBytes(file.bytes))}</span>` +
    `<span class="file-mtime">${escapeHtml(formatMtime(file.mtime))}</span>` +
    '</button>';
}

/** 文件列表 HTML；空列表返回空串（空态由控制器写 `#file-empty`） */
export function renderFileList(raw) {
  const list = normalizeWorkspaceList(raw);
  return list.files.map(renderFileRow).join('');
}

/** 服务端错误 / 网络失败 → 可读中文 */
export function workspaceErrorText(raw, status) {
  return serverErrorText(raw, status);
}

/** 列表加载失败 → 可见文案（WS-010 的错误态） */
export function fileListErrorText(raw, status) {
  return `加载文件列表失败：${workspaceErrorText(raw, status)}`;
}

/** 单文件加载失败 → 可见文案（WS-010 的错误态） */
export function fileLoadErrorText(raw, status) {
  return `读取文件内容失败：${workspaceErrorText(raw, status)}`;
}

/** 截断提示：只有真的截断了才给文案（WS-010 的截断态） */
export function truncatedNotice(raw) {
  const item = isRecord(raw) ? raw : {};
  return item.truncated === true ? TRUNCATED_TEXT : '';
}

// ---------------------------------------------------------------------------
// 对话切换器控制器（只在浏览器里实例化，由 app.js 注入 DOM 与 request）
// ---------------------------------------------------------------------------

/**
 * 顶栏「对话切换器」：下拉（每个对话的标题 + 消息数）+ 新建 + 删除。
 *
 * 控制器**不碰 EventSource、不刷新页面**——真正的「关旧流 / 开新流 / 重画全部区域」
 * 由 `app.js` 的 `onSwitch` 完成（SPEC-020 §三）。这里只保证：
 * 列表来自 `GET /api/conversations`，切换通过 `onSwitch(id)` 上报。
 */
export function createConversationSwitcher(options) {
  const config = isRecord(options) ? options : {};
  const nodes = isRecord(config.nodes) ? config.nodes : {};
  const request = typeof config.request === 'function' ? config.request : null;
  const onSwitch = typeof config.onSwitch === 'function' ? config.onSwitch : null;
  const onError = typeof config.onError === 'function' ? config.onError : null;

  let active = DEFAULT_CONVERSATION;
  let conversations = [];

  async function send(path, init) {
    if (request === null) return null;
    try {
      return await request(path, init);
    } catch {
      return null; // 网络层失败：调用方显示文案，绝不抛出去
    }
  }

  function paint() {
    const select = nodes.select ?? null;
    if (select !== null && select !== undefined) {
      select.innerHTML = renderConversationOptions({ active, conversations });
      // 选项里没有当前 id（例如列表被删空）时退化为空选，不假装选中
      select.value = conversations.some((item) => item.id === active) ? active : '';
    }
    const removeButton = nodes.remove ?? null;
    if (removeButton !== null && removeButton !== undefined) {
      removeButton.disabled = !canDeleteConversation(active);
    }
  }

  function setStatus(text) {
    writeText(nodes.status, text);
  }

  function fail(text, raw, status) {
    const message = `${text}：${serverErrorText(raw, status)}`;
    setStatus(message);
    if (onError !== null) onError(message);
    return message;
  }

  /** 只更新 UI（下拉选中态、删除按钮可用性），不发起任何请求 */
  function setActive(id) {
    active = conversationIdOf(id);
    paint();
    return active;
  }

  /** 拉一次对话列表；失败时保留旧列表并给出可见文案，返回 null */
  async function load() {
    const response = await send(CONVERSATIONS_PATH, { method: 'GET' });
    if (response === null) {
      fail('加载对话列表失败', null, 0);
      return null;
    }
    if (response.ok !== true) {
      fail('加载对话列表失败', response.data, response.status);
      return null;
    }
    const list = normalizeConversationList(response.data);
    conversations = list.conversations;
    // 服务端的 active 是权威；列表里没有它就退回 default（不冒充）
    active = conversations.some((item) => item.id === list.active) ? list.active : DEFAULT_CONVERSATION;
    paint();
    setStatus(conversations.length === 0 ? EMPTY_CONVERSATIONS_TEXT : '');
    return { active, conversations };
  }

  /** 切换：更新 UI 并上报（app.js 负责重开流 + 重画） */
  function switchTo(id) {
    const target = setActive(id);
    if (onSwitch !== null) onSwitch(target);
    return target;
  }

  /** 新建对话：POST → 重新拉列表 → 切到新对话（CONV-004 / CMD-004 的 created） */
  async function create(title) {
    const response = await send(CONVERSATIONS_PATH, {
      method: 'POST',
      body: newConversationRequest(title),
    });
    if (response === null) {
      fail('新建对话失败', null, 0);
      return null;
    }
    if (response.ok !== true || (isRecord(response.data) && response.data.ok === false)) {
      fail('新建对话失败', response.data, response.status);
      return null;
    }
    const created = createdConversation(response.data);
    const list = await load();
    const next = created !== null ? created.id : list === null ? null : list.active;
    if (next !== null && next !== undefined) switchTo(next);
    return created;
  }

  /** 删除对话：默认对话不可删（客户端先挡，服务端仍会拒） */
  async function remove(id) {
    const target = conversationIdOf(id);
    if (!canDeleteConversation(target)) {
      setStatus('默认对话不可删除');
      return false;
    }
    const wasActive = target === active;
    const response = await send(deleteConversationUrl(target), { method: 'DELETE' });
    if (response === null) {
      fail('删除对话失败', null, 0);
      return false;
    }
    if (response.ok !== true || (isRecord(response.data) && response.data.ok === false)) {
      fail('删除对话失败', response.data, response.status);
      return false;
    }
    const list = await load();
    // 删掉的正是当前对话：跟着服务端的 active 走，绝不留在已删除的对话上
    if (wasActive) switchTo(list === null ? DEFAULT_CONVERSATION : list.active);
    return true;
  }

  /**
   * `/api/state.conversation` → 同步 UI（标题 / 选中态）。
   * **只同步 UI，不触发切换**：切换由人类操作、命令的 `action`、删除三处驱动，
   * 这样不会出现「applyState → onSwitch → applyState」的回环。
   */
  function applyState(raw) {
    const conversation = conversationFromState(raw);
    if (conversation === null) return null;
    if (conversations.length === 0 || conversations.some((item) => item.id === conversation.id)) {
      setActive(conversation.id);
    }
    return conversation;
  }

  return {
    setActive,
    getActive: () => active,
    list: () => conversations,
    load,
    create,
    remove,
    switchTo,
    applyState,
  };
}

// ---------------------------------------------------------------------------
// 工作空间「文件」面板控制器（SPEC-021 §四 / WS-010）
// ---------------------------------------------------------------------------

/**
 * 右栏第三个页签「文件」：
 *
 * - 列表只来自 `GET /api/workspace`（元信息，无内容）；
 * - **内容只在点击时**走 `GET /api/workspace/file`，并用 `textContent` 写入；
 * - 空态 / 加载失败 / 截断都有可见文案，绝不白屏、绝不抛异常；
 * - 切换对话时 `reload(新 id)` 整体重画，并用请求令牌丢弃过期响应（防竞态）。
 */
export function createWorkspacePanel(options) {
  const config = isRecord(options) ? options : {};
  const nodes = isRecord(config.nodes) ? config.nodes : {};
  const request = typeof config.request === 'function' ? config.request : null;
  const onError = typeof config.onError === 'function' ? config.onError : null;

  let current = DEFAULT_CONVERSATION;
  let loadedPath = null;
  /** 请求令牌：切对话 / 连点文件时，旧响应回来不许覆盖新的 */
  let token = 0;

  const listNode = nodes.list ?? null;
  const emptyNode = nodes.empty ?? null;
  const statusNode = nodes.status ?? null;
  const contentNode = nodes.content ?? null;
  const rootNode = nodes.root ?? null;

  async function send(path) {
    if (request === null) return null;
    try {
      return await request(path, { method: 'GET' });
    } catch {
      return null;
    }
  }

  function setListHtml(html) {
    if (listNode !== null && listNode !== undefined) listNode.innerHTML = str(html);
  }

  /** 文件内容进 DOM 的唯一入口：**只走 textContent**（WS-010） */
  function setContent(text) {
    if (contentNode !== null && contentNode !== undefined) contentNode.textContent = str(text);
  }

  function setStatus(text, tone) {
    if (statusNode === null || statusNode === undefined) return;
    statusNode.textContent = str(text);
    if (statusNode.dataset !== undefined && statusNode.dataset !== null) {
      statusNode.dataset.tone = str(tone);
    }
  }

  function setEmpty(visible, text) {
    if (emptyNode === null || emptyNode === undefined) return;
    if (text !== undefined) emptyNode.textContent = str(text);
    emptyNode.hidden = visible !== true;
  }

  function markActive(path) {
    if (listNode === null || listNode === undefined || typeof listNode.querySelectorAll !== 'function') return;
    for (const row of listNode.querySelectorAll('[data-file-path]')) {
      const value = typeof row.getAttribute === 'function' ? row.getAttribute('data-file-path') : null;
      if (row.classList !== undefined && row.classList !== null) row.classList.toggle('is-active', value === path);
    }
  }

  function report(text) {
    if (onError !== null) onError(text);
    return text;
  }

  /** 清空面板（切换对话 / 关闭时调用），回到「没有文件」的空态 */
  function clear() {
    token += 1;
    loadedPath = null;
    setListHtml('');
    setContent('');
    setStatus('', '');
    setEmpty(true, EMPTY_FILES_TEXT);
    if (rootNode !== null && rootNode !== undefined) rootNode.textContent = '工作空间';
  }

  /** 加载文件列表：只请求 `/api/workspace`，**不**请求任何文件内容 */
  async function reload(conversationId) {
    current = conversationIdOf(conversationId);
    token += 1;
    const mine = token;
    loadedPath = null;
    setListHtml('');
    setContent('');
    setStatus(LOADING_TEXT, '');
    setEmpty(true, LOADING_TEXT);

    const response = await send(workspaceUrl(current));
    if (mine !== token) return null; // 已经切走了：丢弃过期响应

    if (response === null) {
      const text = report(fileListErrorText(null, 0));
      setListHtml('');
      setStatus(text, 'danger');
      setEmpty(true, text);
      return null;
    }
    if (response.ok !== true || (isRecord(response.data) && response.data.ok === false)) {
      const text = report(fileListErrorText(response.data, response.status));
      setListHtml('');
      setStatus(text, 'danger');
      setEmpty(true, text);
      return null;
    }

    const list = normalizeWorkspaceList(response.data);
    setListHtml(renderFileList(response.data));
    if (rootNode !== null && rootNode !== undefined) {
      rootNode.textContent = list.root.length > 0 ? list.root : '工作空间';
    }
    if (list.files.length === 0) {
      setStatus('', '');
      setEmpty(true, EMPTY_FILES_TEXT);
    } else {
      setStatus(`共 ${list.files.length} 个文件`, '');
      setEmpty(true, NO_FILE_SELECTED_TEXT);
    }
    return list;
  }

  /** 点击一个文件：**这时才**请求内容，并用 textContent 展示 */
  /**
   * SPEC-019：把工作空间里的 HTML 文件送进浏览器面板。
   *
   * 浏览器面板**没有**"Agent 直接塞 HTML"的入口了 —— 想让人看到什么，就写成文件，
   * 再由人决定打开哪个（这里 / 文件行上的「在浏览器打开」/ `/browse` 命令）。
   */
  async function openInBrowser(path) {
    const target = str(path);
    if (target.length === 0) return false;
    if (request === null) return false;
    // 用面板自己的 `current`：列表是从这个对话拉来的，打开也必须打在同一个对话上
    const response = await request(browserOpenUrl(current), { method: 'POST', body: { path: target } });
    if (response === null || response.ok !== true) {
      const data = isRecord(response?.data) ? response.data : {};
      setStatus(`在浏览器打开失败：${serverErrorText(data, response?.status ?? 0)}`, 'fail');
      return false;
    }
    setStatus(`已在浏览器面板渲染 ${target}`, 'ok');
    if (typeof config.onOpenedInBrowser === 'function') config.onOpenedInBrowser(target);
    return true;
  }

  async function openFile(path) {
    const target = str(path);
    if (target.length === 0) return null;
    token += 1;
    const mine = token;
    loadedPath = target;
    markActive(target);
    setContent('');
    setStatus(`${LOADING_TEXT}（${target}）`, '');
    setEmpty(true, LOADING_TEXT);

    const response = await send(workspaceFileUrl(current, target));
    if (mine !== token) return null;

    if (response === null) {
      const text = report(fileLoadErrorText(null, 0));
      setContent('');
      setStatus(text, 'danger');
      setEmpty(true, text);
      return null;
    }
    if (response.ok !== true || (isRecord(response.data) && response.data.ok === false)) {
      const text = report(fileLoadErrorText(response.data, response.status));
      setContent('');
      setStatus(text, 'danger');
      setEmpty(true, text);
      return null;
    }

    const file = normalizeWorkspaceFile(response.data);
    setContent(file.content);
    setEmpty(false, '');
    const label = file.path.length > 0 ? file.path : target;
    if (file.truncated) {
      setStatus(`${TRUNCATED_TEXT}（${label} · ${formatBytes(file.bytes)}）`, 'warning');
    } else {
      setStatus(`${label} · ${formatBytes(file.bytes)}`, '');
    }
    return file;
  }

  return {
    reload,
    openInBrowser,
    openFile,
    clear,
    getConversation: () => current,
    getLoadedPath: () => loadedPath,
  };
}
