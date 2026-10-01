/**
 * SPEC-017 浏览器端设置页的类型声明。
 *
 * 实现是纯 JS（浏览器直接加载、Node 直接 import），类型只为 TS 测试与宿主提供签名。
 * 这里刻意不引用 DOM 类型：`lib` 只有 es2023，DOM 节点按最小结构（`.value` / `.checked`）描述。
 */

/** 两种模型协议：OpenAI 兼容 / Anthropic */
export type ModelProtocol = 'openai' | 'anthropic';

/** 协议的端点与鉴权差异说明 */
export interface ProtocolMeta {
  value: ModelProtocol;
  label: string;
  /** 形如 `POST {baseUrl}/chat/completions` */
  endpoint: string;
  auth: string;
  note: string;
}

/** 预设快捷按钮 */
export interface Preset {
  id: string;
  label: string;
  protocol: ModelProtocol;
  baseUrl: string;
  model: string;
}

/** 给浏览器看的稳定设置模型：`apiKeyMasked` 是唯一与 Key 有关的字段 */
export interface SettingsModel {
  protocol: ModelProtocol;
  baseUrl: string;
  model: string;
  apiKeyMasked: string;
  hasApiKey: boolean;
  temperature: number | null;
  maxTokens: number | null;
  timeoutMs: number | null;
  label: string;
}

/** 表单值：全是字符串，可直接写进 `input.value`；Key 恒为空串 */
export interface SettingsForm {
  protocol: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature: string;
  maxTokens: string;
  timeoutMs: string;
}

/** `PUT /api/settings` 的请求体；Key 为空时**不含** `apiKey` 字段 */
export interface SettingsPayload {
  protocol: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface ValidationResult {
  ok: boolean;
  errors: Record<string, string>;
}

export type FormCheckResult =
  | { ok: true; payload: SettingsPayload }
  | { ok: false; errors: Record<string, string> };

/** `POST /api/settings/test` 的稳定结果 */
export interface TestResult {
  ok: boolean;
  latencyMs: number | null;
  reply: string;
  error: string;
}

/** 协议表 */
export declare const PROTOCOLS: readonly ProtocolMeta[];

/** 预设按钮表：本机 Ollama / OpenAI 官方 / Anthropic 官方 / DeepSeek */
export declare const PRESETS: readonly Preset[];

/** SPEC-015 §1 的默认设置：本机 Ollama */
export declare const DEFAULT_SETTINGS: Readonly<{
  protocol: ModelProtocol;
  baseUrl: string;
  model: string;
  label: string;
}>;

/** 测试结果里模型回复最多展示多少字符 */
export declare const MAX_REPLY_SNIPPET: number;

/** 未知协议退化为 openai 并返回其元信息 */
export declare function protocolMeta(value: unknown): ProtocolMeta;

/** 按 id 找预设；未知 id 返回 null */
export declare function presetById(id: unknown): Preset | null;

/** 任意输入 → 设置模型（不补默认值；缺字段为 '' / null） */
export declare function readSettings(raw: unknown): SettingsModel;

/** 任意输入 → 设置模型；缺 baseUrl / model / label 时补 SPEC-015 默认值 */
export declare function normalizeSettings(raw: unknown): SettingsModel;

/** 来源标签：服务端给了就用，否则按 Base URL 推断 */
export declare function labelFor(raw: unknown): string;

/** 从 `/api/state` 或 `settings` 事件里挑出生效模型；没有线索返回 null */
export declare function effectiveModelFromState(raw: unknown): SettingsModel | null;

/** 当前生效模型的展示文案：`模型名 · 来源` */
export declare function currentModelText(raw: unknown): string;

/** 当前生效模型的 HTML（转义） */
export declare function renderCurrentModel(raw: unknown): string;

/** 空表单 */
export declare function emptyForm(): SettingsForm;

/** 设置 → 表单值；`apiKey` 永远是空串（不读明文 Key） */
export declare function settingsToForm(raw: unknown): SettingsForm;

/** 默认表单：本机 Ollama */
export declare function defaultForm(): SettingsForm;

/** Key 输入框的 placeholder（打码值 + 「留空表示不修改」） */
export declare function apiKeyPlaceholder(raw: unknown): string;

/** Key 字段下方的说明文案 */
export declare function apiKeyHint(raw: unknown): string;

/** 点预设：只覆盖协议 + Base URL + 模型名，保留已输入的 Key 与数字 */
export declare function formFromPreset(id: unknown, current?: unknown): SettingsForm;

/** 当前表单正好匹配哪个预设；都不匹配返回 '' */
export declare function activePresetId(form: unknown): string;

/** 从 DOM 元素读表单（只依赖 `.value` / `.checked`，Node 可用普通对象测） */
export declare function readFormFields(elements: unknown): SettingsForm;

/** 表单校验；errors 以字段名为键 */
export declare function validateForm(form: unknown): ValidationResult;

/** 表单 → 请求体；非法输入返回 `{ok:false, errors}` */
export declare function formToPayload(form: unknown): FormCheckResult;

/** 字段名 → 中文 */
export declare function fieldLabel(field: unknown): string;

/** 测试响应 → 稳定结果；缺字段退化 */
export declare function normalizeTestResult(raw: unknown): TestResult;

/** 测试结果 HTML */
export declare function renderTestResult(raw: unknown): string;

/** 任意错误响应 → 可读中文 */
export declare function normalizeSaveError(raw: unknown): string;

/** 保存失败 HTML */
export declare function renderSaveError(raw: unknown): string;

/** 读取设置失败 HTML */
export declare function renderLoadError(raw: unknown): string;

/** 本地校验错误 → HTML 列表 */
export declare function renderFormErrors(errors: unknown): string;

/** 协议说明 HTML（端点 / 鉴权差异） */
export declare function renderProtocolHint(protocol: unknown): string;

/** 预设按钮 HTML；传入当前预设 id 时高亮 */
export declare function renderPresetButtons(activeId?: unknown): string;

/** 设置页 HTTP 响应（由 app.js 的 requestJson 提供） */
export interface SettingsHttpResponse {
  status: number;
  ok: boolean;
  data: unknown;
}

/** `createSettingsPage` 的依赖注入 */
export interface SettingsPageOptions {
  /** DOM 节点表（page / back / form / save / test / result / 各字段 / presets / 两个模型 chip） */
  nodes: Record<string, any>;
  /** 发起请求；返回 null 表示网络层失败 */
  request: (path: string, init?: { method?: string; body?: unknown }) => Promise<SettingsHttpResponse | null>;
  /** 保存成功后的通知（app.js 在对话里提示） */
  onSaved?: (settings: SettingsModel) => void;
}

/** 设置页控制器 */
export interface SettingsPage {
  open(): void;
  close(): void;
  isOpen(): boolean;
  load(): Promise<void>;
  applySettings(raw: unknown): void;
  applyEffectiveModel(raw: unknown): void;
}

/** 把设置页接上 DOM（只在浏览器里调用） */
export declare function createSettingsPage(options: SettingsPageOptions): SettingsPage;
