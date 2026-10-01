import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TeamRunner } from '../src/orchestrator/team.ts';
import { ApprovalGate } from '../src/kernel/approval.ts';
import { EventLog } from '../src/eventlog/log.ts';

const PANEL = {
  type: 'panel',
  title: '今日预算',
  children: [
    { type: 'progress', label: 'token', value: 0.62, tone: 'warning' },
    { type: 'action', label: '提高上限', emit: 'ui.event:raise_budget' },
  ],
};

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agent-client-orch-${prefix}-`));
}

/** 一个「有人看着」的宿主：审批门放行一次 */
function permissiveRunner(prefix: string, extra: Partial<ConstructorParameters<typeof TeamRunner>[0]> = {}): TeamRunner {
  return new TeamRunner({
    dir: tempDir(prefix),
    approval: new ApprovalGate({ policy: () => 'allow_once' }),
    ...extra,
  });
}

function hostResults(runner: TeamRunner) {
  return runner.log.read().filter((event) => event.type === 'host.tool.result');
}

/** 子进程自己的事件日志：用它看「消息有没有真的进到 Agent 的上下文」 */
function received(runner: TeamRunner, agentId: string) {
  const log = new EventLog({ dir: path.join(runner.dir, 'agents', agentId) });
  return log.read().filter((event) => event.type === 'message.received');
}

function hostResultFor(runner: TeamRunner, tool: string) {
  return hostResults(runner).filter((event) => event.tool === tool);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate: () => boolean, timeoutMs = 8000, stepMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(stepMs);
  }
  throw new Error('waitUntil 超时');
}

// @spec HOST-001
test('agent.spawn 拉起独立子进程，并把 brief 投递给它', async () => {
  const runner = permissiveRunner('spawn');
  try {
    const result = await runner.runLead({
      prompt: '把预算做成进度条',
      script: [
        { toolCalls: [{ id: 'l1', name: 'agent.spawn', args: { agentId: 'teammate:ui', brief: '请写预算进度条组件' } }] },
        { text: '已派活', done: true },
      ],
    });

    assert.equal(result.reason, 'completed');
    assert.deepEqual(result.children, ['teammate:ui']);

    const spawned = hostResultFor(runner, 'agent.spawn')[0];
    assert.equal(spawned?.ok, true);
    const payload = JSON.parse(String(spawned?.result)) as { agentId: string; pid: number };
    assert.equal(payload.agentId, 'teammate:ui');

    const spawnEvents = runner.log.read().filter((event) => event.type === 'agent.spawn');
    const mate = spawnEvents.find((event) => event.agent === 'teammate:ui');
    const lead = spawnEvents.find((event) => event.agent === 'lead');
    assert.ok(mate && lead, '事件日志里要有两个进程的出生记录');
    assert.notEqual(mate?.pid, lead?.pid, '一个 Agent 一个进程：pid 必须不同');
    assert.notEqual(mate?.pid, process.pid, '子进程不是宿主自己');
    assert.equal(payload.pid, mate?.pid, '工具返回的 pid 必须是真进程的 pid');

    assert.equal(
      received(runner, 'teammate:ui').some((event) => event.kind === 'brief' && event.from === 'lead'),
      true,
      'brief 必须真的进到队友的上下文里',
    );
  } finally {
    await runner.reclaim();
  }
});

// @spec HOST-002
test('agent.spawn 过审批门：默认拒绝时不拉起任何进程', async () => {
  const runner = new TeamRunner({ dir: tempDir('approval'), approval: new ApprovalGate() });
  try {
    await runner.runLead({
      prompt: '帮我拉起一个队友',
      script: [
        { toolCalls: [{ id: 'l1', name: 'agent.spawn', args: { agentId: 'teammate:ghost', brief: 'x' } }] },
        { text: '被拒了，换条路', done: true },
      ],
    });

    assert.equal(runner.pool.get('teammate:ghost'), undefined, '审批不过就不该有进程');
    const spawned = hostResultFor(runner, 'agent.spawn')[0];
    assert.equal(spawned?.ok, false);
    assert.match(String(spawned?.error), /审批被拒绝/);
  } finally {
    await runner.reclaim();
  }
});

// @spec HOST-003
test('agent.send 先落盘再投递；目标不在世时消息留在邮箱', async () => {
  const runner = permissiveRunner('send');
  try {
    await runner.runLead({
      prompt: '给还没上线的队友留个话',
      script: [
        { toolCalls: [{ id: 'l1', name: 'agent.send', args: { to: 'teammate:later', body: '上线后看这条' } }] },
        { text: '留言完成', done: true },
      ],
    });

    const delivered = hostResultFor(runner, 'agent.send')[0];
    assert.equal(delivered?.ok, true);
    assert.match(String(delivered?.result), /"delivered":0/, '人不在，投递数应为 0');

    const pending = runner.mailbox.pending('teammate:later');
    assert.equal(pending.length, 1, '消息必须落在邮箱里等着，而不是丢了');
    assert.equal(pending[0]?.body, '上线后看这条');
  } finally {
    await runner.reclaim();
  }
});

// @spec HOST-004
test('agent.wait 等到不了回报就如实失败，并指出是谁没回', async () => {
  const runner = permissiveRunner('wait');
  try {
    await runner.runLead({
      prompt: '等一个不存在的队友',
      script: [
        { toolCalls: [{ id: 'l1', name: 'agent.wait', args: { ids: ['teammate:nobody'], timeoutMs: 300 } }] },
        { text: '等不到，收工', done: true },
      ],
    });

    const waited = hostResultFor(runner, 'agent.wait')[0];
    assert.equal(waited?.ok, false);
    assert.match(String(waited?.error), /teammate:nobody/);
  } finally {
    await runner.reclaim();
  }
});

// @spec HOST-005
test('ui.render 经表面校验落进界面文档；非法 spec 版本不变', async () => {
  const runner = permissiveRunner('render');
  try {
    await runner.runLead({
      prompt: '改界面',
      script: [
        { toolCalls: [{ id: 'l1', name: 'ui.render', args: { scope: 'surface.sidebar', op: 'mount', spec: { type: '不存在的组件' } } }] },
        { toolCalls: [{ id: 'l2', name: 'ui.render', args: { scope: 'surface.sidebar', op: 'mount', spec: PANEL } }] },
        { text: '界面更新完', done: true },
      ],
    });

    const renders = hostResultFor(runner, 'ui.render');
    assert.equal(renders.length, 2);
    assert.equal(renders[0]?.ok, false, '非法 spec 必须被拒');
    assert.equal(renders[1]?.ok, true);

    assert.equal(runner.document.version, 1, '只有合法那次让版本前进');
    assert.match(runner.document.render(), /今日预算/);
  } finally {
    await runner.reclaim();
  }
});

// @spec HOST-006
test('任务板工具保持 CAS 语义：过期 revision 认领失败且不覆盖状态', async () => {
  const runner = permissiveRunner('task');
  try {
    await runner.runLead({
      prompt: '建个任务',
      script: [
        { toolCalls: [{ id: 'l1', name: 'task.create', args: { id: 'task_19', subject: '预算进度条', writeScopes: ['client-plugins/**'] } }] },
        { toolCalls: [{ id: 'l2', name: 'task.claim', args: { id: 'task_19', expectedRevision: 99 } }] },
        { text: '抢单失败', done: true },
      ],
    });

    const created = hostResultFor(runner, 'task.create')[0];
    assert.equal(created?.ok, true);

    const claimed = hostResultFor(runner, 'task.claim')[0];
    assert.equal(claimed?.ok, false);
    assert.match(String(claimed?.error), /REVISION_CONFLICT/);

    const task = runner.board.get('task_19');
    assert.equal(task?.status, 'pending');
    assert.equal(task?.owner, null);
  } finally {
    await runner.reclaim();
  }
});

// @spec HOST-007
test('每次宿主工具调用都写事件日志，可回放审计', async () => {
  const runner = permissiveRunner('audit');
  try {
    await runner.runLead({
      prompt: '随便调几个宿主工具',
      script: [
        { toolCalls: [{ id: 'l1', name: 'task.create', args: { id: 'task_a', subject: 'A' } }] },
        { toolCalls: [{ id: 'l2', name: 'ui.render', args: { scope: 'surface.main', op: 'mount', spec: PANEL } }] },
        { text: '好了', done: true },
      ],
    });

    const calls = runner.log.read().filter((event) => event.type === 'host.tool.call');
    const results = runner.log.read().filter((event) => event.type === 'host.tool.result');
    assert.equal(calls.length, 2);
    assert.equal(results.length, 2);

    const replayed = runner.log.replay(
      (state: string[], event: { type: string; tool?: string }) => {
        if (event.type === 'host.tool.call' && typeof event.tool === 'string') state.push(event.tool);
        return state;
      },
      [] as string[],
    );
    assert.deepEqual(replayed, ['task.create', 'ui.render']);
  } finally {
    await runner.reclaim();
  }
});

const LEAD_SCRIPT = [
  { toolCalls: [{ id: 'l1', name: 'task.create', args: { id: 'task_19', subject: '预算进度条组件', writeScopes: ['client-plugins/**'] } }] },
  { toolCalls: [{ id: 'l2', name: 'agent.spawn', args: { agentId: 'teammate:ui', brief: '请领取 task_19：把预算做成进度条' } }] },
  { toolCalls: [{ id: 'l3', name: 'agent.wait', args: { ids: ['teammate:ui'], timeoutMs: 20000 } }] },
  { toolCalls: [{ id: 'l4', name: 'ui.render', args: { scope: 'surface.sidebar', op: 'mount', spec: PANEL } }] },
  { text: '界面已更新，收工', done: true },
];

const TEAMMATE_SCRIPT = [
  { toolCalls: [{ id: 't1', name: 'task.claim', args: { id: 'task_19', expectedRevision: 0 } }] },
  { toolCalls: [{ id: 't2', name: 'task.complete', args: { id: 'task_19', expectedRevision: 1 } }] },
  { text: '组件写完，已交付', done: true },
];

// @spec ORCH-001
test('Lead 通过 agent.spawn 拉起 Teammate：两者 pid 不同，日志可还原派发', async () => {
  const runner = permissiveRunner('orch1', { scripts: { 'teammate:ui': TEAMMATE_SCRIPT } });
  try {
    const result = await runner.runLead({ prompt: '给预算加个进度条', script: LEAD_SCRIPT });

    assert.equal(result.reason, 'completed');
    assert.deepEqual(result.children, ['teammate:ui']);

    const spawnEvent = runner.log.read().find((event) => event.type === 'agent.spawn' && event.agent === 'teammate:ui');
    assert.ok(spawnEvent, '事件日志里必须有这次派发');
    assert.notEqual(spawnEvent?.pid, process.pid);
  } finally {
    await runner.reclaim();
  }
});

// @spec ORCH-002
test('跨进程协作闭环：Teammate 领任务并完成，Lead 收到回报后继续', async () => {
  const runner = permissiveRunner('orch2', { scripts: { 'teammate:ui': TEAMMATE_SCRIPT } });
  try {
    const result = await runner.runLead({ prompt: '给预算加个进度条', script: LEAD_SCRIPT });

    assert.equal(result.reason, 'completed');

    const task = runner.board.get('task_19');
    assert.equal(task?.status, 'completed', '队友必须真的把任务做完了');
    assert.equal(task?.owner, 'teammate:ui');

    const waited = hostResultFor(runner, 'agent.wait')[0];
    assert.equal(waited?.ok, true, 'Lead 应当等到回报');

    const toLead = received(runner, 'lead');
    assert.equal(
      toLead.some((event) => event.from === 'teammate:ui' && event.kind === 'report'),
      true,
      '回报必须真的进到 Lead 的上下文里',
    );
  } finally {
    await runner.reclaim();
  }
});

// @spec ORCH-003
test('子 Agent 完成时由 Kernel 自动回报父 Agent，agent.wait 因此能确定性返回', async () => {
  const runner = permissiveRunner('orch3', {
    scripts: { 'teammate:quick': [{ text: '我干完了', done: true }] },
  });
  try {
    await runner.runLead({
      prompt: '派一个活',
      script: [
        { toolCalls: [{ id: 'l1', name: 'agent.spawn', args: { agentId: 'teammate:quick', brief: '随便干点' } }] },
        { toolCalls: [{ id: 'l2', name: 'agent.wait', args: { ids: ['teammate:quick'], timeoutMs: 20000 } }] },
        { text: '收到回报', done: true },
      ],
    });

    const waited = hostResultFor(runner, 'agent.wait')[0];
    assert.equal(waited?.ok, true, 'Kernel 应当替子 Agent 回报，让 wait 确定性返回');

    const report = received(runner, 'lead').find((event) => event.from === 'teammate:quick');
    assert.ok(report, 'Lead 必须收到自动回报');
    assert.match(String(report?.body), /完成/);
  } finally {
    await runner.reclaim();
  }
});

// @spec ORCH-004
test('一次完整编排：界面出新版本、任务完成、邮箱留痕、日志可回放时间线', async () => {
  const runner = permissiveRunner('orch4', { scripts: { 'teammate:ui': TEAMMATE_SCRIPT } });
  try {
    const result = await runner.runLead({ prompt: '给预算加个进度条', script: LEAD_SCRIPT });

    assert.equal(result.reason, 'completed');
    assert.equal(result.documentVersion, 1);
    assert.equal(runner.document.hasScope('surface.sidebar'), true);
    assert.match(runner.document.render(), /今日预算/);

    // 只看 Lead 的时间线：队友也在同一份日志里，这正是「合并时间线」的意义
    const timeline = runner.log.replay(
      (state: string[], event: { type: string; tool?: string; agent?: string }) => {
        if (event.type === 'host.tool.call' && event.agent === 'lead') state.push(`tool:${String(event.tool)}`);
        return state;
      },
      [] as string[],
    );
    assert.deepEqual(timeline, ['tool:task.create', 'tool:agent.spawn', 'tool:agent.wait', 'tool:ui.render']);

    // 邮箱留痕：brief 进过队友的上下文，report 回过来进过 Lead 的上下文
    assert.equal(
      received(runner, 'teammate:ui').some((event) => event.kind === 'brief' && event.from === 'lead'),
      true,
      'brief 要留痕',
    );
    assert.equal(
      received(runner, 'lead').some((event) => event.kind === 'report' && event.from === 'teammate:ui'),
      true,
      'report 要留痕',
    );

    // 邮箱是持久层：落盘文件必须存在（重启后消息还在）
    assert.equal(fs.existsSync(path.join(runner.dir, 'mailbox', 'mailbox.jsonl')), true);
  } finally {
    await runner.reclaim();
  }
});

// @spec ORCH-005
test('人类中断 Lead：终态 interrupted，且它派出去的子进程被回收', async () => {
  const runner = permissiveRunner('orch5', {
    // 这个队友永远不会自己收工，只能被回收
    scripts: { 'teammate:busy': [{ text: '一直在干活', toolCalls: [{ id: 'x', name: 'budget', args: {} }] }] },
  });
  try {
    const running = runner.runLead({
      prompt: '派活然后被中断',
      script: [
        // 队友故意开慢档：保证 Lead 一定还堵在 agent.wait 上
        { toolCalls: [{ id: 'l1', name: 'agent.spawn', args: { agentId: 'teammate:busy', brief: '慢慢干', stepDelayMs: 400 } }] },
        { toolCalls: [{ id: 'l2', name: 'agent.wait', args: { ids: ['teammate:busy'], timeoutMs: 30000 } }] },
      ],
      timeoutMs: 20000,
    });

    await waitUntil(() => runner.pool.get('teammate:busy') !== undefined);
    runner.interrupt('lead', 'human_took_over');

    const result = await running;
    assert.equal(result.reason, 'interrupted');
    assert.equal(
      runner.listAgents().filter((agent) => agent.alive).length,
      0,
      '收工后不能留下还活着的子进程',
    );

    // 更硬的一条：每个出生过的进程都必须有对应的退出记录（不留孤儿）
    const spawnedAgents = runner.log.read().filter((event) => event.type === 'agent.spawn').map((event) => String(event.agent));
    const exited = new Set(runner.log.read().filter((event) => event.type === 'agent.exit').map((event) => String(event.agent)));
    assert.equal(spawnedAgents.length >= 2, true);
    for (const agentId of spawnedAgents) {
      assert.equal(exited.has(agentId), true, `${agentId} 必须被回收`);
    }
  } finally {
    await runner.reclaim();
  }
});
