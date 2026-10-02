/**
 * SPEC-021 工作空间：每个对话一块真实存在磁盘上的目录。
 *
 * 这个模块的全部难点只有一件事：**path 是不可信输入**。
 * 规则也只有一个：解析之后必须仍然落在根目录之内。所有校验都在**动磁盘之前**完成，
 * 被拒绝的写入不留半个文件（WS-004）。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 单文件上限 */
export const MAX_FILE_BYTES = 256 * 1024;
/** 整个工作空间上限 */
export const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
/** 文件数量上限 */
export const MAX_FILES = 500;
/** 目录深度上限 */
export const MAX_DEPTH = 8;
/** 单次读取返回的字节上限（超出则截断并标记） */
export const MAX_READ_BYTES = 64 * 1024;

export interface WorkspaceFile {
  path: string;
  bytes: number;
  mtime: string;
}

export interface WriteInput {
  path: string;
  content: string;
  append?: boolean;
}

export type WriteResult = { ok: true; path: string; bytes: number } | { ok: false; code: string; reason: string };

export type ReadResult =
  | { ok: true; path: string; bytes: number; content: string; truncated: boolean }
  | { ok: false; code: string; reason: string };

type Resolved = { ok: true; abs: string; rel: string } | { ok: false; code: string; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 把不可信路径解析成根目录内的绝对路径。
 *
 * 逐条挡住：NUL、Windows 盘符、绝对路径、`..`、空段、超深，最后再兜一次
 * 「解析结果必须在根目录之内」——前几条是常识，最后一条才是真正的地板。
 */
export function resolveInside(root: string, relative: unknown): Resolved {
  if (typeof relative !== 'string' || relative.trim() === '') {
    return { ok: false, code: 'BAD_PATH', reason: 'path 必须是非空字符串' };
  }
  const rel = relative.trim().replace(/\\/g, '/');
  if (rel.includes('\0')) return { ok: false, code: 'BAD_PATH', reason: 'path 不能包含 NUL' };
  if (rel.startsWith('/')) return { ok: false, code: 'PATH_ESCAPE', reason: '不接受绝对路径' };
  if (/^[a-zA-Z]:/.test(rel)) return { ok: false, code: 'PATH_ESCAPE', reason: '不接受盘符路径' };

  const segments = rel.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0) return { ok: false, code: 'BAD_PATH', reason: 'path 指向空路径' };
  if (segments.includes('..')) return { ok: false, code: 'PATH_ESCAPE', reason: '不接受 .. 路径段' };
  if (segments.length > MAX_DEPTH) {
    return { ok: false, code: 'BAD_PATH', reason: `目录深度超过上限 ${MAX_DEPTH}` };
  }

  const normalized = segments.join('/');
  const abs = path.resolve(root, normalized);
  const rootResolved = path.resolve(root);
  if (abs !== rootResolved && !abs.startsWith(`${rootResolved}${path.sep}`)) {
    return { ok: false, code: 'PATH_ESCAPE', reason: '路径落在工作空间之外' };
  }
  return { ok: true, abs, rel: normalized };
}

export class WorkspaceStore {
  readonly root: string;

  constructor(options: { root: string }) {
    this.root = path.resolve(options.root);
  }

  /** 惰性建根目录：只有真的要用它时才动磁盘 */
  ensure(): void {
    fs.mkdirSync(this.root, { recursive: true });
  }

  write(input: unknown): WriteResult {
    if (!isRecord(input)) return { ok: false, code: 'BAD_PATH', reason: '参数必须是对象' };
    const content = typeof input.content === 'string' ? input.content : undefined;
    if (content === undefined) return { ok: false, code: 'INVALID_ARGS', reason: 'content 必须是字符串' };

    const resolved = resolveInside(this.root, input.path);
    if (!resolved.ok) return resolved;

    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_FILE_BYTES) {
      return { ok: false, code: 'WORKSPACE_FULL', reason: `单文件超过上限（${bytes} > ${MAX_FILE_BYTES} 字节）` };
    }

    // 先把所有账算清楚，再动磁盘
    const existing = this.list();
    const previous = existing.find((file) => file.path === resolved.rel);
    const isNew = previous === undefined;
    const append = input.append === true;

    if (isNew && existing.length >= MAX_FILES) {
      return { ok: false, code: 'WORKSPACE_FULL', reason: `文件数超过上限 ${MAX_FILES}` };
    }

    const total = existing.reduce((sum, file) => sum + file.bytes, 0);
    const delta = append ? bytes : bytes - (previous?.bytes ?? 0);
    if (total + delta > MAX_TOTAL_BYTES) {
      return { ok: false, code: 'WORKSPACE_FULL', reason: `工作空间总大小超过上限 ${MAX_TOTAL_BYTES} 字节` };
    }

    try {
      this.ensure();
      fs.mkdirSync(path.dirname(resolved.abs), { recursive: true });
      this.#assertStillInside(resolved.abs);
      if (append) fs.appendFileSync(resolved.abs, content, 'utf8');
      else fs.writeFileSync(resolved.abs, content, 'utf8');
    } catch (err) {
      return { ok: false, code: 'WORKSPACE_IO', reason: err instanceof Error ? err.message : String(err) };
    }

    return { ok: true, path: resolved.rel, bytes };
  }

  read(input: unknown): ReadResult {
    const candidate = isRecord(input) ? input.path : input;
    const resolved = resolveInside(this.root, candidate);
    if (!resolved.ok) return resolved;

    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(resolved.abs);
    } catch {
      return { ok: false, code: 'NOT_FOUND', reason: `文件不存在：${resolved.rel}` };
    }
    if (stat.isSymbolicLink()) return { ok: false, code: 'PATH_ESCAPE', reason: '不接受符号链接' };
    if (stat.isDirectory()) return { ok: false, code: 'IS_DIRECTORY', reason: `${resolved.rel} 是目录` };

    try {
      const raw = fs.readFileSync(resolved.abs);
      const truncated = raw.byteLength > MAX_READ_BYTES;
      const slice = truncated ? raw.subarray(0, MAX_READ_BYTES) : raw;
      return {
        ok: true,
        path: resolved.rel,
        bytes: raw.byteLength,
        content: slice.toString('utf8'),
        truncated,
      };
    } catch (err) {
      return { ok: false, code: 'WORKSPACE_IO', reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 只列元信息（WS-007）：内容一律走 read / HTTP 按需加载 */
  list(): WorkspaceFile[] {
    if (!fs.existsSync(this.root)) return [];
    const files: WorkspaceFile[] = [];
    const walk = (dir: string, prefix: string, depth: number): void => {
      if (depth > MAX_DEPTH) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.')) continue;
        const abs = path.join(dir, entry.name);
        const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) {
          walk(abs, rel, depth + 1);
          continue;
        }
        if (entry.isSymbolicLink()) continue;
        try {
          const stat = fs.statSync(abs);
          files.push({ path: rel, bytes: stat.size, mtime: stat.mtime.toISOString() });
        } catch {
          /* 读不到就跳过，不让一个坏文件毁掉整个列表 */
        }
      }
    };
    walk(this.root, '', 1);
    return files;
  }

  /** 兜底：写入前用 realpath 再确认一次父目录没被符号链接带到外面去 */
  #assertStillInside(abs: string): void {
    const realRoot = fs.realpathSync(this.root);
    const realParent = fs.realpathSync(path.dirname(abs));
    if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${path.sep}`)) {
      throw new Error('路径经符号链接逃出了工作空间');
    }
  }
}
