/**
 * SPEC-012 §1 浏览器端渲染器的类型声明。
 *
 * 实现是纯 JS（浏览器直接加载，Node 直接 import），类型只为 TS 测试与宿主提供签名。
 */

/** 嵌套深度上限（与 src/surface/viewspec.ts 的 MAX_VIEW_DEPTH 保持一致） */
export declare const MAX_VIEW_DEPTH: number;

/**
 * 组件词汇表。必须与 `src/surface/viewspec.ts` 的 `Object.keys(COMPONENT_SPECS)` 完全一致，
 * 由 `test/client-ui.test.ts` 的漂移门禁守护（UI-002）。
 */
export declare const COMPONENT_TYPES: readonly string[];

/** 把任意值转成安全的 HTML 文本 / 属性值（`& < > " '`） */
export declare function escapeHtml(value: unknown): string;

/** 渲染组件片段（不带文档外壳）；未知组件与非法节点降级为占位块，永不抛异常 */
export declare function renderFragment(spec: unknown): string;

/** 渲染自包含 HTML 文档（沙箱 iframe 的 srcdoc），样式内联、无外部依赖 */
export declare function renderViewSpec(spec: unknown, options?: { title?: string }): string;
