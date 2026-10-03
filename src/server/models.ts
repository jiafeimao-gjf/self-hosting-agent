/**
 * SPEC-015 SET-016：列出端点上有哪些模型。
 *
 * 「切换模型」的前提是**看得见有哪些**。让人凭记忆敲 `qwen3.5:9b` 这种东西不合理，
 * 何况 Ollama 上往往躺着十来个模型。
 *
 * 两条路各走各的惯例（都是各自协议里现成的接口）：
 *   · OpenAI 兼容：`GET {baseUrl}/models` → `{data:[{id}]}`（Ollama / vLLM / LM Studio / DeepSeek / OpenAI 都认）
 *   · Anthropic  ：`GET {baseUrl}/v1/models` + `x-api-key` → `{data:[{id, display_name}]}`
 *
 * 三条自我约束：
 *   1. **绝不回显 Key**：错误信息只带状态码与响应片段，不碰请求头；
 *   2. 有超时、有条目上限——列表接口也不能变成拖垮界面的地方；
 *   3. 失败要给出**可归因**的原因（超时 / 连不上 / 鉴权 / 响应格式），而不是笼统一句失败。
 */
import type { ModelSettings } from './settings.ts';

export interface ModelOption {
  id: string;
  /** 更friendly 的显示名（Anthropic 的 display_name，或 Ollama 的体积/参数量） */
  label?: string;
  sizeBytes?: number;
}

export type ListModelsResult =
  | { ok: true; models: ModelOption[]; count: number }
  | { ok: false; code: string; error: string };

/** 列表条目上限：端点上真挂了上千个模型也不必全推给界面 */
export const MAX_MODELS = 200;
export const DEFAULT_LIST_TIMEOUT_MS = 10000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function modelsUrl(settings: ModelSettings): string {
  const base = settings.baseUrl.replace(/\/+$/, '');
  return settings.protocol === 'anthropic' ? `${base}/v1/models` : `${base}/models`;
}

/** Ollama 的原生接口：能给出体积与参数量，用来把选项写得更a有信息量。非 Ollama 时会失败，忽略即可 */
function ollamaTagsUrl(settings: ModelSettings): string | undefined {
  try {
    const url = new URL(settings.baseUrl);
    if (url.port !== '11434') return undefined;
    return `${url.origin}/api/tags`;
  } catch {
    return undefined;
  }
}

function parseOptions(settings: ModelSettings, payload: unknown): ModelOption[] | undefined {
  if (!isRecord(payload)) return undefined;
  const data = payload.data;
  if (!Array.isArray(data)) return undefined;

  const options: ModelOption[] = [];
  for (const entry of data) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === 'string' ? entry.id : typeof entry.name === 'string' ? entry.name : '';
    if (id === '') continue;
    const display = typeof entry.display_name === 'string' && entry.display_name !== '' ? entry.display_name : undefined;
    options.push({ id, ...(display === undefined ? {} : { label: display }) });
    if (options.length >= MAX_MODELS) break;
  }
  void settings;
  return options;
}

/** 尽力而为地补上 Ollama 的体积/参数量；失败就当没有 */
async function enrichWithOllama(
  doFetch: typeof fetch,
  settings: ModelSettings,
  options: ModelOption[],
  timeoutMs: number,
): Promise<ModelOption[]> {
  const tagsUrl = ollamaTagsUrl(settings);
  if (tagsUrl === undefined) return options;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 3000));
    let payload: unknown;
    try {
      const response = await doFetch(tagsUrl, { signal: controller.signal });
      if (!response.ok) return options;
      payload = await response.json();
    } finally {
      clearTimeout(timer);
    }
    if (!isRecord(payload) || !Array.isArray(payload.models)) return options;

    const meta = new Map<string, { size?: number; params?: string }>();
    for (const entry of payload.models) {
      if (!isRecord(entry) || typeof entry.name !== 'string') continue;
      const details = isRecord(entry.details) ? entry.details : {};
      meta.set(entry.name, {
        ...(typeof entry.size === 'number' ? { size: entry.size } : {}),
        ...(typeof details.parameter_size === 'string' ? { params: details.parameter_size } : {}),
      });
    }

    return options.map((option) => {
      const info = meta.get(option.id);
      if (info === undefined) return option;
      const parts: string[] = [];
      if (info.params !== undefined && info.params !== '') parts.push(info.params);
      // 云端模型在本地只是一份很小的 manifest，"0.0 GB" 是噪音，不如不显示
      if (info.size !== undefined && info.size / 1024 ** 3 >= 0.1) parts.push(`${(info.size / 1024 ** 3).toFixed(1)} GB`);
      return {
        ...option,
        ...(parts.length === 0 ? {} : { label: parts.join(' · ') }),
        ...(info.size === undefined ? {} : { sizeBytes: info.size }),
      };
    });
  } catch {
    return options;
  }
}

export async function fetchModelList(
  settings: ModelSettings,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<ListModelsResult> {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    return { ok: false, code: 'NO_FETCH', error: '当前运行时没有全局 fetch' };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;
  const url = modelsUrl(settings);
  const headers: Record<string, string> =
    settings.protocol === 'anthropic'
      ? {
          'x-api-key': settings.apiKey,
          'anthropic-version': '2023-06-01',
        }
      : settings.apiKey === ''
        ? {} // 本机 Ollama 不要鉴权：带一个空 Bearer 反而可能被网关拒
        : { authorization: `Bearer ${settings.apiKey}` };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await doFetch(url, { method: 'GET', headers, signal: controller.signal });
    } catch (err) {
      const aborted = controller.signal.aborted;
      return {
        ok: false,
        code: aborted ? 'TIMEOUT' : 'NETWORK',
        error: aborted ? `列模型超时（${timeoutMs}ms）：${url}` : `连不上端点：${url}（${err instanceof Error ? err.message : String(err)}）`,
      };
    }

    const raw = await response.text().catch(() => '');
    if (!response.ok) {
      const snippet = raw.slice(0, 200).replace(/\s+/g, ' ').trim();
      return {
        ok: false,
        code: response.status === 401 || response.status === 403 ? 'UNAUTHORIZED' : 'HTTP',
        error: `端点返回 HTTP ${response.status}${snippet === '' ? '' : `：${snippet}`}`,
      };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return { ok: false, code: 'BAD_RESPONSE', error: '响应不是合法 JSON（这个端点可能不支持列模型）' };
    }

    const parsed = parseOptions(settings, payload);
    if (parsed === undefined) {
      return { ok: false, code: 'BAD_RESPONSE', error: '响应里没有 models 数组（这个端点可能不支持列模型）' };
    }
    if (parsed.length === 0) {
      return { ok: true, models: [], count: 0 };
    }

    const enriched = await enrichWithOllama(doFetch, settings, parsed, timeoutMs);
    enriched.sort((a, b) => a.id.localeCompare(b.id));
    return { ok: true, models: enriched, count: enriched.length };
  } finally {
    clearTimeout(timer);
  }
}
