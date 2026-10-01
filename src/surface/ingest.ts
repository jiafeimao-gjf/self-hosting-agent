/**
 * 界面意图的入口闸门（Surface 层的收件口）。
 *
 * Agent 递过来的 View Spec 在落进界面文档之前，必须先过 schema 校验：
 * 合法 → 进文档并产生新版本；非法 → 拒绝、留痕、**界面保持可用**。
 * 这是「Agent 有表达自由，客户端保留否决权」在代码里的落点。
 */
import { ViewDocument } from './document.ts';
import type { ViewPatch } from './document.ts';
import { validateViewSpec } from './viewspec.ts';

export interface RejectedPatch {
  patch: ViewPatch;
  reason: string;
  code: string;
  ts: string;
}

export type IngestResult =
  | { ok: true; version: number; scope: string }
  | { ok: false; reason: string; code: string };

export class SurfaceIngest {
  #document: ViewDocument;
  #onReject: ((patch: ViewPatch, reason: string) => void) | undefined;
  #rejected: RejectedPatch[] = [];

  constructor(options: { document: ViewDocument; onReject?: (patch: ViewPatch, reason: string) => void }) {
    this.#document = options.document;
    this.#onReject = options.onReject;
  }

  get document(): ViewDocument {
    return this.#document;
  }

  get rejected(): RejectedPatch[] {
    return [...this.#rejected];
  }

  ingest(patch: ViewPatch): IngestResult {
    // op='patch' 是**局部字段补丁**（允许省略 type 与必填字段），因此不能在入口按整份
    // View Spec 校验——否则 patch 粒度会被入口闸门废掉。它交给 ViewDocument 深合并后再复检，
    // 「提交进文档的 spec 永远合法」这条保证由 applyPatch 的合并后复检兜住。
    const isPartial = patch.op === 'patch';

    let spec: unknown = patch.spec;
    if (!isPartial) {
      const validation = validateViewSpec(patch.spec);
      if (!validation.ok) {
        const reason = validation.error.message;
        this.#reject(patch, reason, validation.error.code);
        return { ok: false, reason, code: validation.error.code };
      }
      spec = validation.spec;
    }

    const applied = this.#document.applyPatch({ scope: patch.scope, op: patch.op, spec });
    if (!applied.ok) {
      const reason = applied.error.message;
      this.#reject(patch, reason, applied.error.code);
      return { ok: false, reason, code: applied.error.code };
    }

    return { ok: true, version: applied.version, scope: applied.scope };
  }

  #reject(patch: ViewPatch, reason: string, code: string): void {
    this.#rejected.push({ patch, reason, code, ts: new Date().toISOString() });
    this.#onReject?.(patch, reason);
  }
}
