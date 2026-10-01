/**
 * SPEC-006 §5 版本化界面文档。
 *
 * `ui.patch` 帧（SPEC-001）带着 `scope / op / spec` 三个字段进来，ViewDocument 负责：
 *
 * - 按 scope 维护区块（sidebar、main、footer…）；
 * - `mount` / `replace` / `patch` 三种粒度；
 * - 每次成功变更落一个全量快照，版本号单调递增；
 * - `rollback(version)` 回到任意历史版本（SPEC-000 不变量 I4）。
 *
 * 不变量：文档里的 spec 永远是合法 View Spec——合并结果会复检，不合法就不落盘。
 * 版本号只增不减：回滚不是时间旅行，而是一笔「内容等于旧版本」的新记录。
 */

import type { ThemeTokens } from './tokens.ts';
import { DEFAULT_TOKENS, tokensToCss } from './tokens.ts';
import { escapeHtml, renderFragment } from './renderer.ts';
import { validateViewSpec } from './viewspec.ts';
import type { ViewSpec } from './viewspec.ts';

export type PatchOp = 'patch' | 'replace' | 'mount';

/** patch 的三种粒度 */
export const PATCH_OPS: readonly PatchOp[] = ['mount', 'replace', 'patch'];

export interface ViewPatch {
  scope: string;
  op: string;
  spec: unknown;
}

export type DocumentErrorCode =
  | 'BAD_SCOPE'
  | 'UNKNOWN_OP'
  | 'SCOPE_EXISTS'
  | 'SCOPE_NOT_FOUND'
  | 'INVALID_SPEC'
  | 'UNKNOWN_VERSION';

export interface DocumentError {
  code: DocumentErrorCode;
  message: string;
  path?: string;
}

export type ApplyResult =
  | { ok: true; version: number; scope: string; op: PatchOp }
  | { ok: false; error: DocumentError };

export type RollbackResult =
  | { ok: true; version: number; restored: number }
  | { ok: false; error: DocumentError };

/** 一个版本的全量快照（架构里说的「快照 v14」就是它） */
export interface DocumentSnapshot {
  version: number;
  scopes: Record<string, ViewSpec>;
  note: string;
  /** 若这一版由 rollback 产生，记录回到的版本号 */
  rolledBackTo?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneSpec(spec: ViewSpec): ViewSpec {
  return JSON.parse(JSON.stringify(spec)) as ViewSpec;
}

function isPatchOp(value: unknown): value is PatchOp {
  return typeof value === 'string' && (PATCH_OPS as readonly string[]).includes(value);
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = merged[key];
    // 对象递归合并；数组与标量整体替换（patch 是「补丁」不是「拼接」）
    merged[key] = isRecord(value) && isRecord(current) ? deepMerge(current, value) : value;
  }
  return merged;
}

export class ViewDocument {
  #scopes: Map<string, ViewSpec> = new Map();
  #snapshots: DocumentSnapshot[] = [];
  #version = 0;
  #tokens: ThemeTokens;

  constructor(options: { tokens?: ThemeTokens } = {}) {
    this.#tokens = options.tokens ?? DEFAULT_TOKENS;
    this.#snapshots.push({ version: 0, scopes: {}, note: '初始空文档' });
  }

  /** 当前版本号。空文档是 v0，每次成功变更 +1 */
  get version(): number {
    return this.#version;
  }

  get tokens(): ThemeTokens {
    return this.#tokens;
  }

  /** 当前全部 scope，按挂载顺序 */
  scopes(): string[] {
    return [...this.#scopes.keys()];
  }

  hasScope(scope: string): boolean {
    return this.#scopes.has(scope);
  }

  /** 取某个 scope 的根组件副本（拿不到就是 undefined） */
  getScope(scope: string): ViewSpec | undefined {
    const spec = this.#scopes.get(scope);
    return spec === undefined ? undefined : cloneSpec(spec);
  }

  /** 全部版本快照（副本，外部改不动内部状态） */
  history(): DocumentSnapshot[] {
    return this.#snapshots.map((snapshot) => ({
      version: snapshot.version,
      scopes: JSON.parse(JSON.stringify(snapshot.scopes)) as Record<string, ViewSpec>,
      note: snapshot.note,
      ...(snapshot.rolledBackTo === undefined ? {} : { rolledBackTo: snapshot.rolledBackTo }),
    }));
  }

  /** 当前状态的一份快照 */
  snapshot(): DocumentSnapshot {
    return this.history()[this.#snapshots.length - 1] as DocumentSnapshot;
  }

  /**
   * 应用一次界面改造。永不抛异常：失败返回错误码且**不改变文档**（SURF-010）。
   */
  applyPatch(patch: ViewPatch): ApplyResult {
    const request: Record<string, unknown> = isRecord(patch) ? patch : {};
    const scope = request.scope;
    const op = request.op;

    if (typeof scope !== 'string' || scope.trim() === '') {
      return { ok: false, error: { code: 'BAD_SCOPE', message: 'scope 必须是非空字符串' } };
    }
    if (!isPatchOp(op)) {
      return {
        ok: false,
        error: { code: 'UNKNOWN_OP', message: `未知 patch 粒度：${String(op)}（只能是 ${PATCH_OPS.join(' / ')}）` },
      };
    }

    // mount / replace 收到的是完整 View Spec；patch 收到的是**局部字段补丁**，
    // 允许省略 type 与必填字段（它只需要是对象），最终以「合并后的结果」为准。
    const isPartial = op === 'patch';
    let fullSpec: ViewSpec | undefined;
    if (!isPartial) {
      const validated = validateViewSpec(request.spec);
      if (!validated.ok) {
        return {
          ok: false,
          error: {
            code: 'INVALID_SPEC',
            message: `View Spec 非法（${validated.error.code}）：${validated.error.message}`,
            path: validated.error.path,
          },
        };
      }
      fullSpec = validated.spec;
    } else if (!isRecord(request.spec)) {
      return {
        ok: false,
        error: { code: 'INVALID_SPEC', message: 'patch 的 spec 必须是对象（局部字段补丁）', path: '$' },
      };
    }

    const exists = this.#scopes.has(scope);
    if (op === 'mount' && exists) {
      return { ok: false, error: { code: 'SCOPE_EXISTS', message: `scope ${scope} 已存在，不能重复 mount` } };
    }
    if (op !== 'mount' && !exists) {
      return { ok: false, error: { code: 'SCOPE_NOT_FOUND', message: `scope ${scope} 不存在，无法 ${op}` } };
    }

    const next = new Map(this.#scopes);
    if (isPartial) {
      const base = next.get(scope) as ViewSpec;
      next.set(scope, deepMerge(base as Record<string, unknown>, request.spec as Record<string, unknown>) as ViewSpec);
    } else {
      next.set(scope, cloneSpec(fullSpec as ViewSpec));
    }

    // 合并后的结果必须仍然是合法 View Spec，否则整笔变更作废
    const recheck = validateViewSpec(next.get(scope));
    if (!recheck.ok) {
      return {
        ok: false,
        error: {
          code: 'INVALID_SPEC',
          message: `${op} 之后结构非法（${recheck.error.code}）：${recheck.error.message}`,
          path: recheck.error.path,
        },
      };
    }
    const version = this.#commit(next, `${op} ${scope}`);
    return { ok: true, version, scope, op };
  }

  /**
   * 回到任意历史版本。会**产生一个新的递增版本**（SURF-011）。
   */
  rollback(version: number): RollbackResult {
    if (!Number.isInteger(version)) {
      return { ok: false, error: { code: 'UNKNOWN_VERSION', message: `版本号必须是整数，收到 ${String(version)}` } };
    }
    const snapshot = this.#snapshots.find((item) => item.version === version);
    if (snapshot === undefined) {
      return { ok: false, error: { code: 'UNKNOWN_VERSION', message: `版本 v${version} 不存在` } };
    }

    const restored = new Map<string, ViewSpec>();
    for (const [scope, spec] of Object.entries(snapshot.scopes)) {
      restored.set(scope, cloneSpec(spec));
    }
    const newVersion = this.#commit(restored, `回滚到 v${version}`, version);
    return { ok: true, version: newVersion, restored: version };
  }

  /** 输出整页 HTML：全部 scope 区块 + 令牌 + 转义（SURF-012） */
  render(options: { tokens?: ThemeTokens; title?: string } = {}): string {
    const tokens = options.tokens ?? this.#tokens;
    const title = options.title ?? 'Agent Client · Surface';

    const sections = [...this.#scopes.entries()].map(([scope, spec]) => {
      const label = `<h2 class="ac-scope-name" style="margin:0 0 8px;font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:${escapeHtml(tokens.color.textMuted)}">${escapeHtml(scope)}</h2>`;
      return `<section class="ac-scope" data-scope="${escapeHtml(scope)}" style="display:flex;flex-direction:column">${label}${renderFragment(spec, tokens)}</section>`;
    });

    const body = sections.length > 0 ? sections.join('\n') : '<p class="ac-empty">（空文档）</p>';

    return [
      '<!doctype html>',
      '<html lang="zh-CN">',
      '<head>',
      '<meta charset="utf-8" />',
      '<meta name="viewport" content="width=device-width, initial-scale=1" />',
      `<title>${escapeHtml(title)}</title>`,
      '<style>',
      tokensToCss(tokens),
      '*{box-sizing:border-box}',
      `body{margin:0;background:var(--ac-bg);color:var(--ac-text);font-family:var(--ac-font-family);font-size:${tokens.fontSize.md}px;line-height:1.55}`,
      `.ac-root{max-width:880px;margin:0 auto;padding:calc(var(--ac-space) * 2);display:flex;flex-direction:column;gap:calc(var(--ac-space) * 2)}`,
      '.ac-empty{color:var(--ac-text-muted)}',
      '</style>',
      '</head>',
      `<body data-version="${this.#version}"><main class="ac-root">${body}</main></body>`,
      '</html>',
      '',
    ].join('\n');
  }

  /** 提交一个新版本；版本号只增不减 */
  #commit(nextScopes: Map<string, ViewSpec>, note: string, rolledBackTo?: number): number {
    this.#version += 1;
    this.#scopes = nextScopes;

    const scopes: Record<string, ViewSpec> = {};
    for (const [scope, spec] of nextScopes) {
      scopes[scope] = cloneSpec(spec);
    }

    const snapshot: DocumentSnapshot = { version: this.#version, scopes, note };
    if (rolledBackTo !== undefined) snapshot.rolledBackTo = rolledBackTo;
    this.#snapshots.push(snapshot);
    return this.#version;
  }
}
