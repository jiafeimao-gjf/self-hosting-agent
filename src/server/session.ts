/**
 * SPEC-011 会话：把 Kernel 的全部状态收口成一个可被前端订阅的对象。
 *
 * 前端只做两件事：订阅事件、发指令。所有真相都在 Kernel 这边——
 * 界面文档、进程表、任务板、事件日志。
 */
import os from 'node:os';
import path from 'node:path';

import { TeamRunner } from '../orchestrator/team.ts';
import type { SpawnAgentOptions } from '../orchestrator/team.ts';
import { ClientSource } from '../orchestrator/client-source.ts';
import type { SelfTestResult } from '../orchestrator/self-test.ts';
import { EventLog } from '../eventlog/log.ts';
import type { ApprovalGate } from '../kernel/approval.ts';
import { projectConversation } from '../runtime/conversation.ts';
import type { ContextItem } from '../loop/loop.ts';
import type { Frame } from '../protocol/frames.ts';
import type { LoggedEvent } from '../eventlog/log.ts';

export type SessionEventType = 'state' | 'frame' | 'document' | 'done' | 'client.changed';

export interface SessionEvent {
  type: SessionEventType;
  data: unknown;
}

export interface ClientState {
  busy: boolean;
  /** Agent 正在干活时，人类至少知道等了多久 */
  busySince: number | null;
  document: { version: number; scopes: string[]; html: string };
  agents: Array<{ id: string; pid: number | undefined; alive: boolean }>;
  tasks: Array<{ id: string; subject: string; status: string; owner: string | null; writeScopes: string[] }>;
  events: Array<{ seq: number; type: string; ts: string; summary: string }>;
  messages: Array<{ from: string; to: string; kind: string; body: string; ts: string }>;
  /** SPEC-013：客户端自身源码（Agent 可以改的那些） */
  sources: Array<{ path: string; bytes: number; versions: number }>;
}

export interface SessionOptions {
  dir?: string;
  /** 模型侧环境变量，透传给 Agent 子进程（AGENT_MODEL / AGENT_BASE_URL / ...） */
  agentEnv?: Record<string, string>;
  /** 一次最多回多少条事件（默认 120） */
  eventTail?: number;
  /** 复用外部事件日志（默认在 dir 下自建） */
  log?: EventLog;
  /** 固定 Lead 的剧本/延迟：确定性演示与测试用（不传就跑真模型） */
  lead?: SpawnAgentOptions;
  /** 可改的客户端源码根目录（默认 <cwd>/src/client）；传 null 表示不启用自举 */
  clientRoot?: string | null;
  /** 自检器注入点（测试用假实现，避免每次都跑真测试） */
  selfTest?: (input: { changed: string[] }) => Promise<SelfTestResult>;
  /** 审批门（默认拒绝；`serve` 会用「人类在旁边看着」的策略） */
  approval?: ApprovalGate;
}

export class ClientSession {
  readonly runner: TeamRunner;
  readonly dir: string;

  #agentEnv: Record<string, string>;
  #lead: SpawnAgentOptions;
  #eventTail: number;
  #listeners = new Set<(event: SessionEvent) => void>();
  #lastDocumentVersion = -1;
  #busySince: number | null = null;
  #started = false;

  constructor(options: SessionOptions = {}) {
    this.dir = options.dir ?? path.join(os.tmpdir(), 'agent-client', 'client-session');
    this.#agentEnv = options.agentEnv ?? {};
    this.#lead = options.lead ?? {};
    this.#eventTail = options.eventTail ?? 120;

    const clientRoot =
      options.clientRoot === null
        ? undefined
        : (options.clientRoot ?? path.join(process.cwd(), 'src', 'client'));

    // 事件日志先建好，源码管理器与 runner 共用同一份（审计只有一个来源）
    const log = options.log ?? new EventLog({ dir: path.join(this.dir, 'events') });

    // P3：接上源码管理器，Agent 才能改自己的界面代码（且必须过自检门禁）
    const clientSource =
      clientRoot === undefined
        ? undefined
        : new ClientSource({
            root: clientRoot,
            historyDir: path.join(this.dir, 'client-history'),
            projectRoot: process.cwd(),
            log,
            ...(options.selfTest === undefined ? {} : { selfTest: options.selfTest }),
          });

    this.runner = new TeamRunner({
      dir: this.dir,
      log,
      ...(options.approval === undefined ? {} : { approval: options.approval }),
      onFrame: (agentId, frame) => this.#onFrame(agentId, frame),
      ...(clientSource === undefined ? {} : { clientSource }),
      onClientChanged: (payload) => {
        this.#emit({ type: 'client.changed', data: payload });
        this.#emit({ type: 'state', data: this.state() });
      },
    });
  }

  get log(): EventLog {
    return this.runner.log;
  }

  get clientSource(): ClientSource | undefined {
    return this.runner.clientSource;
  }

  /** 拉起 Lead。幂等：重复调用不会起第二个。 */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.runner.spawnAgent('lead', { ...this.#lead, env: { ...this.#agentEnv, ...(this.#lead.env ?? {}) } });
    this.#emit({ type: 'state', data: this.state() });
  }

  onEvent(listener: (event: SessionEvent) => void): () => void {
    this.#listeners.add(listener);
    listener({ type: 'state', data: this.state() });
    return () => this.#listeners.delete(listener);
  }

  /** 人类说话 */
  send(text: string): { ok: boolean; error?: string } {
    const body = text.trim();
    if (body === '') return { ok: false, error: 'EMPTY_MESSAGE' };
    this.start();

    const lead = this.runner.pool.get('lead');
    if (lead === undefined) return { ok: false, error: 'LEAD_NOT_RUNNING' };

    // 落进邮箱（有记录），再作为 human.message 投递（有边界语义）
    this.runner.mailbox.send({ from: 'human', to: 'lead', kind: 'human', body });
    this.runner.log.append({ type: 'mail.message', from: 'human', to: 'lead', kind: 'human', body });
    try {
      lead.send({ t: 'human.message', text: body });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    this.#busySince = Date.now();
    this.#emit({ type: 'state', data: this.state() });
    return { ok: true };
  }

  /** 人类夺权 */
  interrupt(reason = 'human_took_over'): { ok: boolean; error?: string } {
    const lead = this.runner.pool.get('lead');
    if (lead === undefined) return { ok: false, error: 'LEAD_NOT_RUNNING' };
    lead.interrupt(reason);
    return { ok: true };
  }

  /**
   * 客户端源码回滚：人类不必经过 Agent 就能撤销它对自己代码的改动。
   * 这是「永远能夺回控制权」这条底线在自举场景下的落点。
   */
  revertClient(path: string, version?: number): { ok: boolean; version?: number; error?: string } {
    const source = this.runner.clientSource;
    if (source === undefined) return { ok: false, error: 'CLIENT_SOURCE_DISABLED' };

    const reverted = source.revert(path, version);
    if (!reverted.ok) return { ok: false, error: `${reverted.error.code}: ${reverted.error.message}` };

    this.runner.onClientChanged?.({
      kind: 'revert',
      path,
      reason: `人类手动回滚（撤销 v${reverted.value.restoredFrom}）`,
      version: reverted.value.version,
      selfTest: 'skipped',
      restoredFrom: reverted.value.restoredFrom,
    });
    return { ok: true, version: reverted.value.version };
  }

  /** 界面回滚：回到历史版本，并广播新文档 */
  rollback(version: number): { ok: boolean; version?: number; error?: string } {
    const result = this.runner.document.rollback(version);
    if (!result.ok) return { ok: false, error: `${result.error.code}: ${result.error.message}` };
    this.#lastDocumentVersion = -1;
    this.#emitDocument();
    this.#emit({ type: 'state', data: this.state() });
    return { ok: true, version: result.version };
  }

  state(): ClientState {
    const agents = this.runner.pool.list().map((handle) => ({
      id: handle.agentId,
      pid: handle.pid,
      alive: handle.alive,
    }));

    const tasks = this.runner.board.list().map((task) => ({
      id: task.id,
      subject: task.subject,
      status: task.status,
      owner: task.owner,
      writeScopes: [...task.writeScopes],
    }));

    const all = this.runner.log.read();
    const events = all.slice(-this.#eventTail).map((event) => ({
      seq: event.seq,
      type: event.type,
      ts: event.ts,
      summary: summarize(event),
    }));

    const messages = all
      .filter((event) => event.type === 'mail.message')
      .slice(-30)
      .map((event) => ({
        from: String(event.from ?? ''),
        to: String(event.to ?? ''),
        kind: String(event.kind ?? ''),
        body: String(event.body ?? ''),
        ts: event.ts,
      }));

    const listedSources = this.runner.clientSource?.list();
    const sources = listedSources?.ok === true ? listedSources.value : [];

    return {
      busy: this.#busySince !== null,
      busySince: this.#busySince,
      document: this.documentPayload(),
      agents,
      tasks,
      events,
      messages,
      sources,
    };
  }

  /**
   * 当前对话上下文（由事件日志投影）。
   * 读的是 Lead 自己的日志——和它真正喂给模型的那份是同一个来源。
   */
  conversation(): ContextItem[] {
    return projectConversation(this.runner.agentEvents('lead'));
  }

  documentPayload(): ClientState['document'] {
    return {
      version: this.runner.document.version,
      scopes: this.runner.document.scopes(),
      html: this.runner.document.render({ title: 'Agent 展示的界面' }),
    };
  }

  async close(): Promise<void> {
    await this.runner.reclaim();
    this.#listeners.clear();
  }

  #onFrame(agentId: string, frame: Frame): void {
    this.#emit({ type: 'frame', data: { agent: agentId, frame } });

    // Agent 自己发的 ui.patch（脚本模型路线）
    if (frame.t === 'ui.patch') {
      this.runner.ingest.ingest({
        scope: String(frame.scope),
        op: String(frame.op),
        spec: frame.spec,
      });
    }

    if (frame.t === 'loop.done') {
      this.#busySince = null;
      this.#emit({ type: 'done', data: { agent: agentId, reason: String(frame.reason) } });
      this.#emit({ type: 'state', data: this.state() });
    }

    // 宿主工具（例如 ui.render）改的是宿主这边的文档，所以每帧都查一下版本
    this.#emitDocument();
  }

  #emitDocument(): void {
    const version = this.runner.document.version;
    if (version === this.#lastDocumentVersion) return;
    this.#lastDocumentVersion = version;
    this.#emit({ type: 'document', data: this.documentPayload() });
  }

  #emit(event: SessionEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // 单个订阅者出错不能拖垮会话
      }
    }
  }
}

function summarize(event: LoggedEvent): string {
  switch (event.type) {
    case 'agent.spawn':
      return `${String(event.agent)} 启动（pid ${String(event.pid)}）`;
    case 'agent.exit':
      return `${String(event.agent)} 退出（code ${String(event.code)}）`;
    case 'host.tool.call':
      return `→ ${String(event.tool)}`;
    case 'host.tool.result':
      return `← ${String(event.tool)} ${event.ok === true ? '成功' : `失败：${String(event.error ?? '')}`}`;
    case 'loop.step':
      return `${String(event.agent)} 第 ${String(event.turn)} 轮 · 第 ${String(event.step)} 步 ${String(event.name)}`;
    case 'loop.done':
      return `${String(event.agent)} 收工：${String(event.reason)}`;
    case 'message.received':
      return `收到来自 ${String(event.from)} 的消息`;
    case 'ui.patch':
      return `界面改动 ${String(event.op)} @ ${String(event.scope)}${event.rejected === true ? '（被拒绝）' : ''}`;
    case 'agent.frame':
      return `帧 ${String((event.frame as Frame | undefined)?.t ?? '')}`;
    default:
      return event.type;
  }
}
