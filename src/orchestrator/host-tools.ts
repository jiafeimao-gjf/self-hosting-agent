/**
 * SPEC-010 §2 宿主工具 —— Agent 干不了、只能请 Kernel 代办的那些事。
 *
 * 这些工具跑在**宿主进程**里：拉起进程、落盘邮箱、写界面文档、动任务板。
 * Loop 侧只看到 tool.call / tool.reply 一来一回。
 */
import type { EventAppender } from '../eventlog/log.ts';
import type { AgentPool } from '../kernel/pool.ts';
import type { ApprovalGate } from '../kernel/approval.ts';
import type { Mailbox } from '../mailbox/mailbox.ts';
import type { TaskBoard } from '../taskboard/board.ts';
import type { ViewDocument } from '../surface/document.ts';
import type { SurfaceIngest } from '../surface/ingest.ts';
import type { BrowserHost } from '../browser/document.ts';
import type { ClientSource } from './client-source.ts';

/** 宿主工具清单：宿主与子进程两边都按这份名字对齐 */
export const HOST_TOOL_NAMES = [
  'agent.spawn',
  'agent.send',
  'agent.wait',
  'ui.render',
  'browser.render',
  'task.create',
  'task.claim',
  'task.complete',
  'client.list',
  'client.read',
  'client.write',
  'client.revert',
] as const;

/** SPEC-013：客户端源码被改动时广播给外界（浏览器据此热更新/提示刷新） */
export interface ClientChangedPayload {
  kind: 'write' | 'revert';
  path: string;
  reason: string;
  version: number;
  selfTest: 'passed' | 'skipped';
  diff?: { added: number; removed: number };
  restoredFrom?: number;
}

export interface HostRuntime {
  log: EventAppender;
  approval: ApprovalGate;
  pool: AgentPool;
  board: TaskBoard;
  mailbox: Mailbox;
  ingest: SurfaceIngest;
  /** SPEC-019 内置浏览器：Agent 直接给一份 HTML 时用它 */
  browser: BrowserHost;
  document: ViewDocument;
  spawnAgent(
    agentId: string,
    options: { parent: string; script?: unknown[]; stepDelayMs?: number },
  ): { agentId: string; pid: number | undefined };
  deliver(agentId: string): number;
  waitForReport(caller: string, ids: string[], timeoutMs: number): Promise<{ ok: boolean; missing: string[] }>;
  /** P3：客户端源码管理器；没接上时 client.* 工具明确报错，而不是假装成功 */
  clientSource?: ClientSource;
  onClientChanged?: (payload: ClientChangedPayload) => void;
  /** 浏览器文档更新：宿主据此推给客户端（SPEC-019） */
  onBrowserChanged?: (doc: { version: number; title: string; html: string; allowNetwork: boolean }) => void;
}

export interface HostToolResult {
  ok: boolean;
  result?: string;
  error?: string;
}

export interface HostTool {
  name: string;
  description: string;
  run(args: Record<string, unknown>, runtime: HostRuntime, caller: string): Promise<HostToolResult>;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function fail(error: string): HostToolResult {
  return { ok: false, error };
}

function done(payload: unknown): HostToolResult {
  return { ok: true, result: JSON.stringify(payload) };
}

export function createHostTools(): HostTool[] {
  return [
    {
      name: 'agent.spawn',
      description: '拉起一个新的 Agent 子进程（需要审批），并把 brief 投递给它',
      async run(args, runtime, caller) {
        const agentId = asString(args.agentId);
        if (agentId === '') return fail('INVALID_ARGS: agent.spawn 需要 agentId');
        const brief = asString(args.brief, '（没有 brief）');

        // 「拉起进程」是 Kernel 的动作，必须过审批门；审批门默认拒绝
        const decision = await runtime.approval.request({
          id: `appr_${agentId}_${Date.now()}`,
          action: 'agent.spawn',
          risk: 'medium',
          agentId: caller,
          detail: agentId,
        });
        if (decision === 'deny') return fail('审批被拒绝：agent.spawn');

        let spawned: { agentId: string; pid: number | undefined };
        try {
          spawned = runtime.spawnAgent(agentId, {
            parent: caller,
            ...(Array.isArray(args.script) ? { script: args.script } : {}),
            ...(typeof args.stepDelayMs === 'number' ? { stepDelayMs: args.stepDelayMs } : {}),
          });
        } catch (err) {
          return fail(`SPAWN_FAILED: ${err instanceof Error ? err.message : String(err)}`);
        }

        runtime.mailbox.send({ from: caller, to: agentId, kind: 'brief', body: brief });
        runtime.deliver(agentId);
        return done({ agentId: spawned.agentId, pid: spawned.pid });
      },
    },
    {
      name: 'agent.send',
      description: '经邮箱落盘后把消息投递给另一个 Agent',
      async run(args, runtime, caller) {
        const to = asString(args.to);
        const body = asString(args.body);
        if (to === '' || body === '') return fail('INVALID_ARGS: agent.send 需要 to 与 body');

        const sent = runtime.mailbox.send({
          from: caller,
          to,
          kind: asString(args.kind, 'note'),
          body,
          ...(typeof args.taskId === 'string' ? { taskId: args.taskId } : {}),
          ...(Array.isArray(args.artifacts) ? { artifacts: asStringArray(args.artifacts) } : {}),
        });
        if (!sent.ok) return fail(`MAILBOX_ERROR: ${sent.error.code} ${sent.error.message}`);

        const delivered = runtime.deliver(to);
        return done({ to, messageId: sent.value.message.id, delivered, duplicate: sent.value.duplicate });
      },
    },
    {
      name: 'agent.wait',
      description: '等到列出的 Agent 都回报（或超时 / 进程已死）',
      async run(args, runtime, caller) {
        const ids = asStringArray(args.ids);
        if (ids.length === 0) return fail('INVALID_ARGS: agent.wait 需要 ids');
        const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : 30_000;

        const outcome = await runtime.waitForReport(caller, ids, timeoutMs);
        if (!outcome.ok) return fail(`AGENT_WAIT_FAILED: 未回报的 Agent: ${outcome.missing.join(', ')}`);
        return done({ reported: ids });
      },
    },
    {
      name: 'ui.render',
      description: '把一份 View Spec 经校验后落进界面文档，返回版本号',
      async run(args, runtime, caller) {
        const scope = asString(args.scope);
        // 默认 upsert：Agent 通常不知道这个 scope 是否已经存在，别让它为此失败一轮
        const op = asString(args.op, 'upsert');
        if (scope === '') return fail('INVALID_ARGS: ui.render 需要 scope');

        const result = runtime.ingest.ingest({ scope, op, spec: args.spec });
        if (!result.ok) return fail(`${result.code}: ${result.reason}`);
        return done({ version: result.version, scope: result.scope });
      },
    },
    {
      name: 'browser.render',
      description: '把一个完整的 HTML 文档渲染进内置浏览器面板（独立于界面文档），返回版本号',
      async run(args, runtime) {
        const html = asString(args.html);
        if (html === '') return fail('INVALID_ARGS: browser.render 需要 html');

        const result = runtime.browser.render({
          html,
          ...(typeof args.title === 'string' ? { title: args.title } : {}),
          ...(args.allowNetwork === true ? { allowNetwork: true } : {}),
        });
        if (!result.ok) return fail(`${result.code}: ${result.reason}`);

        const doc = runtime.browser.current();
        if (doc !== undefined) {
          runtime.onBrowserChanged?.({
            version: doc.version,
            title: doc.title,
            html: doc.html,
            allowNetwork: doc.allowNetwork,
          });
        }
        return done({ version: result.version, title: result.title });
      },
    },
    {
      name: 'task.create',
      description: '在任务板上建一个任务',
      async run(args, runtime) {
        const subject = asString(args.subject);
        if (subject === '') return fail('INVALID_ARGS: task.create 需要 subject');

        const created = runtime.board.create({
          ...(typeof args.id === 'string' ? { id: args.id } : {}),
          subject,
          ...(typeof args.description === 'string' ? { description: args.description } : {}),
          ...(Array.isArray(args.writeScopes) ? { writeScopes: asStringArray(args.writeScopes) } : {}),
          ...(Array.isArray(args.blockedBy) ? { blockedBy: asStringArray(args.blockedBy) } : {}),
        });
        if (!created.ok) return fail(`TASK_ERROR: ${created.error.code} ${created.error.message}`);
        const task = created.value;
        return done({ id: task.id, status: task.status, revision: task.revision, writeScopes: task.writeScopes });
      },
    },
    {
      name: 'task.claim',
      description: 'CAS 认领任务（过期 revision 会被拒绝）',
      async run(args, runtime, caller) {
        const id = asString(args.id);
        if (id === '') return fail('INVALID_ARGS: task.claim 需要 id');

        const task = runtime.board.get(id);
        if (task === undefined) return fail(`TASK_NOT_FOUND: ${id}`);
        const expected = typeof args.expectedRevision === 'number' ? args.expectedRevision : task.revision;

        const claimed = runtime.board.claim(id, caller, expected);
        if (!claimed.ok) return fail(`TASK_ERROR: ${claimed.error.code} ${claimed.error.message}`);
        return done({
          id,
          owner: claimed.value.owner,
          status: claimed.value.status,
          revision: claimed.value.revision,
        });
      },
    },
    {
      name: 'task.complete',
      description: 'CAS 完成任务（过期 revision 会被拒绝）',
      async run(args, runtime, caller) {
        const id = asString(args.id);
        if (id === '') return fail('INVALID_ARGS: task.complete 需要 id');

        const task = runtime.board.get(id);
        if (task === undefined) return fail(`TASK_NOT_FOUND: ${id}`);
        const expected = typeof args.expectedRevision === 'number' ? args.expectedRevision : task.revision;

        const completed = runtime.board.complete(id, caller, expected);
        if (!completed.ok) return fail(`TASK_ERROR: ${completed.error.code} ${completed.error.message}`);
        return done({ id, status: completed.value.status, revision: completed.value.revision });
      },
    },
    {
      name: 'client.list',
      description: '列出客户端自身可改的源码文件（路径、字节数、已有版本数）',
      async run(_args, runtime) {
        const source = runtime.clientSource;
        if (source === undefined) return fail('CLIENT_SOURCE_DISABLED: 当前宿主没有接上客户端源码管理器');
        const listed = source.list();
        if (!listed.ok) return fail(`${listed.error.code}: ${listed.error.message}`);
        return done({ files: listed.value });
      },
    },
    {
      name: 'client.read',
      description: '读客户端自身的一个源码文件（限 src/client/**）。参数：path',
      async run(args, runtime) {
        const source = runtime.clientSource;
        if (source === undefined) return fail('CLIENT_SOURCE_DISABLED: 当前宿主没有接上客户端源码管理器');
        const read = source.read(asString(args.path));
        if (!read.ok) return fail(`${read.error.code}: ${read.error.message}`);
        return done(read.value);
      },
    },
    {
      name: 'client.write',
      description:
        '改客户端自己的源码（限 src/client/**，需要人类审批；写完会跑项目自检，不通过自动回滚）。' +
        '参数：path(如 style.css)、content、reason(为什么改)、append?(true 表示追加到文件末尾)',
      async run(args, runtime, caller) {
        const source = runtime.clientSource;
        if (source === undefined) return fail('CLIENT_SOURCE_DISABLED: 当前宿主没有接上客户端源码管理器');

        const relPath = asString(args.path);
        if (relPath === '') return fail('INVALID_ARGS: client.write 需要 path');
        if (typeof args.content !== 'string') return fail('INVALID_ARGS: client.write 需要 content（字符串）');

        // 改自己的代码属于最高风险动作：必须过审批门（默认拒绝）
        const decision = await runtime.approval.request({
          id: `appr_${relPath}_${Date.now()}`,
          action: 'client.write',
          risk: 'high',
          agentId: caller,
          detail: relPath,
        });
        if (decision === 'deny') return fail('审批被拒绝：client.write');

        const written = await source.write(relPath, args.content, {
          reason: asString(args.reason),
          author: caller,
          append: args.append === true,
        });
        if (!written.ok) return fail(`${written.error.code}: ${written.error.message}`);

        if (!written.value.unchanged) {
          const diff = source.diff(relPath);
          runtime.onClientChanged?.({
            kind: 'write',
            path: relPath,
            reason: asString(args.reason),
            version: written.value.version,
            selfTest: 'passed',
            ...(diff.ok ? { diff: { added: diff.value.added, removed: diff.value.removed } } : {}),
          });
        }

        return done({
          path: relPath,
          version: written.value.version,
          bytes: written.value.bytes,
          created: written.value.created,
          unchanged: written.value.unchanged,
          selfTest: written.value.selfTest.checks.map((check) => `${check.name}: ${check.ok ? 'ok' : 'failed'}`),
        });
      },
    },
    {
      name: 'client.revert',
      description: '把客户端源码回滚到上一版或指定版本。参数：path, version?',
      async run(args, runtime) {
        const source = runtime.clientSource;
        if (source === undefined) return fail('CLIENT_SOURCE_DISABLED: 当前宿主没有接上客户端源码管理器');

        const relPath = asString(args.path);
        if (relPath === '') return fail('INVALID_ARGS: client.revert 需要 path');

        const reverted = source.revert(relPath, typeof args.version === 'number' ? args.version : undefined);
        if (!reverted.ok) return fail(`${reverted.error.code}: ${reverted.error.message}`);

        runtime.onClientChanged?.({
          kind: 'revert',
          path: relPath,
          reason: `回滚到 v${reverted.value.restoredFrom}`,
          version: reverted.value.version,
          selfTest: 'skipped',
          restoredFrom: reverted.value.restoredFrom,
        });

        return done(reverted.value);
      },
    },
  ];
}
