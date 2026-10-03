/**
 * SPEC-016 Anthropic 协议适配器 —— POST {baseUrl}/v1/messages。
 *
 * 与 SPEC-009 的 `http-model.ts` 是同族：同一个 `ModelPort`，同一套重试 / 超时 / 错误分类 / done 约定。
 * 差别只在**线格式**，而线格式的差异集中在三处：
 *   1. system 是请求体顶层字段，不进 messages；
 *   2. 工具结果是 user 消息里的 `tool_result` 内容块，不是独立的 tool 角色消息；
 *   3. user / assistant 必须交替，连续多条工具结果要合并进同一条 user 消息。
 *
 * 三条设计原则（详见 specs/016-anthropic-model.md）：
 *   1. 端口不变：只实现 ModelPort，Loop 一行不改。
 *   2. 失败要响：不可信的响应一律抛导出类型的错误，绝不降级成空参数去执行工具。
 *   3. 离线可测：零第三方依赖，fetchImpl 可注入，测试用 node:http 本地假服务。
 */
import { createWireNameMap } from './wire-names.ts';
import { createDeltaThrottle, createSseParser } from './sse.ts';
import type { WireNameMap } from './wire-names.ts';
import type {
  ContextItem,
  ModelInput,
  ModelOutput,
  ModelPort,
  ModelStepOptions,
  ToolCall,
  ToolSpec,
} from './loop.ts';

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_RETRY_BASE_DELAY_MS = 250;
/** Anthropic 的 max_tokens 是必填字段：缺省时给一个足够大的合理值，而不是让请求 400 */
export const DEFAULT_MAX_TOKENS = 4096;
export const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';

/** 响应片段最多带这么多字符进错误对象：够排障，又不至于把日志撑爆 */
const BODY_SNIPPET_LIMIT = 500;

export type AnthropicModelErrorKind =
  | 'http'
  | 'network'
  | 'timeout'
  | 'bad_response'
  /** SPEC-022：端点没返回事件流（网关无视 stream:true），调用方应退回非流式 */
  | 'not_stream';

export interface AnthropicModelErrorOptions {
  kind: AnthropicModelErrorKind;
  /** 非 2xx 时的 HTTP 状态码 */
  status?: number;
  /** 响应片段（截断到 500 字符），便于宿主日志与界面展示 */
  bodySnippet?: string;
  cause?: unknown;
}

/**
 * Anthropic 适配器抛出的唯一错误基类：宿主用 `instanceof` 就能把「模型侧故障」与自身 bug 分开。
 * 类型必须导出——不然宿主只能靠 message 字符串猜。
 */
export class AnthropicModelError extends Error {
  readonly kind: AnthropicModelErrorKind;
  readonly status: number | undefined;
  readonly bodySnippet: string | undefined;

  constructor(message: string, options: AnthropicModelErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AnthropicModelError';
    this.kind = options.kind;
    this.status = options.status;
    this.bodySnippet = options.bodySnippet;
  }
}

/** 超时是单独的类型：宿主常需要对它做不同的降级（例如提示用户而不是重试） */
export class AnthropicModelTimeoutError extends AnthropicModelError {
  readonly timeoutMs: number;

  constructor(message: string, timeoutMs: number, cause?: unknown) {
    super(message, { kind: 'timeout', cause });
    this.name = 'AnthropicModelTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export interface AnthropicModelOptions {
  /** 流式失败降级时的回调（排障用：谁把 stream 拒了） */
  onStreamFallback?: (reason: string) => void;
  /** 例如 https://api.anthropic.com；尾部斜杠会被归一化 */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 映射为请求体的 max_tokens；Anthropic 必填，缺省为 4096 */
  maxTokens?: number;
  /** 只有显式给出才写进请求体（0 也是有效值） */
  temperature?: number;
  /** 单次 HTTP 交换（含读 body）的总超时，默认 30000 */
  timeoutMs?: number;
  /** 注入点：测试、代理、自定义传输都靠它；默认 Node 24 全局 fetch */
  fetchImpl?: typeof fetch;
  /** 重试次数（总尝试次数 = maxRetries + 1），默认 2；仅 429 / 5xx / 网络错误会重试 */
  maxRetries?: number;
  /** 退避基数：第 n 次重试等待 base * 2^n，默认 250ms */
  retryBaseDelayMs?: number;
  /** 映射为 anthropic-version 请求头，默认 2023-06-01 */
  anthropicVersion?: string;
}

export function createAnthropicModel(options: AnthropicModelOptions): ModelPort {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error('当前运行时没有全局 fetch，请通过 fetchImpl 注入一个实现');
  }
  const url = `${options.baseUrl.replace(/\/+$/, '')}/v1/messages`;

  return {
    async step(input: ModelInput, stepOptions: ModelStepOptions = {}): Promise<ModelOutput> {
      // 工具名出网前必须压成 [a-zA-Z0-9_-]（Anthropic 同样拒绝点号）
      const names = createWireNameMap(input.tools.map((tool) => tool.name));
      const wantsStream = typeof stepOptions.onDelta === 'function';

      const body = (stream: boolean): string =>
        JSON.stringify({
          ...(buildBody(options, input, names) as Record<string, unknown>),
          ...(stream ? { stream: true } : {}),
        });

      for (let attempt = 0; ; attempt += 1) {
        try {
          if (wantsStream) {
            try {
              return await requestStream(
                doFetch,
                url,
                options,
                body(true),
                timeoutMs,
                names,
                stepOptions.onDelta as (text: string) => void,
              );
            } catch (err) {
              // SPEC-022：流式失败退回非流式（超时除外：再试一次只是让用户多等一个超时）
              if (err instanceof AnthropicModelError && err.kind === 'timeout') throw err;
              if (typeof options.onStreamFallback === 'function') {
                options.onStreamFallback(err instanceof Error ? err.message : String(err));
              }
            }
          }
          return await requestOnce(doFetch, url, options, body(false), timeoutMs, names);
        } catch (err) {
          // 只有排得上号、且还有重试余额的失败才重试；其余（含 4xx、解析错误）立即上抛
          if (!(err instanceof AnthropicModelError) || attempt >= maxRetries || !isRetriable(err)) throw err;
          await sleep(retryBaseDelayMs * 2 ** attempt);
        }
      }
    },
  };
}

// ── 请求 ──

/**
 * SPEC-022：Anthropic 的流式请求。
 *
 * 事件比 OpenAI 啰嗦得多，但我们真正关心的只有四类：
 *   content_block_delta(text_delta)        → 文本增量
 *   content_block_delta(input_json_delta)  → 工具入参增量（按 index 拼）
 *   content_block_start(tool_use)          → 工具名与 id
 *   message_delta / message_stop           → 收尾与 stop_reason
 */
async function requestStream(
  doFetch: typeof fetch,
  url: string,
  options: AnthropicModelOptions,
  payload: string,
  timeoutMs: number,
  names: WireNameMap,
  onDelta: (text: string) => void,
): Promise<ModelOutput> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const throttle = createDeltaThrottle(onDelta);

  try {
    let response: Response;
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': options.apiKey,
          'anthropic-version': options.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION,
        },
        body: payload,
        signal: controller.signal,
      });
    } catch (err) {
      throw transportError(err, controller.signal.aborted, url, timeoutMs);
    }

    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      const snippet = snippetOf(raw);
      throw new AnthropicModelError(
        `Anthropic 流式请求失败：HTTP ${response.status} ${response.statusText}（POST ${url}）${snippet === '' ? '' : `；响应片段：${snippet}`}`,
        { kind: 'http', status: response.status, bodySnippet: snippet },
      );
    }
    // 同上：网关不认 stream 时会回普通 JSON，识别出来走非流式
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      throw new AnthropicModelError(
        `端点没有返回事件流（content-type: ${contentType || '未知'}），改走非流式`,
        { kind: 'not_stream' },
      );
    }
    if (response.body === null) {
      throw new AnthropicModelError('流式响应没有 body', { kind: 'bad_response' });
    }

    let text = '';
    const blocks = new Map<number, { type: string; id: string; name: string; json: string }>();
    let usage = { input_tokens: 0, output_tokens: 0 };
    let stopReason = '';
    let failure: AnthropicModelError | undefined;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = createSseParser((event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return; // 坏块跳过
      }
      const record = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      const type = typeof record.type === 'string' ? record.type : event.event ?? '';

      if (type === 'error') {
        failure = new AnthropicModelError(`流式响应报错：${JSON.stringify(record.error ?? record).slice(0, 200)}`, {
          kind: 'bad_response',
        });
        return;
      }

      if (type === 'content_block_start') {
        const index = typeof record.index === 'number' ? record.index : blocks.size;
        const block = record.content_block;
        const blockRecord = block !== null && typeof block === 'object' ? (block as Record<string, unknown>) : {};
        blocks.set(index, {
          type: typeof blockRecord.type === 'string' ? blockRecord.type : 'unknown',
          id: typeof blockRecord.id === 'string' ? blockRecord.id : '',
          name: typeof blockRecord.name === 'string' ? blockRecord.name : '',
          json: '',
        });
        return;
      }

      if (type === 'content_block_delta') {
        const index = typeof record.index === 'number' ? record.index : 0;
        const delta = record.delta;
        const deltaRecord = delta !== null && typeof delta === 'object' ? (delta as Record<string, unknown>) : {};
        if (deltaRecord.type === 'text_delta' && typeof deltaRecord.text === 'string') {
          text += deltaRecord.text;
          throttle.push(text);
          return;
        }
        if (deltaRecord.type === 'input_json_delta' && typeof deltaRecord.partial_json === 'string') {
          const current = blocks.get(index) ?? { type: 'tool_use', id: '', name: '', json: '' };
          current.json += deltaRecord.partial_json;
          blocks.set(index, current);
        }
        return;
      }

      if (type === 'message_delta') {
        const delta = record.delta;
        const deltaRecord = delta !== null && typeof delta === 'object' ? (delta as Record<string, unknown>) : {};
        if (typeof deltaRecord.stop_reason === 'string') stopReason = deltaRecord.stop_reason;
        const usageField = record.usage;
        if (usageField !== null && typeof usageField === 'object') {
          const usageRecord = usageField as Record<string, unknown>;
          if (typeof usageRecord.output_tokens === 'number') usage.output_tokens = usageRecord.output_tokens;
        }
        return;
      }

      if (type === 'message_start') {
        const message = record.message;
        if (message !== null && typeof message === 'object') {
          const messageRecord = message as Record<string, unknown>;
          const usageField = messageRecord.usage;
          if (usageField !== null && typeof usageField === 'object') {
            const usageRecord = usageField as Record<string, unknown>;
            if (typeof usageRecord.input_tokens === 'number') usage.input_tokens = usageRecord.input_tokens;
          }
        }
      }
    });

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
      }
      parser.push(decoder.decode());
      parser.flush();
    } catch (err) {
      throw transportError(err, controller.signal.aborted, url, timeoutMs);
    }

    if (failure !== undefined) throw failure;

    // 与实体响应同一条解析路径：把流拼回 Anthropic 的 message 形状
    const content: Array<Record<string, unknown>> = [];
    if (text !== '') content.push({ type: 'text', text });
    for (const [, block] of [...blocks.entries()].sort((a, b) => a[0] - b[0])) {
      if (block.type !== 'tool_use') continue;
      let input: unknown = {};
      try {
        input = block.json === '' ? {} : JSON.parse(block.json);
      } catch {
        throw new AnthropicModelError(`工具入参不是合法 JSON：${block.json.slice(0, 120)}`, { kind: 'bad_response' });
      }
      content.push({ type: 'tool_use', id: block.id === '' ? 'toolu_0' : block.id, name: block.name, input });
    }

    const assembled = { content, usage, ...(stopReason === '' ? {} : { stop_reason: stopReason }) };
    const output = parseMessage(JSON.stringify(assembled), url, names);
    throttle.finish(text);
    return output;
  } finally {
    clearTimeout(timer);
  }
}

async function requestOnce(
  doFetch: typeof fetch,
  url: string,
  options: AnthropicModelOptions,
  payload: string,
  timeoutMs: number,
  names: WireNameMap,
): Promise<ModelOutput> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': options.apiKey,
          'anthropic-version': options.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION,
        },
        body: payload,
        signal: controller.signal,
      });
    } catch (err) {
      throw transportError(err, controller.signal.aborted, url, timeoutMs);
    }

    // 读 body 也在超时覆盖范围内：连接建好了但对方挤牙膏同样是故障
    let raw: string;
    try {
      raw = await response.text();
    } catch (err) {
      throw transportError(err, controller.signal.aborted, url, timeoutMs);
    }

    if (!response.ok) {
      const snippet = snippetOf(raw);
      const tail = snippet === '' ? '' : `；响应片段：${snippet}`;
      throw new AnthropicModelError(
        `Anthropic 模型请求失败：HTTP ${response.status} ${response.statusText}（POST ${url}）${tail}`,
        { kind: 'http', status: response.status, bodySnippet: snippet },
      );
    }

    return parseMessage(raw, url, names);
  } finally {
    clearTimeout(timer);
  }
}

/** fetch 的失败只有两种归宿：超时（我们主动 abort）或网络错误 */
function transportError(err: unknown, aborted: boolean, url: string, timeoutMs: number): AnthropicModelError {
  if (aborted) {
    return new AnthropicModelTimeoutError(
      `Anthropic 模型请求超时：超过 timeoutMs=${timeoutMs}ms 仍未完成（POST ${url}）`,
      timeoutMs,
      err,
    );
  }
  const reason = err instanceof Error ? err.message : String(err);
  return new AnthropicModelError(`Anthropic 模型网络错误：POST ${url} 失败：${reason}`, { kind: 'network', cause: err });
}

// ── 请求体映射 ──

interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

/** 助手回传的工具调用块：tool_result 必须能对应到它 */
interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

type AnthropicBlock = AnthropicTextBlock | AnthropicToolResultBlock | AnthropicToolUseBlock;

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicBlock[];
}

function buildBody(options: AnthropicModelOptions, input: ModelInput, names: WireNameMap): Record<string, unknown> {
  const { system, messages } = toMessages(input.context, names);
  const body: Record<string, unknown> = {
    model: options.model,
    // Anthropic 必填：即便调用方没给，也要发一个合理值，否则请求必然 400
    max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages,
  };
  if (system !== undefined) body.system = system;
  const tools = toTools(input.tools, names);
  if (tools !== undefined) body.tools = tools;
  if (options.temperature !== undefined) body.temperature = options.temperature;
  return body;
}

function toMessages(context: ContextItem[], names: WireNameMap): { system: string | undefined; messages: AnthropicMessage[] } {
  const systems: string[] = [];
  const messages: AnthropicMessage[] = [];

  // Anthropic 要求 user / assistant 交替：相邻同角色直接并入上一条消息。
  // 连续多条 tool_result 因此天然收进同一条 user 消息，而不是几条并肩的 user 消息。
  const push = (role: AnthropicMessage['role'], block: AnthropicBlock): void => {
    const last = messages[messages.length - 1];
    if (last !== undefined && last.role === role) last.content.push(block);
    else messages.push({ role, content: [block] });
  };

  for (const item of context) {
    if (item.role === 'system') {
      // system 是顶层字段，绝不能进 messages；空串没有信息量，拼进去只会多出空行
      if (item.text !== '') systems.push(item.text);
      continue;
    }
    if (item.role === 'human') {
      push('user', { type: 'text', text: item.text });
      continue;
    }
    if (item.role === 'peer') {
      // 同伴消息复用 user 角色，但必须标出来源，否则模型分不清「谁在说话」
      const from = typeof item.meta?.from === 'string' && item.meta.from !== '' ? item.meta.from : 'peer';
      push('user', { type: 'text', text: `[来自 ${from}] ${item.text}` });
      continue;
    }
    if (item.role === 'assistant') {
      if (item.text !== '') push('assistant', { type: 'text', text: item.text });
      // 助手发起过的工具调用必须还原成 tool_use 块：Anthropic 会校验每个 tool_result
      // 都必须对应前一条消息里的 tool_use，缺了就 400
      for (const call of item.toolCalls ?? []) {
        push('assistant', {
          type: 'tool_use',
          id: call.id,
          name: names.toWire(call.name),
          input: call.args ?? {},
        });
      }
      // 既没文本也没工具调用的助手消息没有信息量，不占一个 user/assistant 交替位
      if (item.text === '' && (item.toolCalls ?? []).length === 0) continue;
      continue;
    }

    // role === 'tool'
    const id = typeof item.meta?.id === 'string' && item.meta.id !== '' ? item.meta.id : undefined;
    if (id === undefined) {
      // 不能伪造 tool_use_id：Anthropic 会校验它必须对应前一条 assistant 的 tool_use。
      // 降级为同一条 user 消息里的文本块——内容不丢，消息结构仍然合法（同 SPEC-009：宁可少一个字段，也不编一个假的）。
      push('user', { type: 'text', text: `[工具结果] ${item.text}` });
      continue;
    }
    push('user', { type: 'tool_result', tool_use_id: id, content: item.text });
  }

  return { system: systems.length === 0 ? undefined : systems.join('\n\n'), messages };
}

function toTools(tools: ToolSpec[], names: WireNameMap): Array<Record<string, unknown>> | undefined {
  if (tools.length === 0) return undefined;
  return tools.map((tool) => ({
    name: names.toWire(tool.name),
    description: tool.description ?? '',
    // 参数 schema 原样透传；没给才退回空对象 schema（那样模型只能猜参数）
    input_schema: tool.parameters ?? { type: 'object', properties: {} },
  }));
}

// ── 响应解析 ──

function parseMessage(raw: string, url: string, names: WireNameMap): ModelOutput {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    throw badResponse(`Anthropic 模型响应不是合法 JSON（POST ${url}）：${snippetOf(raw)}`, raw, err);
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw badResponse(`Anthropic 模型响应必须是 JSON 对象（POST ${url}）`, raw);
  }

  const record = payload as Record<string, unknown>;
  const blocks = record.content;
  if (!Array.isArray(blocks)) {
    throw badResponse(`Anthropic 模型响应缺少 content 数组（POST ${url}）`, raw);
  }

  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];

  blocks.forEach((rawBlock: unknown, index: number) => {
    if (rawBlock === null || typeof rawBlock !== 'object' || Array.isArray(rawBlock)) return;
    const block = rawBlock as Record<string, unknown>;

    if (block.type === 'text') {
      if (typeof block.text === 'string' && block.text !== '') textParts.push(block.text);
      return;
    }
    // thinking / redacted_thinking 等未知块直接跳过：协议会演进，未知块不该让整轮失败
    if (block.type !== 'tool_use') return;

    const name = typeof block.name === 'string' && block.name !== '' ? block.name : undefined;
    if (name === undefined) {
      throw badResponse(`Anthropic 模型返回的 tool_use 缺少 name（content[${index}]）`, raw);
    }
    const id = typeof block.id === 'string' && block.id !== '' ? block.id : `toolu_${index}`;
    const input = block.input;
    if (input !== undefined && (input === null || typeof input !== 'object' || Array.isArray(input))) {
      throw badResponse(`Anthropic 模型返回的 tool_use.input 必须是对象（content[${index}]）`, raw);
    }
    // input 已经是对象：不做 JSON.parse，直接交给 Loop
    // 回程把线上名改回内部名：宿主工具仍以 ui.render / agent.spawn 这些名字注册
    toolCalls.push({ id, name: names.toInternal(name) ?? name, args: (input ?? {}) as Record<string, unknown> });
  });

  const output: ModelOutput = {};
  if (textParts.length > 0) output.text = textParts.join('\n');
  if (toolCalls.length > 0) output.toolCalls = toolCalls;
  // 终止约定：还有待办动作就不算完成；纯文本才算本轮收尾；什么都没有则交给 Loop 的预算护栏
  if (toolCalls.length > 0) output.done = false;
  else if (textParts.length > 0) output.done = true;

  const usage = record.usage;
  if (usage !== null && typeof usage === 'object' && !Array.isArray(usage)) {
    const usageRecord = usage as Record<string, unknown>;
    const inputTokens = typeof usageRecord.input_tokens === 'number' ? usageRecord.input_tokens : undefined;
    const outputTokens = typeof usageRecord.output_tokens === 'number' ? usageRecord.output_tokens : undefined;
    if (inputTokens !== undefined || outputTokens !== undefined) {
      output.usage = { tokens: (inputTokens ?? 0) + (outputTokens ?? 0) };
    }
  }
  return output;
}

// ── 小工具 ──

function badResponse(message: string, raw: string, cause?: unknown): AnthropicModelError {
  return new AnthropicModelError(message, { kind: 'bad_response', bodySnippet: snippetOf(raw), cause });
}

function snippetOf(raw: string): string {
  return raw.length <= BODY_SNIPPET_LIMIT ? raw : raw.slice(0, BODY_SNIPPET_LIMIT);
}

/** 超时不在重试之列：重试只会把预算烧在同一个坑里 */
function isRetriable(error: AnthropicModelError): boolean {
  if (error.kind === 'network') return true;
  if (error.kind === 'http' && typeof error.status === 'number') return error.status === 429 || error.status >= 500;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
