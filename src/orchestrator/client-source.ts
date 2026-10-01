/**
 * SPEC-013 客户端源码管理器 —— 自举的安全闸门。
 *
 * 规矩只有三条，但每条都由测试守着：
 *   1. 只能改 `src/client/**` 里的东西（内核不可被被监管者改写）
 *   2. 改完必须过自检，不过就**逐字节回滚**
 *   3. 每次成功变更都留版本、留 diff、留审计
 */
import fs from 'node:fs';
import path from 'node:path';

import type { EventAppender } from '../eventlog/log.ts';
import { runClientSelfTest } from './self-test.ts';
import type { SelfTestResult } from './self-test.ts';

export interface SourceFileInfo {
  path: string;
  bytes: number;
  versions: number;
}

export interface SourceVersionRecord {
  version: number;
  path: string;
  ts: string;
  reason: string;
  author: string;
  selfTest: 'passed' | 'failed' | 'skipped';
  bytes: number;
  /** 这次写入**之后**的内容 */
  content: string;
  /** 这次写入**之前**的内容（文件此前不存在则为 null）——回滚就靠它 */
  previousContent: string | null;
}

export type SourceErrorCode =
  | 'OUT_OF_SCOPE'
  | 'BAD_PATH'
  | 'NOT_FOUND'
  | 'TOO_LARGE'
  | 'IO_ERROR'
  | 'SELF_TEST_FAILED'
  | 'NO_HISTORY';

export interface SourceError {
  code: SourceErrorCode;
  message: string;
}

export type SourceResult<T> = { ok: true; value: T } | { ok: false; error: SourceError };

export interface ClientSourceOptions {
  /** 可写根目录：真实运行时是 <project>/src/client */
  root: string;
  /** 版本历史目录 */
  historyDir: string;
  /** 项目根：跑自检用 */
  projectRoot: string;
  /** 注入自检器（测试用假实现，生产用 runClientSelfTest） */
  selfTest?: (input: { changed: string[] }) => Promise<SelfTestResult>;
  log?: EventAppender;
  /** 单文件大小上限 */
  maxBytes?: number;
}

export interface WriteOutcome {
  version: number;
  bytes: number;
  created: boolean;
  /** 内容与当前一致 → 幂等，不产生新版本 */
  unchanged: boolean;
  selfTest: SelfTestResult;
}

export interface DiffOutcome {
  path: string;
  from: number;
  to: number;
  diff: string;
  added: number;
  removed: number;
}

export interface RevertOutcome {
  version: number;
  restoredFrom: number;
}

const DEFAULT_MAX_BYTES = 256 * 1024;

function fail(code: SourceErrorCode, message: string): { ok: false; error: SourceError } {
  return { ok: false, error: { code, message } };
}

export class ClientSource {
  #root: string;
  #historyDir: string;
  #projectRoot: string;
  #selfTest: (input: { changed: string[] }) => Promise<SelfTestResult>;
  #log: EventAppender | undefined;
  #maxBytes: number;

  constructor(options: ClientSourceOptions) {
    this.#root = path.resolve(options.root);
    this.#historyDir = path.resolve(options.historyDir);
    this.#projectRoot = path.resolve(options.projectRoot);
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#log = options.log;
    this.#selfTest =
      options.selfTest ??
      ((input) =>
        runClientSelfTest({
          projectRoot: this.#projectRoot,
          clientRoot: this.#root,
          changed: input.changed,
        }));

    fs.mkdirSync(this.#root, { recursive: true });
    fs.mkdirSync(this.#historyDir, { recursive: true });
  }

  get root(): string {
    return this.#root;
  }

  /** 路径守卫：解析后必须落在可写根目录内（SELF-001） */
  resolveInside(relative: string): SourceResult<string> {
    if (typeof relative !== 'string' || relative.trim() === '') return fail('BAD_PATH', '路径不能为空');
    if (relative.includes('\0')) return fail('BAD_PATH', '路径含非法字符');

    const normalized = relative.trim().replace(/^\.\//, '');
    if (normalized === '' || normalized === '.') return fail('BAD_PATH', `路径指向目录而不是文件：${relative}`);
    if (path.isAbsolute(normalized)) return fail('OUT_OF_SCOPE', `只允许相对路径：${relative}`);
    if (normalized.split(/[\\/]/).includes('..')) return fail('OUT_OF_SCOPE', `不允许路径穿越：${relative}`);

    const full = path.resolve(this.#root, normalized);
    const base = this.#root;
    if (full !== base && !full.startsWith(base + path.sep)) {
      return fail('OUT_OF_SCOPE', `只能改 ${path.basename(base)}/ 里的文件：${relative}`);
    }
    return { ok: true, value: full };
  }

  /** 列出可改文件（SELF-003） */
  list(): SourceResult<SourceFileInfo[]> {
    const files: SourceFileInfo[] = [];
    const walk = (dir: string): void => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        const relative = path.relative(this.#root, full).split(path.sep).join('/');
        files.push({
          path: relative,
          bytes: fs.statSync(full).size,
          versions: this.history(relative).ok ? (this.history(relative) as { value: SourceVersionRecord[] }).value.length : 0,
        });
      }
    };
    walk(this.#root);
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { ok: true, value: files };
  }

  /** 读一个文件（SELF-002） */
  read(relative: string): SourceResult<{ path: string; content: string; bytes: number }> {
    const resolved = this.resolveInside(relative);
    if (!resolved.ok) return resolved;

    if (!fs.existsSync(resolved.value) || !fs.statSync(resolved.value).isFile()) {
      return fail('NOT_FOUND', `文件不存在：${relative}`);
    }
    const stats = fs.statSync(resolved.value);
    if (stats.size > this.#maxBytes) return fail('TOO_LARGE', `文件过大（${stats.size} 字节）`);

    return {
      ok: true,
      value: {
        path: this.#relative(resolved.value),
        content: fs.readFileSync(resolved.value, 'utf8'),
        bytes: stats.size,
      },
    };
  }

  /** 版本历史（SELF-005） */
  history(relative: string): SourceResult<SourceVersionRecord[]> {
    const resolved = this.resolveInside(relative);
    if (!resolved.ok) return resolved;
    return { ok: true, value: this.#readHistory(this.#relative(resolved.value)) };
  }

  /**
   * 写入：先落盘 → 自检 → 通过则记录版本；失败则**逐字节回滚**（SELF-004/006/007/012/013）
   */
  async write(
    relative: string,
    content: string,
    options: { reason?: string; author?: string; append?: boolean } = {},
  ): Promise<SourceResult<WriteOutcome>> {
    const resolved = this.resolveInside(relative);
    if (!resolved.ok) return resolved;
    const full = resolved.value;
    const rel = this.#relative(full);

    if (typeof content !== 'string') return fail('BAD_PATH', 'content 必须是字符串');

    const existed = fs.existsSync(full) && fs.statSync(full).isFile();
    const previous = existed ? fs.readFileSync(full, 'utf8') : undefined;
    const next = options.append === true ? `${previous ?? ''}${content}` : content;

    if (Buffer.byteLength(next, 'utf8') > this.#maxBytes) {
      return fail('TOO_LARGE', `写入内容过大（上限 ${this.#maxBytes} 字节）`);
    }

    const history = this.#readHistory(rel);
    const currentVersion = history.length;

    // 幂等：内容没变就不产生新版本（SELF-012）
    if (existed && previous === next) {
      return {
        ok: true,
        value: {
          version: currentVersion,
          bytes: Buffer.byteLength(next, 'utf8'),
          created: false,
          unchanged: true,
          selfTest: { ok: true, checks: [], output: '' },
        },
      };
    }

    try {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, next, 'utf8');
    } catch (err) {
      return fail('IO_ERROR', err instanceof Error ? err.message : String(err));
    }

    const selfTest = await this.#selfTest({ changed: [rel] });

    if (!selfTest.ok) {
      // 门禁不放行：把文件恢复成写入前的样子，坏代码不许留在磁盘上
      try {
        if (existed) fs.writeFileSync(full, previous as string, 'utf8');
        else fs.rmSync(full, { force: true });
      } catch (err) {
        return fail('IO_ERROR', `回滚失败：${err instanceof Error ? err.message : String(err)}`);
      }

      this.#log?.append({
        type: 'client.write.rejected',
        path: rel,
        reason: options.reason ?? '',
        author: options.author ?? 'agent',
        error: selfTest.output || '自检未通过',
      });

      return fail('SELF_TEST_FAILED', `自检未通过，已回滚：${selfTest.output || '见 checks'}`);
    }

    const version = currentVersion + 1;
    this.#appendHistory({
      version,
      path: rel,
      ts: new Date().toISOString(),
      reason: options.reason ?? '',
      author: options.author ?? 'agent',
      selfTest: 'passed',
      bytes: Buffer.byteLength(next, 'utf8'),
      content: next,
      previousContent: existed ? (previous as string) : null,
    });

    this.#log?.append({
      type: 'client.write',
      path: rel,
      version,
      reason: options.reason ?? '',
      author: options.author ?? 'agent',
      bytes: Buffer.byteLength(next, 'utf8'),
      selfTest: 'passed',
    });

    return {
      ok: true,
      value: {
        version,
        bytes: Buffer.byteLength(next, 'utf8'),
        created: !existed,
        unchanged: false,
        selfTest,
      },
    };
  }

  /** 人可读差异（SELF-005） */
  diff(relative: string, version?: number): SourceResult<DiffOutcome> {
    const resolved = this.resolveInside(relative);
    if (!resolved.ok) return resolved;
    const rel = this.#relative(resolved.value);

    const history = this.#readHistory(rel);
    if (history.length === 0) return fail('NO_HISTORY', `没有版本历史：${rel}`);

    const to = version ?? history.length;
    const record = history.find((item) => item.version === to);
    if (record === undefined) return fail('NOT_FOUND', `没有版本 v${to}`);

    const diff = lineDiff(record.previousContent ?? '', record.content);
    return {
      ok: true,
      value: { path: rel, from: to - 1, to, diff: diff.text, added: diff.added, removed: diff.removed },
    };
  }

  /**
   * 回滚：**撤销**一次写入，把文件恢复到那次写入之前的样子（SELF-010）。
   *
   * 不传 version 就撤销最近一次。之所以记录 `previousContent` 而不是靠「上一个版本的 content」，
   * 是因为一个文件被改之前的那份内容根本没进过历史——那正是最需要回滚到的地方。
   */
  revert(relative: string, version?: number): SourceResult<RevertOutcome> {
    const resolved = this.resolveInside(relative);
    if (!resolved.ok) return resolved;
    const full = resolved.value;
    const rel = this.#relative(full);

    const history = this.#readHistory(rel);
    if (history.length === 0) return fail('NO_HISTORY', `没有可回滚的版本：${rel}`);

    const target = version ?? (history[history.length - 1] as SourceVersionRecord).version;
    const record = history.find((item) => item.version === target);
    if (record === undefined) return fail('NOT_FOUND', `没有版本 v${target}`);

    const before = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
    const restored = record.previousContent;

    try {
      if (restored === null) fs.rmSync(full, { force: true });
      else fs.writeFileSync(full, restored, 'utf8');
    } catch (err) {
      return fail('IO_ERROR', err instanceof Error ? err.message : String(err));
    }

    const nextVersion = history.length + 1;
    this.#appendHistory({
      version: nextVersion,
      path: rel,
      ts: new Date().toISOString(),
      reason: `回滚（撤销 v${target}）`,
      author: 'human',
      selfTest: 'skipped',
      bytes: Buffer.byteLength(restored ?? '', 'utf8'),
      content: restored ?? '',
      previousContent: before,
    });

    this.#log?.append({
      type: 'client.revert',
      path: rel,
      restoredFrom: target,
      version: nextVersion,
    });

    return { ok: true, value: { version: nextVersion, restoredFrom: target } };
  }

  // ── 内部 ──

  #relative(full: string): string {
    return path.relative(this.#root, full).split(path.sep).join('/');
  }

  #historyFile(rel: string): string {
    return path.join(this.#historyDir, `${rel.replace(/[\\/]/g, '__')}.jsonl`);
  }

  #readHistory(rel: string): SourceVersionRecord[] {
    const file = this.#historyFile(rel);
    if (!fs.existsSync(file)) return [];
    const records: SourceVersionRecord[] = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        records.push(JSON.parse(line) as SourceVersionRecord);
      } catch {
        // 坏行跳过：宁可历史少一条，也不让整个文件读不出来
      }
    }
    return records.sort((a, b) => a.version - b.version);
  }

  #appendHistory(record: SourceVersionRecord): void {
    fs.mkdirSync(this.#historyDir, { recursive: true });
    fs.appendFileSync(this.#historyFile(record.path), `${JSON.stringify(record)}\n`, 'utf8');
  }
}

/**
 * 极简逐行差异：掐掉公共前后缀，中间整段替换。
 * 不用 LCS 是因为「人看一眼就知道改了哪几行」才是目的，而不是最小编辑距离。
 */
export function lineDiff(before: string, after: string): { text: string; added: number; removed: number } {
  const a = before.split('\n');
  const b = after.split('\n');

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const removedLines = a.slice(prefix, a.length - suffix);
  const addedLines = b.slice(prefix, b.length - suffix);

  const lines: string[] = [];
  for (const line of a.slice(0, prefix)) lines.push(`  ${line}`);
  for (const line of removedLines) lines.push(`- ${line}`);
  for (const line of addedLines) lines.push(`+ ${line}`);
  if (suffix > 0) lines.push(`  …（末尾 ${suffix} 行未变）`);

  return { text: lines.join('\n'), added: addedLines.length, removed: removedLines.length };
}
