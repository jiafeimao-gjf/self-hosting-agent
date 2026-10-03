/**
 * SPEC-023 Shell 命令执行。
 *
 * 立场：**不给「安全的 shell」，给「被看着的 shell」**。任意命令执行不可能靠过滤变安全，
 * 所以这个模块只管「跑得干净、跑得住、留得下痕迹」，要不要跑由人类的审批决定。
 *
 * 四件事必须做对：
 *   1. **独立进程组 + 超时杀整棵树**：不然 `sleep 100 &` 会留下来，宿主等它一辈子；
 *   2. **环境变量白名单**：`AGENT_API_KEY` 这类东西绝不进 shell（`env` 一条命令就能打出来）；
 *   3. **输出上限**：`yes` 一条命令能吐出几个 G，不封顶就是把宿主撑爆；
 *   4. **退出码如实透传**：非 0 是结果，不是异常。
 */
import { spawn } from 'node:child_process';

/** stdout / stderr 各自的上限 */
export const MAX_OUTPUT_BYTES = 64 * 1024;
/** 默认超时；上限再大也不该让宿主无限等 */
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 300_000;

/** 允许传进 shell 的环境变量：够用，且不含任何凭据 */
export const ENV_ALLOWLIST = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'USER', 'SHELL', 'LOGNAME', 'PWD'] as const;

export interface ShellInput {
  command: string;
  cwd: string;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface ShellResult {
  /** 退出码；被信号杀死时为 null */
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  /** 输出被截断（stdout 或 stderr 任一超限） */
  truncated: boolean;
}

export interface ShellRunner {
  run(input: ShellInput): Promise<ShellResult>;
  /** 当前还活着的进程组（测试与关停用） */
  alive(): number[];
  /** 关停时回收全部 */
  killAll(): void;
}

export function buildEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

/**
 * 独立进程组 + 超时杀整棵树的执行器。
 *
 * 用 `detached: true` 让子进程自成进程组：超时时 `kill(-pid)` 才能连它的子子孙孙一起收掉。
 */
export function createShellRunner(options: { spawnImpl?: typeof spawn } = {}): ShellRunner {
  const doSpawn = options.spawnImpl ?? spawn;
  const alive = new Set<number>();

  const killGroup = (pid: number): void => {
    try {
      process.kill(-pid, 'SIGKILL'); // 负号 = 整个进程组
    } catch {
      try {
        process.kill(pid, 'SIGKILL'); // 退而求其次：至少把主进程杀掉
      } catch {
        /* 已经没了 */
      }
    }
  };

  return {
    alive: () => [...alive],
    killAll(): void {
      for (const pid of [...alive]) killGroup(pid);
      alive.clear();
    },

    run(input: ShellInput): Promise<ShellResult> {
      const timeoutMs = Math.min(
        Math.max(1, input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        MAX_TIMEOUT_MS,
      );
      const maxBytes = Math.max(1024, input.maxBytes ?? MAX_OUTPUT_BYTES);
      const startedAt = Date.now();

      return new Promise<ShellResult>((resolve) => {
        const child = doSpawn('/bin/bash', ['-lc', input.command], {
          cwd: input.cwd,
          env: buildEnv(),
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        const pid = child.pid;
        if (typeof pid === 'number') alive.add(pid);

        let stdout = '';
        let stderr = '';
        let truncated = false;
        let timedOut = false;
        let settled = false;

        const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
          const current = target === 'stdout' ? stdout : stderr;
          const room = maxBytes - Buffer.byteLength(current, 'utf8');
          if (room <= 0) {
            truncated = true;
            return;
          }
          const slice = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
          if (slice.byteLength < chunk.byteLength) truncated = true;
          const text = slice.toString('utf8');
          if (target === 'stdout') stdout += text;
          else stderr += text;
        };

        child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk));
        child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));

        const timer = setTimeout(() => {
          timedOut = true;
          if (typeof pid === 'number') killGroup(pid);
        }, timeoutMs);

        const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
          if (settled) return; // exit 与 error 都可能来，结果只算第一次
          settled = true;
          clearTimeout(timer);
          if (typeof pid === 'number') alive.delete(pid);
          resolve({
            code,
            signal: signal ?? null,
            stdout,
            stderr,
            durationMs: Date.now() - startedAt,
            timedOut,
            truncated,
          });
        };

        child.once('exit', (code, signal) => finish(code, signal));
        child.once('error', () => finish(null, null));
      });
    },
  };
}
