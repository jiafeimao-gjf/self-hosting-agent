/**
 * SPEC-020 多对话 / `/` 命令 + SPEC-021 工作空间「文件」页签的类型声明。
 *
 * 实现是纯 JS（浏览器直接加载、Node 直接 import），类型只为 TS 测试与宿主提供签名。
 * 与 `browser.d.ts` / `settings.d.ts` 一样刻意不引用 DOM 类型（`lib` 只有 es2023）：
 * 需要的节点按最小结构描述（`any`），宿主由 `app.js` 注入。
 */

/** 省略 `conversation` 时的对话 id：`default` */
export declare const DEFAULT_CONVERSATION: string;

/** 对话集合端点：`/api/conversations` */
export declare const CONVERSATIONS_PATH: string;

/** 命令端点：`/api/command` */
export declare const COMMAND_PATH: string;

/** 工作空间列表端点：`/api/workspace` */
export declare const WORKSPACE_PATH: string;

/** 工作空间单文件端点：`/api/workspace/file` */
export declare const WORKSPACE_FILE_PATH: string;

/** 缺标题时的对话框面文案 */
export declare const DEFAULT_CONVERSATION_TITLE: string;

/** 输入以 `/` 开头时的可见提示 */
export declare const COMMAND_HINT_TEXT: string;

/** 一个对话都没有时的空态文案 */
export declare const EMPTY_CONVERSATIONS_TEXT: string;

/** 工作空间没有文件时的空态文案 */
export declare const EMPTY_FILES_TEXT: string;

/** 有文件但还没点开时的提示 */
export declare const NO_FILE_SELECTED_TEXT: string;

/** 加载中文案 */
export declare const LOADING_TEXT: string;

/** 截断提示文案 */
export declare const TRUNCATED_TEXT: string;

// ---------------------------------------------------------------------------
// 路由拼装
// ---------------------------------------------------------------------------

/** 任意输入是否是合法对话 id（`[a-z0-9][a-z0-9_-]{0,31}`） */
export declare function isConversationId(raw: unknown): boolean;

/** 任意输入 → 合法对话 id；空 / 非法退化为 `default` */
export declare function conversationIdOf(raw: unknown): string;

/** 给路由带上 `?conversation=<id>`；`default` 走省略形态；空路径返回空串 */
export declare function withConversation(path: unknown, id: unknown): string;

/** SSE 地址：`default` → `/api/stream`，其余 → `/api/stream?conversation=<id>` */
export declare function streamUrl(id: unknown): string;

/** 工作空间列表地址 */
export declare function workspaceUrl(id: unknown): string;

/** 工作空间单文件地址（`path` 经过 encodeURIComponent） */
export declare function workspaceFileUrl(id: unknown, path: unknown): string;

// ---------------------------------------------------------------------------
// 对话列表
// ---------------------------------------------------------------------------

/** 一条对话的稳定模型 */
export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  lastActiveAt: string;
  messages: number;
  /** 默认对话不可删 */
  deletable: boolean;
}

/** 一条对话 / 坏输入 → 稳定模型 */
export declare function normalizeConversation(raw: unknown): Conversation;

/** `{active, conversations}`；坏输入退化为空列表 */
export declare function normalizeConversationList(raw: unknown): {
  active: string;
  conversations: Conversation[];
};

/** `POST /api/conversations` 响应 / `/api/state.conversation` → `{id, title}`；不可用 → null */
export declare function conversationFromState(raw: unknown): { id: string; title: string } | null;

/** `conversationFromState` 的语义化别名（新建对话的响应用） */
export declare function createdConversation(raw: unknown): { id: string; title: string } | null;

/** 该对话是否可删（默认对话不可删） */
export declare function canDeleteConversation(raw: unknown): boolean;

/** `DELETE /api/conversations/<id>` 的地址 */
export declare function deleteConversationUrl(raw: unknown): string;

/** `POST /api/conversations` 的请求体：标题可省 */
export declare function newConversationRequest(title: unknown): { title?: string };

/** 下拉选项文案：标题 + 消息数 */
export declare function conversationOptionLabel(raw: unknown): string;

/** 下拉选项 HTML（active 选中；文本全部转义；空列表给禁用空态选项） */
export declare function renderConversationOptions(raw: unknown): string;

// ---------------------------------------------------------------------------
// `/` 命令
// ---------------------------------------------------------------------------

/** 输入是否以 `/` 开头 */
export declare function isCommandText(text: unknown): boolean;

/** 前缀路由：`'command'` 或 `'message'` */
export declare function routeForText(text: unknown): 'command' | 'message';

/** `POST /api/command` 的请求体 */
export declare function commandRequest(text: unknown): { text: string };

/** 服务端 `action` → 稳定模型；`switch` / `created` 必须带合法目标对话，否则 null */
export declare function commandActionOf(raw: unknown): {
  type: 'switch' | 'created' | 'cleared';
  conversation: string;
} | null;

/** `{ok, command, output, action?}` → 稳定模型（失败原因在 `error` 里） */
export declare function normalizeCommandResult(raw: unknown): {
  ok: boolean;
  command: string;
  output: string;
  error: string;
  action: { type: 'switch' | 'created' | 'cleared'; conversation: string } | null;
};

/** 命令失败 / 网络失败 → 可读中文 */
export declare function commandErrorText(raw: unknown, status?: number): string;

/** 服务端返回 404/405 → 多半是前后端版本漂移（客户端从磁盘读，服务端还停在旧进程） */
export declare function isStaleServer(status?: number): boolean;

export declare const STALE_SERVER_TEXT: string;

/** 命令结果 → 系统消息 HTML（文本全部转义；失败带 `is-fail`） */
export declare function renderCommandResult(raw: unknown, commandText?: string): string;

// ---------------------------------------------------------------------------
// SPEC-021 工作空间
// ---------------------------------------------------------------------------

/** 一条文件元信息：只有 path / bytes / mtime */
export interface WorkspaceFileEntry {
  path: string;
  bytes: number | null;
  mtime: string;
}

/** `/api/workspace` → `{root, files}`；坏输入退化为空列表 */
export declare function normalizeWorkspaceList(raw: unknown): {
  root: string;
  files: WorkspaceFileEntry[];
};

/** 一条文件元信息（坏输入退化） */
export declare function normalizeWorkspaceFileEntry(raw: unknown): WorkspaceFileEntry;

/** `/api/workspace/file` → 内容模型；非字符串 content 退化为空串 */
export declare function normalizeWorkspaceFile(raw: unknown): {
  path: string;
  bytes: number | null;
  content: string;
  truncated: boolean;
};

/** 字节数 → 人话；未知显示 `—` */
export declare function formatBytes(bytes: unknown): string;

/** 修改时间 → `YYYY-MM-DD HH:mm`；认不出原样显示 */
export declare function formatMtime(raw: unknown): string;

/** 文件列表一行 HTML（只有元信息，path 转义） */
export declare function renderFileRow(raw: unknown): string;

/** 文件列表 HTML；空列表返回空串 */
export declare function renderFileList(raw: unknown): string;

/** 服务端错误 / 网络失败 → 可读中文 */
export declare function workspaceErrorText(raw: unknown, status?: number): string;

/** 列表加载失败文案 */
export declare function fileListErrorText(raw: unknown, status?: number): string;

/** 单文件加载失败文案 */
export declare function fileLoadErrorText(raw: unknown, status?: number): string;

/** 截断提示：只有真截断才给文案 */
export declare function truncatedNotice(raw: unknown): string;

// ---------------------------------------------------------------------------
// 控制器
// ---------------------------------------------------------------------------

/** 设置页 / 浏览器面板同款 HTTP 响应形状（由 app.js 的 requestJson 提供） */
export interface ConversationHttpResponse {
  status: number;
  ok: boolean;
  data: unknown;
}

/** 请求函数：路径已由控制器拼好 conversation 查询串 */
export type ConversationRequest = (
  path: string,
  init?: { method?: string; body?: unknown },
) => Promise<ConversationHttpResponse | null>;

/** `createConversationSwitcher` 的依赖注入 */
export interface ConversationSwitcherOptions {
  /** DOM 节点表：select / create / remove / status */
  nodes: Record<string, any>;
  request: ConversationRequest;
  /** 人类切换对话（app.js 据此关旧流、开新流、重画全部区域） */
  onSwitch?: (id: string) => void;
  /** 列表加载 / 新建 / 删除失败的可见文案 */
  onError?: (message: string) => void;
}

/** 对话切换器控制器 */
export interface ConversationSwitcher {
  /** 只更新 UI（下拉选中态、删除按钮可用性） */
  setActive(id: unknown): string;
  /** 当前对话 id */
  getActive(): string;
  /** 最近一次列表 */
  list(): Conversation[];
  /** 拉一次 `GET /api/conversations`；失败返回 null 并给出可见文案 */
  load(): Promise<{ active: string; conversations: Conversation[] } | null>;
  /** 新建对话并切过去；失败返回 null */
  create(title?: unknown): Promise<{ id: string; title: string } | null>;
  /** 删除对话；默认对话不可删；成功返回 true */
  remove(id: unknown): Promise<boolean>;
  /** 切换：更新 UI 并上报 `onSwitch` */
  switchTo(id: unknown): string;
  /** `/api/state.conversation` → 只同步 UI，不触发切换 */
  applyState(raw: unknown): { id: string; title: string } | null;
}

/** 把顶栏切换器接上 DOM */
export declare function createConversationSwitcher(options: ConversationSwitcherOptions): ConversationSwitcher;

/** `createWorkspacePanel` 的依赖注入 */
export interface WorkspacePanelOptions {
  /** DOM 节点表：list / empty / status / content / root */
  nodes: Record<string, any>;
  request: ConversationRequest;
  /** 加载失败的可见文案（app.js 据此进时间线） */
  onError?: (message: string) => void;
}

/** 工作空间「文件」面板控制器 */
export interface WorkspacePanel {
  /** 重新加载文件列表（只请求 `/api/workspace`）；失败返回 null 并给出可见文案 */
  reload(conversationId?: unknown): Promise<{ root: string; files: WorkspaceFileEntry[] } | null>;
  /** 点击文件：这时才请求内容，并用 textContent 展示；失败返回 null */
  openFile(path: unknown): Promise<{
    path: string;
    bytes: number | null;
    content: string;
    truncated: boolean;
  } | null>;
  /** 清空列表与内容，回到空态 */
  clear(): void;
  /** 当前对话 id */
  getConversation(): string;
  /** 当前已加载的文件路径（没有则 null） */
  getLoadedPath(): string | null;
}

/** 把「文件」页签接上 DOM */
export declare function createWorkspacePanel(options: WorkspacePanelOptions): WorkspacePanel;
