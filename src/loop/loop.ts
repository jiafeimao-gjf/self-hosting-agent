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
}

export interface ToolCall {
  id: string;
  name: string;
  args?: Record<string, unknown>;
}

export interface UiPatch {
  scope: string;
  op: 'patch' | 'replace' | 'mount';
  spec: Record<string, unknown>;
}

export interface ModelOutput {
  text?: string;
  toolCalls?: ToolCall[];
  uiPatches?: UiPatch[];
  done?: boolean;
  usage?: { tokens?: number };
}

export interface ToolSpec {
  name: string;
  description?: string;
  run(args: Record<string, unknown>, context: ToolContext): Promise<unknown> | unknown;
}

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
  return description === undefined ? { name, run } : { name, description, run };
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
      if (output.text !== undefined && output.text !== '') {
        record({ type: 'agent.thinking', agent: agentId, turn, text: output.text });
        emit({ t: 'agent.thinking', agent: agentId, text: output.text });
        baseContext.push({ role: 'assistant', text: output.text });
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
          const value = await tool.run(call.args ?? {}, { agentId, turn, callId: call.id });
          resultText = typeof value === 'string' ? value : JSON.stringify(value);
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
