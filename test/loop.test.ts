import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EventLog } from '../src/eventlog/log.ts';
import { AgentLoop, assembleContext, defineHostTool, defineTool } from '../src/loop/loop.ts';
import type { HostToolReply } from '../src/loop/loop.ts';
import type { ContextItem, ModelInput, ModelOutput } from '../src/loop/loop.ts';
import type { Frame } from '../src/protocol/frames.ts';
import { scriptedModel } from '../src/loop/fake-model.ts';

function tempLog(): EventLog {
  return new EventLog({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'agent-client-loop-')) });
}

interface FakeInboxState {
  pending: Array<{ id: string; from: string; body: string; kind?: string }>;
  drained: string[];
}

function fakeInbox(state: FakeInboxState) {
  return {
    drainAt(_agentId: string, boundary: 'step_boundary') {
      assert.equal(boundary, 'step_boundary');
      const taken = state.pending.splice(0, state.pending.length);
      state.drained.push(...taken.map((m) => m.id));
      return taken;
    },
  };
}

function collector() {
  const frames: Frame[] = [];
  return { frames, sink: { onFrame: (f: Frame) => frames.push(f) } };
}

function namesOfStepFrames(frames: Frame[], turn: number): string[] {
  return frames
    .filter((f) => f.t === 'loop.step' && f.step !== undefined)
    .slice(( turn - 1) * 5, turn * 5)
    .map((f) => String(f.name));
}

// @spec LOOP-001
test('每轮迭代按 assemble → infer → dispatch → emit → checkpoint 发 5 个 loop.step 帧', async () => {
  const model = scriptedModel([
    { text: '先看看情况', toolCalls: [{ id: 'c1', name: 'echo', args: { v: 1 } }], uiPatches: [{ scope: 'surface.sidebar', op: 'replace', spec: { type: 'panel', children: [] } }] },
    { text: '做完了', done: true },
  ]);
  const { frames, sink } = collector();
  const loop = new AgentLoop({
    agentId: 'lead',
    model,
    tools: [defineTool('echo', async (args) => JSON.stringify(args))],
    log: tempLog(),
    sink,
  });

  const result = await loop.run({ seed: '开始' });
  assert.equal(result.reason, 'completed');
  assert.deepEqual(namesOfStepFrames(frames, 1), ['assemble', 'infer', 'dispatch', 'emit', 'checkpoint']);
  assert.deepEqual(namesOfStepFrames(frames, 2), ['assemble', 'infer', 'dispatch', 'emit', 'checkpoint']);
});

// @spec LOOP-002
test('模型端口可插拔：脚本化假模型驱动全流程，结果确定可复现', async () => {
  const runOnce = async () => {
    const { frames, sink } = collector();
    const loop = new AgentLoop({
      agentId: 'lead',
      model: scriptedModel([{ text: '完成', done: true }]),
      log: tempLog(),
      sink,
    });
    return (await loop.run({ seed: '同一句话' })).reason + '|' + frames.map((f) => f.t).join(',');
  };
  assert.equal(await runOnce(), await runOnce());
});

// @spec LOOP-003
test('边界投递：运行中送来的消息只在下一个 step boundary 被消费', async () => {
  const inboxState: FakeInboxState = { pending: [], drained: [] };
  const contexts: ContextItem[][] = [];
  let injected = false;

  const model = {
    async step(input: ModelInput): Promise<ModelOutput> {
      contexts.push(input.context);
      if (!injected) {
        injected = true;
        inboxState.pending.push({ id: 'msg_1', from: 'human', body: '把预算显示成进度条' });
        return { text: '第一轮', toolCalls: [{ id: 'c1', name: 'echo', args: {} }] };
      }
      return { text: '第二轮', done: true };
    },
  };

  const { sink } = collector();
  const loop = new AgentLoop({
    agentId: 'lead',
    model,
    tools: [defineTool('echo', async () => 'ok')],
    log: tempLog(),
    sink,
    inbox: fakeInbox(inboxState),
  });

  await loop.run({ seed: '你好' });

  assert.equal(contexts.length, 2);
  const turn1Texts = contexts[0]?.map((c) => c.text) ?? [];
  assert.equal(turn1Texts.includes('把预算显示成进度条'), false, '第一轮不该看到运行中送来的消息');
  const turn2Texts = contexts[1]?.map((c) => c.text) ?? [];
  assert.equal(turn2Texts.includes('把预算显示成进度条'), true, '第二轮（下一个 boundary）才消费');
  assert.deepEqual(inboxState.drained, ['msg_1']);
});

// @spec LOOP-004
test('工具调用成对发帧；未知工具与抛异常的工具都只得到 ok:false', async () => {
  const { frames, sink } = collector();
  const loop = new AgentLoop({
    agentId: 'lead',
    model: scriptedModel([
      {
        toolCalls: [
          { id: 'c1', name: 'boom', args: {} },
          { id: 'c2', name: '不存在的工具', args: {} },
        ],
      },
      { done: true },
    ]),
    tools: [
      defineTool('boom', async () => {
        throw new Error('工具炸了');
      }),
    ],
    log: tempLog(),
    sink,
  });

  const result = await loop.run({ seed: '跑工具' });
  assert.equal(result.reason, 'completed');

  const calls = frames.filter((f) => f.t === 'tool.call').map((f) => f.id);
  const results = frames.filter((f) => f.t === 'tool.result');
  assert.deepEqual(calls, ['c1', 'c2']);
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((f) => f.ok), [false, false]);
  assert.match(String(results[1]?.error), /UNKNOWN_TOOL/);
  assert.match(String(results[0]?.error), /工具炸了/);
});

// @spec LOOP-005
test('ui.patch 必须过 UiGuard；被拒绝的 patch 不外发但记账', async () => {
  const log = tempLog();
  const { frames, sink } = collector();
  const rejected: string[] = [];
  const loop = new AgentLoop({
    agentId: 'lead',
    model: scriptedModel([
      {
        uiPatches: [
          { scope: 'surface.sidebar', op: 'replace', spec: { type: 'panel', children: [] } },
          { scope: 'surface.evil', op: 'mount', spec: { type: '未知组件' } },
        ],
      },
      { done: true },
    ]),
    log,
    sink,
    guard: {
      check: (patch) => {
        if (patch.scope === 'surface.evil') {
          rejected.push(patch.scope);
          return { ok: false, reason: '未知组件类型' };
        }
        return { ok: true };
      },
    },
  });

  await loop.run({ seed: '改界面' });
  const patches = frames.filter((f) => f.t === 'ui.patch').map((f) => f.scope);
  assert.deepEqual(patches, ['surface.sidebar']);
  assert.deepEqual(rejected, ['surface.evil']);

  const logged = log.read().filter((e) => e.type === 'ui.patch');
  assert.equal(logged.length, 2, '被拒绝的 patch 也要留痕');
  assert.equal(logged.filter((e) => e.rejected === true).length, 1);
});

// @spec LOOP-006
test('预算三维任一触顶即终止，终态 budget_exhausted', async () => {
  const alwaysWork = scriptedModel([
    { text: '再来一轮', toolCalls: [{ id: 'c', name: 'echo', args: {} }], usage: { tokens: 120 } },
  ]);

  const byTurns = new AgentLoop({
    agentId: 'lead',
    model: alwaysWork,
    tools: [defineTool('echo', async () => 'ok')],
    log: tempLog(),
    sink: collector().sink,
    budget: { maxTurns: 3 },
  });
  const turnsResult = await byTurns.run({ seed: 'x' });
  assert.equal(turnsResult.reason, 'budget_exhausted');
  assert.equal(turnsResult.turns, 3);

  const byTools = new AgentLoop({
    agentId: 'lead',
    model: alwaysWork,
    tools: [defineTool('echo', async () => 'ok')],
    log: tempLog(),
    sink: collector().sink,
    budget: { maxTurns: 99, maxToolCalls: 2 },
  });
  assert.equal((await byTools.run({ seed: 'x' })).reason, 'budget_exhausted');

  const byTokens = new AgentLoop({
    agentId: 'lead',
    model: alwaysWork,
    tools: [defineTool('echo', async () => 'ok')],
    log: tempLog(),
    sink: collector().sink,
    budget: { maxTurns: 99, maxTokens: 250 },
  });
  assert.equal((await byTokens.run({ seed: 'x' })).reason, 'budget_exhausted');
});

// @spec LOOP-007
test('interrupt 后在最近的 step boundary 停止，已完成的 step 事件完整', async () => {
  const { frames, sink } = collector();
  const log = tempLog();
  let loopRef: AgentLoop | undefined;

  const model = {
    async step(): Promise<ModelOutput> {
      loopRef?.interrupt('human_took_over');
      return { text: '这一轮跑完再说', toolCalls: [{ id: 'c', name: 'echo', args: {} }] };
    },
  };

  const loop = new AgentLoop({
    agentId: 'lead',
    model,
    tools: [defineTool('echo', async () => 'ok')],
    log,
    sink,
  });
  loopRef = loop;

  const result = await loop.run({ seed: '开始' });
  assert.equal(result.reason, 'interrupted');
  assert.deepEqual(namesOfStepFrames(frames, 1), ['assemble', 'infer', 'dispatch', 'emit', 'checkpoint']);
  const done = frames.find((f) => f.t === 'loop.done');
  assert.equal(done?.reason, 'interrupted');
});

// @spec LOOP-008
test('模型声明完成 → 终态 completed 并写检查点事件', async () => {
  const log = tempLog();
  const loop = new AgentLoop({
    agentId: 'lead',
    model: scriptedModel([{ text: '搞定', done: true }]),
    log,
    sink: collector().sink,
  });

  const result = await loop.run({ seed: '收尾' });
  assert.equal(result.reason, 'completed');
  const checkpoint = log.read().find((e) => e.type === 'loop.checkpoint');
  assert.ok(checkpoint, '必须写检查点事件');
  assert.equal(typeof checkpoint?.seq, 'number');
});

// @spec LOOP-009
test('每个 step 都写日志，可用 replay 重建每轮五步序列', async () => {
  const log = tempLog();
  const loop = new AgentLoop({
    agentId: 'lead',
    model: scriptedModel([{ text: 'a', toolCalls: [{ id: 'c', name: 'echo', args: {} }] }, { done: true }]),
    tools: [defineTool('echo', async () => 'ok')],
    log,
    sink: collector().sink,
  });
  await loop.run({ seed: '跑' });

  const turns = log.replay(
    (state: Record<number, string[]>, event: { type: string; turn?: number; name?: string }) => {
      if (event.type !== 'loop.step') return state;
      const turn = event.turn ?? 0;
      state[turn] = [...(state[turn] ?? []), event.name as string];
      return state;
    },
    {},
  );

  assert.deepEqual(turns[1], ['assemble', 'infer', 'dispatch', 'emit', 'checkpoint']);
  assert.deepEqual(turns[2], ['assemble', 'infer', 'dispatch', 'emit', 'checkpoint']);
});

function fakeBridge(responder: (callId: string) => HostToolReply | Promise<HostToolReply>) {
  const asked: string[] = [];
  return {
    asked,
    async awaitToolReply(callId: string): Promise<HostToolReply> {
      asked.push(callId);
      return responder(callId);
    },
  };
}

// @spec LOOP-011
test('工具分流：宿主工具请宿主代办，进程内工具自己跑，同一轮可混用', async () => {
  const bridge = fakeBridge(() => ({ ok: true, result: '{"pid":4021}' }));
  const { frames, sink } = collector();
  const loop = new AgentLoop({
    agentId: 'lead',
    model: scriptedModel([
      {
        toolCalls: [
          { id: 'c1', name: 'echo', args: { v: 1 } },
          { id: 'c2', name: 'agent.spawn', args: { agentId: 'teammate:ui' } },
        ],
      },
      { done: true },
    ]),
    tools: [defineTool('echo', async (args) => `本地跑了 ${JSON.stringify(args)}`), defineHostTool('agent.spawn', '请 Kernel 拉起一个队友进程')],
    log: tempLog(),
    sink,
    hostBridge: bridge,
  });

  const result = await loop.run({ seed: '派活' });
  assert.equal(result.reason, 'completed');
  assert.deepEqual(bridge.asked, ['c2'], '只有宿主工具才去麻烦宿主');

  const results = frames.filter((f) => f.t === 'tool.result');
  assert.equal(results.length, 2);
  assert.match(String(results[0]?.result), /本地跑了/);
  assert.equal(results[1]?.result, '{"pid":4021}');
});

// @spec LOOP-012
test('宿主回填：tool.result 成对发出、原样透传，并写入事件日志', async () => {
  const log = tempLog();
  const bridge = fakeBridge(() => ({ ok: false, error: '审批被拒绝：install_dependency' }));
  const { frames, sink } = collector();
  const loop = new AgentLoop({
    agentId: 'lead',
    model: scriptedModel([{ toolCalls: [{ id: 'c9', name: 'fs.write', args: {} }] }, { done: true }]),
    tools: [defineHostTool('fs.write')],
    log,
    sink,
    hostBridge: bridge,
  });

  await loop.run({ seed: '写文件' });
  const toolResults = frames.filter((f) => f.t === 'tool.result');
  assert.equal(toolResults.length, 1);
  assert.equal(toolResults[0]?.id, 'c9');
  assert.equal(toolResults[0]?.ok, false);
  assert.equal(toolResults[0]?.error, '审批被拒绝：install_dependency');

  const logged = log.read().filter((e) => e.type === 'tool.result');
  assert.equal(logged.length, 1);
  assert.equal(logged[0]?.ok, false);
});

// @spec LOOP-013
test('宿主工具失败不致命：超时/中断/回填失败都只变成 ok:false，Loop 继续', async () => {
  const bridge = {
    async awaitToolReply(callId: string): Promise<HostToolReply> {
      if (callId === 'c1') throw new Error('HOST_TOOL_TIMEOUT: 宿主 30000ms 未回填');
      return { ok: false, error: '宿主回填失败' };
    },
  };
  const { frames, sink } = collector();
  const loop = new AgentLoop({
    agentId: 'lead',
    model: scriptedModel([
      { toolCalls: [{ id: 'c1', name: 'agent.spawn', args: {} }, { id: 'c2', name: 'agent.wait', args: {} }] },
      { text: '换条路走', done: true },
    ]),
    tools: [defineHostTool('agent.spawn'), defineHostTool('agent.wait')],
    log: tempLog(),
    sink,
    hostBridge: bridge,
  });

  const result = await loop.run({ seed: 'x' });
  assert.equal(result.reason, 'completed', '一次宿主工具失败不该打死 Loop');
  const results = frames.filter((f) => f.t === 'tool.result');
  assert.deepEqual(results.map((f) => f.ok), [false, false]);
  assert.match(String(results[0]?.error), /HOST_TOOL_TIMEOUT/);
});

// @spec LOOP-014
test('没有宿主桥时调用宿主工具 → NO_HOST_BRIDGE，Loop 不崩', async () => {
  const { frames, sink } = collector();
  const loop = new AgentLoop({
    agentId: 'lead',
    model: scriptedModel([{ toolCalls: [{ id: 'c1', name: 'agent.spawn', args: {} }] }, { done: true }]),
    tools: [defineHostTool('agent.spawn')],
    log: tempLog(),
    sink,
  });

  const result = await loop.run({ seed: 'x' });
  assert.equal(result.reason, 'completed');
  const failure = frames.find((f) => f.t === 'tool.result');
  assert.equal(failure?.ok, false);
  assert.match(String(failure?.error), /NO_HOST_BRIDGE/);
});

// @spec LOOP-010
test('上下文按预算裁剪：保留系统提示与最近条目', () => {
  const items: ContextItem[] = [{ role: 'system', text: '你是 Lead' }];
  for (let i = 1; i <= 10; i += 1) items.push({ role: 'human', text: `消息 ${i}` });

  const trimmed = assembleContext(items, { maxItems: 4 });
  assert.equal(trimmed.length, 4);
  assert.equal(trimmed[0]?.role, 'system');
  assert.deepEqual(
    trimmed.slice(1).map((c) => c.text),
    ['消息 8', '消息 9', '消息 10'],
  );

  const untouched = assembleContext(items.slice(0, 3), { maxItems: 4 });
  assert.deepEqual(untouched, items.slice(0, 3));
});
