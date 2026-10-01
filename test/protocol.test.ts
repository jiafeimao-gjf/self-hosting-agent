import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FRAME_SPECS,
  decodeFrame,
  directionOf,
  encodeFrame,
  frameJsonSchema,
  isInbound,
  validateFrame,
} from '../src/protocol/frames.ts';
import { FrameChannel } from '../src/protocol/channel.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(here, '..', 'specs', 'schemas', 'frame.schema.json');

function waitFor<T>(emitter: { on: (e: string, cb: (...a: never[]) => void) => unknown }, event: string, timeoutMs = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for "${event}"`)), timeoutMs);
    (emitter as { on: (e: string, cb: (v: T) => void) => unknown }).on(event, (value: T) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

// @spec PROTO-001
test('encodeFrame 输出单行 JSON，以换行结尾，不产生裸换行', () => {
  const line = encodeFrame({ t: 'agent.thinking', agent: 'lead', seq: 1, text: '第一行\n第二行' });
  assert.equal(line.endsWith('\n'), true);
  assert.equal(line.split('\n').length, 2, '整行内只能有一个换行（结尾那个）');
  const parsed = JSON.parse(line.trimEnd()) as Record<string, unknown>;
  assert.equal(parsed.text, '第一行\n第二行');
});

// @spec PROTO-002
test('decodeFrame 对非法输入返回错误而不是抛异常', () => {
  const bad = decodeFrame('这不是 JSON');
  assert.equal(bad.ok, false);
  assert.equal(bad.ok === false && bad.error.code, 'BAD_JSON');

  const arr = decodeFrame('[1,2,3]');
  assert.equal(arr.ok, false);
  assert.equal(arr.ok === false && arr.error.code, 'NOT_OBJECT');

  const nul = decodeFrame('null');
  assert.equal(nul.ok, false);
  assert.equal(nul.ok === false && nul.error.code, 'NOT_OBJECT');
});

// @spec PROTO-003
test('未知帧类型与缺必填字段分别报 UNKNOWN_TYPE / MISSING_FIELD', () => {
  const unknown = decodeFrame(JSON.stringify({ t: 'nope.nope' }));
  assert.equal(unknown.ok, false);
  assert.equal(unknown.ok === false && unknown.error.code, 'UNKNOWN_TYPE');

  const missing = decodeFrame(JSON.stringify({ t: 'human.message' }));
  assert.equal(missing.ok, false);
  assert.equal(missing.ok === false && missing.error.code, 'MISSING_FIELD');
  assert.equal(missing.ok === false && missing.error.field, 'text');
});

// @spec PROTO-004
test('未知字段报 UNKNOWN_FIELD，类型不符报 BAD_FIELD_TYPE', () => {
  const extra = validateFrame({ t: 'human.message', text: '你好', 额外字段: 1 });
  assert.equal(extra.ok, false);
  assert.equal(extra.ok === false && extra.error.code, 'UNKNOWN_FIELD');
  assert.equal(extra.ok === false && extra.error.field, '额外字段');

  const wrongType = validateFrame({ t: 'human.message', text: 42 });
  assert.equal(wrongType.ok, false);
  assert.equal(wrongType.ok === false && wrongType.error.code, 'BAD_FIELD_TYPE');
  assert.equal(wrongType.ok === false && wrongType.error.field, 'text');

  const badEnvelope = validateFrame({ t: 'human.message', text: 'hi', seq: -1 });
  assert.equal(badEnvelope.ok, false);
  assert.equal(badEnvelope.ok === false && badEnvelope.error.code, 'BAD_FIELD_TYPE');
});

// @spec PROTO-005
test('通道能处理半帧分块到达与多帧粘连', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const channel = new FrameChannel({ input, output });
  const seen: string[] = [];
  channel.on('frame', (frame) => seen.push(String(frame.t)));

  const line1 = encodeFrame({ t: 'agent.thinking', text: '切开的' });
  input.write(line1.slice(0, 8));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(seen, [], '半帧不应触发 frame 事件');
  input.write(line1.slice(8));

  input.write(encodeFrame({ t: 'loop.done', reason: 'completed' }));
  input.write(encodeFrame({ t: 'loop.step', step: 1, name: 'assemble' }));
  await new Promise((r) => setTimeout(r, 20));

  assert.deepEqual(seen, ['agent.thinking', 'loop.done', 'loop.step']);
  channel.close();
});

// @spec PROTO-006
test('超长行报 LINE_TOO_LONG，通道随后仍可正常收帧', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const channel = new FrameChannel({ input, output, maxLineBytes: 256 });
  const errors: string[] = [];
  const frames: string[] = [];
  channel.on('error', (err) => errors.push(err.code));
  channel.on('frame', (frame) => frames.push(String(frame.t)));

  input.write('x'.repeat(400) + '\n');
  input.write(encodeFrame({ t: 'loop.done', reason: 'completed' }));
  await new Promise((r) => setTimeout(r, 20));

  assert.deepEqual(errors, ['LINE_TOO_LONG']);
  assert.deepEqual(frames, ['loop.done']);
  channel.close();
});

// @spec PROTO-007
test('磁盘上的 frame.schema.json 与代码生成的 schema 完全一致（契约漂移门禁）', () => {
  const generated = JSON.stringify(frameJsonSchema(), null, 2) + '\n';
  const onDisk = fs.readFileSync(schemaPath, 'utf8');
  assert.equal(onDisk, generated, 'schema 漂移：请运行 `node scripts/gen-schema.mjs` 重新生成');
});

// @spec PROTO-008
test('每个帧类型都声明方向，directionOf / isInbound 与帧表一致', () => {
  for (const [type, spec] of Object.entries(FRAME_SPECS)) {
    assert.ok(spec.direction === 'in' || spec.direction === 'out', `${type} 缺少方向`);
    assert.equal(directionOf(type as keyof typeof FRAME_SPECS), spec.direction);
  }
  assert.equal(isInbound({ t: 'human.message', text: 'hi' }), true);
  assert.equal(isInbound({ t: 'loop.done', reason: 'completed' }), false);
});

// @spec PROTO-009
test('每个帧类型都能编码-解码往返且不丢字段', () => {
  const samples: Record<string, Record<string, unknown>> = {
    'human.message': { t: 'human.message', text: '把预算显示成进度条', at: 'step_boundary' },
    'peer.message': { t: 'peer.message', from: 'teammate:tests', body: '快照测试已更新', taskId: 'task_19', artifacts: ['a.ts'] },
    'ui.event': { t: 'ui.event', target: 'budget_bar', event: 'click', payload: { range: 'today' } },
    'approval.reply': { t: 'approval.reply', id: 'c41', decision: 'allow_once', reason: '人类同意' },
    interrupt: { t: 'interrupt', reason: 'human_took_over' },
    'agent.thinking': { t: 'agent.thinking', agent: 'lead', seq: 118, text: '正在设计…' },
    'tool.call': { t: 'tool.call', id: 'c41', name: 'write_file', args: { path: 'x.ts' } },
    'tool.result': { t: 'tool.result', id: 'c41', ok: true, result: 'written' },
    'ui.patch': { t: 'ui.patch', scope: 'surface.sidebar', op: 'replace', spec: { type: 'panel', children: [] } },
    'approval.ask': { t: 'approval.ask', id: 'c41', action: 'install_dependency', risk: 'medium' },
    'loop.step': { t: 'loop.step', step: 3, name: 'tool_dispatch' },
    'loop.state': { t: 'loop.state', state: 'waiting_human', detail: '等待审批' },
    'loop.done': { t: 'loop.done', reason: 'completed' },
    'loop.error': { t: 'loop.error', message: 'boom', stack: 'at x' },
  };

  for (const type of Object.keys(FRAME_SPECS)) {
    const sample = samples[type];
    assert.ok(sample, `帧表里的 ${type} 没有往返用例——新增帧类型时必须补样例`);
    const decoded = decodeFrame(encodeFrame(sample as never));
    assert.equal(decoded.ok, true, `${type} 往返失败: ${decoded.ok === false ? JSON.stringify(decoded.error) : ''}`);
    if (decoded.ok) assert.deepEqual(decoded.frame, sample);
  }
  assert.deepEqual(Object.keys(samples).sort(), Object.keys(FRAME_SPECS).sort());
});
