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
    const validation = validateViewSpec(patch.spec);

    if (!validation.ok) {
      const reason = validation.error.message;
      this.#reject(patch, reason, validation.error.code);
      return { ok: false, reason, code: validation.error.code };
    }

    const applied = this.#document.applyPatch({ scope: patch.scope, op: patch.op, spec: validation.spec });
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
