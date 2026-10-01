/**
 * SPEC-004 §1 进程池 —— 一个 Agent 一个子进程。
 *
 * 为什么必须是子进程而不是协程：崩溃隔离、真并行、按进程限权限预算、可单独 kill。
 * 这就是架构里最硬的那条公理，落到代码上就是这个文件。
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FrameChannel } from '../protocol/channel.ts';
import { ProtocolError, decodeFrame } from '../protocol/frames.ts';
import type { Frame } from '../protocol/frames.ts';
import type { EventAppender } from '../eventlog/log.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ENTRY = path.resolve(HERE, '..', 'runtime', 'agent-main.ts');
export const DEFAULT_LOG_ROOT = path.join(os.tmpdir(), 'agent-client', 'agents');

export interface SpawnOptions {
  agentId: string;
  /** 子进程入口，默认 src/runtime/agent-main.ts */
  entry?: string;
  /** 脚本化模型剧本（JSON 数组），用于确定性 demo 与测试 */
  script?: unknown[];
  /** 子进程自己的事件日志目录 */
  logDir?: string;
  /** 模拟模型延迟，便于观察中断与边界投递 */
  stepDelayMs?: number;
  /** 声明为宿主工具的名字列表：这些调用会走 tool.call → 宿主执行 → tool.reply 回填 */
  hostTools?: string[];
  /** 宿主工具回填超时 */
  hostToolTimeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
  /** 子进程启动参数（高级用法，会追加在内置参数之后） */
  extraArgs?: string[];
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export class AgentProcess extends EventEmitter {
  readonly agentId: string;
  readonly child: ChildProcess;
  readonly pid: number | undefined;
  readonly logDir: string;

  #channel: FrameChannel;
  #exited: Promise<ExitInfo>;
  #alive = true;
  #stderr = '';

  constructor(options: { agentId: string; child: ChildProcess; logDir: string; log?: EventAppender }) {
    super();
    this.agentId = options.agentId;
    this.child = options.child;
    this.pid = options.child.pid;
    this.logDir = options.logDir;

    const stdout = options.child.stdout;
    const stdin = options.child.stdin;
    if (!stdout || !stdin) throw new Error('子进程必须提供 stdio 管道');

    this.#channel = new FrameChannel({ input: stdout, output: stdin });
    this.#channel.on('frame', (frame: Frame, raw: string) => {
      options.log?.append({ type: 'agent.frame', agent: this.agentId, pid: this.pid, frame, raw });
      this.emit('frame', frame);
    });
    this.#channel.on('error', (error: { code: string; message: string }) => {
      options.log?.append({ type: 'agent.protocol_error', agent: this.agentId, pid: this.pid, ...error });
      this.emit('protocol-error', error);
    });

    const stderr = options.child.stderr;
    if (stderr) {
      stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        this.#stderr += text;
        this.emit('stderr', text);
      });
    }

    this.#exited = new Promise<ExitInfo>((resolve) => {
      options.child.once('exit', (code, signal) => {
        this.#alive = false;
        this.#channel.close();
        const info: ExitInfo = { code, signal };
        options.log?.append({ type: 'agent.exit', agent: this.agentId, pid: this.pid, ...info });
        this.emit('exit', info);
        resolve(info);
      });
    });
  }

  get alive(): boolean {
    return this.#alive;
  }

  get stderr(): string {
    return this.#stderr;
  }

  get exited(): Promise<ExitInfo> {
    return this.#exited;
  }

  /** 发送一帧；非法帧在这里就被拦下，不写进管道（KERN-004） */
  send(frame: Frame): void {
    const checked = decodeFrame(JSON.stringify(frame));
    if (!checked.ok) throw new ProtocolError(checked.error);
    this.#channel.send(checked.frame);
  }

  onFrame(handler: (frame: Frame) => void): () => void {
    this.on('frame', handler);
    return () => this.off('frame', handler);
  }

  /** 人类夺权：让 Loop 在最近一个 step boundary 停下（KERN-005） */
  interrupt(reason: string): void {
    this.send({ t: 'interrupt', reason });
  }

  /** 回填一次宿主工具调用（tool.reply 是唯一的入站回填帧，PROTO-010） */
  replyTool(callId: string, reply: { ok: boolean; result?: string; error?: string }): void {
    this.send({
      t: 'tool.reply',
      id: callId,
      ok: reply.ok,
      ...(reply.result === undefined ? {} : { result: reply.result }),
      ...(reply.error === undefined ? {} : { error: reply.error }),
    });
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this.#alive) this.child.kill(signal);
  }
}

export class AgentPool {
  #agents = new Map<string, AgentProcess>();
  #log: EventAppender | undefined;
  #logRoot: string;

  constructor(options: { log?: EventAppender; logRoot?: string } = {}) {
    this.#log = options.log;
    this.#logRoot = options.logRoot ?? DEFAULT_LOG_ROOT;
  }

  list(): AgentProcess[] {
    return [...this.#agents.values()];
  }

  get(agentId: string): AgentProcess | undefined {
    return this.#agents.get(agentId);
  }

  /** 拉起一个 Agent（一个 Agent 一个进程） */
  spawn(options: SpawnOptions): AgentProcess {
    if (this.#agents.has(options.agentId)) {
      throw new Error(`Agent ${options.agentId} 已经在运行（一个 Agent 一个进程）`);
    }

    const entry = options.entry ?? DEFAULT_ENTRY;
    const logDir = options.logDir ?? path.join(this.#logRoot, options.agentId);
    const args = [entry, '--agent', options.agentId, '--log-dir', logDir];
    if (options.stepDelayMs !== undefined) args.push('--step-delay', String(options.stepDelayMs));
    if (options.hostTools !== undefined && options.hostTools.length > 0) {
      args.push('--host-tools', options.hostTools.join(','));
    }
    if (options.hostToolTimeoutMs !== undefined) args.push('--host-tool-timeout', String(options.hostToolTimeoutMs));
    if (options.script !== undefined) args.push('--script', JSON.stringify(options.script));
    if (options.extraArgs) args.push(...options.extraArgs);

    const child = spawn(process.execPath, args, {
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const handle = new AgentProcess({ agentId: options.agentId, child, logDir, log: this.#log });
    this.#agents.set(options.agentId, handle);
    this.#log?.append({ type: 'agent.spawn', agent: options.agentId, pid: handle.pid, entry, logDir });

    handle.exited.then(() => {
      if (this.#agents.get(options.agentId) === handle) this.#agents.delete(options.agentId);
    });

    return handle;
  }

  /** 关闭池：先礼后兵 */
  async shutdown(options: { graceMs?: number } = {}): Promise<ExitInfo[]> {
    const graceMs = options.graceMs ?? 500;
    const handles = this.list();

    for (const handle of handles) {
      if (!handle.alive) continue;
      try {
        handle.interrupt('pool_shutdown');
      } catch {
        /* 管道可能已关，忽略 */
      }
    }

    const timer = setTimeout(() => {
      for (const handle of handles) handle.kill('SIGKILL');
    }, graceMs);
    timer.unref?.();

    const results = await Promise.all(handles.map((handle) => handle.exited));
    clearTimeout(timer);
    this.#agents.clear();
    return results;
  }
}
