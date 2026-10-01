/**
 * SPEC-017 浏览器端设置页：纯逻辑 + DOM 渲染 / 接线。
 *
 * 分工和 `app.js` 一致：
 *
 * - 上半部分是**纯函数**：设置归一化、预设、表单校验、表单 ⇄ 设置互转、测试 / 保存结果渲染。
 *   不碰 DOM、不碰网络，`node --test` 里 import 进来没有副作用，可以直接断言（UI3-002…UI3-008）。
 * - 下半部分 `createSettingsPage()` 只做 DOM 连线，由 `app.js` 在浏览器里实例化（UI3-001）。
 *
 * 安全底线（SPEC-015 §2 / SPEC-017 §4）：
 *
 * - `GET /api/settings` 只回 `apiKeyMasked`；本模块**只读打码值**，从不读 `apiKey` 字段，
 *   表单里的 Key 输入框永远是空的，只有人类亲手输入才会随 PUT / POST 的请求体发出。
 * - Key 不进浏览器存储 / cookie / URL，也不打日志。
 * - 所有进入 DOM 的文本都过 `escapeHtml`（`textContent` 路径天然安全）。
 */

import { escapeHtml } from './renderer.js';

// ---------------------------------------------------------------------------
// 基础取值：坏输入一律退化成安全值，绝不抛异常
// ---------------------------------------------------------------------------

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value) {
  return typeof value === 'string' ? value : '';
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstString(item, keys) {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
}

function firstNumber(item, keys) {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 协议与预设
// ---------------------------------------------------------------------------

/**
 * 两种协议的端点差异。文案里刻意不写具体主机地址——预设按钮负责填地址，
 * 说明只讲清「打哪个路径、怎么鉴权」。
 */
export const PROTOCOLS = [
  {
    value: 'openai',
    label: 'OpenAI 兼容',
    endpoint: 'POST {baseUrl}/chat/completions',
    auth: 'Authorization: Bearer <key>',
    note: 'Ollama、vLLM、DeepSeek、OpenAI 官方等',
  },
  {
    value: 'anthropic',
    label: 'Anthropic',
    endpoint: 'POST {baseUrl}/v1/messages',
    auth: 'x-api-key + anthropic-version',
    note: 'Claude 官方与 Anthropic 兼容网关',
  },
];

/** 预设快捷按钮：一键填好协议 + Base URL + 模型名 */
export const PRESETS = [
  { id: 'ollama', label: '本机 Ollama', protocol: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:4b' },
  { id: 'openai', label: 'OpenAI 官方', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'anthropic', label: 'Anthropic 官方', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5' },
  { id: 'deepseek', label: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
];

/** SPEC-015 §1 的默认值：本机 Ollama，开箱即用、离线、不要 Key */
export const DEFAULT_SETTINGS = Object.freeze({
  protocol: 'openai',
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'qwen3:4b',
  label: '本机 Ollama',
});

/** 测试结果里模型回复最多展示多少字符 */
export const MAX_REPLY_SNIPPET = 80;

/** 未知协议退化为列表第一项（openai），不瞎猜 anthropic */
export function protocolMeta(value) {
  const raw = str(value).toLowerCase();
  for (const meta of PROTOCOLS) {
    if (meta.value === raw) return meta;
  }
  return PROTOCOLS[0];
}

/** 按 id 找预设；未知 id 返回 null（调用方据此保持表单原样） */
export function presetById(id) {
  const key = str(id);
  for (const preset of PRESETS) {
    if (preset.id === key) return preset;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 设置归一化（GET /api/settings、/api/state、PUT 响应共用）
// ---------------------------------------------------------------------------

/** 给浏览器看的稳定设置模型；`apiKeyMasked` 是唯一与 Key 有关的字段 */
export function readSettings(raw) {
  const item = unwrapSettings(raw);
  const protocol = item.protocol === 'anthropic' || item.provider === 'anthropic' ? 'anthropic' : 'openai';
  const apiKeyMasked = firstString(item, ['apiKeyMasked', 'maskedApiKey', 'api_key_masked', 'keyMasked']);
  return {
    protocol,
    baseUrl: firstString(item, ['baseUrl', 'baseURL', 'base_url', 'endpoint', 'url']).trim(),
    model: firstString(item, ['model', 'modelName', 'model_name']).trim(),
    // 只认打码值：服务端就算误传明文 `apiKey`，这里也当作不存在，绝不进 DOM
    apiKeyMasked,
    hasApiKey:
      item.hasApiKey === true || item.has_api_key === true || item.hasKey === true || apiKeyMasked.length > 0,
    temperature: firstNumber(item, ['temperature']),
    maxTokens: firstNumber(item, ['maxTokens', 'max_tokens', 'maxOutputTokens', 'max_output_tokens']),
    timeoutMs: firstNumber(item, ['timeoutMs', 'timeout', 'timeout_ms']),
    label: firstString(item, ['label', 'sourceLabel', 'providerLabel']).trim(),
  };
}

/** `{ok, settings:{…}}` / `{value:{…}}` 这类外壳先剥掉，再读字段 */
function unwrapSettings(raw) {
  if (!isRecord(raw)) return {};
  for (const key of ['settings', 'value', 'data', 'result']) {
    const nested = raw[key];
    if (isRecord(nested) && hasSettingsField(nested)) return { ...raw, ...nested };
  }
  return raw;
}

function hasSettingsField(item) {
  return ['protocol', 'provider', 'baseUrl', 'base_url', 'model', 'modelName', 'apiKeyMasked', 'hasApiKey'].some(
    (key) => key in item,
  );
}

/** 缺字段 → 补 SPEC-015 §1 的默认值；来源标签缺失时按 Base URL 推断 */
export function normalizeSettings(raw) {
  const item = readSettings(raw);
  const baseUrl = item.baseUrl.length > 0 ? item.baseUrl : DEFAULT_SETTINGS.baseUrl;
  const model = item.model.length > 0 ? item.model : DEFAULT_SETTINGS.model;
  const label = item.label.length > 0 ? item.label : item.baseUrl.length > 0 ? labelFor(item) : DEFAULT_SETTINGS.label;
  return { ...item, baseUrl, model, label };
}

/** 来源标签：服务端给了就用，没给就按 Base URL 推断（与 SPEC-015 §1 的默认一致） */
export function labelFor(raw) {
  const item = readSettings(raw);
  if (item.label.length > 0) return item.label;
  const url = item.baseUrl;
  if (url.length === 0) return '';
  if (item.protocol === 'openai' && /(11434|localhost|127\.0\.0\.1)/.test(url)) return '本机 Ollama';
  if (/anthropic\.com/.test(url)) return 'Anthropic 官方';
  if (/api\.openai\.com/.test(url)) return 'OpenAI 官方';
  if (/deepseek\.com/.test(url)) return 'DeepSeek';
  return '自定义端点';
}

/**
 * 从 `/api/state`（或 `settings` 事件）里挑出生效模型信息。
 * 找不到任何线索就返回 null —— 不拿默认值冒充「服务端说过的状态」。
 */
export function effectiveModelFromState(raw) {
  const state = isRecord(raw) ? raw : {};
  const sources = [state.settings, state.effectiveModel, state.currentModel, state.model, state.current, state.agent];
  let merged = null;

  for (const source of toArray(sources)) {
    if (isRecord(source)) {
      merged = { ...(merged ?? {}), ...source };
    } else if (typeof source === 'string' && source.length > 0 && merged === null) {
      merged = { model: source };
    }
  }

  if (merged === null) {
    if (typeof state.model === 'string' && state.model.length > 0) merged = { model: state.model };
    else return null;
  }

  for (const key of ['protocol', 'baseUrl', 'baseURL', 'base_url', 'label', 'apiKeyMasked', 'hasApiKey', 'model']) {
    if (merged[key] === undefined && state[key] !== undefined) merged[key] = state[key];
  }

  const settings = readSettings(merged);
  if (settings.model.length === 0 && settings.label.length === 0) return null;
  return settings;
}

/** 当前生效模型的展示文案：`模型名 · 来源`（UI3-002） */
export function currentModelText(raw) {
  const item = normalizeSettings(raw);
  const model = item.model.length > 0 ? item.model : '(未配置模型)';
  const label = item.label.length > 0 ? item.label : '自定义端点';
  return `${model} · ${label}`;
}

/** 当前生效模型的 HTML（所有文本转义） */
export function renderCurrentModel(raw) {
  const text = currentModelText(raw);
  return `<span class="model-chip" data-model="${escapeHtml(text)}">${escapeHtml(text)}</span>`;
}

// ---------------------------------------------------------------------------
// 设置 ⇄ 表单
// ---------------------------------------------------------------------------

/** 空表单：Base URL / 模型名也留空，等人类或预设来填 */
export function emptyForm() {
  return {
    protocol: 'openai',
    baseUrl: '',
    model: '',
    apiKey: '',
    temperature: '',
    maxTokens: '',
    timeoutMs: '',
  };
}

/** 任意输入 → 表单值（全部是字符串，直接喂给 input.value）；数字缺失退化为空串 */
export function settingsToForm(raw) {
  const item = normalizeSettings(raw);
  return {
    protocol: item.protocol,
    baseUrl: item.baseUrl,
    model: item.model,
    apiKey: '', // 明文永不回填
    temperature: item.temperature === null ? '' : String(item.temperature),
    maxTokens: item.maxTokens === null ? '' : String(item.maxTokens),
    timeoutMs: item.timeoutMs === null ? '' : String(item.timeoutMs),
  };
}

/** 默认表单：本机 Ollama（SPEC-015 §1），Key 留空 */
export function defaultForm() {
  return settingsToForm(DEFAULT_SETTINGS);
}

/** 已存过 Key 时，Key 输入框的 placeholder：打码值 + 「留空表示不修改」 */
export function apiKeyPlaceholder(raw) {
  const item = normalizeSettings(raw);
  if (item.apiKeyMasked.length > 0) return `${item.apiKeyMasked}（留空表示不修改）`;
  if (item.hasApiKey) return '已保存（打码不可用）（留空表示不修改）';
  return '可留空（本机模型无需 Key）';
}

/** Key 字段下方的说明文案 */
export function apiKeyHint(raw) {
  const item = normalizeSettings(raw);
  if (item.apiKeyMasked.length > 0) return `已保存 API Key：${item.apiKeyMasked} · 留空表示不修改`;
  if (item.hasApiKey) return '已保存 API Key · 留空表示不修改';
  return '尚未保存 API Key；本机模型可留空';
}

function formFromUnknown(value) {
  const item = isRecord(value) ? value : {};
  return {
    protocol: item.protocol === 'anthropic' ? 'anthropic' : 'openai',
    baseUrl: str(item.baseUrl),
    model: str(item.model),
    apiKey: str(item.apiKey),
    temperature: str(item.temperature),
    maxTokens: str(item.maxTokens),
    timeoutMs: str(item.timeoutMs),
  };
}

/** 点预设：只覆盖协议 + Base URL + 模型名，人类已输入的 Key 与数字原样保留（UI3-005） */
export function formFromPreset(id, current) {
  const base = formFromUnknown(current);
  const preset = presetById(id);
  if (preset === null) return base;
  return { ...base, protocol: preset.protocol, baseUrl: preset.baseUrl, model: preset.model };
}

/** 当前表单正好等于哪个预设（用于高亮）；都不匹配返回空串 */
export function activePresetId(form) {
  const item = formFromUnknown(form);
  for (const preset of PRESETS) {
    if (preset.protocol === item.protocol && preset.baseUrl === item.baseUrl.trim() && preset.model === item.model.trim()) {
      return preset.id;
    }
  }
  return '';
}

/** 从 DOM 元素读表单。只依赖 `.value` / `.checked`，所以 Node 里能用普通对象测（UI3-006） */
export function readFormFields(elements) {
  const nodes = isRecord(elements) ? elements : {};
  return {
    protocol: checkedProtocol(nodes.protocolInputs),
    baseUrl: fieldValue(nodes.baseUrl),
    model: fieldValue(nodes.model),
    apiKey: fieldValue(nodes.apiKey),
    temperature: fieldValue(nodes.temperature),
    maxTokens: fieldValue(nodes.maxTokens),
    timeoutMs: fieldValue(nodes.timeoutMs),
  };
}

function fieldValue(node) {
  return isRecord(node) && typeof node.value === 'string' ? node.value : '';
}

function checkedProtocol(inputs) {
  for (const input of toArray(inputs)) {
    if (isRecord(input) && input.checked === true && typeof input.value === 'string' && input.value.length > 0) {
      return input.value;
    }
  }
  return 'openai';
}

// ---------------------------------------------------------------------------
// 校验与请求体
// ---------------------------------------------------------------------------

/** 可选数字：空 → null（用服务端默认）；坏输入 → 'bad' */
function optionalNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 'bad';
  const text = String(value).trim();
  if (text.length === 0) return null;
  const num = Number(text);
  return Number.isFinite(num) ? num : 'bad';
}

function optionalInteger(value) {
  const num = optionalNumber(value);
  if (num === null || num === 'bad') return num;
  return Number.isInteger(num) ? num : 'bad';
}

/**
 * 表单校验（UI3-006）。返回 `{ok, errors}`：errors 以字段名为键，值是可读中文，
 * 设置页直接把 errors 渲染在结果区，**不发请求**。
 */
export function validateForm(form) {
  const item = isRecord(form) ? form : {};
  const errors = {};

  const protocol = str(item.protocol).toLowerCase();
  if (protocol !== 'openai' && protocol !== 'anthropic') errors.protocol = '协议只能是 openai 或 anthropic';

  const baseUrl = str(item.baseUrl).trim();
  if (baseUrl.length === 0) errors.baseUrl = '请填写 Base URL';
  else if (!/^https?:\/\//i.test(baseUrl)) errors.baseUrl = 'Base URL 需以 http:// 或 https:// 开头';

  if (str(item.model).trim().length === 0) errors.model = '请填写模型名';

  const temperature = optionalNumber(item.temperature);
  if (temperature === 'bad') errors.temperature = '温度需为数字';
  else if (temperature !== null && (temperature < 0 || temperature > 2)) errors.temperature = '温度需在 0 到 2 之间';

  const maxTokens = optionalInteger(item.maxTokens);
  if (maxTokens === 'bad' || (maxTokens !== null && maxTokens < 1)) errors.maxTokens = '最大输出 token 需为正整数';

  const timeoutMs = optionalInteger(item.timeoutMs);
  if (timeoutMs === 'bad' || (timeoutMs !== null && timeoutMs < 1)) errors.timeoutMs = '超时需为大于 0 的整数（ms）';

  return { ok: Object.keys(errors).length === 0, errors };
}

/**
 * 表单 → `PUT /api/settings` 请求体。
 * Key 为空时**不带 apiKey 字段**：服务端据此保留原有 Key（SPEC-015 §2）。
 */
export function formToPayload(form) {
  const check = validateForm(form);
  if (!check.ok) return { ok: false, errors: check.errors };

  const item = isRecord(form) ? form : {};
  const payload = {
    protocol: str(item.protocol).toLowerCase(),
    baseUrl: str(item.baseUrl).trim(),
    model: str(item.model).trim(),
  };

  const apiKey = str(item.apiKey);
  if (apiKey.trim().length > 0) payload.apiKey = apiKey;

  const temperature = optionalNumber(item.temperature);
  if (typeof temperature === 'number') payload.temperature = temperature;
  const maxTokens = optionalInteger(item.maxTokens);
  if (typeof maxTokens === 'number') payload.maxTokens = maxTokens;
  const timeoutMs = optionalInteger(item.timeoutMs);
  if (typeof timeoutMs === 'number') payload.timeoutMs = timeoutMs;

  return { ok: true, payload };
}

// ---------------------------------------------------------------------------
// 结果渲染（纯字符串，全部转义）
// ---------------------------------------------------------------------------

function snippet(text) {
  const value = text.replace(/\s+/g, ' ').trim();
  return value.length > MAX_REPLY_SNIPPET ? `${value.slice(0, MAX_REPLY_SNIPPET)}…` : value;
}

/** 字段名 → 中文（错误信息里给人类看的） */
export function fieldLabel(field) {
  const labels = {
    protocol: '协议',
    baseUrl: 'Base URL',
    model: '模型名',
    apiKey: 'API Key',
    temperature: '温度',
    maxTokens: '最大输出 token',
    timeoutMs: '超时(ms)',
  };
  const key = str(field);
  return labels[key] ?? key;
}

/** `POST /api/settings/test` 的响应 → 稳定模型；缺字段退化，绝不抛异常 */
export function normalizeTestResult(raw) {
  const item = isRecord(raw) ? raw : {};
  const ok = item.ok === true;
  const error = firstString(item, ['error', 'reason', 'detail']);
  return {
    ok,
    latencyMs: firstNumber(item, ['latencyMs', 'latency', 'ms']),
    reply: firstString(item, ['reply', 'message', 'text', 'content']),
    error: ok ? '' : error.length > 0 ? error : '测试失败',
  };
}

/** 测试结果 HTML：成功显示延迟 ms 与回复片段，失败显示可读错误（UI3-007） */
export function renderTestResult(raw) {
  const result = normalizeTestResult(raw);
  if (result.ok) {
    const parts = ['<span class="result-title">连接成功</span>'];
    if (result.latencyMs !== null) {
      parts.push(`<span class="result-latency">延迟 ${escapeHtml(Math.round(result.latencyMs))} ms</span>`);
    }
    if (result.reply.length > 0) {
      parts.push(`<span class="result-reply">模型回复：${escapeHtml(snippet(result.reply))}</span>`);
    }
    return `<div class="settings-result is-ok" data-test-ok="true">${parts.join('')}</div>`;
  }
  return `<div class="settings-result is-fail" data-test-ok="false">` +
    '<span class="result-title">连接失败</span>' +
    `<span class="result-error">${escapeHtml(result.error)}</span>` +
    '</div>';
}

/** 任意错误响应 → 可读中文（error / message / 字段错误表） */
export function normalizeSaveError(raw) {
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  const item = isRecord(raw) ? raw : {};
  const direct = firstString(item, ['error', 'message', 'reason']);
  if (direct.length > 0) return direct;
  if (isRecord(item.errors)) {
    const parts = [];
    for (const [field, message] of Object.entries(item.errors)) {
      if (typeof message === 'string' && message.length > 0) parts.push(`${fieldLabel(field)}：${message}`);
      if (parts.length >= 3) break;
    }
    if (parts.length > 0) return parts.join('；');
  }
  return '服务端没有返回可读信息';
}

/** 保存失败 HTML（停留在设置页） */
export function renderSaveError(raw) {
  return `<div class="settings-result is-fail" data-save-ok="false">` +
    '<span class="result-title">保存失败</span>' +
    `<span class="result-error">${escapeHtml(normalizeSaveError(raw))}</span>` +
    '</div>';
}

/** 读取设置失败 HTML（退化显示，但明确说「失败」，不假装正常） */
export function renderLoadError(raw) {
  return `<div class="settings-result is-fail" data-load-ok="false">` +
    '<span class="result-title">读取设置失败</span>' +
    `<span class="result-error">${escapeHtml(normalizeSaveError(raw))}</span>` +
    '</div>';
}

/** 本地校验错误 → HTML 列表 */
export function renderFormErrors(errors) {
  const item = isRecord(errors) ? errors : {};
  const rows = Object.entries(item)
    .filter(([, message]) => typeof message === 'string' && message.length > 0)
    .map(([field, message]) => `<li data-field="${escapeHtml(field)}">${escapeHtml(`${fieldLabel(field)}：${message}`)}</li>`);
  if (rows.length === 0) return '';
  return `<div class="settings-result is-fail" data-form-errors="true"><ul class="form-errors">${rows.join('')}</ul></div>`;
}

/** 协议说明 HTML：端点 / 鉴权差异一目了然（UI3-003） */
export function renderProtocolHint(protocol) {
  const meta = protocolMeta(protocol);
  return `<p class="settings-hint" data-protocol-hint="${escapeHtml(meta.value)}">` +
    `选择「${escapeHtml(meta.label)}」后请求 <code>${escapeHtml(meta.endpoint)}</code>` +
    `，鉴权：<code>${escapeHtml(meta.auth)}</code>；适用于${escapeHtml(meta.note)}。</p>`;
}

/** 预设按钮 HTML（当前生效的那个加 is-active，UI3-005） */
export function renderPresetButtons(activeId) {
  const active = str(activeId);
  return PRESETS.map((preset) => {
    const isActive = preset.id === active;
    return `<button type="button" class="btn preset-btn${isActive ? ' is-active' : ''}" data-preset="${escapeHtml(preset.id)}"` +
      ` aria-pressed="${isActive ? 'true' : 'false'}"` +
      ` title="${escapeHtml(`${preset.protocol} · ${preset.baseUrl} · ${preset.model}`)}">` +
      `${escapeHtml(preset.label)}</button>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// 设置页 DOM 控制器（只在浏览器里跑，由 app.js 实例化）
// ---------------------------------------------------------------------------

/**
 * 把设置页接上 DOM。所有节点由调用方传入，本模块不直接碰 `document`，
 * 这样纯逻辑与 DOM 的边界一眼可见。
 */
export function createSettingsPage(options) {
  const config = isRecord(options) ? options : {};
  const nodes = isRecord(config.nodes) ? config.nodes : {};
  const request = typeof config.request === 'function' ? config.request : null;
  const onSaved = typeof config.onSaved === 'function' ? config.onSaved : null;
  let settings = normalizeSettings(null);
  let busy = false;

  function isOpen() {
    return nodes.page !== undefined && nodes.page.hidden === false;
  }

  function setBusy(value) {
    busy = value === true;
    if (nodes.save !== undefined) nodes.save.disabled = busy;
    if (nodes.test !== undefined) nodes.test.disabled = busy;
  }

  function showResult(html, state) {
    if (nodes.result === undefined) return;
    nodes.result.innerHTML = html;
    if (typeof state === 'string' && state.length > 0) nodes.result.dataset.state = state;
    else delete nodes.result.dataset.state;
  }

  function fillForm(form, keepApiKey = false) {
    for (const input of toArray(nodes.protocolInputs)) {
      if (isRecord(input)) input.checked = input.value === form.protocol;
    }
    if (nodes.baseUrl !== undefined) nodes.baseUrl.value = form.baseUrl;
    if (nodes.model !== undefined) nodes.model.value = form.model;
    // 服务端不回明文，输入框永远留空；只有「点预设」这条路要保住人类刚敲进去的 Key
    if (nodes.apiKey !== undefined && !keepApiKey) nodes.apiKey.value = '';
    if (nodes.temperature !== undefined) nodes.temperature.value = form.temperature;
    if (nodes.maxTokens !== undefined) nodes.maxTokens.value = form.maxTokens;
    if (nodes.timeoutMs !== undefined) nodes.timeoutMs.value = form.timeoutMs;
  }

  function paintModel(value) {
    const text = currentModelText(value);
    if (nodes.topbarModel !== undefined) nodes.topbarModel.textContent = text;
    if (nodes.pageModel !== undefined) nodes.pageModel.textContent = text;
  }

  function paintSettings() {
    const form = readFormFields(nodes);
    if (nodes.protocolHint !== undefined) nodes.protocolHint.innerHTML = renderProtocolHint(form.protocol);
    if (nodes.apiKeyHint !== undefined) nodes.apiKeyHint.textContent = apiKeyHint(settings);
    if (nodes.apiKey !== undefined) nodes.apiKey.placeholder = apiKeyPlaceholder(settings);
    if (nodes.presets !== undefined) nodes.presets.innerHTML = renderPresetButtons(activePresetId(form));
    paintModel(settings);
  }

  function open() {
    if (nodes.page === undefined) return;
    nodes.page.hidden = false;
    if (nodes.back !== undefined) nodes.back.focus?.();
    const form = settingsToForm(settings);
    fillForm(form);
    paintSettings();
    void load();
  }

  function close() {
    if (nodes.page === undefined) return;
    nodes.page.hidden = true;
  }

  async function load() {
    if (request === null) return;
    const response = await request('/api/settings', { method: 'GET' });
    if (response === null) {
      showResult(renderLoadError('服务端没有响应'), 'fail');
      return;
    }
    if (!response.ok) {
      showResult(renderLoadError(isRecord(response.data) ? response.data : { error: `HTTP ${response.status}` }), 'fail');
      return;
    }
    applySettings(response.data);
  }

  function applySettings(raw) {
    settings = normalizeSettings(raw);
    fillForm(settingsToForm(settings));
    paintSettings();
  }

  function applyEffectiveModel(raw) {
    const model = effectiveModelFromState(raw);
    if (model === null) return;
    paintModel(model);
  }

  async function save() {
    if (busy) return;
    const check = formToPayload(readFormFields(nodes));
    if (!check.ok) {
      showResult(renderFormErrors(check.errors), 'fail');
      return;
    }
    if (request === null) {
      showResult(renderSaveError('当前环境不支持保存'), 'fail');
      return;
    }
    setBusy(true);
    const response = await request('/api/settings', { method: 'PUT', body: check.payload });
    setBusy(false);
    if (response === null) {
      showResult(renderSaveError('服务端没有响应'), 'fail');
      return;
    }
    if (!response.ok || (isRecord(response.data) && response.data.ok === false)) {
      const data = isRecord(response.data) ? response.data : { error: `HTTP ${response.status}` };
      showResult(renderSaveError(data), 'fail');
      return;
    }
    const saved = mergeSavedSettings(check.payload, response.data);
    settings = saved;
    fillForm(settingsToForm(settings));
    paintSettings();
    showResult('', '');
    close();
    if (onSaved !== null) onSaved(saved);
  }

  /** 保存成功后的生效设置：以刚提交的请求体为准，服务端回显了模型才覆盖（空字段不覆盖） */
  function mergeSavedSettings(payload, responseData) {
    const echoed = readSettings(responseData);
    const merged = {
      protocol: payload.protocol,
      baseUrl: payload.baseUrl,
      model: payload.model,
      temperature: payload.temperature,
      maxTokens: payload.maxTokens,
      timeoutMs: payload.timeoutMs,
      apiKeyMasked: echoed.apiKeyMasked.length > 0 ? echoed.apiKeyMasked : settings.apiKeyMasked,
      hasApiKey:
        (typeof payload.apiKey === 'string' && payload.apiKey.length > 0) || echoed.hasApiKey || settings.hasApiKey,
      label: echoed.label,
    };
    if (echoed.model.length > 0) {
      merged.protocol = echoed.protocol;
      merged.baseUrl = echoed.baseUrl.length > 0 ? echoed.baseUrl : payload.baseUrl;
      merged.model = echoed.model;
      merged.temperature = echoed.temperature === null ? payload.temperature : echoed.temperature;
      merged.maxTokens = echoed.maxTokens === null ? payload.maxTokens : echoed.maxTokens;
      merged.timeoutMs = echoed.timeoutMs === null ? payload.timeoutMs : echoed.timeoutMs;
    }
    return normalizeSettings(merged);
  }

  async function runTest() {
    if (busy) return;
    const check = formToPayload(readFormFields(nodes));
    if (!check.ok) {
      showResult(renderFormErrors(check.errors), 'fail');
      return;
    }
    if (request === null) {
      showResult(renderTestResult({ ok: false, error: '当前环境不支持测试连接' }), 'fail');
      return;
    }
    setBusy(true);
    showResult('<div class="settings-result is-pending" data-test-ok="pending"><span class="result-title">正在测试连接…</span></div>', 'pending');
    const response = await request('/api/settings/test', { method: 'POST', body: check.payload });
    setBusy(false);
    if (response === null) {
      showResult(renderTestResult({ ok: false, error: '服务端没有响应' }), 'fail');
      return;
    }
    const data = isRecord(response.data) ? response.data : {};
    if (!response.ok && data.ok !== true) {
      showResult(renderTestResult({ ok: false, error: normalizeSaveError(data) }), 'fail');
      return;
    }
    const result = normalizeTestResult(data);
    showResult(renderTestResult(data), result.ok ? 'ok' : 'fail');
  }

  if (nodes.back !== undefined) nodes.back.addEventListener('click', () => close());
  if (nodes.save !== undefined) {
    nodes.save.addEventListener('click', (event) => {
      event.preventDefault();
      void save();
    });
  }
  if (nodes.test !== undefined) {
    nodes.test.addEventListener('click', (event) => {
      event.preventDefault();
      void runTest();
    });
  }
  if (nodes.form !== undefined) {
    nodes.form.addEventListener('submit', (event) => {
      event.preventDefault();
      void save();
    });
  }
  for (const input of toArray(nodes.protocolInputs)) {
    if (isRecord(input)) input.addEventListener('change', () => paintSettings());
  }
  if (nodes.presets !== undefined) {
    nodes.presets.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target.closest('[data-preset]') : null;
      if (target === null) return;
      const preset = presetById(target.getAttribute('data-preset'));
      if (preset === null) return;
      fillForm(formFromPreset(preset.id, readFormFields(nodes)), true); // 保住人类已输入的 Key
      paintSettings();
    });
  }

  paintSettings();
  return { open, close, isOpen, load, applySettings, applyEffectiveModel };
}
