/**
 * SPEC-001 §4 通道语义 —— NDJSON over stdio。
 *
 * 只做三件事：帧 → 行、行 → 帧、以及在这两件事上不丢字节。
 */
import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';

import { decodeFrame, encodeFrame, ProtocolError } from './frames.ts';
import type { Frame } from './frames.ts';

export interface FrameChannelOptions {
  input: Readable;
  output: Writable;
  /** 单行上限，默认 1 MiB（PROTO-006） */
  maxLineBytes?: number;
}

export interface ChannelErrorInfo {
  code: string;
  message: string;
  raw?: string;
}

export class FrameChannel extends EventEmitter {
  #input: Readable;
  #output: Writable;
  #maxLineBytes: number;
  #buffer = Buffer.alloc(0);
  #closed = false;

  constructor(options: FrameChannelOptions) {
    super();
    this.#input = options.input;
    this.#output = options.output;
    this.#maxLineBytes = options.maxLineBytes ?? 1024 * 1024;

    this.#input.on('data', (chunk: Buffer | string) => {
      this.#onData(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
    });
    this.#input.on('end', () => this.close());
    this.#input.on('error', (err: Error) => {
      this.emit('error', { code: 'STREAM_ERROR', message: err.message } satisfies ChannelErrorInfo);
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** 发送一帧；关闭后调用会抛错 */
  send(frame: Frame): void {
    if (this.#closed) throw new Error('FrameChannel 已关闭，不能继续发送帧');
    this.#output.write(encodeFrame(frame));
  }

  /** 手工关掉通道（输入流 end 时也会自动关） */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.emit('close');
  }

  #onData(chunk: Buffer): void {
    if (this.#closed) return;
    this.#buffer = Buffer.concat([this.#buffer, chunk]);

    for (;;) {
      const newlineAt = this.#buffer.indexOf(0x0a);
      if (newlineAt === -1) {
        if (this.#buffer.length > this.#maxLineBytes) {
          const oversize = this.#buffer.length;
          this.#buffer = Buffer.alloc(0);
          this.#fail('LINE_TOO_LONG', `单帧超过 ${this.#maxLineBytes} 字节（收到 ${oversize}）`);
        }
        return;
      }

      const lineBuffer = this.#buffer.subarray(0, newlineAt);
      this.#buffer = this.#buffer.subarray(newlineAt + 1);

      if (lineBuffer.length > this.#maxLineBytes) {
        this.#fail('LINE_TOO_LONG', `单帧超过 ${this.#maxLineBytes} 字节（收到 ${lineBuffer.length}）`);
        continue;
      }

      const line = lineBuffer.toString('utf8');
      if (line.trim() === '') continue;

      const decoded = decodeFrame(line);
      if (!decoded.ok) {
        this.#fail(decoded.error.code, decoded.error.message, decoded.raw);
        continue;
      }
      this.emit('frame', decoded.frame, decoded.raw);
    }
  }

  #fail(code: string, message: string, raw?: string): void {
    this.emit('error', { code, message, raw } satisfies ChannelErrorInfo);
  }
}

/** 便于测试与宿主复用：把一次编码错误翻译成通道错误码 */
export function isProtocolError(err: unknown): err is ProtocolError {
  return err instanceof ProtocolError;
}
