/**
 * SPEC-019 客户端浏览器面板的类型声明。
 *
 * 实现是纯 JS（浏览器直接加载、Node 直接 import），类型只为 TS 测试与宿主提供签名。
 * 与 `settings.d.ts` 一样刻意不引用 DOM 类型（`lib` 只有 es2023）：
 * 需要的节点按最小结构描述，宿主由 `app.js` 注入。
 */

/** 桥的通道名：`agent-client:browser` */
export declare const BROWSER_CHANNEL: string;

/** 桥的标记字段值：`__ac === 1` */
export declare const BROWSER_MARK: number;

/** 回传事件落地的端点：`/api/browser/event` */
export declare const BROWSER_EVENT_PATH: string;

/** 空态标题 */
export declare const EMPTY_BROWSER_TITLE: string;

/** 允许转发的消息类型白名单：`['emit', 'log', 'error']`（`ready` 静默忽略） */
export declare const BROWSER_KINDS: readonly string[];

/** 事件文本进 UI 前最多展示多少字符 */
export declare const MAX_EVENT_TEXT: number;

/** `/api/state.browser` / SSE `browser` 的稳定模型 */
export interface BrowserDocument {
  /** 有没有文档（html 非空） */
  hasDoc: boolean;
  /** 文档版本号；坏输入退化为 0 */
  version: number;
  /** 文档标题；缺字段退化为「未命名文档」 */
  title: string;
  /** 宿主已组合好的完整文档，直接进 srcdoc */
  html: string;
  allowNetwork: boolean;
}

/** 面板头部展示用：空态时 title 是「暂无浏览器文档」 */
export interface BrowserStatus {
  hasDoc: boolean;
  title: string;
  version: number;
  versionLabel: string;
  html: string;
  allowNetwork: boolean;
}

/** 桥的回传消息 → 稳定模型；信封不对 / kind 不在白名单 → null */
export type BrowserMessage =
  | { kind: 'emit'; name: string; payload: unknown }
  | { kind: 'log' | 'error'; name: ''; text: string };

/** `POST /api/browser/event` 的请求体 */
export type BrowserEventRequest =
  | { kind: 'emit'; name: string; payload: unknown }
  | { kind: 'log' | 'error'; text: string };

/** 任意输入 → 文档模型；坏字段退化，绝不抛异常 */
export declare function normalizeBrowserDoc(raw: unknown): BrowserDocument;

/** 面板头部展示模型：没有文档时给空态标题与 v0 */
export declare function browserStatus(raw: unknown): BrowserStatus;

/** `/api/state` → 文档；**没有 `browser` 字段时返回 null**（保持现状，不误清空） */
export declare function browserDocFromState(raw: unknown): BrowserDocument | null;

/** 要不要把 html 写进浏览器沙箱：看「画没画上」，不是只看内容变没变 */
export declare function shouldPaintBrowser(input: {
  nextHtml: unknown;
  prevHtml: unknown;
  painted: unknown;
  force?: boolean;
}): boolean;

/** 桥消息（含 `__ac` / `channel`）→ 稳定模型；不是我们的消息 → null */
export declare function normalizeBrowserMessage(raw: unknown): BrowserMessage | null;

/** 稳定模型 → `POST /api/browser/event` 请求体；非法 → null */
export declare function toBrowserEventRequest(message: unknown): BrowserEventRequest | null;

/** window `message` 事件 + 本 iframe window → 请求体；来源 / 标记 / 白名单任一不过 → null */
export declare function acceptBrowserEvent(event: unknown, sourceWindow: unknown): BrowserEventRequest | null;

/** payload → 展示片段（空对象不显示，长 JSON 截断） */
export declare function describePayload(payload: unknown): string;

/** 已转发的浏览器事件 → 人话 */
export declare function describeBrowserEvent(body: unknown): string;

/** 已转发的浏览器事件 → 面板状态行 HTML（文本全部转义） */
export declare function renderBrowserEvent(body: unknown): string;

/** 服务端拒绝 / 网络失败 → 可读中文 */
export declare function browserErrorText(raw: unknown, status?: number): string;

/** 设置页 HTTP 响应（由 app.js 的 requestJson 提供） */
export interface BrowserHttpResponse {
  status: number;
  ok: boolean;
  data: unknown;
}

/** `createBrowserPanel` 的依赖注入 */
export interface BrowserPanelOptions {
  /** DOM 节点表：iframe / title / version / empty / lastEvent */
  nodes: Record<string, any>;
  /** 转发一条事件；返回 null 表示网络层失败 */
  request: (path: string, init?: { method?: string; body?: unknown }) => Promise<BrowserHttpResponse | null>;
  /** 已受理并发出的事件（app.js 据此进时间线 / 对话） */
  onForwarded?: (body: BrowserEventRequest) => void;
  /** 转发失败（网络 / 服务端拒绝）的中文说明 */
  onError?: (message: string) => void;
}

/** 浏览器面板控制器 */
export interface BrowserPanel {
  /** 应用一份文档（SSE `browser` 事件 / 快照字段）；返回是否真的重画 */
  applyDocument(raw: unknown, flags?: { force?: boolean }): boolean;
  /** 应用 `/api/state`；没有 browser 字段 → false（保持现状） */
  applyState(raw: unknown): boolean;
  /** 处理一条 window `message`；受理并转发返回 true，其余一律 false */
  handleMessage(event: unknown): boolean;
  /** 是否真的把某份 html 画进过沙箱 */
  isPainted(): boolean;
}

/** 把浏览器面板接上 DOM（只在浏览器里调用） */
export declare function createBrowserPanel(options: BrowserPanelOptions): BrowserPanel;
