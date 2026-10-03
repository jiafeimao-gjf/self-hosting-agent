/**
 * SPEC-023 §三 客户端审批对话框的类型声明。
 *
 * 实现是纯 JS（浏览器直接加载、Node 直接 import），类型只为 TS 测试与宿主提供签名。
 * 与 `browser.d.ts` / `settings.d.ts` 一样刻意不引用 DOM 类型（`lib` 只有 es2023）：
 * 需要的节点按最小结构描述，宿主由 `app.js` 注入。
 */

/** 人类回复审批的端点：`/api/approval` */
export declare const APPROVAL_PATH: string;

/** 允许的三个决定：`['allow_once', 'allow_always', 'deny']` */
export declare const APPROVAL_DECISIONS: readonly string[];

/** 决定 → 按钮文案（`允许一次` / `一直允许` / `拒绝`） */
export declare const DECISION_LABELS: Record<string, string>;

/** `detail` 缺失时的占位 */
export declare const EMPTY_DETAIL_TEXT: string;

/** 发起者缺失时的占位 */
export declare const UNKNOWN_AGENT_TEXT: string;

/** 动作名缺失时的占位 */
export declare const UNKNOWN_ACTION_TEXT: string;

/** 风险等级缺失 / 认不出时的占位 */
export declare const UNKNOWN_RISK_TEXT: string;

/** 一条待批审批（SHELL-011）：`detail` 是**完整命令原文**，不 trim、不截断 */
export interface ApprovalRequest {
  id: string;
  action: string;
  risk: string;
  /** 发起者；契约字段是 `agent`，内核 ApprovalRequest 的 `agentId` 也认 */
  agent: string;
  detail: string;
}

/** 对话框展示模型：所有字段都是可直接写 `textContent` 的字符串 */
export interface ApprovalView {
  visible: boolean;
  id: string;
  action: string;
  risk: string;
  agent: string;
  riskLabel: string;
  riskTone: string;
  agentLabel: string;
  actionLabel: string;
  /** 完整命令原文（原文为空时是占位文案） */
  detail: string;
  /** `true` 表示 `detail` 是占位，不是服务端给的原文 */
  detailIsPlaceholder: boolean;
}

/** 任意输入 → 待批模型；没有 id / 输入是 null → `null` */
export declare function normalizeApproval(raw: unknown): ApprovalRequest | null;

/**
 * `/api/state` → 待批模型：**没有 `approval` 字段时返回 `undefined`**（保持现状），
 * 字段存在且为 `null` 时返回 `null`（明确没有待批）。
 */
export declare function approvalFromState(raw: unknown): ApprovalRequest | null | undefined;

/** `decision` 是否在冻结契约的白名单里 */
export declare function isApprovalDecision(raw: unknown): boolean;

/** 决定 → 按钮文案；非法决定返回空串 */
export declare function decisionLabel(raw: unknown): string;

/** 稳定模型 → `POST /api/approval` 请求体；id 为空 / decision 非法 → `null` */
export declare function approvalRequest(id: unknown, decision: unknown): { id: string; decision: string } | null;

/** 风险等级 → 人话；认不出的等级原样显示，空值显示「未知风险」 */
export declare function riskLabel(raw: unknown): string;

/** 风险等级 → 配色语义（`danger` / `warning` / `info` / `default`） */
export declare function riskTone(raw: unknown): string;

/** 对话框展示模型（纯字符串，供控制器用 textContent 写入） */
export declare function approvalView(raw: unknown): ApprovalView;

/** 服务端拒绝 / 网络失败 → 可读中文 */
export declare function approvalErrorText(raw: unknown, status?: number): string;

/** 审批回复的 HTTP 响应（由 app.js 的 requestJson 提供，已带 `?conversation=<id>`） */
export interface ApprovalHttpResponse {
  status: number;
  ok: boolean;
  data: unknown;
}

/** `createApprovalDialog` 的依赖注入 */
export interface ApprovalDialogOptions {
  /**
   * DOM 节点表：`root` / `detail` / `risk` / `agent` / `action` / `error` /
   * `deny` / `allowOnce` / `allowAlways`。`detail` 只用 `textContent` 写入。
   */
  nodes: Record<string, any>;
  /** 发送一个决定；返回 null 表示网络层失败（对话框保持打开） */
  request: (path: string, init?: { method?: string; body?: unknown }) => Promise<ApprovalHttpResponse | null>;
  /** 收到一条待批（app.js 据此进时间线） */
  onAsked?: (view: ApprovalView) => void;
  /** 回复成功、对话框已关闭 */
  onDecided?: (decision: string, request: ApprovalRequest) => void;
  /** 回复失败（对话框仍然打开） */
  onError?: (message: string) => void;
}

/** 审批对话框控制器 */
export interface ApprovalDialog {
  /** 应用一条待批（SSE `approval` / 快照条目）；同一 id 幂等返回 false */
  apply(raw: unknown): boolean;
  /** 应用 `/api/state`；没有 `approval` 字段 → false（保持现状） */
  applyState(raw: unknown): boolean;
  /** 人类的决定：成功关窗返回 true；失败保持打开返回 false */
  decide(decision: unknown): Promise<boolean>;
  /** 关窗并清干净（切对话时用） */
  close(): void;
  isOpen(): boolean;
  isBusy(): boolean;
  getPending(): ApprovalRequest | null;
}

/** 把对话框接上 DOM（只在浏览器里调用） */
export declare function createApprovalDialog(options: ApprovalDialogOptions): ApprovalDialog;
