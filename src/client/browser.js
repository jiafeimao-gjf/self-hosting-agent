/**
 * SPEC-019 内置浏览器：客户端侧的浏览器面板。
 *
 * 面板是**第二个沙箱**，与 `#surface`（View Spec 界面面板）并存、互不覆盖：
 * 宿主给的 `html` 已经组合好（含桥脚本与断网 CSP），这里只负责把它塞进
 * `<iframe sandbox="allow-scripts" srcdoc>`，再把文档里的交互转成一次 POST。
 *
 * 分工和 `app.js` / `settings.js` 一致：
 *
 * - 上半部分是**纯函数**：文档归一化、来源校验、消息白名单、POST 请求体、展示文案。
 *   不碰 DOM、不碰网络，`node --test` 里 import 进来没有副作用，可以直接断言。
 * - 下半部分 `createBrowserPanel()` 只做 DOM 接线，由 `app.js` 在浏览器里实例化。
 *
 * 安全底线（SPEC-019 §2，BROWSER-011）：
 *
 * 1. 只受理 `event.source === 本 iframe 的 contentWindow` 的消息——别的窗口、别的
 *    iframe、宿主页面自己的 postMessage 一律丢弃；
 * 2. 还必须带桥标记 `__ac === 1`、`channel === 'agent-client:browser'`，且 kind 在白名单内；
 * 3. title / text / payload 的展示只走 `textContent` 或 `escapeHtml`，绝不拼 innerHTML；
 * 4. iframe 的 sandbox 只由 index.html 决定，本模块**从不**写 sandbox 属性，
 *    更不会追加同源权限（那等于沙箱失效）。
 */

import { escapeHtml } from './renderer.js';

/** 桥与宿主约定的通道名（与 `src/browser/bootstrap.ts` 的 BRIDGE_CHANNEL 一致） */
export const BROWSER_CHANNEL = 'agent-client:browser';

/** 桥的标记字段值：只有 `{__ac:1,…}` 才是我们认的消息 */
export const BROWSER_MARK = 1;

/** 回传事件落地的端点（SPEC-019 冻结契约） */
export const BROWSER_EVENT_PATH = '/api/browser/event';

/** 空态标题：没有文档时说清楚，而不是显示空白 */
export const EMPTY_BROWSER_TITLE = '暂无浏览器文档';

/**
 * 允许转发的消息类型白名单。
 *
 * 桥另外还会发 `ready`（文档加载完成）与 console 的 `level` 字段：它们不在冻结的
 * POST 契约里，客户端**静默忽略**（不当错误、不转发）——面板的标题 / 版本来自
 * SSE 的 `browser` 事件，不依赖 ready。
 */
export const BROWSER_KINDS = ['emit', 'log', 'error'];

/** 事件文本进 UI 前最多展示多少字符（payload 一长就会刷屏） */
export const MAX_EVENT_TEXT = 160;

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

/** payload 必须能被 JSON 序列化：循环引用 / 函数等一律拒绝（宿主侧也会再校验一次） */
function serializable(value) {
  try {
    return JSON.stringify(value) !== undefined;
  } catch {
    return false;
  }
}

function snippet(text) {
  const value = str(text).replace(/\s+/g, ' ').trim();
  return value.length > MAX_EVENT_TEXT ? `${value.slice(0, MAX_EVENT_TEXT)}…` : value;
}

// ---------------------------------------------------------------------------
// 文档归一化（SSE `browser` 事件、/api/state.browser 共用）
// ---------------------------------------------------------------------------

/**
 * SSE `browser` / `/api/state.browser` 的 data → 稳定模型。
 *
 * `html` 已经是宿主组合好的完整文档，客户端**不再加工**：直接进 srcdoc。
 * 没有 html（或字段不是字符串）就是空态；版本号非数字退化为 0，不瞎猜。
 */
export function normalizeBrowserDoc(raw) {
  const item = isRecord(raw) ? raw : {};
  const html = str(item.html);
  const version = finiteNumber(item.version);
  const title = str(item.title).trim();
  return {
    hasDoc: html.length > 0,
    version: version === null ? 0 : version,
    title: title.length > 0 ? title : '未命名文档',
    html,
    allowNetwork: item.allowNetwork === true,
  };
}

/** 面板头部要显示的东西：标题 + 版本；空态给一句人话（BROWSER-011） */
export function browserStatus(raw) {
  const doc = normalizeBrowserDoc(raw);
  return {
    hasDoc: doc.hasDoc,
    title: doc.hasDoc ? doc.title : EMPTY_BROWSER_TITLE,
    version: doc.version,
    versionLabel: `v${doc.version}`,
    html: doc.html,
    allowNetwork: doc.allowNetwork,
  };
}

/**
 * `/api/state` → 浏览器文档；**没有 `browser` 字段时返回 null**。
 *
 * 这个区分很重要：老服务端 / 别的快照里没有这个字段，不能因此把 SSE 刚送来的
 * 文档清空；只有字段存在且为 `null` 才是「真的没有文档」。
 */
export function browserDocFromState(raw) {
  const state = isRecord(raw) ? raw : {};
  if (!Object.prototype.hasOwnProperty.call(state, 'browser')) return null;
  return normalizeBrowserDoc(state.browser);
}

/**
 * 要不要把这份 html 写进浏览器沙箱？
 *
 * 与界面面板同一个坑：首帧赋值会被 iframe 尚未完成的初始加载覆盖，所以判定看的是
 * **画没画上**（painted），不是只看「内容变没变」。
 */
export function shouldPaintBrowser({ nextHtml, prevHtml, painted, force = false }) {
  if (typeof nextHtml !== 'string' || nextHtml.length === 0) return false;
  if (force) return true;
  return nextHtml !== prevHtml || painted !== true;
}

// ---------------------------------------------------------------------------
// 桥消息 → POST 请求体
// ---------------------------------------------------------------------------

/**
 * 桥的回传消息（`{__ac:1, channel, kind, …}`）→ 稳定模型；不是我们的消息返回 null。
 *
 * 只做结构白名单，不做来源校验——来源校验在 `acceptBrowserEvent` 里，
 * 因为那需要真实的 window 对象，纯函数测试里用任意标记对象即可。
 */
export function normalizeBrowserMessage(raw) {
  const item = isRecord(raw) ? raw : {};
  if (item.__ac !== BROWSER_MARK) return null;
  if (item.channel !== BROWSER_CHANNEL) return null;

  const kind = str(item.kind);
  if (!BROWSER_KINDS.includes(kind)) return null; // 含 ready：白名单外一律忽略

  if (kind === 'emit') {
    const name = str(item.name).trim();
    if (name.length === 0) return null;
    const payload = item.payload === undefined ? {} : item.payload;
    if (!serializable(payload)) return null;
    return { kind, name, payload };
  }

  const text = str(item.text);
  if (text.length === 0) return null;
  return { kind, name: '', text };
}

/**
 * 稳定模型 → `POST /api/browser/event` 的请求体（SPEC-019 冻结契约）。
 *
 * 只带契约里的字段：`{kind:'emit', name, payload}` / `{kind:'log'|'error', text}`。
 * 桥信封上的 `__ac` / `channel` / `level` **不往服务端转发**——服务端只认事件本身。
 */
export function toBrowserEventRequest(message) {
  const item = isRecord(message) ? message : {};
  const kind = str(item.kind);

  if (kind === 'emit') {
    const name = str(item.name).trim();
    if (name.length === 0) return null;
    const payload = item.payload === undefined ? {} : item.payload;
    if (!serializable(payload)) return null;
    return { kind: 'emit', name, payload };
  }

  if (kind === 'log' || kind === 'error') {
    const text = str(item.text);
    if (text.length === 0) return null;
    return { kind, text };
  }

  return null;
}

/**
 * 一条 `message` 事件 → POST 请求体；**任何一种校验不过都返回 null**（BROWSER-011）。
 *
 * 三道闸缺一不可：来源 window 必须是我们这个 iframe、必须带桥标记与通道、
 * kind 与字段必须在白名单内。任何一条不满足就当没看见，连日志都不留。
 */
export function acceptBrowserEvent(event, sourceWindow) {
  if (!isRecord(event)) return null;
  const win = sourceWindow ?? null;
  if (win === null) return null; // iframe 还没就绪 → 一律丢弃
  if (event.source !== win) return null; // 不是本 iframe 的 window → 一律丢弃
  const message = normalizeBrowserMessage(event.data);
  if (message === null) return null;
  return toBrowserEventRequest(message);
}

// ---------------------------------------------------------------------------
// 展示文案（纯字符串）
// ---------------------------------------------------------------------------

/** payload 的展示片段：空对象不显示；长 JSON 截断 */
export function describePayload(payload) {
  if (payload === null || payload === undefined) return '';
  if (!isRecord(payload) && !Array.isArray(payload)) return '';
  if (Object.keys(payload).length === 0) return '';
  let json;
  try {
    json = JSON.stringify(payload);
  } catch {
    return '';
  }
  if (typeof json !== 'string' || json.length === 0) return '';
  const cut = json.length > MAX_EVENT_TEXT ? `${json.slice(0, MAX_EVENT_TEXT)}…` : json;
  return `（${cut}）`;
}

/** 一条已转发的浏览器事件 → 人话（进对话 / 时间线用） */
export function describeBrowserEvent(body) {
  const item = isRecord(body) ? body : {};
  const kind = str(item.kind);
  if (kind === 'emit') return `浏览器交互：${str(item.name)}${describePayload(item.payload)}`;
  if (kind === 'log') return `浏览器日志：${snippet(item.text)}`;
  if (kind === 'error') return `浏览器出错：${snippet(item.text)}`;
  return '';
}

/** 一条已转发的浏览器事件 → 面板上的状态行 HTML（文本全部转义） */
export function renderBrowserEvent(body) {
  const item = isRecord(body) ? body : {};
  const kind = str(item.kind);
  const tone = kind === 'error' ? 'tone-danger' : kind === 'log' ? 'tone-muted' : 'tone-info';
  const text = describeBrowserEvent(body);
  if (text.length === 0) return '';
  return `<span class="browser-event ${tone}" data-browser-event="${escapeHtml(kind)}">${escapeHtml(text)}</span>`;
}

/** 服务端拒绝 / 网络失败 → 可读中文 */
export function browserErrorText(raw, status) {
  const item = isRecord(raw) ? raw : {};
  const direct = str(item.error) || str(item.message) || str(item.reason);
  if (direct.length > 0) return direct;
  if (typeof status === 'number' && Number.isFinite(status) && status > 0) return `HTTP ${status}`;
  return '服务端没有返回可读信息';
}

// ---------------------------------------------------------------------------
// 浏览器面板 DOM 控制器（只在浏览器里跑，由 app.js 实例化）
// ---------------------------------------------------------------------------

/**
 * 把浏览器面板接上 DOM。所有节点由调用方传入，本模块不直接碰 `document`，
 * 这样纯逻辑与 DOM 的边界一眼可见，Node 里 import 也不会有副作用。
 */
export function createBrowserPanel(options) {
  const config = isRecord(options) ? options : {};
  const nodes = isRecord(config.nodes) ? config.nodes : {};
  const request = typeof config.request === 'function' ? config.request : null;
  const onForwarded = typeof config.onForwarded === 'function' ? config.onForwarded : null;
  const onError = typeof config.onError === 'function' ? config.onError : null;

  const iframe = nodes.iframe ?? null;
  let html = '';
  /** 是否真的把某一份 html 写进过沙箱（首帧被初始加载吞掉时靠它重画） */
  let painted = false;
  /** iframe 是否已经跑完自己的首次加载 */
  let loaded = false;
  /** 首帧期间收到的 html，等 load 后补画 */
  let pendingHtml = null;

  /**
   * 强制 iframe 重绘一帧。
   *
   * 真机上踩到的现象：`srcdoc` 赋值之后，iframe 明明**加载过了**（load 触发、属性正确、
   * 内容也没问题），画面却一直是空的——直到有别的重排把它顶出来。实测：
   *   · 只读一次 `offsetHeight` → 没用；
   *   · 把同一份 srcdoc 再赋一次 → 同值赋值是 no-op，也没用；
   *   · **让它消失一帧再回来** → 立刻画出来。
   * 跨域沙箱读不到里面，没法"确认画上了"，所以这里用这个朴素但可靠的办法。
   * 代价是打开文档时有一帧的空档（肉眼基本看不见），换来的是不会白屏。
   */
  function nudgePaint() {
    // 纯视觉补救：拿不到 style（假 DOM / 老浏览器）就静默跳过，别让它把主流程搞挂
    const style = iframe === null ? undefined : iframe.style;
    if (style === undefined || style === null) return;
    style.display = 'none';
    void iframe.offsetHeight;
    const restore = () => {
      if (iframe !== null && iframe.style !== undefined && iframe.style !== null) iframe.style.display = '';
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restore);
    else setTimeout(restore, 16);
  }

  /** 写完等着顶一帧：必须等它**加载完**再顶，导航还没起来就藏起来会把这次导航撤掉 */
  let nudgePending = false;

  function write(htmlText) {
    if (iframe === null) return;
    iframe.srcdoc = htmlText;
    nudgePending = true;
    // 万一 load 一直不来，也给一次兜底
    setTimeout(() => {
      if (nudgePending) {
        nudgePending = false;
        nudgePaint();
      }
    }, 400);
  }

  /** 把首帧期间攒下的文档补画上（沙箱 settled 之后才写） */
  function flushPendingBrowser() {
    if (pendingHtml === null) return;
    const next = pendingHtml;
    pendingHtml = null;
    loaded = true; // 主动认定可以画了：不能无限等一个可能永远不来的事件
    write(next);
    painted = true;
  }

  if (iframe !== null && typeof iframe.addEventListener === 'function') {
    iframe.addEventListener('load', () => {
      loaded = true;
      flushPendingBrowser();
      // 加载完成了：这时候顶一帧才能真正把画面顶出来（早于加载会被撤掉）
      if (nudgePending) {
        nudgePending = false;
        nudgePaint();
      }
    });
  }

  /**
   * 兜底路径：load 事件可能在挂监听之前就已经发生过，那 `loaded` 永远是 false，
   * 全部内容都堆在 pendingHtml 里永不落地 —— 和界面面板踩过的是同一个坑。
   */
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      // 首次 load 可能早于挂监听：不等它了，直接认定可以画（否则内容永远卡在 pendingHtml）
      loaded = true;
      flushPendingBrowser();
    });
  }

  /** 应用一份文档：更新标题 / 版本 / 空态，必要时写 srcdoc。返回是否真的重画 */
  function applyDocument(raw, flags = {}) {
    const status = browserStatus(raw);

    if (nodes.title !== undefined && nodes.title !== null) nodes.title.textContent = status.title;
    if (nodes.version !== undefined && nodes.version !== null) nodes.version.textContent = status.versionLabel;
    if (nodes.empty !== undefined && nodes.empty !== null) nodes.empty.hidden = status.hasDoc;

    if (!status.hasDoc) {
      // 真的没有文档：清空沙箱 + 显示空态，绝不沿用上一份内容
      html = '';
      pendingHtml = null;
      painted = false;
      write('');
      return false;
    }

    if (!shouldPaintBrowser({ nextHtml: status.html, prevHtml: html, painted, force: flags.force === true })) {
      return false;
    }
    html = status.html;

    if (!loaded) {
      pendingHtml = status.html; // 先记下，等沙箱 settled 再画
      return false;
    }
    write(status.html);
    painted = true;
    return true;
  }

  /** `/api/state` 快照：没有 browser 字段就什么都不做（不误清空 SSE 收到的文档） */
  function applyState(raw) {
    const doc = browserDocFromState(raw);
    if (doc === null) return false;
    return applyDocument(doc);
  }

  async function send(body) {
    if (request === null) return;
    let response = null;
    try {
      response = await request(BROWSER_EVENT_PATH, { method: 'POST', body });
    } catch {
      response = null;
    }
    if (response === null) {
      if (onError !== null) onError('浏览器事件转发失败：服务端没有响应');
      return;
    }
    if (!response.ok || (isRecord(response.data) && response.data.ok === false)) {
      if (onError !== null) onError(`浏览器事件被拒绝：${browserErrorText(response.data, response.status)}`);
    }
  }

  /**
   * window `message` 事件的唯一入口：来源 / 标记 / 白名单全过才转发。
   * 不满足的（包括文档里的脚本乱发的、别的窗口发来的）**直接丢弃**。
   */
  function handleMessage(event) {
    const win = iframe === null ? null : iframe.contentWindow;
    const body = acceptBrowserEvent(event, win);
    if (body === null) return false;
    if (nodes.lastEvent !== undefined && nodes.lastEvent !== null) {
      nodes.lastEvent.innerHTML = renderBrowserEvent(body);
    }
    if (onForwarded !== null) onForwarded(body);
    void send(body);
    return true;
  }

  /**
   * 把当前文档重新写一遍。切到浏览器页签时调用：隐藏期间写进去的文档
   * 可能一直没加载，显示出来时补一次。
   */
  function repaint() {
    if (html.length === 0 || iframe === null) return false;
    write(html);
    painted = true;
    return true;
  }

  return {
    repaint,
    applyDocument,
    applyState,
    handleMessage,
    isPainted: () => painted,
  };
}
