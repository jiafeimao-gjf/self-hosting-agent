/**
 * SPEC-002 事件日志 —— 唯一真相。
 *
 * 追加写 JSONL：一行一事件。快照单独落盘，回放可以从快照水位起跳。
 * 选 JSONL 而不是数据库，是为了让「可读、可 diff、可 grep」在 P0 就成立。
 */
import fs from 'node:fs';
import path from 'node:path';

export interface LoggedEvent {
  seq: number;
  type: string;
  ts: string;
  [field: string]: unknown;
}

export interface EventInput {
  type: string;
  [field: string]: unknown;
}

export interface LogIssue {
  line: number;
  reason: string;
  raw?: string;
}

export type AppendErrorCode = 'BAD_EVENT' | 'IO_ERROR';

export type AppendResult =
  | { ok: true; event: LoggedEvent }
  | { ok: false; error: { code: AppendErrorCode; message: string } };

export interface SnapshotRef {
  seq: number;
  ts: string;
  file: string;
}

export interface LoadedSnapshot<T = unknown> extends SnapshotRef {
  state: T;
}

export interface ReplayOptions {
  /** 从哪个 seq（含）开始折叠，默认 1 */
  fromSeq?: number;
}

/** 事件日志需要的最小接口：Loop 只依赖它，不依赖具体实现（依赖倒置） */
export interface EventAppender {
  append(event: EventInput): AppendResult;
}

export class EventLog implements EventAppender {
  #dir: string;
  #file: string;
  #snapshotDir: string;
  #seq = 0;
  #lastTs = 0;
  #issues: LogIssue[] = [];
  #cache: LoggedEvent[] | undefined;

  #maxBytes: number | undefined;

  constructor(options: { dir: string; maxBytes?: number }) {
    this.#maxBytes = options.maxBytes;
    this.#dir = options.dir;
    this.#file = path.join(options.dir, 'events.jsonl');
    this.#snapshotDir = path.join(options.dir, 'snapshots');
    fs.mkdirSync(this.#snapshotDir, { recursive: true });

    // 启动时把水位恢复到已有事件的最大 seq，保证多实例/重启后号段连续
    for (const event of this.#parseFile()) {
      if (event.seq > this.#seq) this.#seq = event.seq;
    }
  }

  get dir(): string {
    return this.#dir;
  }

  get file(): string {
    return this.#file;
  }

  get size(): number {
    return this.read().length;
  }

  /** 追加一条事件；返回落盘后的完整事件（LOG-001 / LOG-007） */
  append(event: EventInput): AppendResult {
    if (typeof event !== 'object' || event === null || typeof event.type !== 'string' || event.type.trim() === '') {
      return {
        ok: false,
        error: { code: 'BAD_EVENT', message: '事件必须带非空 type' },
      };
    }

    const logged: LoggedEvent = {
      ...event,
      seq: this.#seq + 1,
      // ts 单调不减：同毫秒内的连续写入也要有稳定顺序
      ts: new Date(Math.max(Date.now(), this.#lastTs)).toISOString(),
    };

    try {
      this.#rotateIfNeeded();
      fs.appendFileSync(this.#file, JSON.stringify(logged) + '\n', 'utf8');
    } catch (err) {
      return {
        ok: false,
        error: { code: 'IO_ERROR', message: err instanceof Error ? err.message : String(err) },
      };
    }

    this.#seq = logged.seq;
    this.#lastTs = Date.parse(logged.ts);
    this.#cache = undefined;
    return { ok: true, event: logged };
  }

  /** 按 seq 升序返回全部事件；损坏行被跳过并记入 issues()（LOG-003 / LOG-006） */
  read(): LoggedEvent[] {
    if (this.#cache) return this.#cache;
    this.#issues = [];
    this.#cache = this.#parseFile();
    return this.#cache;
  }

  readFrom(seq: number): LoggedEvent[] {
    return this.read().filter((event) => event.seq >= seq);
  }

  issues(): LogIssue[] {
    this.read();
    return [...this.#issues];
  }

  /** 写入快照，记录当前水位（LOG-004） */
  snapshot(state: unknown): SnapshotRef {
    const seq = this.#seq;
    const ts = new Date(Math.max(Date.now(), this.#lastTs)).toISOString();
    const file = path.join(this.#snapshotDir, `${String(seq).padStart(8, '0')}.json`);
    fs.writeFileSync(file, JSON.stringify({ seq, ts, state }, null, 2) + '\n', 'utf8');
    return { seq, ts, file };
  }

  /** 最近一次快照；没有则返回 null */
  latestSnapshot<T = unknown>(): LoadedSnapshot<T> | null {
    if (!fs.existsSync(this.#snapshotDir)) return null;
    const files = fs
      .readdirSync(this.#snapshotDir)
      .filter((name) => name.endsWith('.json'))
      .sort();
    const last = files[files.length - 1];
    if (last === undefined) return null;

    const full = path.join(this.#snapshotDir, last);
    try {
      const parsed = JSON.parse(fs.readFileSync(full, 'utf8')) as { seq: number; ts: string; state: T };
      return { seq: parsed.seq, ts: parsed.ts, state: parsed.state, file: full };
    } catch {
      this.#issues.push({ line: 0, reason: `快照损坏：${last}` });
      return null;
    }
  }

  /** 折叠出派生状态（LOG-005 / LOG-008） */
  replay<T>(reducer: (state: T, event: LoggedEvent) => T, initial: T, options: ReplayOptions = {}): T {
    let state = initial;
    for (const event of this.readFrom(options.fromSeq ?? 1)) {
      state = reducer(state, event);
    }
    return state;
  }

  /**
   * 超过上限就把当前文件滚到 `<file>.1`（只保留一代）。
   *
   * 取舍写清楚：轮转后 `read()` 只覆盖当前文件，更早的事件仍在 `.1` 里可查，
   * 但不参与 replay —— 用「可回放的完整性」换「磁盘不会无限增长」。
   * 默认不开启（maxBytes 未配置），需要长时间运行时显式打开。
   */
  #rotateIfNeeded(): void {
    if (this.#maxBytes === undefined || !fs.existsSync(this.#file)) return;
    const size = fs.statSync(this.#file).size;
    if (size < this.#maxBytes) return;
    fs.renameSync(this.#file, `${this.#file}.1`);
    this.#cache = undefined;
  }

  #parseFile(): LoggedEvent[] {
    if (!fs.existsSync(this.#file)) return [];
    const raw = fs.readFileSync(this.#file, 'utf8');
    const events: LoggedEvent[] = [];
    const lines = raw.split('\n');

    lines.forEach((line, index) => {
      if (line.trim() === '') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.#issues.push({ line: index + 1, reason: '不是合法 JSON', raw: line.slice(0, 120) });
        return;
      }
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        typeof (parsed as LoggedEvent).seq !== 'number' ||
        typeof (parsed as LoggedEvent).type !== 'string' ||
        typeof (parsed as LoggedEvent).ts !== 'string'
      ) {
        this.#issues.push({ line: index + 1, reason: '事件缺少 seq/type/ts', raw: line.slice(0, 120) });
        return;
      }
      events.push(parsed as LoggedEvent);
    });

    events.sort((a, b) => a.seq - b.seq);
    return events;
  }
}
