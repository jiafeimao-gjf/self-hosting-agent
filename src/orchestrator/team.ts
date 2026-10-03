/**
 * SPEC-010 §3 多 Agent 编排 —— 本文件是「装配层」，允许依赖下面所有层。
 *
 * 它把 P0 造好的零件接成一次真实的多进程协作：
 *   进程池 + 帧协议 + 邮箱 + 任务板 + 界面文档 + 审批门 + 宿主工具。
 *
 * 两条编排不变量：
 *   · 父子关系由 Kernel 记账，子 Agent 完成即向父 Agent 回报——不指望子 Agent 记得说话。
 *   · 邮箱是唯一的投递记录：先落盘，再送给在世的进程；不在世就等它上线。
 */
import os from 'node:os';
import path from 'node:path';

import { EventLog } from '../eventlog/log.ts';
import type { EventAppender, LoggedEvent } from '../eventlog/log.ts';
import { AgentPool } from '../kernel/pool.ts';
import type { AgentProcess } from '../kernel/pool.ts';
import { ApprovalGate } from '../kernel/approval.ts';
import { Mailbox, toPeerFrame } from '../mailbox/mailbox.ts';
import { TaskBoard } from '../taskboard/board.ts';
import { ViewDocument } from '../surface/document.ts';
import { SurfaceIngest } from '../surface/ingest.ts';
import type { Frame } from '../protocol/frames.ts';
import { HOST_TOOL_NAMES, createHostTools } from './host-tools.ts';
import type { ClientChangedPayload, HostRuntime, HostTool } from './host-tools.ts';
import { BrowserHost } from '../browser/document.ts';
import { WorkspaceStore } from '../workspace/store.ts';
import type { ShellRunner } from '../kernel/shell.ts';
import { silentLogger } from '../log/logger.ts';
import type { Logger } from '../log/logger.ts';
import type { ClientSource } from './client-source.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface TeamRunnerOptions {
  /** 工作目录：事件日志、邮箱、子进程日志都放这里 */
  dir?: string;
  log?: EventLog;
  approval?: ApprovalGate;
  document?: ViewDocument;
  board?: TaskBoard;
  mailbox?: Mailbox;
  /** 每个 Agent 的剧本（P1 用确定性脚本驱动；换成真模型时留空即可） */
  scripts?: Record<string, unknown[]>;
  /** 观察每一帧的钩子：宿主 UI / CLI 靠它把编排过程显示给人看 */
  onFrame?: (agentId: string, frame: Frame) => void;
  /** P3：客户端源码管理器（接上后 Agent 就能改自己的界面代码，且受自检门禁约束） */
  clientSource?: ClientSource;
  /** 客户端源码被改动时通知宿主（浏览器据此热更新） */
  onClientChanged?: (payload: ClientChangedPayload) => void;
  /** 诊断日志：子进程 stderr、进程起停都记它 */
  logger?: Logger;
  /** 浏览器文档更新时通知宿主（浏览器面板据此重画） */
  onBrowserChanged?: (doc: { version: number; title: string; html: string; allowNetwork: boolean }) => void;
  /** 可注入的浏览器宿主（测试与恢复现场用） */
  browser?: BrowserHost;
  /** 可注入的工作空间（默认 <dir>/workspace） */
  workspace?: WorkspaceStore;
  /** SPEC-023：给了执行器才注册 shell.run（默认不给 = 模型看不到这个工具） */
  shell?: ShellRunner;
  /** SPEC-023 审计回调：每次 shell 调用（含被拒绝的）都过它 */
  logShell?: (entry: {
    command: string;
    decision: string;
    code: number | null;
    durationMs: number;
    timedOut?: boolean;
    truncated?: boolean;
    note?: string;
  }) => void;
}

export interface SpawnAgentOptions {
  parent?: string;
  script?: unknown[];
  /** 模拟模型延迟：用来观察中断、超时与「慢队友」 */
  stepDelayMs?: number;
  hostToolTimeoutMs?: number;
  /** 透传给子进程的环境变量（例如 AGENT_MODEL / AGENT_BASE_URL 切真模型） */
  env?: Record<string, string>;
}

export interface OrchestrationResult {
  reason: string;
  leadId: string;
  children: string[];
  documentVersion: number;
  elapsedMs: number;
}

export class TeamRunner implements HostRuntime {
  readonly log: EventLog;
  readonly approval: ApprovalGate;
  readonly pool: AgentPool;
  /** SPEC-019 内置浏览器的宿主侧文档 */
  readonly browser: BrowserHost;
  /** SPEC-021 工作空间 */
  readonly workspace: WorkspaceStore;
  /** SPEC-023 shell 执行器（没启用则为 undefined） */
  readonly shell: ShellRunner | undefined;
  readonly logShell:
    | ((entry: {
        command: string;
        decision: string;
        code: number | null;
        durationMs: number;
        timedOut?: boolean;
        truncated?: boolean;
        note?: string;
      }) => void)
    | undefined;
  readonly board: TaskBoard;
  readonly mailbox: Mailbox;
  readonly document: ViewDocument;
  readonly ingest: SurfaceIngest;
  readonly dir: string;
  readonly clientSource: ClientSource | undefined;
  readonly onClientChanged: ((payload: ClientChangedPayload) => void) | undefined;
  readonly onBrowserChanged:
    | ((doc: { version: number; title: string; html: string; allowNetwork: boolean }) => void)
    | undefined;

  #tools: HostTool[];
  #scripts: Record<string, unknown[]>;
  #onFrameHook: ((agentId: string, frame: Frame) => void) | undefined;
  #parents = new Map<string, string>();
  #children = new Map<string, Set<string>>();
  #reports = new Map<string, Set<string>>();

  constructor(options: TeamRunnerOptions = {}) {
    this.dir = options.dir ?? path.join(os.tmpdir(), 'agent-client', 'team');
    this.log = options.log ?? new EventLog({ dir: path.join(this.dir, 'events') });
    this.approval = options.approval ?? new ApprovalGate();
    this.document = options.document ?? new ViewDocument();
    this.ingest = new SurfaceIngest({ document: this.document });
    this.board = options.board ?? new TaskBoard();
    this.mailbox = options.mailbox ?? new Mailbox({ dir: path.join(this.dir, 'mailbox') });
    this.pool = new AgentPool({
      log: this.log,
      logRoot: path.join(this.dir, 'agents'),
      logger: (options.logger ?? silentLogger).child('pool'),
    });
    this.#tools = createHostTools({ shell: options.shell !== undefined });
    this.#scripts = options.scripts ?? {};
    this.#onFrameHook = options.onFrame;
    this.clientSource = options.clientSource;
    this.onClientChanged = options.onClientChanged;
    this.browser = options.browser ?? new BrowserHost();
    this.workspace = options.workspace ?? new WorkspaceStore({ root: path.join(this.dir, 'workspace') });
    this.shell = options.shell;
    this.logShell = options.logShell;
    this.onBrowserChanged = options.onBrowserChanged;
  }

  /**
   * 声明给子进程的工具名 = **实际注册的那些**。
   *
   * 不能直接返回常量表：`shell.run` 在表里，但没启用 shell 时它没被注册 ——
   * 若照样声明，模型会去调用一个不存在的工具，只会拿到 UNKNOWN_TOOL。
   */
  get hostToolNames(): readonly string[] {
    return this.#tools.map((tool) => tool.name);
  }

  listAgents(): AgentProcess[] {
    return this.pool.list();
  }

  /**
   * 某个 Agent 自己的事件日志。
   * 它的对话上下文就是这么投影出来的（agent-main 用的是同一份），
   * 所以宿主想给人类看「Agent 现在记得什么」，读这里最诚实。
   */
  agentEvents(agentId: string): LoggedEvent[] {
    return new EventLog({ dir: path.join(this.dir, 'agents', agentId) }).read();
  }

  /** 拉起一个 Agent，并把父子关系、宿主工具、帧处理都接好 */
  spawnAgent(agentId: string, options: SpawnAgentOptions = {}): { agentId: string; pid: number | undefined } {
    const script = options.script ?? this.#scripts[agentId];
    const handle = this.pool.spawn({
      agentId,
      logDir: path.join(this.dir, 'agents', agentId),
      hostTools: [...this.hostToolNames],
      ...(script === undefined ? {} : { script }),
      ...(options.stepDelayMs === undefined ? {} : { stepDelayMs: options.stepDelayMs }),
      ...(options.hostToolTimeoutMs === undefined ? {} : { hostToolTimeoutMs: options.hostToolTimeoutMs }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });

    if (options.parent !== undefined) {
      this.#parents.set(agentId, options.parent);
      const siblings = this.#children.get(options.parent) ?? new Set<string>();
      siblings.add(agentId);
      this.#children.set(options.parent, siblings);
    }

    handle.onFrame((frame) => this.#onFrame(handle, agentId, frame));
    return { agentId, pid: handle.pid };
  }

  /** 把邮箱里攒着的消息送给这个 Agent（它此刻在世才送得出去） */
  deliver(agentId: string): number {
    const handle = this.pool.get(agentId);
    if (handle === undefined || !handle.alive) return 0;

    const drained = this.mailbox.drainAt(agentId, 'step_boundary');
    if (!drained.ok) return 0;

    let delivered = 0;
    for (const message of drained.value) {
      try {
        handle.send(toPeerFrame(message));
        delivered += 1;
        this.log.append({
          type: 'mail.message',
          from: message.from,
          to: message.to,
          kind: message.kind,
          body: message.body,
        });
      } catch {
        // 进程刚好死了：消息已经在邮箱里落过盘，等它下次上线
        break;
      }
    }
    return delivered;
  }

  async waitForReport(caller: string, ids: string[], timeoutMs: number): Promise<{ ok: boolean; missing: string[] }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const reported = this.#reports.get(caller) ?? new Set<string>();
      const missing = ids.filter((id) => !reported.has(id));
      if (missing.length === 0) return { ok: true, missing: [] };

      // 进程已经没了且没回报 → 等下去也没意义，如实报失败
      const hopeless = missing.filter((id) => {
        const handle = this.pool.get(id);
        return handle === undefined || !handle.alive;
      });
      if (hopeless.length > 0) return { ok: false, missing: hopeless };
      if (Date.now() >= deadline) return { ok: false, missing };

      await sleep(20);
    }
  }

  /** 人类对某个 Agent 夺权 */
  interrupt(agentId: string, reason: string): void {
    this.pool.get(agentId)?.interrupt(reason);
  }

  /**
   * 跑一次编排：把人类需求交给 Lead，等它收工。
   * 默认收工时回收它派出去的所有子进程——不能留孤儿进程继续烧钱。
   */
  async runLead(input: {
    prompt: string;
    script?: unknown[];
    leadId?: string;
    timeoutMs?: number;
    reclaimOnFinish?: boolean;
  }): Promise<OrchestrationResult> {
    const leadId = input.leadId ?? 'lead';
    const timeoutMs = input.timeoutMs ?? 30_000;
    const startedAt = Date.now();

    this.spawnAgent(leadId, {
      ...(input.script === undefined ? {} : { script: input.script }),
    });
    const lead = this.pool.get(leadId);
    if (lead === undefined) throw new Error('Lead 启动失败');

    const finished = new Promise<string>((resolve) => {
      const off = lead.onFrame((frame: Frame) => {
        if (frame.t !== 'loop.done') return;
        off();
        resolve(String(frame.reason));
      });
    });

    lead.send({ t: 'human.message', text: input.prompt });

    const timer = setTimeout(() => this.interrupt(leadId, 'run_timeout'), timeoutMs);
    let reason = 'timeout';
    try {
      reason = await finished;
    } finally {
      clearTimeout(timer);
      if (input.reclaimOnFinish !== false) await this.reclaim();
    }

    return {
      reason,
      leadId,
      children: [...(this.#children.get(leadId) ?? new Set<string>())],
      documentVersion: this.document.version,
      elapsedMs: Date.now() - startedAt,
    };
  }

  /** 回收所有子进程（先礼后兵） */
  async reclaim(): Promise<void> {
    await this.pool.shutdown();
  }

  #onFrame(handle: AgentProcess, agentId: string, frame: Frame): void {
    this.#onFrameHook?.(agentId, frame);

    // 宿主工具调用：Loop 干不了的事，由宿主代办后回填
    if (frame.t === 'tool.call' && typeof frame.name === 'string' && this.#isHostTool(frame.name)) {
      void this.#runHostTool(handle, agentId, frame);
    }

    // 子 Agent 完成 → Kernel 主动替它向父 Agent 回报（ORCH-003）
    if (frame.t === 'loop.done') {
      const parent = this.#parents.get(agentId);
      if (parent !== undefined) {
        const body = `${agentId} 完成：${String(frame.reason)}`;
        this.mailbox.send({ from: agentId, to: parent, kind: 'report', body });
        this.#markReport(parent, agentId);
        this.deliver(parent);
      }
    }
  }

  #isHostTool(name: string): boolean {
    return this.#tools.some((tool) => tool.name === name);
  }

  async #runHostTool(handle: AgentProcess, caller: string, frame: Frame): Promise<void> {
    const callId = String(frame.id);
    const toolName = String(frame.name);
    const args = typeof frame.args === 'object' && frame.args !== null ? (frame.args as Record<string, unknown>) : {};

    this.log.append({ type: 'host.tool.call', agent: caller, tool: toolName, id: callId, args });
    const tool = this.#tools.find((candidate) => candidate.name === toolName);

    let result: { ok: boolean; result?: string; error?: string };
    if (tool === undefined) {
      result = { ok: false, error: `UNKNOWN_HOST_TOOL: ${toolName}` };
    } else {
      try {
        result = await tool.run(args, this, caller);
      } catch (err) {
        result = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    this.log.append({
      type: 'host.tool.result',
      agent: caller,
      tool: toolName,
      id: callId,
      ok: result.ok,
      result: result.result,
      error: result.error,
    });

    try {
      handle.replyTool(callId, result);
    } catch {
      // 进程已经退出，回填不回也就是了——错误已经记在日志里
    }
  }

  #markReport(caller: string, reporter: string): void {
    const set = this.#reports.get(caller) ?? new Set<string>();
    set.add(reporter);
    this.#reports.set(caller, set);
  }
}
