/**
 * 界面意图的入口闸门（Surface 层的收件口）。
 *
 * Agent 递过来的 View Spec 在落进界面文档之前，必须先过 schema 校验：
 * 合法 → 进文档并产生新版本；非法 → 拒绝、留痕、**界面保持可用**。
 * 这是「Agent 有表达自由，客户端保留否决权」在代码里的落点。
 */
import { ViewDocument } from './document.ts';
import type { EventAppender, LoggedEvent } from '../eventlog/log.ts';
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

export interface IngestOptions {
  /**
   * 回放模式：应用改动但**不再记事件**（启动时从日志重建界面用）。
   * 否则回放一遍就把日志又写了一遍，越滚越长。
   */
  silent?: boolean;
}

export class SurfaceIngest {
  #document: ViewDocument;
  #onReject: ((patch: ViewPatch, reason: string) => void) | undefined;
  #log: EventAppender | undefined;
  #rejected: RejectedPatch[] = [];

  constructor(options: {
    document: ViewDocument;
    onReject?: (patch: ViewPatch, reason: string) => void;
    /** 界面改动落进事件日志：这样「界面 = f(事件日志)」对界面自己也是成立的（重启能重建） */
    log?: EventAppender;
  }) {
    this.#document = options.document;
    this.#onReject = options.onReject;
    this.#log = options.log;
  }

  get document(): ViewDocument {
    return this.#document;
  }

  get rejected(): RejectedPatch[] {
    return [...this.#rejected];
  }

  ingest(patch: ViewPatch, options: IngestOptions = {}): IngestResult {
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

    // 成功的改动写成一条事实：重启时按它回放，界面就回来了。
    // 被拒绝的**不记**——它没改任何东西，记了只会让回放时重复走一遍拒绝路径。
    if (options.silent !== true) {
      this.#log?.append({
        type: 'ui.patch',
        version: applied.version,
        op: patch.op,
        scope: applied.scope,
        spec: patch.spec ?? null,
      });
    }
    return { ok: true, version: applied.version, scope: applied.scope };
  }

  /**
   * 从事件日志回放界面（SPEC-025）。
   *
   * `界面 = f(事件日志)` 这条不变量对界面自己也成立：把 `ui.patch` 与 `surface.rollback`
   * 按序重放，就能把文档恢复到重启前的样子。
   */
  replay(events: LoggedEvent[]): { applied: number; rolledBack: number } {
    let applied = 0;
    let rolledBack = 0;
    for (const event of events) {
      if (event.type === 'ui.patch') {
        const patch: ViewPatch = {
          scope: String(event.scope ?? ''),
          op: String(event.op ?? 'upsert') as ViewPatch['op'],
          spec: event.spec,
        };
        if (patch.scope === '') continue;
        if (this.ingest(patch, { silent: true }).ok) applied += 1;
        continue;
      }
      if (event.type === 'surface.rollback') {
        // 事件里记的是 `rolledBackTo`（回到哪一版）；`from` 是回滚产生的那一新版号。
        // 回放时照样执行一次 rollback：它会产生与当时**同样的**版本号，序列完全对齐。
        const target = Number(event.rolledBackTo ?? event.to);
        if (Number.isInteger(target) && this.#document.rollback(target).ok) rolledBack += 1;
      }
    }
    return { applied, rolledBack };
  }

  #reject(patch: ViewPatch, reason: string, code: string): void {
    this.#rejected.push({ patch, reason, code, ts: new Date().toISOString() });
    this.#onReject?.(patch, reason);
  }
}
