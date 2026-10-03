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
import { ApprovalGate } from '../kernel/approval.ts';
import type { ApprovalDecision, ApprovalRequest } from '../kernel/approval.ts';
import type { ShellRunner } from '../kernel/shell.ts';
import { DEFAULT_MODEL_SETTINGS, SettingsStore, settingsToAgentEnv } from './settings.ts';
import type { ModelSettings, PublicSettings } from './settings.ts';
import fs from 'node:fs';
import { clearBoundary } from '../runtime/conversation.ts';
import { createModelPort } from './model-factory.ts';
import { fetchModelList } from './models.ts';
import type { ListModelsResult } from './models.ts';
import { createLogger } from '../log/logger.ts';
import type { Logger } from '../log/logger.ts';
import { projectConversation } from '../runtime/conversation.ts';
import type { ContextItem } from '../loop/loop.ts';
import type { Frame } from '../protocol/frames.ts';
import type { LoggedEvent } from '../eventlog/log.ts';

export type SessionEventType =
  | 'state'
  | 'frame'
  | 'document'
  | 'done'
  | 'client.changed'
  | 'settings'
  // SPEC-019：内置浏览器的文档更新
  | 'browser'
  // SPEC-023：需要人类批准的敏感动作（shell 命令）
  | 'approval';

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
  /** SPEC-015：当前生效的模型配置（Key 已打码） */
  model: PublicSettings;
  /** SPEC-019：内置浏览器的当前文档（已组合、可直接进 srcdoc）；没有则为 null */
  browser: { version: number; title: string; html: string; allowNetwork: boolean } | null;
  /** SPEC-020：这个快照属于哪个对话 */
  conversation: { id: string; title: string };
  /** SPEC-023：待人类批准的动作（没有则 null）——刷新页面也要能看到 */
  approval: ApprovalRequest | null;
}

export interface SessionOptions {
  dir?: string;
  /** SPEC-020 对话 id（默认 default） */
  id?: string;
  /** SPEC-020 对话标题 */
  title?: string;
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
  /** SPEC-023：这些动作必须**人工逐次批准**（默认只有 shell.run）；其余动作沿用 approval 的策略 */
  humanApprovalFor?: string[];
  /** SPEC-023：给了执行器才注册 shell 工具（默认不给） */
  shell?: ShellRunner;
  /** 等人批准的上限；超时按拒绝处理 */
  approvalTimeoutMs?: number;
  /** 日志级别（默认 info） */
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  /** 是否把日志同时打到 stderr */
  logEcho?: boolean;
  /** 初始模型设置（命令行参数/环境变量）；持久化过的设置优先 */
  modelSettings?: Partial<ModelSettings>;
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
  #settingsStore: SettingsStore;
  #model: ModelSettings;
  #restarting: Promise<void> = Promise.resolve();
  #closed = false;
  #approvalTimeoutMs: number;
  readonly logger: Logger;
  /** SPEC-023：待批准的动作（id → 等待中的请求） */
  #pendingApprovals = new Map<
    string,
    { request: ApprovalRequest; resolve: (decision: ApprovalDecision) => void; timer: NodeJS.Timeout }
  >();
  /** SPEC-020：这个会话属于哪个对话 */
  readonly id: string;
  readonly title: string;
  #lastActiveAt = new Date().toISOString();

  constructor(options: SessionOptions = {}) {
    this.dir = options.dir ?? path.join(os.tmpdir(), 'agent-client', 'client-session');
    this.#agentEnv = options.agentEnv ?? {};
    this.#lead = options.lead ?? {};
    this.#eventTail = options.eventTail ?? 120;
    // 默认 10 分钟：人不可能总守在这一屏，而 2 分钟对「读清一条长命令再决定」太紧
    // （真机上我隔了 11 分钟回来，第一次审批就是被 120s 超时判的拒绝）
    this.#approvalTimeoutMs = options.approvalTimeoutMs ?? 600_000;
    this.id = options.id ?? 'default';
    this.title = options.title ?? (this.id === 'default' ? '默认对话' : this.id);

    const clientRoot =
      options.clientRoot === null
        ? undefined
        : (options.clientRoot ?? path.join(process.cwd(), 'src', 'client'));

    // 事件日志先建好，源码管理器与 runner 共用同一份（审计只有一个来源）
    const log = options.log ?? new EventLog({ dir: path.join(this.dir, 'events') });

    // 诊断日志与事件日志分开：前者给排障，后者是领域事实
    this.logger = createLogger({
      dir: path.join(this.dir, 'logs'),
      ...(options.logLevel === undefined ? {} : { level: options.logLevel }),
      ...(options.logEcho === undefined ? {} : { echo: options.logEcho }),
    });

    // 事件日志的坏行以前只有测试会看：启动时报一次，别静默丢事件
    const issues = log.issues();
    if (issues.length > 0) {
      this.logger.warn('事件日志存在损坏行，已跳过', { count: issues.length, first: issues[0] });
    }

    // SPEC-015：设置持久化在会话目录；命令行给的只是「还没配过时」的初值
    this.#settingsStore = new SettingsStore({ file: path.join(this.dir, 'settings.json') });
    // 界面上配过的设置优先；命令行参数只在「还没配过」时当默认值
    this.#model = this.#settingsStore.exists()
      ? this.#settingsStore.load()
      : { ...DEFAULT_MODEL_SETTINGS, ...(options.modelSettings ?? {}) };

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

    // SPEC-023：shell 这类动作必须人工逐次批准；其余动作沿用注入的策略（serve 里是「人类在场即放行」）
    const askFor = new Set(options.humanApprovalFor ?? ['shell.run']);
    const baseGate = options.approval;
    const gate =
      baseGate !== undefined && askFor.size === 0
        ? baseGate
        : new ApprovalGate({
            policy: async (request) => {
              if (askFor.has(request.action)) return await this.#askHuman(request);
              return baseGate === undefined ? 'deny' : await baseGate.request(request);
            },
          });

    this.runner = new TeamRunner({
      dir: this.dir,
      log,
      approval: gate,
      ...(options.shell === undefined ? {} : { shell: options.shell }),
      logShell: (entry) => {
        // SPEC-023：每次调用（含被拒绝的）都留痕——「谁想跑什么、人类批没批」本身就是审计要的
        this.runner.log.append({ type: 'shell.run', conversation: this.id, ...entry });
        this.logger.warn('shell 调用', entry);
      },
      logger: this.logger,
      onFrame: (agentId, frame) => this.#onFrame(agentId, frame),
      ...(clientSource === undefined ? {} : { clientSource }),
      onBrowserChanged: (doc) => {
        this.logger.info('浏览器文档已更新', { version: doc.version, title: doc.title });
        this.#emit({ type: 'browser', data: doc });
        this.#emit({ type: 'state', data: this.state() });
      },
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
    if (this.#started || this.#closed) return;
    this.#started = true;
    // 优先级：设置 < 显式 agentEnv < lead 自己的 env（测试/演示可以强行指定，例如 demo 模型）
    const env = { ...settingsToAgentEnv(this.#model), ...this.#agentEnv, ...(this.#lead.env ?? {}) };
    this.logger.info('拉起 Lead', { model: this.#model.model, protocol: this.#model.protocol });
    this.runner.spawnAgent('lead', { ...this.#lead, env });
    this.#emit({ type: 'state', data: this.state() });
  }

  /** 当前生效模型（Key 已打码） */
  publicSettings(): PublicSettings {
    return this.#settingsStore.toPublic(this.#model);
  }

  /**
   * 保存设置并让它**真的生效**：回收旧 Agent（它们用的是旧模型），按新环境重新拉起。
   * 历史不会丢——上下文本来就由事件日志投影而来。
   */
  updateSettings(input: unknown): { ok: boolean; settings?: PublicSettings; restarted?: boolean; error?: string } {
    const saved = this.#settingsStore.save(input, this.#model);
    if (!saved.ok) return { ok: false, error: `${saved.error.code}: ${saved.error.message}` };

    const changed = JSON.stringify(saved.value) !== JSON.stringify(this.#model);
    this.#model = saved.value;

    if (changed) {
      this.#restarting = this.#restarting.then(async () => {
        // 关停过程中不能再拉起新进程，否则会留下无法回收的孤儿 Agent
        if (this.#closed) return;
        this.#started = false;
        await this.runner.reclaim();
        if (this.#closed) return;
        this.start();
      });
    }

    this.#emit({ type: 'settings', data: this.publicSettings() });
    this.#emit({ type: 'state', data: this.state() });
    return { ok: true, settings: this.publicSettings(), restarted: changed };
  }

  /**
   * SPEC-015 SET-016：列出端点上有哪些模型。
   *
   * 与连接测试同一套「候选配置」语义：传了 body 就校验后**只用于本次请求**，不写盘；
   * 没传就用当前生效的配置。这样「先拉列表、再选模型、最后保存」的顺序是安全的。
   */
  async listModels(input?: unknown): Promise<ListModelsResult> {
    let candidate = this.#model;
    if (input !== undefined && input !== null && typeof input === 'object' && Object.keys(input).length > 0) {
      const probe = this.#settingsStore.validate(input, this.#model);
      if (!probe.ok) return { ok: false, code: probe.error.code, error: probe.error.message };
      candidate = probe.value;
    }
    return fetchModelList(candidate);
  }

  /** 用当前（或候选）配置发一次最小请求（SET-006） */
  async testSettings(input?: unknown): Promise<{ ok: boolean; latencyMs?: number; reply?: string; error?: string; model?: PublicSettings }> {
    let candidate = this.#model;
    if (input !== undefined && input !== null && typeof input === 'object' && Object.keys(input).length > 0) {
      // 测试不写盘：只校验，落盘交给 PUT
      const probe = this.#settingsStore.validate(input, this.#model);
      if (!probe.ok) return { ok: false, error: `${probe.error.code}: ${probe.error.message}` };
      candidate = probe.value;
    }

    const port = createModelPort(candidate, { timeoutMs: candidate.timeoutMs ?? 60_000 });
    const startedAt = Date.now();
    try {
      const output = await port.step({
        agentId: 'settings-test',
        turn: 1,
        context: [{ role: 'human', text: '只回两个字：你好' }],
        tools: [],
      });
      const reply = (output.text ?? '').trim();
      return {
        ok: true,
        latencyMs: Date.now() - startedAt,
        reply: reply === '' ? '（模型没有返回文本，但连接是通的）' : reply.slice(0, 80),
        model: this.#settingsStore.toPublic(candidate),
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  onEvent(listener: (event: SessionEvent) => void): () => void {
    this.#listeners.add(listener);
    listener({ type: 'state', data: this.state() });
    return () => this.#listeners.delete(listener);
  }

  /** 人类说话 */
  send(text: string): { ok: boolean; error?: string } {
    this.#lastActiveAt = new Date().toISOString();
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

    const messages = this.#conversationMessages();
    const browserDoc = this.runner.browser.current();

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
      conversation: { id: this.id, title: this.title },
      approval: (() => {
        const pending = [...this.#pendingApprovals.values()][0]?.request;
        return pending === undefined ? null : { ...pending, agent: pending.agentId };
      })(),
      model: this.publicSettings(),
      browser:
        browserDoc === undefined
          ? null
          : {
              version: browserDoc.version,
              title: browserDoc.title,
              html: browserDoc.html,
              allowNetwork: browserDoc.allowNetwork,
            },
    };
  }

  /**
   * 当前对话上下文（由事件日志投影）。
   * 读的是 Lead 自己的日志——和它真正喂给模型的那份是同一个来源。
   */
  conversation(): ContextItem[] {
    return projectConversation(this.runner.agentEvents('lead'));
  }

  /**
   * SPEC-023：把一个敏感动作摆到人类面前，等他点。
   *
   * 三条安全默认值：
   *   1. **没有客户端连着 → 直接拒绝**（fail closed），不挂住；
   *   2. 等人的时间有上限，超时按拒绝；
   *   3. 同一个 id 只认第一次回复。
   */
  #askHuman(request: ApprovalRequest): Promise<ApprovalDecision> {
    if (this.#listeners.size === 0) {
      this.logger.warn('无人可批，直接拒绝', { action: request.action, detail: request.detail });
      return Promise.resolve('deny');
    }

    const timeoutMs = this.#approvalTimeoutMs;
    return new Promise<ApprovalDecision>((resolve) => {
      const done = (decision: ApprovalDecision): void => {
        const pending = this.#pendingApprovals.get(request.id);
        if (pending !== undefined) clearTimeout(pending.timer);
        this.#pendingApprovals.delete(request.id);
        this.#emit({ type: 'state', data: this.state() });
        resolve(decision);
      };

      const timer = setTimeout(() => {
        this.logger.warn('等人批准超时，按拒绝处理', { id: request.id, action: request.action });
        done('deny');
      }, timeoutMs);

      this.#pendingApprovals.set(request.id, { request, resolve: done, timer });
      this.logger.warn('请求人类批准', { id: request.id, action: request.action, detail: request.detail });
      // 按冻结契约发 `agent`（内核的 ApprovalRequest 里叫 agentId）——两个都给，
      // 消费方按哪个读都行，但不许出现「契约里写了却没发」的字段
      this.#emit({ type: 'approval', data: { ...request, agent: request.agentId } });
      this.#emit({ type: 'state', data: this.state() });
    });
  }

  /** 人类的回复（POST /api/approval）。未知 id / 非法 decision 一律拒绝。 */
  respondApproval(id: unknown, decision: unknown): { ok: boolean; error?: string } {
    if (typeof id !== 'string' || id === '') return { ok: false, error: 'BAD_ID' };
    const allowed: ApprovalDecision[] = ['allow_once', 'allow_always', 'deny'];
    if (typeof decision !== 'string' || !allowed.includes(decision as ApprovalDecision)) {
      return { ok: false, error: 'BAD_DECISION' };
    }
    const pending = this.#pendingApprovals.get(id);
    if (pending === undefined) return { ok: false, error: 'NO_SUCH_APPROVAL' };

    pending.resolve(decision as ApprovalDecision); // done() 会清定时器与表项
    return { ok: true };
  }

  lastActiveAt(): string {
    return this.#lastActiveAt;
  }

  /** 对话条数（对话列表用） */
  messageCount(): number {
    return this.#conversationMessages(1000).filter((item) => item.kind === 'human' || item.kind === 'assistant').length;
  }

  /**
   * SPEC-015 SET-014：新对话**继承**当前对话的模型配置，而不是回落到内置默认。
   *
   * 只在「本对话还没配过」时生效：已经配过的不动。继承来的 Key 与本机同一信任边界
   * （都在同一个运行目录下），所以整体复制是合理的——用户选的就是「从最近用的那份起步」。
   */
  inheritSettingsFrom(source: ClientSession): { ok: boolean; inherited: boolean } {
    if (this.id === source.id) return { ok: true, inherited: false };
    if (this.#settingsStore.exists()) return { ok: true, inherited: false };

    const saved = this.#settingsStore.save(source.#model, {
      protocol: 'openai',
      baseUrl: '',
      model: '',
      apiKey: '',
      timeoutMs: 180000,
    });
    if (!saved.ok) return { ok: false, inherited: false };

    this.#model = this.#settingsStore.load();
    this.logger.info('新对话继承了模型配置', { from: source.id, model: this.#model.model });
    this.#emit({ type: 'settings', data: this.publicSettings() });
    return { ok: true, inherited: true };
  }

  /**
   * SPEC-020 `/clear`：写一条清空标记，并让子进程也写一条。
   *
   * 两边共用 `projectConversation` 的边界语义，所以宿主显示与 Agent 记忆同时清空；
   * 磁盘上的旧日志一个字都不删（审计还在）。
   */
  clear(): { ok: boolean } {
    this.runner.log.append({ type: 'conversation.cleared', conversation: this.id });
    const lead = this.runner.pool.get('lead');
    if (lead !== undefined) {
      try {
        lead.send({ t: 'conversation.clear' });
      } catch (err) {
        this.logger.warn('清空标记投递失败', { error: err instanceof Error ? err.message : String(err) });
      }
    }
    this.#busySince = null;
    this.#emit({ type: 'state', data: this.state() });
    this.#emit({ type: 'done', data: { reason: 'cleared' } });
    return { ok: true };
  }

  /** SPEC-020 `/history`：把当前可见对话导出成 Markdown */
  exportHistory(): { ok: true; name: string; path: string; lines: number; bytes: number } {
    const items = this.#conversationMessages(1000);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `${stamp}.md`;
    const dir = path.join(this.dir, 'history');
    fs.mkdirSync(dir, { recursive: true });

    const lines: string[] = [`# ${this.title}`, '', `> 对话 id：${this.id}`, `> 导出时间：${new Date().toISOString()}`, ''];
    for (const item of items) {
      const who = item.kind === 'human' ? '人类' : item.kind === 'assistant' ? 'Agent' : item.kind;
      lines.push(`## ${who}`, '', item.body, '');
    }
    const body = lines.join('\n');
    const abs = path.join(dir, name);
    fs.writeFileSync(abs, body, 'utf8');
    return { ok: true, name, path: abs, lines: lines.length, bytes: Buffer.byteLength(body, 'utf8') };
  }

  listHistory(): Array<{ name: string; bytes: number; mtime: string }> {
    const dir = path.join(this.dir, 'history');
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => {
        const stat = fs.statSync(path.join(dir, entry.name));
        return { name: entry.name, bytes: stat.size, mtime: stat.mtime.toISOString() };
      })
      .sort((a, b) => b.name.localeCompare(a.name));
  }

  readHistoryFile(
    name: unknown,
  ): { ok: true; name: string; bytes: number; content: string; truncated: boolean } | { ok: false; error: string } {
    // 只接受纯文件名：历史文件目录里不该出现路径
    if (
      typeof name !== 'string' ||
      name.trim() === '' ||
      name.includes('/') ||
      name.includes('\\') ||
      name.includes('..')
    ) {
      return { ok: false, error: 'BAD_NAME' };
    }
    const abs = path.join(this.dir, 'history', name);
    if (!fs.existsSync(abs)) return { ok: false, error: 'NOT_FOUND' };
    const raw = fs.readFileSync(abs);
    const truncated = raw.byteLength > 256 * 1024;
    return {
      ok: true,
      name,
      bytes: raw.byteLength,
      content: (truncated ? raw.subarray(0, 256 * 1024) : raw).toString('utf8'),
      truncated,
    };
  }

  /**
   * 对话流投影：**人类消息 + Agent 说过的话**，按时间戳归并。
   *
   * 早先只投影邮件类消息（人类→Lead、Agent 间投递），于是前端那个
   * 「整体重建对话流」的渲染一旦跑起来，就会把 Agent 的回复冲掉——
   * 人类消息因为恰好在邮件日志里才活了下来。两边同源才是对的。
   */
  #conversationMessages(limit = 40): ClientState['messages'] {
    const hostEvents = this.runner.log.read();
    const childEvents = this.runner.agentEvents('lead');

    // **两份日志的 seq 是两个独立号段**（各写各的文件），边界必须各算各的。
    // 拿宿主日志的 seq 去过滤子进程的事件，会把回复整条吃掉——
    // 而且越晚越容易踩到：宿主每轮产生的事件比子进程多，号段涨得更快。
    const hostBoundary = clearBoundary(hostEvents);
    const childBoundary = clearBoundary(childEvents);

    const host = hostEvents
      .filter((event) => event.type === 'mail.message' && event.seq > hostBoundary)
      .map((event) => ({
        from: String(event.from ?? ''),
        to: String(event.to ?? ''),
        kind: String(event.kind ?? ''),
        body: String(event.body ?? ''),
        ts: event.ts,
      }));

    const spoken = childEvents
      .filter((event) => event.type === 'agent.thinking' && event.seq > childBoundary)
      .map((event) => ({
        from: 'lead',
        to: 'human',
        kind: 'assistant',
        body: String(event.text ?? ''),
        ts: event.ts,
      }));

    return [...host, ...spoken].sort((a, b) => a.ts.localeCompare(b.ts)).slice(-limit);
  }

  /**
   * SPEC-019：受理人类在内置浏览器里的交互。
   *
   * 全链路都当**不可信输入**：形状不对、超限、kind 不在白名单，一律拒绝且不落日志。
   * 通过之后才写事件日志，并以 `browser.event` 帧投给 Lead —— 这样 Agent 才「知道」人类点了什么。
   */
  browserEvent(raw: unknown): { ok: boolean; error?: string } {
    // HTTP 入口：客户端按契约只发 {kind,name,payload}，信封校验在窗口边界（acceptBridge）
    const accepted = this.runner.browser.acceptEvent(raw);
    if (!accepted.ok) {
      this.logger.warn('浏览器事件被拒绝', { code: accepted.code, reason: accepted.reason });
      return { ok: false, error: `${accepted.code}: ${accepted.reason}` };
    }

    const event = accepted.event;
    this.runner.log.append({
      type: 'browser.event',
      kind: event.kind,
      name: event.name ?? '',
      payload: event.payload ?? null,
      ts: event.ts,
    });

    // ready / log / error 只是留痕；只有人类真的「操作」了才值得惊动 Agent
    if (event.kind !== 'emit') {
      this.#emit({ type: 'state', data: this.state() });
      return { ok: true };
    }

    // 落进邮箱与邮件日志：这样它才会出现在对话投影里（人类看得到自己点了什么），
    // 也和 human.message 走同一套「有记录」的语义
    const body = `[浏览器交互] 人类触发了「${String(event.name)}」，参数：${safeJson(event.payload ?? {})}`;
    this.runner.mailbox.send({ from: 'human', to: 'lead', kind: 'browser', body });
    this.runner.log.append({ type: 'mail.message', from: 'human', to: 'lead', kind: 'browser', body });

    this.start();
    const lead = this.runner.pool.get('lead');
    if (lead === undefined) {
      // Agent 不在也照样留痕：事件已经落日志，人类交互不该因为 Agent 崩了就丢
      this.#emit({ type: 'state', data: this.state() });
      return { ok: true };
    }

    try {
      lead.send({
        t: 'browser.event',
        name: String(event.name ?? ''),
        payload: (event.payload ?? {}) as Record<string, unknown>,
        source: 'human',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error('browser.event 投递失败', { error: message });
      return { ok: false, error: message };
    }

    this.#busySince = Date.now();
    this.#emit({ type: 'state', data: this.state() });
    return { ok: true };
  }

  documentPayload(): ClientState['document'] {
    return {
      version: this.runner.document.version,
      scopes: this.runner.document.scopes(),
      html: this.runner.document.render({ title: 'Agent 展示的界面' }),
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    // 关停时把还挂着的审批按拒绝收掉，否则等它的人会一直等
    for (const [, pending] of this.#pendingApprovals) {
      clearTimeout(pending.timer);
      pending.resolve('deny');
    }
    this.#pendingApprovals.clear();
    // 先等重启链收尾：否则它会在我们把进程都回收之后又拉起一个
    await this.#restarting.catch(() => undefined);
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

/** 序列化不可信 payload：失败也不能让受理流程崩 */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '{}';
  } catch {
    return '{}';
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
    case 'shell.run': {
      const decision = String(event.decision ?? '');
      const detail = `shell：${String(event.command ?? '').slice(0, 60)}`;
      if (decision === 'deny') return `${detail}（人类拒绝）`;
      const code = event.code;
      return `${detail}（退出码 ${code === null || code === undefined ? '被中断' : String(code)}）`;
    }
    case 'browser.event':
      return event.kind === 'emit'
        ? `浏览器交互：${String(event.name)}`
        : `浏览器${String(event.kind)}：${String(event.name ?? '')}`;
    case 'agent.frame':
      return `帧 ${String((event.frame as Frame | undefined)?.t ?? '')}`;
    default:
      return event.type;
  }
}
