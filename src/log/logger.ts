/**
 * SPEC-018 诊断日志。
 *
 * 与 `src/eventlog/log.ts` 的分工，别混：
 *   · EventLog = **领域事实**（谁改了什么、界面 = f(事件日志)），为审计与回放服务；
 *   · Logger   = **排障证据**（进程为什么崩、端点连没连上、帧为什么发不出去）。
 *
 * 在补齐它之前，子进程往 stderr 写的那些话（模型端口、夺权、发包失败）**收进了内存
 * 却没人看**——出问题时最该看的东西恰好被丢了。这个模块就是那条出口。
 *
 * 三条自我约束：
 *   1. 记日志绝不能反过来把主流程搞挂（任何写盘异常都吞掉）。
 *   2. 级别过滤在写入前，不是"写了再丢"。
 *   3. 每条都是结构化 JSONL，同时能给人类看的可读行。
 */
import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogRecord {
  ts: string;
  level: LogLevel;
  scope: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface LoggerOptions {
  /** 日志目录；给了就写 <dir>/app.log */
  dir?: string;
  /** 直接指定文件（优先于 dir） */
  file?: string;
  /** 低于该级别的丢弃，默认 info */
  level?: LogLevel;
  /** 是否同时写到 stderr（给人看） */
  echo?: boolean;
  /** 额外接收器：测试与前端订阅用 */
  sink?: (record: LogRecord) => void;
  /** 可注入时钟，便于测试 */
  now?: () => Date;
}

export interface Logger {
  readonly scope: string;
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  /** 派生一个带 scope 的子 logger（如按 agent id 打标签） */
  child(scope: string): Logger;
  /** 当前落盘文件；没开文件则为 undefined */
  file(): string | undefined;
  /** 读回已落盘的记录（排障与测试用） */
  read(): LogRecord[];
}

export function formatRecord(record: LogRecord): string {
  const head = `${record.ts} [${record.level.toUpperCase()}] ${record.scope}: ${record.message}`;
  if (record.data === undefined) return head;
  try {
    return `${head} ${JSON.stringify(record.data)}`;
  } catch {
    return head;
  }
}

class FileLogger implements Logger {
  readonly scope: string;
  #file: string | undefined;
  #level: LogLevel;
  #echo: boolean;
  #sink: ((record: LogRecord) => void) | undefined;
  #now: () => Date;
  #memory: LogRecord[] = [];

  constructor(options: LoggerOptions, scope = 'app', file?: string) {
    this.scope = scope;
    this.#file = file;
    this.#level = options.level ?? 'info';
    this.#echo = options.echo ?? false;
    this.#sink = options.sink;
    this.#now = options.now ?? (() => new Date());

    if (this.#file !== undefined) {
      try {
        fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      } catch {
        // 建不出目录就退化成"只在内存里"，绝不因此让调用方崩
        this.#file = undefined;
      }
    }
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.#write('debug', message, data);
  }
  info(message: string, data?: Record<string, unknown>): void {
    this.#write('info', message, data);
  }
  warn(message: string, data?: Record<string, unknown>): void {
    this.#write('warn', message, data);
  }
  error(message: string, data?: Record<string, unknown>): void {
    this.#write('error', message, data);
  }

  child(scope: string): Logger {
    return new FileLogger(
      { level: this.#level, echo: this.#echo, sink: this.#sink, now: this.#now },
      scope,
      this.#file,
    );
  }

  file(): string | undefined {
    return this.#file;
  }

  read(): LogRecord[] {
    if (this.#file === undefined || !fs.existsSync(this.#file)) return [...this.#memory];
    try {
      const records: LogRecord[] = [];
      for (const line of fs.readFileSync(this.#file, 'utf8').split('\n')) {
        if (line.trim() === '') continue;
        try {
          records.push(JSON.parse(line) as LogRecord);
        } catch {
          // 坏行跳过：日志坏一行不该让整个读回失败
        }
      }
      return records;
    } catch {
      return [...this.#memory];
    }
  }

  #write(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    // 级别过滤放在最前面：低于阈值连对象都不建
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.#level]) return;

    const record: LogRecord = {
      ts: this.#now().toISOString(),
      level,
      scope: this.scope,
      message,
      ...(data === undefined ? {} : { data }),
    };

    // 内存留一份尾部：即使文件写不出去，排障时也还能读到最后几条
    this.#memory.push(record);
    if (this.#memory.length > 500) this.#memory.shift();

    if (this.#file !== undefined) {
      try {
        fs.appendFileSync(this.#file, `${JSON.stringify(record)}\n`, 'utf8');
      } catch {
        // 记日志失败不能反过来把业务搞挂
      }
    }

    if (this.#echo) {
      try {
        process.stderr.write(`${formatRecord(record)}\n`);
      } catch {
        /* ignore */
      }
    }

    try {
      this.#sink?.(record);
    } catch {
      /* ignore */
    }
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const file = options.file ?? (options.dir === undefined ? undefined : path.join(options.dir, 'app.log'));
  return new FileLogger(options, 'app', file);
}

/** 空实现：需要"关掉日志"时用它，调用点不必到处判空 */
export const silentLogger: Logger = new FileLogger({ level: 'error' }, 'silent', undefined);
