import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Mailbox, fromPeerFrame, senderKind, toPeerFrame } from '../src/mailbox/mailbox.ts';

/** 可控时钟：让 createdAt / deliveredAt 的断言不依赖真实时间 */
function fakeClock(start = '2026-02-01T00:00:00.000Z') {
  let ms = Date.parse(start);
  return {
    now: () => new Date(ms),
    tick: (deltaMs = 1000) => {
      ms += deltaMs;
    },
  };
}

function mkTmpDir(prefix = 'mailbox-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// @spec MAIL-001
test('send 写入字段完整的消息，收件 Agent 可用 pending 读到', () => {
  const clock = fakeClock();
  const box = new Mailbox({ now: clock.now });
  const sent = box.send({
    from: 'teammate:frontend',
    to: 'lead',
    kind: 'handoff',
    body: '侧边栏改完了',
    taskId: 'task_1',
    artifacts: ['src/surface/sidebar.ts'],
  });
  assert.equal(sent.ok, true);
  if (!sent.ok) return;

  assert.equal(sent.value.duplicate, false);
  const message = sent.value.message;
  assert.equal(message.id, 'mail_1');
  assert.equal(message.from, 'teammate:frontend');
  assert.equal(message.to, 'lead');
  assert.equal(message.kind, 'handoff');
  assert.equal(message.body, '侧边栏改完了');
  assert.equal(message.taskId, 'task_1');
  assert.deepEqual(message.artifacts, ['src/surface/sidebar.ts']);
  assert.equal(message.createdAt, '2026-02-01T00:00:00.000Z');
  assert.equal(message.deliveredAt, undefined);

  const pending = box.pending('lead');
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0], message);
  assert.deepEqual(box.pending('别的 Agent'), []);

  const bad = box.send({ from: 'lead', to: '', kind: 'note', body: 'x' });
  assert.equal(bad.ok, false);
  assert.equal(bad.ok === false && bad.error.code, 'INVALID_MESSAGE');
  assert.equal(bad.ok === false && bad.error.field, 'to');
});

// @spec MAIL-002
test('重复 id 幂等：不新增记录，duplicate 为 true', () => {
  const box = new Mailbox({ now: fakeClock().now });
  const first = box.send({ id: 'mail_fixed', from: 'lead', to: 'teammate:tests', kind: 'assignment', body: '写邮箱测试' });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.value.duplicate, false);

  const again = box.send({ id: 'mail_fixed', from: 'lead', to: 'teammate:tests', kind: 'assignment', body: '重复投递' });
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.equal(again.value.duplicate, true);
  assert.equal(again.value.message.body, '写邮箱测试', '重复 id 不覆盖已有消息');
  assert.equal(box.messages().length, 1);
  assert.equal(box.pending('teammate:tests').length, 1);
});

// @spec MAIL-003
test('pending 只读不消费，且返回快照副本', () => {
  const box = new Mailbox({ now: fakeClock().now });
  assert.equal(box.send({ from: 'lead', to: 'teammate:a', kind: 'note', body: '一' }).ok, true);
  assert.equal(box.send({ from: 'lead', to: 'teammate:a', kind: 'note', body: '二' }).ok, true);

  const first = box.pending('teammate:a');
  const second = box.pending('teammate:a');
  assert.deepEqual(first.map((m) => m.id), second.map((m) => m.id));
  assert.deepEqual(first.map((m) => m.body), ['一', '二']);
  assert.ok(first.every((m) => m.deliveredAt === undefined), 'pending 不写 deliveredAt');

  const copy = first[0];
  if (copy) copy.body = '外部篡改';
  assert.equal(box.pending('teammate:a')[0]?.body, '一', 'pending 结果是快照副本');
  assert.equal(box.messages().length, 2, 'pending 不消费');
});

// @spec MAIL-004
test('drainAt 一次性取出并消费，第二次返回空数组', () => {
  const clock = fakeClock();
  const box = new Mailbox({ now: clock.now });
  assert.equal(box.send({ from: 'lead', to: 'teammate:a', kind: 'note', body: '一' }).ok, true);
  assert.equal(box.send({ from: 'lead', to: 'teammate:a', kind: 'note', body: '二' }).ok, true);
  clock.tick(5000);

  const drained = box.drainAt('teammate:a', 'step_boundary');
  assert.equal(drained.ok, true);
  if (!drained.ok) return;
  assert.deepEqual(drained.value.map((m) => m.body), ['一', '二']);
  assert.ok(drained.value.every((m) => m.deliveredAt === '2026-02-01T00:00:05.000Z'));

  const again = box.drainAt('teammate:a', 'step_boundary');
  assert.equal(again.ok, true);
  assert.deepEqual(again.ok ? again.value : null, []);
  assert.deepEqual(box.pending('teammate:a'), []);
  assert.equal(box.messages().length, 2, '消费不删除消息');
});

// @spec MAIL-005
test('drainAt 只投递指定 Agent，其他 Agent 不受影响', () => {
  const box = new Mailbox({ now: fakeClock().now });
  assert.equal(box.send({ from: 'lead', to: 'teammate:a', kind: 'note', body: '给 a' }).ok, true);
  assert.equal(box.send({ from: 'lead', to: 'teammate:b', kind: 'note', body: '给 b' }).ok, true);

  const drainedA = box.drainAt('teammate:a', 'step_boundary');
  assert.equal(drainedA.ok, true);
  assert.deepEqual(drainedA.ok ? drainedA.value.map((m) => m.body) : [], ['给 a']);
  assert.deepEqual(box.pending('teammate:b').map((m) => m.body), ['给 b']);

  const empty = box.drainAt('teammate:ghost', 'step_boundary');
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.ok ? empty.value : null, [], '无消息不是错误');
});

// @spec MAIL-006
test('投递边界不是 step_boundary 报 BAD_BOUNDARY，且不消费', () => {
  const box = new Mailbox({ now: fakeClock().now });
  assert.equal(box.send({ from: 'lead', to: 'teammate:a', kind: 'note', body: '别丢' }).ok, true);

  const bad = box.drainAt('teammate:a', 'tool_boundary');
  assert.equal(bad.ok, false);
  assert.equal(bad.ok === false && bad.error.code, 'BAD_BOUNDARY');
  assert.deepEqual(box.pending('teammate:a').map((m) => m.body), ['别丢']);
});

// @spec MAIL-007
test('持久化：重启后未投递消息仍在，已消费不重复投递', () => {
  const dir = mkTmpDir();
  try {
    const first = new Mailbox({ dir, now: fakeClock().now });
    assert.equal(first.send({ from: 'lead', to: 'teammate:a', kind: 'note', body: '一' }).ok, true);
    assert.equal(first.send({ from: 'lead', to: 'teammate:a', kind: 'note', body: '二' }).ok, true);

    const reopened = new Mailbox({ dir, now: fakeClock().now });
    assert.deepEqual(reopened.pending('teammate:a').map((m) => m.body), ['一', '二'], '未投递消息跨实例存活');
    assert.equal(reopened.drainAt('teammate:a', 'step_boundary').ok, true);

    const afterDrain = new Mailbox({ dir, now: fakeClock().now });
    assert.deepEqual(afterDrain.pending('teammate:a'), [], '已消费消息不重复投递');
    assert.equal(afterDrain.messages().length, 2);
    assert.ok(afterDrain.messages().every((m) => typeof m.deliveredAt === 'string'));

    // 也支持直接指定 .jsonl 文件
    const file = path.join(dir, 'other.jsonl');
    const byFile = new Mailbox({ file, now: fakeClock().now });
    assert.equal(byFile.send({ from: 'lead', to: 'teammate:b', kind: 'note', body: '文件模式' }).ok, true);
    assert.equal(fs.existsSync(file), true);
    assert.deepEqual(new Mailbox(file).pending('teammate:b').map((m) => m.body), ['文件模式']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// @spec MAIL-008
test('空闲/不存在 Agent 的消息不丢；发送者前缀与 peer.message 帧互转', () => {
  const box = new Mailbox({ now: fakeClock().now });
  assert.equal(
    box.send({ from: 'lead', to: 'teammate:frontend', kind: 'assignment', body: '改侧边栏', taskId: 'task_7' }).ok,
    true,
  );

  // 收件人空闲/还没被拉起，其他 Agent 的活动不该带走它的消息
  assert.equal(box.drainAt('lead', 'step_boundary').ok, true);
  assert.deepEqual(box.pending('lead'), []);
  assert.deepEqual(box.pending('teammate:frontend').map((m) => m.body), ['改侧边栏']);

  const later = box.drainAt('teammate:frontend', 'step_boundary');
  assert.equal(later.ok, true);
  assert.deepEqual(later.ok ? later.value.map((m) => m.body) : [], ['改侧边栏']);

  assert.equal(senderKind('teammate:frontend'), 'teammate');
  assert.equal(senderKind('lead'), 'agent');
  assert.equal(senderKind('subagent:worker-1'), 'subagent');

  const frame = toPeerFrame({
    id: 'mail_9',
    from: 'teammate:frontend',
    to: 'lead',
    kind: 'report',
    body: '完成',
    taskId: 'task_7',
    artifacts: ['a.ts'],
    createdAt: '2026-02-01T00:00:00.000Z',
  });
  assert.equal(frame.t, 'peer.message');
  assert.equal(frame.from, 'teammate:frontend');
  assert.equal(frame.body, '完成');
  assert.equal(frame.taskId, 'task_7');
  assert.deepEqual(frame.artifacts, ['a.ts']);

  const back = fromPeerFrame(frame, 'lead');
  assert.equal(back.ok, true);
  if (!back.ok) return;
  assert.equal(back.value.from, 'teammate:frontend');
  assert.equal(back.value.to, 'lead');
  assert.equal(back.value.body, '完成');
  assert.equal(back.value.taskId, 'task_7');
  assert.deepEqual(back.value.artifacts, ['a.ts']);

  const notPeer = fromPeerFrame({ t: 'loop.done', reason: 'completed' }, 'lead');
  assert.equal(notPeer.ok, false);
  assert.equal(notPeer.ok === false && notPeer.error.code, 'INVALID_MESSAGE');
});
