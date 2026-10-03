/**
 * SPEC-009 真实模型端口 —— OpenAI 兼容的 /chat/completions 适配器。
 *
 * 与 `fake-model.ts` 的关系：假模型证明「协议与状态机是真的」，本文件证明「这套端口接得上真模型」。
 * Loop 对两者一视同仁——它只认 `ModelPort`，模型是不是真的不进状态机。
 *
 * 三条设计原则（详见 specs/009-http-model.md）：
 *   1. 端口不变：只实现 ModelPort，零改动接入。
 *   2. 失败要响：不可信的响应一律抛导出类型的错误，绝不降级成空参数去执行工具。
 *   3. 离线可测：零第三方依赖，fetchImpl 可注入，测试用 node:http 本地假服务。
 */
import { createWireNameMap } from './wire-names.ts';
import type { WireNameMap } from './wire-names.ts';
import type {
  ContextItem,
  ModelInput,
  ModelOutput,
  ModelPort,
  ModelStepOptions,
  ToolCall,
  ToolSpec,
  UiPatch,
} from './loop.ts';
import { createDeltaThrottle, createSseParser, isDoneSentinel } from './sse.ts';

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_RETRY_BASE_DELAY_MS = 250;

/** 响应片段最多带这么多字符进错误对象：够排障，又不至于把日志撑爆 */
const BODY_SNIPPET_LIMIT = 500;

const UI_OPS: readonly UiPatch['op'][] = ['patch', 'replace', 'mount'];

export type HttpModelErrorKind =
  | 'http'
  | 'network'
  | 'timeout'
  | 'bad_response'
  /** SPEC-022：端点没返回事件流（网关无视 stream:true），调用方应退回非流式 */
  | 'not_stream'
  | 'bad_arguments'
  | 'bad_ui_patch';

export interface HttpModelErrorOptions {
  kind: HttpModelErrorKind;
  /** 非 2xx 时的 HTTP 状态码 */
  status?: number;
  /** 响应片段（截断到 500 字符），便于宿主日志与界面展示 */
  bodySnippet?: string;
  cause?: unknown;
}

/**
 * 真实模型端口抛出的唯一错误基类：宿主用 `instanceof` 就能把「模型侧故障」与自身 bug 分开。
 * 类型必须导出——不然宿主只能靠 message 字符串猜。
 */
export class HttpModelError extends Error {
  readonly kind: HttpModelErrorKind;
  readonly status: number | undefined;
  readonly bodySnippet: string | undefined;

  constructor(message: string, options: HttpModelErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'HttpModelError';
    this.kind = options.kind;
    this.status = options.status;
    this.bodySnippet = options.bodySnippet;
  }
}

/** 超时是单独的类型：宿主常需要对它做不同的降级（例如提示用户而不是重试） */
export class HttpModelTimeoutError extends HttpModelError {
  readonly timeoutMs: number;

  constructor(message: string, timeoutMs: number, cause?: unknown) {
    super(message, { kind: 'timeout', cause });
    this.name = 'HttpModelTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export interface HttpModelOptions {
  /** 例如 https://api.example.com/v1；尾部斜杠会被归一化 */
  baseUrl: string;
  model: string;
  apiKey: string;
  /** 只有显式给出才写进请求体（0 也是有效值） */
  temperature?: number;
  /** 映射为请求体的 max_tokens */
  maxTokens?: number;
  /** 单次 HTTP 交换（含读 body）的总超时，默认 30000 */
  timeoutMs?: number;
  /** 注入点：测试、代理、自定义传输都靠它；默认 Node 24 全局 fetch */
  fetchImpl?: typeof fetch;
  /** 重试次数（总尝试次数 = maxRetries + 1），默认 2；仅 429 / 5xx / 网络错误会重试 */
  maxRetries?: number;
  /** 退避基数：第 n 次重试等待 base * 2^n，默认 250ms */
  retryBaseDelayMs?: number;
  /** 命中该名字的工具调用转成 uiPatches，不进入 toolCalls */
  uiToolName?: string;
  /** 流式失败降级时的回调（排障用：谁把 stream 拒了） */
  onStreamFallback?: (reason: string) => void;
}

export function createHttpModel(options: HttpModelOptions): ModelPort {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error('当前运行时没有全局 fetch，请通过 fetchImpl 注入一个实现');
  }
  const url = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  return {
    async step(input: ModelInput, stepOptions: ModelStepOptions = {}): Promise<ModelOutput> {
      // 一次调用内工具集合是固定的：出网/回程共用同一张名字映射
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
                options.apiKey,
                body(true),
                timeoutMs,
                options.uiToolName,
                names,
                stepOptions.onDelta as (text: string) => void,
              );
            } catch (err) {
              // SPEC-022：流式失败（网关不认 stream、中途断流）不能把整轮搞死 ——
              // 退回非流式重来一次，宁可慢一点，也不要「有流式就没答案」。
              // 但超时就别重试了：那只会让用户多等一个超时。
              if (err instanceof HttpModelError && err.kind === 'timeout') throw err;
              streamFallbacks.push(err instanceof Error ? err.message : String(err));
              if (typeof options.onStreamFallback === 'function') options.onStreamFallback(streamFallbacks.at(-1) as string);
            }
          }
          return await requestOnce(doFetch, url, options.apiKey, body(false), timeoutMs, options.uiToolName, names);
        } catch (err) {
          // 只有排得上号、且还有重试余额的失败才重试；其余（含 4xx、解析错误）立即上抛
          if (!(err instanceof HttpModelError) || attempt >= maxRetries || !isRetriable(err)) throw err;
          await sleep(retryBaseDelayMs * 2 ** attempt);
        }
      }
    },
  };
}

// ── 请求 ──

/** 流式尝试的失败原因，供上层记录（不改动返回值形状） */
const streamFallbacks: string[] = [];

/**
 * SPEC-022：OpenAI 兼容的流式请求。
 *
 * `data:` 里是增量 JSON，文本在 `choices[0].delta.content`，工具调用在
 * `choices[0].delta.tool_calls`（**分批到达**，按 index 拼 name 与 arguments）。
 * 收尾约定是 `data: [DONE]`。
 */
async function requestStream(
  doFetch: typeof fetch,
  url: string,
  apiKey: string,
  payload: string,
  timeoutMs: number,
  uiToolName: string | undefined,
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
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: payload,
        signal: controller.signal,
      });
    } catch (err) {
      throw transportError(err, controller.signal.aborted, url, timeoutMs);
    }

    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      const snippet = snippetOf(raw);
      throw new HttpModelError(
        `HTTP 模型流式请求失败：HTTP ${response.status} ${response.statusText}（POST ${url}）${snippet === '' ? '' : `；响应片段：${snippet}`}`,
        { kind: 'http', status: response.status, bodySnippet: snippet },
      );
    }
    // 有些网关无视 `stream: true`，直接回一个普通 JSON（200，不是错误）。
    // 这时候当成 SSE 解析只会得到一个空答案 —— 必须识别出来并走非流式解析。
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      const raw = await response.text().catch(() => '');
      throw new HttpModelError(
        `端点没有返回事件流（content-type: ${contentType || '未知'}），改走非流式`,
        { kind: 'not_stream' },
      );
    }
    if (response.body === null) {
      throw new HttpModelError('流式响应没有 body', { kind: 'bad_response' });
    }

    let text = '';
    const rawCalls = new Map<number, { id: string; name: string; args: string }>();
    let failure: HttpModelError | undefined;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = createSseParser((event) => {
      if (isDoneSentinel(event.data)) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return; // 流里混进坏块就跳过：不能因为一条脏数据把整轮答案丢掉
      }
      const record = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      const choices = Array.isArray(record.choices) ? record.choices : [];
      const first = choices[0];
      if (first === null || typeof first !== 'object') return;

      // 有些网关会在流里夹一条 error
      const errorField = (first as Record<string, unknown>).error ?? record.error;
      if (errorField !== undefined) {
        failure = new HttpModelError(`流式响应报错：${JSON.stringify(errorField).slice(0, 200)}`, { kind: 'bad_response' });
        return;
      }

      const delta = (first as Record<string, unknown>).delta;
      if (delta === null || typeof delta !== 'object') return;
      const deltaRecord = delta as Record<string, unknown>;

      if (typeof deltaRecord.content === 'string' && deltaRecord.content !== '') {
        text += deltaRecord.content;
        throttle.push(text);
      }

      const calls = Array.isArray(deltaRecord.tool_calls) ? deltaRecord.tool_calls : [];
      for (const entry of calls) {
        if (entry === null || typeof entry !== 'object') continue;
        const callRecord = entry as Record<string, unknown>;
        const index = typeof callRecord.index === 'number' ? callRecord.index : rawCalls.size;
        const current = rawCalls.get(index) ?? { id: '', name: '', args: '' };
        if (typeof callRecord.id === 'string' && callRecord.id !== '') current.id = callRecord.id;
        const fn = callRecord.function;
        if (fn !== null && typeof fn === 'object') {
          const fnRecord = fn as Record<string, unknown>;
          if (typeof fnRecord.name === 'string' && fnRecord.name !== '') current.name += fnRecord.name;
          if (typeof fnRecord.arguments === 'string') current.args += fnRecord.arguments;
        }
        rawCalls.set(index, current);
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

    // 与实体响应同一条解析路径：把流拼回来的东西喂给 parseCompletion，保证两条路结果一致
    const assembled: Record<string, unknown> = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: text,
            ...(rawCalls.size === 0
              ? {}
              : {
                  tool_calls: [...rawCalls.entries()]
                    .sort((a, b) => a[0] - b[0])
                    .map(([index, call]) => ({
                      id: call.id === '' ? `call_${index}` : call.id,
                      type: 'function',
                      function: { name: call.name, arguments: call.args === '' ? '{}' : call.args },
                    })),
                }),
          },
        },
      ],
    };

    const output = parseCompletion(JSON.stringify(assembled), url, uiToolName, names);
    throttle.finish(text);
    return output;
  } finally {
    clearTimeout(timer);
  }
}

async function requestOnce(
  doFetch: typeof fetch,
  url: string,
  apiKey: string,
  payload: string,
  timeoutMs: number,
  uiToolName: string | undefined,
  names: WireNameMap,
): Promise<ModelOutput> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
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
      throw new HttpModelError(
        `HTTP 模型请求失败：HTTP ${response.status} ${response.statusText}（POST ${url}）${tail}`,
        { kind: 'http', status: response.status, bodySnippet: snippet },
      );
    }

    return parseCompletion(raw, url, uiToolName, names);
  } finally {
    clearTimeout(timer);
  }
}

/** fetch 的失败只有两种归宿：超时（我们主动 abort）或网络错误 */
function transportError(err: unknown, aborted: boolean, url: string, timeoutMs: number): HttpModelError {
  if (aborted) {
    return new HttpModelTimeoutError(
      `HTTP 模型请求超时：超过 timeoutMs=${timeoutMs}ms 仍未完成（POST ${url}）`,
      timeoutMs,
      err,
    );
  }
  const reason = err instanceof Error ? err.message : String(err);
  return new HttpModelError(`HTTP 模型网络错误：POST ${url} 失败：${reason}`, { kind: 'network', cause: err });
}

// ── 请求体映射 ──

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
}

function buildBody(options: HttpModelOptions, input: ModelInput, names: WireNameMap): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: options.model,
    messages: toMessages(input.context, names),
  };
  const tools = toTools(input.tools, names);
  if (tools !== undefined) body.tools = tools;
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
  return body;
}

function toMessages(context: ContextItem[], names: WireNameMap): ChatMessage[] {
  return context.map((item) => {
    if (item.role === 'peer') {
      // 同伴消息复用 user 角色，但必须标出来源，否则模型分不清「谁在说话」
      const from = typeof item.meta?.from === 'string' && item.meta.from !== '' ? item.meta.from : 'peer';
      return { role: 'user', content: `[来自 ${from}] ${item.text}` };
    }
    if (item.role === 'tool') {
      const id = typeof item.meta?.id === 'string' && item.meta.id !== '' ? item.meta.id : undefined;
      return id === undefined
        ? { role: 'tool', content: item.text }
        : { role: 'tool', content: item.text, tool_call_id: id };
    }
    if (item.role === 'human') return { role: 'user', content: item.text };
    if (item.role === 'system') return { role: 'system', content: item.text };

    // 助手消息发起过工具调用就必须带上 tool_calls：否则后续 role:'tool' 是孤儿，
    // OpenAI 会直接 400（messages with role 'tool' must be a response to a message with 'tool_calls'）
    if (Array.isArray(item.toolCalls) && item.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: item.text,
        tool_calls: item.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          // 助手回传的历史调用也要用线上名，与工具声明保持一致
          function: { name: names.toWire(call.name), arguments: JSON.stringify(call.args ?? {}) },
        })),
      };
    }
    return { role: 'assistant', content: item.text };
  });
}

function toTools(tools: ToolSpec[], names: WireNameMap): Array<Record<string, unknown>> | undefined {
  if (tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: names.toWire(tool.name),
      description: tool.description ?? '',
      // 参数 schema 原样透传；没给才退回空对象 schema（那样模型只能猜参数）
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    },
  }));
}

// ── 响应解析 ──

function parseCompletion(raw: string, url: string, uiToolName: string | undefined, names: WireNameMap): ModelOutput {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    throw badResponse(`HTTP 模型响应不是合法 JSON（POST ${url}）：${snippetOf(raw)}`, raw, err);
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw badResponse(`HTTP 模型响应必须是 JSON 对象（POST ${url}）`, raw);
  }

  const record = payload as Record<string, unknown>;
  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw badResponse(`HTTP 模型响应缺少 choices[0]（POST ${url}）`, raw);
  }
  const choice: unknown = choices[0];
  const message = choice !== null && typeof choice === 'object' ? (choice as Record<string, unknown>).message : undefined;
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    throw badResponse(`HTTP 模型响应缺少 choices[0].message（POST ${url}）`, raw);
  }
  const messageRecord = message as Record<string, unknown>;

  // 空串与缺失都归一化为 undefined：Loop 只看 text !== undefined，别让它出现两种「没说话」
  const content = typeof messageRecord.content === 'string' ? messageRecord.content : '';
  const text = content === '' ? undefined : content;

  const toolCalls: ToolCall[] = [];
  const uiPatches: UiPatch[] = [];
  const rawCalls = Array.isArray(messageRecord.tool_calls) ? messageRecord.tool_calls : [];
  rawCalls.forEach((rawCall: unknown, index: number) => {
    const callRecord = (rawCall !== null && typeof rawCall === 'object' ? rawCall : {}) as Record<string, unknown>;
    const fn = (callRecord.function !== null && typeof callRecord.function === 'object' ? callRecord.function : {}) as Record<string, unknown>;
    const name = typeof fn.name === 'string' && fn.name !== '' ? fn.name : undefined;
    if (name === undefined) {
      throw badResponse(`HTTP 模型返回的工具调用缺少 function.name（tool_calls[${index}]）`, raw);
    }
    const id = typeof callRecord.id === 'string' && callRecord.id !== '' ? callRecord.id : `call_${index}`;
    const args = parseArguments(typeof fn.arguments === 'string' ? fn.arguments : '', name);
    // 回程把线上名改回内部名：宿主工具仍以 ui.render / agent.spawn 这些名字注册
    const internal = names.toInternal(name) ?? name;
    if (uiToolName !== undefined && (name === uiToolName || internal === uiToolName)) {
      uiPatches.push(toUiPatch(args, internal));
    } else {
      toolCalls.push({ id, name: internal, args });
    }
  });

  const output: ModelOutput = {};
  if (text !== undefined) output.text = text;
  if (toolCalls.length > 0) output.toolCalls = toolCalls;
  if (uiPatches.length > 0) output.uiPatches = uiPatches;
  // 终止约定：还有待办动作就不算完成；纯文本才算本轮收尾；什么都没有则交给 Loop 的预算护栏
  if (toolCalls.length > 0 || uiPatches.length > 0) output.done = false;
  else if (text !== undefined) output.done = true;

  const usage = record.usage;
  if (usage !== null && typeof usage === 'object' && !Array.isArray(usage)) {
    const total = (usage as Record<string, unknown>).total_tokens;
    if (typeof total === 'number') output.usage = { tokens: total };
  }
  return output;
}

/**
 * `arguments` 是模型给的 JSON 字符串：解析失败宁可整轮失败，也不静默降级成 {}。
 * 拿空参数去跑有副作用的工具（删文件、发请求）比报错危险得多。
 */
function parseArguments(raw: string, toolName: string): Record<string, unknown> {
  const text = raw.trim();
  if (text === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new HttpModelError(`工具 ${toolName} 的 arguments 不是合法 JSON：${snippetOf(text)}`, {
      kind: 'bad_arguments',
      bodySnippet: snippetOf(text),
      cause: err,
    });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpModelError(`工具 ${toolName} 的 arguments 必须是 JSON 对象，实际为：${snippetOf(text)}`, {
      kind: 'bad_arguments',
      bodySnippet: snippetOf(text),
    });
  }
  return parsed as Record<string, unknown>;
}

/** 这里只做形状校验；scope 白名单与组件合法性仍归 Loop 的 UiGuard（SPEC-003）裁决 */
function toUiPatch(args: Record<string, unknown>, toolName: string): UiPatch {
  const scope = args.scope;
  const op = args.op;
  const spec = args.spec;
  if (typeof scope !== 'string' || scope === '') {
    throw badUiPatch(`工具 ${toolName} 的 arguments 缺少字符串 scope`);
  }
  if (typeof op !== 'string' || !UI_OPS.includes(op as UiPatch['op'])) {
    throw badUiPatch(`工具 ${toolName} 的 op 必须是 patch/replace/mount 之一，实际为 ${JSON.stringify(op)}`);
  }
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw badUiPatch(`工具 ${toolName} 的 spec 必须是对象`);
  }
  return { scope, op: op as UiPatch['op'], spec: spec as Record<string, unknown> };
}

// ── 小工具 ──

function badResponse(message: string, raw: string, cause?: unknown): HttpModelError {
  return new HttpModelError(message, { kind: 'bad_response', bodySnippet: snippetOf(raw), cause });
}

function badUiPatch(message: string): HttpModelError {
  return new HttpModelError(`界面意图非法：${message}`, { kind: 'bad_ui_patch' });
}

function snippetOf(raw: string): string {
  return raw.length <= BODY_SNIPPET_LIMIT ? raw : raw.slice(0, BODY_SNIPPET_LIMIT);
}

/** 超时不在重试之列：重试只会把预算烧在同一个坑里 */
function isRetriable(error: HttpModelError): boolean {
  if (error.kind === 'network') return true;
  if (error.kind === 'http' && typeof error.status === 'number') return error.status === 429 || error.status >= 500;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
