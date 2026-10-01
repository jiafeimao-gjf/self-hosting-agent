/**
 * SPEC-005 邮箱 —— append-only、持久、边界投递。
 *
 * 只依赖 `src/protocol`（跨层数据只用 SPEC-001 的帧类型）。
 * 不变量 I2：给运行中 Agent 的消息只在 step boundary 被消费（drainAt）。
 *
 * 持久化是 append-only JSONL：`send` 追加发送记录，`drainAt` 追加投递记录，
 * 启动时按行回放。先落盘再改内存，落盘失败就不算消费 —— 消息宁可重复也不能丢。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Frame } from '../protocol/frames.ts';

/** I2：目前只允许在 step boundary 投递 */
export type DeliveryBoundary = 'step_boundary';

export interface MailboxMessage {
  id: string;
  /** 发送者，形如 `teammate:frontend` 或裸 id */
  from: string;
  /** 收件 Agent id */
  to: string;
  kind: string;
  body: string;
  taskId?: string;
  artifacts?: string[];
  createdAt: string;
  /** 被消费的时间；未投递时不存在 */
  deliveredAt?: string;
}

export type MailboxErrorCode = 'INVALID_MESSAGE' | 'BAD_BOUNDARY' | 'PERSIST_ERROR';

export interface MailboxError {
  code: MailboxErrorCode;
  message: string;
  field?: string;
}

export type MailboxResult<T> = { ok: true; value: T } | { ok: false; error: MailboxError };

export interface SendInput {
  id?: string;
  from: string;
  to: string;
  kind: string;
  body: string;
  taskId?: string;
  artifacts?: string[];
}

export interface SendOutcome {
  message: MailboxMessage;
  /** true = 该 id 已存在，本次 send 是幂等重放 */
  duplicate: boolean;
}

export interface MailboxOptions {
  /** 以 `.jsonl` 结尾视为文件；否则视为目录（目录下写 mailbox.jsonl） */
  path?: string;
  /** 目录，等价于 path=<dir> */
  dir?: string;
  /** 直接指定 jsonl 文件 */
  file?: string;
  /** 可注入时钟，便于确定性测试 */
  now?: () => Date;
}

/** 磁盘记录：append-only 回放的最小单元 */
type MailboxRecord =
  | { op: 'send'; message: MailboxMessage }
  | { op: 'deliver'; to: string; ids: string[]; at: string };

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function invalid(message: string, field?: string): MailboxResult<never> {
  const error: MailboxError = { code: 'INVALID_MESSAGE', message };
  if (field !== undefined) error.field = field;
  return { ok: false, error };
}

function cloneMessage(message: MailboxMessage): MailboxMessage {
  const copy: MailboxMessage = { ...message };
  if (message.artifacts !== undefined) copy.artifacts = [...message.artifacts];
  return copy;
}

/** 解析发送者前缀：`teammate:frontend` → `teammate`；裸 id → `agent` */
export function senderKind(sender: string): string {
  const index = typeof sender === 'string' ? sender.indexOf(':') : -1;
  return index > 0 ? sender.slice(0, index) : 'agent';
}

/** 邮箱消息 → SPEC-001 的 peer.message 帧（跨层数据只用协议帧类型） */
export function toPeerFrame(message: MailboxMessage): Frame {
  const frame: Frame = {
    t: 'peer.message',
    agent: message.from,
    from: message.from,
    body: message.body,
  };
  if (message.kind !== undefined) frame.kind = message.kind;
  if (message.taskId !== undefined) frame.taskId = message.taskId;
  if (message.artifacts !== undefined) frame.artifacts = [...message.artifacts];
  return frame;
}

/** SPEC-001 的 peer.message 帧 → send 入参；帧不合法时返回错误而不是抛异常 */
export function fromPeerFrame(frame: Frame, to: string): MailboxResult<SendInput> {
  if (frame === null || typeof frame !== 'object' || frame.t !== 'peer.message') {
    return invalid('不是 peer.message 帧', 't');
  }
  if (typeof frame.from !== 'string') return invalid('peer.message 帧缺少 from', 'from');
  if (typeof frame.body !== 'string') return invalid('peer.message 帧缺少 body', 'body');

  const input: SendInput = {
    from: frame.from,
    to,
    kind: typeof frame.kind === 'string' ? frame.kind : 'peer.message',
    body: frame.body,
  };
  if (typeof frame.taskId === 'string') input.taskId = frame.taskId;
  if (Array.isArray(frame.artifacts)) {
    input.artifacts = frame.artifacts.filter((value): value is string => typeof value === 'string');
  }
  return { ok: true, value: input };
}

/** 路径解析：`.jsonl` 结尾是文件，否则是目录；返回 null 表示纯内存模式 */
function resolveMailboxFile(options: MailboxOptions): string | null {
  if (typeof options.file === 'string' && options.file !== '') {
    fs.mkdirSync(path.dirname(options.file), { recursive: true });
    return options.file;
  }
  const target = options.path ?? options.dir;
  if (typeof target !== 'string' || target === '') return null;
  if (target.endsWith('.jsonl')) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    return target;
  }
  fs.mkdirSync(target, { recursive: true });
  return path.join(target, 'mailbox.jsonl');
}

export class Mailbox {
  /** 落盘文件；纯内存模式为 null */
  readonly file: string | null;

  private readonly byId = new Map<string, MailboxMessage>();
  private readonly clock: () => Date;
  private counter = 1;

  constructor(pathOrOptions: string | MailboxOptions = {}) {
    const options: MailboxOptions = typeof pathOrOptions === 'string' ? { path: pathOrOptions } : pathOrOptions;
    this.clock = options.now ?? (() => new Date());
    this.file = resolveMailboxFile(options);
    if (this.file !== null) this.replay(this.file);
  }

  /** 发送一条消息。重复 id 幂等：不新增记录，返回已有消息。 */
  send(input: SendInput): MailboxResult<SendOutcome> {
    if (input === null || typeof input !== 'object') return invalid('消息必须是对象');

    const from = typeof input.from === 'string' ? input.from.trim() : '';
    if (from === '') return invalid('from 不能为空', 'from');
    const to = typeof input.to === 'string' ? input.to.trim() : '';
    if (to === '') return invalid('to 不能为空', 'to');
    const kind = typeof input.kind === 'string' ? input.kind.trim() : '';
    if (kind === '') return invalid('kind 不能为空', 'kind');
    if (typeof input.body !== 'string') return invalid('body 必须是字符串', 'body');
    if (input.taskId !== undefined && typeof input.taskId !== 'string') {
      return invalid('taskId 必须是字符串', 'taskId');
    }
    if (
      input.artifacts !== undefined &&
      (!Array.isArray(input.artifacts) || input.artifacts.some((value) => typeof value !== 'string'))
    ) {
      return invalid('artifacts 必须是字符串数组', 'artifacts');
    }

    const id = input.id ?? `mail_${this.counter}`;
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      return invalid(`非法消息 id：${String(id)}`, 'id');
    }
    const existing = this.byId.get(id);
    if (existing !== undefined) {
      return { ok: true, value: { message: cloneMessage(existing), duplicate: true } };
    }

    const message: MailboxMessage = {
      id,
      from,
      to,
      kind,
      body: input.body,
      createdAt: this.clock().toISOString(),
    };
    if (input.taskId !== undefined) message.taskId = input.taskId;
    if (input.artifacts !== undefined) message.artifacts = [...input.artifacts];

    const written = this.appendRecord({ op: 'send', message });
    if (!written.ok) return { ok: false, error: written.error };

    this.byId.set(id, message);
    this.advanceCounter(id, input.id === undefined);
    return { ok: true, value: { message: cloneMessage(message), duplicate: false } };
  }

  /** 只读：该 Agent 尚未投递的消息，按到达顺序。不消费、不写 deliveredAt。 */
  pending(agentId: string): MailboxMessage[] {
    return this.pendingInternal(agentId).map(cloneMessage);
  }

  /**
   * 边界投递：一次性取出并消费该 Agent 的全部待投递消息（I2）。
   * 先落盘投递记录，成功后才在内存标记 deliveredAt；同一批不会投递两次。
   */
  drainAt(agentId: string, boundary: string): MailboxResult<MailboxMessage[]> {
    if (boundary !== 'step_boundary') {
      return {
        ok: false,
        error: {
          code: 'BAD_BOUNDARY',
          message: `只允许在 step_boundary 投递，收到 ${String(boundary)}`,
          field: 'boundary',
        },
      };
    }

    const pending = this.pendingInternal(agentId);
    if (pending.length === 0) return { ok: true, value: [] };

    const at = this.clock().toISOString();
    const written = this.appendRecord({ op: 'deliver', to: agentId, ids: pending.map((m) => m.id), at });
    if (!written.ok) return { ok: false, error: written.error };

    for (const message of pending) message.deliveredAt = at;
    return { ok: true, value: pending.map(cloneMessage) };
  }

  /** 全部消息（含已投递），按到达顺序；主要给审计/调试用 */
  messages(): MailboxMessage[] {
    return [...this.byId.values()].map(cloneMessage);
  }

  private pendingInternal(agentId: string): MailboxMessage[] {
    const pending: MailboxMessage[] = [];
    for (const message of this.byId.values()) {
      if (message.to === agentId && message.deliveredAt === undefined) pending.push(message);
    }
    return pending;
  }

  /** 回放 append-only JSONL；坏行跳过，不阻塞其余消息恢复 */
  private replay(file: string): void {
    if (!fs.existsSync(file)) return;
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      this.applyRecord(record);
    }
  }

  private applyRecord(record: unknown): void {
    if (record === null || typeof record !== 'object') return;
    const candidate = record as { op?: unknown; message?: unknown; ids?: unknown; at?: unknown };
    if (candidate.op === 'send') {
      const message = candidate.message as Partial<MailboxMessage> | undefined;
      if (message === undefined || typeof message.id !== 'string') return;
      if (this.byId.has(message.id)) return; // 幂等：重复 send 记录不覆盖
      this.byId.set(message.id, {
        id: message.id,
        from: typeof message.from === 'string' ? message.from : '',
        to: typeof message.to === 'string' ? message.to : '',
        kind: typeof message.kind === 'string' ? message.kind : '',
        body: typeof message.body === 'string' ? message.body : '',
        ...(typeof message.taskId === 'string' ? { taskId: message.taskId } : {}),
        ...(Array.isArray(message.artifacts)
          ? { artifacts: message.artifacts.filter((value): value is string => typeof value === 'string') }
          : {}),
        createdAt: typeof message.createdAt === 'string' ? message.createdAt : '',
        ...(typeof message.deliveredAt === 'string' ? { deliveredAt: message.deliveredAt } : {}),
      });
      this.advanceCounter(message.id, false);
      return;
    }
    if (candidate.op === 'deliver') {
      const ids = Array.isArray(candidate.ids) ? candidate.ids : [];
      const at = typeof candidate.at === 'string' ? candidate.at : '';
      for (const id of ids) {
        if (typeof id !== 'string') continue;
        const message = this.byId.get(id);
        if (message !== undefined && message.deliveredAt === undefined) message.deliveredAt = at;
      }
    }
  }

  /** 显式 id 也要让自增生成器跨过去，避免后续自动 id 撞车 */
  private advanceCounter(id: string, generated: boolean): void {
    if (generated) {
      this.counter += 1;
      return;
    }
    const match = /^mail_(\d+)$/.exec(id);
    if (match) this.counter = Math.max(this.counter, Number(match[1]) + 1);
  }

  private appendRecord(record: MailboxRecord): MailboxResult<void> {
    if (this.file === null) return { ok: true, value: undefined };
    try {
      fs.appendFileSync(this.file, `${JSON.stringify(record)}\n`, 'utf8');
      return { ok: true, value: undefined };
    } catch (error) {
      return {
        ok: false,
        error: { code: 'PERSIST_ERROR', message: `追加邮箱记录失败：${(error as Error).message}` },
      };
    }
  }
}
