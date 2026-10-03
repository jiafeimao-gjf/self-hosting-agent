/** 浏览器端 Markdown 渲染的类型声明（实现是纯 JS，浏览器与 Node 共用） */

/** HTML 转义：整个渲染的第一步，也是唯一的安全边界 */
export declare function escapeHtml(text: unknown): string;

/** 链接协议白名单；不安全返回 null（调用方降级成纯文本） */
export declare function sanitizeUrl(url: unknown): string | null;

/** Markdown → HTML（先整段转义，再做标记，永不产出源文本里的 HTML） */
export declare function renderMarkdown(source: unknown): string;

/** 这段文本里有没有 Markdown 标记 */
export declare function looksLikeMarkdown(text: unknown): boolean;
