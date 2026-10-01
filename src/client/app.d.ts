/** 浏览器端界面逻辑的类型声明（实现是纯 JS，浏览器与 Node 共用同一份文件） */

export interface ApplySurfaceInput {
  nextHtml: unknown;
  prevHtml: unknown;
  painted: unknown;
  force?: boolean;
}

/** 要不要把这份 html 写进沙箱：看的是「画没画上」，不是「内容变没变」 */
export function shouldApplySurface(input: ApplySurfaceInput): boolean;

export interface NormalizedState {
  version: number;
  html: string;
  scopes: unknown[];
  agents: unknown[];
  tasks: unknown[];
  messages: unknown[];
  events: unknown[];
}

/** 把 /api/state 的任意输入收敛成界面需要的形状，坏输入退化为空 */
export function normalizeState(raw: unknown): NormalizedState;

// ---------------------------------------------------------------------------
// SPEC-014 客户端自举的浏览器端呈现
// ---------------------------------------------------------------------------

/** `client.changed` 的稳定模型：未知 / 坏字段一律退化为默认值 */
export interface ClientChange {
  kind: 'write' | 'revert' | 'unknown';
  path: string;
  file: string;
  reason: string;
  selfTest: string;
  author: string;
  version: number | null;
  added: number | null;
  removed: number | null;
  isCss: boolean;
  needsRefresh: boolean;
  ts: string;
}

/** 路径是否是能无刷新热替换的样式表（忽略查询串 / 目录 / 大小写） */
export function isCssClientPath(path: unknown): boolean;

/** 从任意路径里取文件名：`src/client/style.css` → `style.css` */
export function baseNameOf(path: unknown): string;

/** 给样式表地址加 cache-bust 查询串；空地址或坏输入返回空串 */
export function cacheBustHref(href: unknown, version: unknown, nonce: unknown): string;

/** 在已有样式表地址里按文件名定位，找不到返回 -1 */
export function findStyleLinkIndex(hrefs: unknown, path: unknown): number;

/** `client.changed` 的 data → 稳定模型 */
export function normalizeClientChange(raw: unknown): ClientChange;

/** 自检结果 → 中文（未知显示「未知」，不装作通过） */
export function selfTestLabel(value: unknown): string;

/** 变更横幅 HTML（所有文本都经过 escapeHtml） */
export function renderClientChange(raw: unknown): string;

/** `/api/state` 的一条客户端源码记录 */
export interface ClientSource {
  path: string;
  bytes: number | null;
  versions: number | null;
}

/** `/api/state.sources` → 稳定列表；缺字段 / 坏输入退化为空数组 */
export function normalizeSources(raw: unknown): ClientSource[];

/** 检查器「客户端源码」一行：路径 / 字节 / 版本数（缺字段显示 —） */
export function renderSourceRow(source: unknown): string;
