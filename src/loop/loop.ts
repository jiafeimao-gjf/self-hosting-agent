/**
 * SPEC-003 Agent Loop —— 五步状态机。
 *
 * 依赖倒置：Loop 不 import 上层实现（Surface / Kernel），只依赖端口。
 * 这样它既能被假模型在 CI 里离线驱动，也不会为了校验 View Spec 而反向依赖界面层。
 */
import type { Frame } from '../protocol/frames.ts';
import type { EventAppender, EventInput } from '../eventlog/log.ts';

export type ContextRole = 'system' | 'human' | 'peer' | 'assistant' | 'tool';

export interface ContextItem {
  role: ContextRole;
  text: string;
  meta?: Record<string, unknown>;
  /**
   * 助手消息携带的工具调用。
   *
   * 这不是可选项：OpenAI 要求 `role:'tool'` 必须紧跟在带 `tool_calls` 的助手消息之后，
   * Anthropic 要求 `tool_result` 必须对应前一条消息里的 `tool_use`。
   * 助手消息丢了 toolCalls，工具结果就成了孤儿，严格端点会直接 400。
   */
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  args?: Record<string, unknown>;
}

export interface UiPatch {
  scope: string;
  /** upsert = 有没有都画成这样（Agent 的默认粒度），其余三种见 SPEC-006 */
  op: 'patch' | 'replace' | 'mount' | 'upsert';
  spec: Record<string, unknown>;
}

export interface ModelOutput {
  text?: string;
  toolCalls?: ToolCall[];
  uiPatches?: UiPatch[];
  done?: boolean;
  usage?: { tokens?: number };
}

/** 工具在哪执行：进程内，还是请宿主代办 */
export type ToolExecution = 'loop' | 'host';

export interface ToolSpec {
  name: string;
  description?: string;
  /**
   * 'loop'（默认）在 Loop 进程内执行；
   * 'host' 是**宿主工具**——「拉起一个进程」「派发任务」这类只有 Kernel 干得了的事，
   * Loop 发 tool.call 请宿主代办，宿主用 tool.reply 回填。
   */
  execute?: ToolExecution;
  run?(args: Record<string, unknown>, context: ToolContext): Promise<unknown> | unknown;
}

/** 宿主对一次宿主工具调用的回填 */
export interface HostToolReply {
  ok: boolean;
  result?: string;
  error?: string;
}

/** 宿主工具桥：Loop 侧只需要这一个能力，不依赖 Kernel 的任何实现 */
export interface HostBridgePort {
  awaitToolReply(callId: string, options: { timeoutMs: number }): Promise<HostToolReply>;
}

export const DEFAULT_HOST_TOOL_TIMEOUT_MS = 30_000;

export interface ToolContext {
  agentId: string;
  turn: number;
  callId: string;
}

export interface ModelInput {
  agentId: string;
  turn: number;
  context: ContextItem[];
  tools: ToolSpec[];
}

export interface ModelPort {
  step(input: ModelInput): Promise<ModelOutput>;
}

export interface UiGuard {
  check(patch: UiPatch): { ok: true } | { ok: false; reason: string };
}

export interface InboxMessage {
  id: string;
  from: string;
  body: string;
  kind?: string;
  taskId?: string;
  artifacts?: string[];
}

/** 邮箱端口：真实 Mailbox 结构上即可满足（鸭子类型），Loop 不依赖它的实现 */
export interface InboxPort {
  drainAt(agentId: string, boundary: 'step_boundary'): InboxMessage[];
}

export interface LoopSink {
  onFrame(frame: Frame): void;
}

export interface LoopBudget {
  maxTurns?: number;
  maxToolCalls?: number;
  maxTokens?: number;
  maxWallClockMs?: number;
}

export type LoopReason = 'completed' | 'interrupted' | 'budget_exhausted' | 'error';

export interface LoopResult {
  reason: LoopReason;
  turns: number;
  toolCalls: number;
  tokens: number;
  elapsedMs: number;
}

export interface LoopOptions {
  agentId: string;
  model: ModelPort;
  tools?: ToolSpec[];
  log: EventAppender;
  sink: LoopSink;
  inbox?: InboxPort;
  guard?: UiGuard;
  /** 宿主工具桥；没有它则宿主工具一律 NO_HOST_BRIDGE */
  hostBridge?: HostBridgePort;
  hostToolTimeoutMs?: number;
  /**
   * 历史上下文（由事件日志投影而来）。
   * 放在 system 之后、本轮 seed 之前——多轮对话的记忆就靠它，而不是进程里的一个数组。
   */
  seedContext?: ContextItem[];
  budget?: LoopBudget;
  system?: string;
  maxContextItems?: number;
}

/** 五步的名字，顺序即语义，也是测试与文档共同引用的事实 */
export const LOOP_STEPS = ['assemble', 'infer', 'dispatch', 'emit', 'checkpoint'] as const;

export function defineTool(
  name: string,
  run: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown> | unknown,
  description?: string,
): ToolSpec {
  return description === undefined ? { name, run, execute: 'loop' } : { name, description, run, execute: 'loop' };
}

export function defineHostTool(name: string, description?: string): ToolSpec {
  return description === undefined ? { name, execute: 'host' } : { name, description, execute: 'host' };
}

/** 上下文裁剪：系统提示永远保留，其余保留最近的（LOOP-010） */
export function assembleContext(items: ContextItem[], options: { maxItems?: number } = {}): ContextItem[] {
  const maxItems = options.maxItems ?? Number.POSITIVE_INFINITY;
  if (items.length <= maxItems) return [...items];

  const systems = items.filter((item) => item.role === 'system');
  const rest = items.filter((item) => item.role !== 'system');
  const keep = Math.max(0, maxItems - systems.length);
  return [...systems, ...rest.slice(Math.max(0, rest.length - keep))];
}

export class AgentLoop {
  #options: LoopOptions;
  #interrupted = false;
  #interruptReason = '';

  constructor(options: LoopOptions) {
    this.#options = options;
  }

  /** 人类夺权：在最近一个 step boundary 生效（LOOP-007） */
  interrupt(reason: string): void {
    this.#interrupted = true;
    this.#interruptReason = reason;
  }

  get interrupted(): boolean {
    return this.#interrupted;
  }

  async run(input: { seed?: string } = {}): Promise<LoopResult> {
    const { agentId, model, log, sink } = this.#options;
    const tools = this.#options.tools ?? [];
    const budget = this.#options.budget ?? {};
    const maxTurns = budget.maxTurns ?? Number.POSITIVE_INFINITY;
    const maxToolCalls = budget.maxToolCalls ?? Number.POSITIVE_INFINITY;
    const maxTokens = budget.maxTokens ?? Number.POSITIVE_INFINITY;
    const maxWallClockMs = budget.maxWallClockMs ?? Number.POSITIVE_INFINITY;
    const startedAt = Date.now();

    const baseContext: ContextItem[] = [];
    if (this.#options.system !== undefined) baseContext.push({ role: 'system', text: this.#options.system });
    for (const item of this.#options.seedContext ?? []) baseContext.push(item);
    if (input.seed !== undefined) baseContext.push({ role: 'human', text: input.seed });

    let turn = 0;
    let toolCallCount = 0;
    let tokens = 0;

    const record = (event: EventInput): void => {
      log.append(event);
    };
    const emit = (frame: Frame): void => {
      sink.onFrame(frame);
    };
    const step = (currentTurn: number, index: number, name: string): void => {
      record({ type: 'loop.step', agent: agentId, turn: currentTurn, step: index, name });
      emit({ t: 'loop.step', agent: agentId, step: index, name });
    };
    const finish = (reason: LoopReason, detail?: string): LoopResult => {
      const elapsedMs = Date.now() - startedAt;
      // 详情只进事件日志：帧表里的 loop.done 只有 reason，协议宁可严格也不留暗门
      record({ type: 'loop.done', agent: agentId, reason, detail, turn, toolCalls: toolCallCount, tokens, elapsedMs });
      emit({ t: 'loop.done', agent: agentId, reason });
      return { reason, turns: turn, toolCalls: toolCallCount, tokens, elapsedMs };
    };

    for (;;) {
      if (this.#interrupted) return finish('interrupted', this.#interruptReason);

      if (turn >= maxTurns) return finish('budget_exhausted', `maxTurns=${maxTurns}`);
      if (toolCallCount >= maxToolCalls) return finish('budget_exhausted', `maxToolCalls=${maxToolCalls}`);
      if (tokens >= maxTokens) return finish('budget_exhausted', `maxTokens=${maxTokens}`);
      if (Date.now() - startedAt >= maxWallClockMs) return finish('budget_exhausted', `maxWallClockMs=${maxWallClockMs}`);

      turn += 1;

      // ── Step 1 组装上下文：只有在这里消费消息（I2 边界投递） ──
      const inbox = this.#options.inbox;
      const delivered = inbox ? inbox.drainAt(agentId, 'step_boundary') : [];
      for (const message of delivered) {
        record({
          type: 'message.received',
          agent: agentId,
          turn,
          id: message.id,
          from: message.from,
          body: message.body,
          kind: message.kind,
        });
        baseContext.push({
          role: message.from === 'human' ? 'human' : 'peer',
          text: message.body,
          meta: { id: message.id, from: message.from, kind: message.kind },
        });
      }
      const context = assembleContext(baseContext, { maxItems: this.#options.maxContextItems });
      step(turn, 1, LOOP_STEPS[0]);

      // ── Step 2 模型推理 ──
      let output: ModelOutput;
      try {
        output = await model.step({ agentId, turn, context, tools });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        record({ type: 'loop.error', agent: agentId, turn, message });
        emit({ t: 'loop.error', agent: agentId, message, ...(err instanceof Error && err.stack ? { stack: err.stack } : {}) });
        return finish('error', message);
      }
      const pendingToolCalls = output.toolCalls ?? [];
      if ((output.text !== undefined && output.text !== '') || pendingToolCalls.length > 0) {
        if (output.text !== undefined && output.text !== '') {
          record({ type: 'agent.thinking', agent: agentId, turn, text: output.text });
          emit({ t: 'agent.thinking', agent: agentId, text: output.text });
        }
        // 助手消息必须把它发起的工具调用一起存下来，下一步的工具结果才有归属
        baseContext.push({
          role: 'assistant',
          text: output.text ?? '',
          ...(pendingToolCalls.length === 0 ? {} : { toolCalls: pendingToolCalls }),
        });
      }
      tokens += output.usage?.tokens ?? 0;
      step(turn, 2, LOOP_STEPS[1]);

      // ── Step 3 工具分发：失败不致命 ──
      for (const call of output.toolCalls ?? []) {
        toolCallCount += 1;
        record({ type: 'tool.call', agent: agentId, turn, id: call.id, name: call.name, args: call.args });
        emit({ t: 'tool.call', agent: agentId, id: call.id, name: call.name, args: call.args ?? {} });

        const tool = tools.find((candidate) => candidate.name === call.name);
        let ok = true;
        let resultText = '';
        try {
          if (tool === undefined) throw new Error(`UNKNOWN_TOOL: 没有名为 ${call.name} 的工具`);

          if (tool.execute === 'host') {
            const bridge = this.#options.hostBridge;
            if (bridge === undefined) {
              throw new Error(`NO_HOST_BRIDGE: ${call.name} 需要宿主代办，但当前 Loop 没有接到宿主桥`);
            }
            const reply = await bridge.awaitToolReply(call.id, {
              timeoutMs: this.#options.hostToolTimeoutMs ?? DEFAULT_HOST_TOOL_TIMEOUT_MS,
            });
            if (!reply.ok) throw new Error(reply.error ?? `HOST_TOOL_FAILED: ${call.name}`);
            resultText = reply.result ?? '';
          } else {
            if (tool.run === undefined) {
              throw new Error(`TOOL_NOT_IMPLEMENTED: ${call.name} 既没有本地实现，也没有标记为宿主工具`);
            }
            const value = await tool.run(call.args ?? {}, { agentId, turn, callId: call.id });
            resultText = typeof value === 'string' ? value : JSON.stringify(value);
          }
        } catch (err) {
          ok = false;
          resultText = err instanceof Error ? err.message : String(err);
        }

        record({ type: 'tool.result', agent: agentId, turn, id: call.id, name: call.name, ok, result: resultText });
        emit(
          ok
            ? { t: 'tool.result', agent: agentId, id: call.id, ok, result: resultText }
            : { t: 'tool.result', agent: agentId, id: call.id, ok, error: resultText },
        );
        baseContext.push({ role: 'tool', text: `[${call.name}] ${resultText}`, meta: { id: call.id, ok } });
      }
      step(turn, 3, LOOP_STEPS[2]);

      // ── Step 4 外发界面意图：必须过守卫 ──
      for (const patch of output.uiPatches ?? []) {
        const verdict = this.#options.guard ? this.#options.guard.check(patch) : ({ ok: true } as const);
        if (verdict.ok) {
          record({ type: 'ui.patch', agent: agentId, turn, scope: patch.scope, op: patch.op, spec: patch.spec, rejected: false });
          emit({ t: 'ui.patch', agent: agentId, scope: patch.scope, op: patch.op, spec: patch.spec });
        } else {
          record({
            type: 'ui.patch',
            agent: agentId,
            turn,
            scope: patch.scope,
            op: patch.op,
            spec: patch.spec,
            rejected: true,
            reason: verdict.reason,
          });
        }
      }
      step(turn, 4, LOOP_STEPS[3]);

      // ── Step 5 检查点 ──
      record({ type: 'loop.checkpoint', agent: agentId, turn, toolCalls: toolCallCount, tokens });
      step(turn, 5, LOOP_STEPS[4]);

      if (output.done === true) return finish('completed');
    }
  }
}
