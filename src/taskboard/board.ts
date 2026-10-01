/**
 * SPEC-005 任务板 —— CAS 状态机、依赖就绪、写作用域警告。
 *
 * 只依赖 `src/protocol`（本文件不依赖任何上层）：任务板是 Runtime 层原语，
 * 跨进程协作的唯一事实源之一（另一个是邮箱）。
 *
 * 风格与 SPEC-001 一致：所有操作返回 `{ok:true,...} | {ok:false,error}`，永不抛异常；
 * 每次成功变更都派发事件，供宿主写入事件日志（I3 事件即真相）。
 */

import fs from 'node:fs';

/** 任务状态机：pending → in_progress → completed，另有 release / reopen */
export type TaskStatus = 'pending' | 'in_progress' | 'completed';

export interface Task {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  /** 认领者；pending 时必为 null */
  owner: string | null;
  /** 依赖的任务 id：它们全部 completed 后本任务才 ready */
  blockedBy: string[];
  /** 声称要写的路径。重叠只是警告，不是锁 */
  writeScopes: string[];
  /** CAS 版本号，创建时为 0，每次成功变更 +1 */
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type TaskErrorCode =
  | 'NOT_FOUND'
  | 'DUPLICATE_ID'
  | 'INVALID_INPUT'
  | 'UNKNOWN_BLOCKER'
  | 'REVISION_CONFLICT'
  | 'INVALID_TRANSITION'
  | 'BLOCKED'
  | 'NOT_OWNER'
  | 'PERSIST_ERROR';

export interface TaskError {
  code: TaskErrorCode;
  message: string;
  taskId?: string;
  field?: string;
  expected?: number;
  actual?: number;
  blockers?: string[];
}

export type TaskResult<T> = { ok: true; value: T } | { ok: false; error: TaskError };

export type TaskEventType =
  | 'task.created'
  | 'task.claimed'
  | 'task.released'
  | 'task.completed'
  | 'task.reopened';

export interface TaskEvent {
  type: TaskEventType;
  /** 变更后的任务快照 */
  task: Task;
  /** 触发者；创建为 null */
  actor: string | null;
  at: string;
  /** 仅 task.claimed：写作用域重叠警告（不是失败原因） */
  conflicts?: Task[];
}

export interface CreateTaskInput {
  id?: string;
  subject: string;
  description?: string;
  blockedBy?: string[];
  writeScopes?: string[];
}

export interface TaskBoardOptions {
  /** 可注入时钟，便于确定性测试 */
  now?: () => Date;
  /** 便捷的初始订阅者，等价于构造后调用 onChange */
  onChange?: (event: TaskEvent) => void;
}

export interface TaskBoardSnapshot {
  version: 1;
  tasks: Task[];
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function fail(code: TaskErrorCode, message: string, extra: Partial<TaskError> = {}): TaskResult<never> {
  return { ok: false, error: { code, message, ...extra } };
}

function cloneTask(task: Task): Task {
  return { ...task, blockedBy: [...task.blockedBy], writeScopes: [...task.writeScopes] };
}

function cloneEvent(event: TaskEvent): TaskEvent {
  const copy: TaskEvent = {
    type: event.type,
    task: cloneTask(event.task),
    actor: event.actor,
    at: event.at,
  };
  if (event.conflicts !== undefined) copy.conflicts = event.conflicts.map(cloneTask);
  return copy;
}

/** 写作用域规范化：去空白、统一斜杠、去掉末尾 `/`；空串视为仓库根 `.` */
function normalizeScope(scope: string): string {
  const normalized = scope
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .replace(/^\.\//, '');
  return normalized === '' ? '.' : normalized;
}

/**
 * 写作用域是否重叠：相等，或一方是另一方的路径前缀（按 `/` 分段）。
 * `.`（仓库根）与任何作用域重叠。注意：这是契约判定，不是互斥锁。
 */
export function scopesOverlap(a: string, b: string): boolean {
  const left = normalizeScope(a);
  const right = normalizeScope(b);
  if (left === '.' || right === '.') return true;
  if (left === right) return true;
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function normalizeTask(raw: Partial<Task>): Task | null {
  if (typeof raw.id !== 'string' || raw.id === '') return null;
  if (typeof raw.subject !== 'string') return null;

  const status: TaskStatus =
    raw.status === 'in_progress' || raw.status === 'completed' ? raw.status : 'pending';
  const owner = status === 'pending' ? null : typeof raw.owner === 'string' ? raw.owner : null;
  const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : '';
  const revision =
    typeof raw.revision === 'number' && Number.isInteger(raw.revision) && raw.revision >= 0
      ? raw.revision
      : 0;

  return {
    id: raw.id,
    subject: raw.subject,
    description: typeof raw.description === 'string' ? raw.description : '',
    status,
    owner,
    blockedBy: Array.isArray(raw.blockedBy)
      ? raw.blockedBy.filter((value): value is string => typeof value === 'string')
      : [],
    writeScopes: Array.isArray(raw.writeScopes)
      ? raw.writeScopes.filter((value): value is string => typeof value === 'string')
      : [],
    revision,
    createdAt,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : createdAt,
  };
}

export class TaskBoard {
  private readonly tasks = new Map<string, Task>();
  private readonly listeners = new Set<(event: TaskEvent) => void>();
  private readonly audit: TaskEvent[] = [];
  private readonly clock: () => Date;
  private counter = 1;

  constructor(options: TaskBoardOptions = {}) {
    this.clock = options.now ?? (() => new Date());
    if (options.onChange) this.listeners.add(options.onChange);
  }

  /** 订阅所有成功变更；返回退订函数 */
  onChange(listener: (event: TaskEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 只增不改的审计记录（宿主可据此写事件日志） */
  events(): TaskEvent[] {
    return this.audit.map(cloneEvent);
  }

  create(input: CreateTaskInput): TaskResult<Task> {
    const subject = typeof input.subject === 'string' ? input.subject.trim() : '';
    if (subject === '') {
      return fail('INVALID_INPUT', 'subject 不能为空', { field: 'subject' });
    }

    const description = input.description ?? '';
    if (typeof description !== 'string') {
      return fail('INVALID_INPUT', 'description 必须是字符串', { field: 'description' });
    }

    const rawBlockedBy = input.blockedBy ?? [];
    if (!Array.isArray(rawBlockedBy) || rawBlockedBy.some((value) => typeof value !== 'string')) {
      return fail('INVALID_INPUT', 'blockedBy 必须是字符串数组', { field: 'blockedBy' });
    }
    const rawScopes = input.writeScopes ?? [];
    if (!Array.isArray(rawScopes) || rawScopes.some((value) => typeof value !== 'string')) {
      return fail('INVALID_INPUT', 'writeScopes 必须是字符串数组', { field: 'writeScopes' });
    }

    // 先生成候选 id 但不消耗生成器：失败的创建不能占用 id
    const id = input.id ?? `task_${this.counter}`;
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      return fail('INVALID_INPUT', `非法任务 id：${String(id)}`, { field: 'id' });
    }
    if (this.tasks.has(id)) {
      return fail('DUPLICATE_ID', `任务 ${id} 已存在`, { taskId: id, field: 'id' });
    }

    const blockedBy = [...new Set(rawBlockedBy)];
    for (const blocker of blockedBy) {
      if (blocker === id || !this.tasks.has(blocker)) {
        return fail('UNKNOWN_BLOCKER', `blockedBy 引用了不存在的任务 ${blocker}`, {
          taskId: id,
          field: 'blockedBy',
          blockers: [blocker],
        });
      }
    }

    const at = this.clock().toISOString();
    const task: Task = {
      id,
      subject,
      description,
      status: 'pending',
      owner: null,
      blockedBy,
      writeScopes: [...new Set(rawScopes)],
      revision: 0,
      createdAt: at,
      updatedAt: at,
    };

    this.tasks.set(id, task);
    // 显式 id 也要让自增生成器跨过去，避免后续自动 id 撞车
    if (input.id === undefined) {
      this.counter += 1;
    } else {
      const match = /^task_(\d+)$/.exec(id);
      if (match) this.counter = Math.max(this.counter, Number(match[1]) + 1);
    }
    this.emit({ type: 'task.created', task, actor: null, at });

    return { ok: true, value: cloneTask(task) };
  }

  get(id: string): Task | undefined {
    const task = this.tasks.get(id);
    return task === undefined ? undefined : cloneTask(task);
  }

  /** 按创建顺序返回全部任务快照 */
  list(): Task[] {
    return [...this.tasks.values()].map(cloneTask);
  }

  /** pending、无 owner、且所有 blockedBy 已 completed，按创建顺序 */
  ready(): Task[] {
    const ready: Task[] = [];
    for (const task of this.tasks.values()) {
      if (task.status !== 'pending' || task.owner !== null) continue;
      if (this.unfinishedBlockers(task).length > 0) continue;
      ready.push(cloneTask(task));
    }
    return ready;
  }

  /**
   * 写作用域与在途任务的重叠警告（排除 owner 自己的任务）。
   * 这是契约，不是锁：调用方得到警告后自行决定让路还是继续。
   */
  conflicts(owner: string, scopes: string[]): Task[] {
    const wanted = Array.isArray(scopes) ? scopes : [];
    if (wanted.length === 0) return [];
    const hits: Task[] = [];
    for (const task of this.tasks.values()) {
      if (task.status !== 'in_progress') continue;
      if (task.owner !== null && task.owner === owner) continue;
      const overlap = task.writeScopes.some((scope) =>
        wanted.some((candidate) => scopesOverlap(scope, candidate)),
      );
      if (overlap) hits.push(cloneTask(task));
    }
    return hits;
  }

  claim(id: string, owner: string, expectedRevision: number): TaskResult<Task> {
    const found = this.require(id, expectedRevision);
    if (!found.ok) return found;
    const task = found.value;

    const trimmedOwner = typeof owner === 'string' ? owner.trim() : '';
    if (trimmedOwner === '') {
      return fail('INVALID_INPUT', 'owner 不能为空', { taskId: id, field: 'owner' });
    }
    if (task.status !== 'pending' || task.owner !== null) {
      return fail('INVALID_TRANSITION', `任务 ${id} 处于 ${task.status}，不能 claim`, { taskId: id });
    }

    const blockers = this.unfinishedBlockers(task);
    if (blockers.length > 0) {
      return fail('BLOCKED', `任务 ${id} 依赖未完成：${blockers.join(', ')}`, {
        taskId: id,
        blockers,
      });
    }

    // 警告先算（此时本任务还未变成在途，不会被算成自己的冲突）
    const warnings = this.conflicts(trimmedOwner, task.writeScopes);

    task.status = 'in_progress';
    task.owner = trimmedOwner;
    task.revision += 1;
    task.updatedAt = this.clock().toISOString();

    this.emit({ type: 'task.claimed', task, actor: trimmedOwner, at: task.updatedAt, conflicts: warnings });
    return { ok: true, value: cloneTask(task) };
  }

  release(id: string, owner: string, expectedRevision: number): TaskResult<Task> {
    const found = this.require(id, expectedRevision);
    if (!found.ok) return found;
    const task = found.value;

    if (task.status !== 'in_progress') {
      return fail('INVALID_TRANSITION', `任务 ${id} 处于 ${task.status}，不能 release`, { taskId: id });
    }
    if (task.owner !== owner) {
      return fail('NOT_OWNER', `任务 ${id} 的 owner 是 ${String(task.owner)}，不是 ${owner}`, {
        taskId: id,
        field: 'owner',
      });
    }

    task.status = 'pending';
    task.owner = null;
    task.revision += 1;
    task.updatedAt = this.clock().toISOString();

    this.emit({ type: 'task.released', task, actor: owner, at: task.updatedAt });
    return { ok: true, value: cloneTask(task) };
  }

  complete(id: string, owner: string, expectedRevision: number): TaskResult<Task> {
    const found = this.require(id, expectedRevision);
    if (!found.ok) return found;
    const task = found.value;

    if (task.status !== 'in_progress') {
      return fail('INVALID_TRANSITION', `任务 ${id} 处于 ${task.status}，不能 complete`, { taskId: id });
    }
    if (task.owner !== owner) {
      return fail('NOT_OWNER', `任务 ${id} 的 owner 是 ${String(task.owner)}，不是 ${owner}`, {
        taskId: id,
        field: 'owner',
      });
    }

    task.status = 'completed';
    task.revision += 1;
    task.updatedAt = this.clock().toISOString();

    this.emit({ type: 'task.completed', task, actor: owner, at: task.updatedAt });
    return { ok: true, value: cloneTask(task) };
  }

  reopen(id: string, expectedRevision: number): TaskResult<Task> {
    const found = this.require(id, expectedRevision);
    if (!found.ok) return found;
    const task = found.value;

    if (task.status !== 'completed') {
      return fail('INVALID_TRANSITION', `任务 ${id} 处于 ${task.status}，不能 reopen`, { taskId: id });
    }

    task.status = 'pending';
    task.owner = null;
    task.revision += 1;
    task.updatedAt = this.clock().toISOString();

    this.emit({ type: 'task.reopened', task, actor: null, at: task.updatedAt });
    return { ok: true, value: cloneTask(task) };
  }

  toJSON(): TaskBoardSnapshot {
    return { version: 1, tasks: this.list() };
  }

  /** 重建任务板：重建不是变更，不派发事件、不进审计 */
  static fromJSON(snapshot: TaskBoardSnapshot, options: TaskBoardOptions = {}): TaskBoard {
    const board = new TaskBoard(options);
    const tasks = snapshot !== null && typeof snapshot === 'object' && Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
    for (const raw of tasks) {
      if (raw === null || typeof raw !== 'object') continue;
      const task = normalizeTask(raw);
      if (task !== null) board.tasks.set(task.id, task);
    }
    board.counter = 1;
    for (const id of board.tasks.keys()) {
      const match = /^task_(\d+)$/.exec(id);
      if (match) board.counter = Math.max(board.counter, Number(match[1]) + 1);
    }
    return board;
  }

  /** 一行一任务写 JSONL */
  save(file: string): TaskResult<void> {
    try {
      const lines = this.list().map((task) => JSON.stringify(task));
      fs.writeFileSync(file, lines.length === 0 ? '' : `${lines.join('\n')}\n`, 'utf8');
      return { ok: true, value: undefined };
    } catch (error) {
      return fail('PERSIST_ERROR', `写入任务板失败：${(error as Error).message}`);
    }
  }

  static load(file: string, options: TaskBoardOptions = {}): TaskResult<TaskBoard> {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
      return fail('PERSIST_ERROR', `读取任务板失败：${(error as Error).message}`);
    }

    const tasks: Task[] = [];
    const lines = raw.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      if (line.trim() === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return fail('PERSIST_ERROR', `任务板第 ${index + 1} 行不是合法 JSON`);
      }
      const task = normalizeTask((parsed ?? {}) as Partial<Task>);
      if (task === null) return fail('PERSIST_ERROR', `任务板第 ${index + 1} 行缺少 id/subject`);
      tasks.push(task);
    }

    return { ok: true, value: TaskBoard.fromJSON({ version: 1, tasks }, options) };
  }

  private require(id: string, expectedRevision?: number): TaskResult<Task> {
    const task = this.tasks.get(id);
    if (task === undefined) {
      return fail('NOT_FOUND', `任务 ${id} 不存在`, { taskId: id });
    }
    if (expectedRevision !== undefined && task.revision !== expectedRevision) {
      return fail(
        'REVISION_CONFLICT',
        `任务 ${id} 的 revision 是 ${task.revision}，期望 ${expectedRevision}`,
        { taskId: id, expected: expectedRevision, actual: task.revision },
      );
    }
    return { ok: true, value: task };
  }

  private unfinishedBlockers(task: Task): string[] {
    return task.blockedBy.filter((blocker) => this.tasks.get(blocker)?.status !== 'completed');
  }

  private emit(event: TaskEvent): void {
    const record = cloneEvent(event);
    this.audit.push(record);
    for (const listener of this.listeners) listener(cloneEvent(record));
  }
}
