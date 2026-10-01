import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TaskBoard, scopesOverlap } from '../src/taskboard/board.ts';
import type { TaskEvent } from '../src/taskboard/board.ts';

/** 可控时钟：让 revision / updatedAt 的断言不依赖真实时间 */
function fakeClock(start = '2026-01-01T00:00:00.000Z') {
  let ms = Date.parse(start);
  return {
    now: () => new Date(ms),
    tick: (deltaMs = 1000) => {
      ms += deltaMs;
    },
  };
}

// @spec TASK-001
test('create 生成稳定 id 与完整字段，get/list 返回快照副本', () => {
  const clock = fakeClock();
  const board = new TaskBoard({ now: clock.now });

  const created = board.create({
    subject: '  实现邮箱  ',
    description: 'JSONL 落盘',
    writeScopes: ['src/mailbox'],
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const task = created.value;
  assert.equal(task.id, 'task_1');
  assert.equal(task.subject, '实现邮箱', 'subject 去首尾空白');
  assert.equal(task.description, 'JSONL 落盘');
  assert.equal(task.status, 'pending');
  assert.equal(task.owner, null);
  assert.deepEqual(task.blockedBy, []);
  assert.deepEqual(task.writeScopes, ['src/mailbox']);
  assert.equal(task.revision, 0);
  assert.equal(task.createdAt, '2026-01-01T00:00:00.000Z');
  assert.equal(task.updatedAt, task.createdAt);

  assert.deepEqual(board.get('task_1'), task);
  assert.equal(board.list().length, 1);
  assert.equal(board.get('不存在'), undefined);

  // 快照副本：调用方改不动内部状态
  task.writeScopes.push('src/hack');
  task.subject = '被篡改';
  assert.deepEqual(board.get('task_1')?.writeScopes, ['src/mailbox']);
  assert.equal(board.get('task_1')?.subject, '实现邮箱');
});

// @spec TASK-002
test('状态机拒绝非法迁移，任务保持不变', () => {
  const clock = fakeClock();
  const board = new TaskBoard({ now: clock.now });
  const created = board.create({ subject: 'A' });
  assert.ok(created.ok);
  const id = created.ok ? created.value.id : '';

  const illegal = [
    board.complete(id, 'agent-a', 0),
    board.release(id, 'agent-a', 0),
    board.reopen(id, 0),
  ];
  for (const result of illegal) {
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'INVALID_TRANSITION');
  }
  assert.equal(board.get(id)?.status, 'pending');
  assert.equal(board.get(id)?.revision, 0);

  assert.equal(board.claim(id, 'agent-a', 0).ok, true);
  const secondClaim = board.claim(id, 'agent-b', 1);
  assert.equal(secondClaim.ok, false);
  assert.equal(secondClaim.ok === false && secondClaim.error.code, 'INVALID_TRANSITION');

  assert.equal(board.complete(id, 'agent-a', 1).ok, true);
  const releaseCompleted = board.release(id, 'agent-a', 2);
  assert.equal(releaseCompleted.ok, false);
  assert.equal(releaseCompleted.ok === false && releaseCompleted.error.code, 'INVALID_TRANSITION');
  const claimCompleted = board.claim(id, 'agent-b', 2);
  assert.equal(claimCompleted.ok, false);
  assert.equal(claimCompleted.ok === false && claimCompleted.error.code, 'INVALID_TRANSITION');
});

// @spec TASK-003
test('CAS：expectedRevision 不符报 REVISION_CONFLICT，任务不变', () => {
  const clock = fakeClock();
  const board = new TaskBoard({ now: clock.now });
  const created = board.create({ subject: 'A' });
  assert.ok(created.ok);
  const id = created.ok ? created.value.id : '';
  clock.tick();

  const stale = board.claim(id, 'agent-a', 7);
  assert.equal(stale.ok, false);
  if (!stale.ok) {
    assert.equal(stale.error.code, 'REVISION_CONFLICT');
    assert.equal(stale.error.expected, 7);
    assert.equal(stale.error.actual, 0);
  }
  assert.equal(board.get(id)?.status, 'pending');
  assert.equal(board.get(id)?.owner, null);
  assert.equal(board.get(id)?.revision, 0);
  assert.equal(board.get(id)?.updatedAt, '2026-01-01T00:00:00.000Z', '失败不推进 updatedAt');
  assert.equal(board.events().length, 1, '只有 create 这一条审计');
});

// @spec TASK-004
test('并发抢同一任务只有一个成功', async () => {
  const clock = fakeClock();
  const board = new TaskBoard({ now: clock.now });
  const created = board.create({ subject: '抢单' });
  assert.ok(created.ok);
  const id = created.ok ? created.value.id : '';

  const owners = Array.from({ length: 16 }, (_, i) => `agent-${i}`);
  const results = await Promise.all(
    owners.map((owner) => Promise.resolve().then(() => board.claim(id, owner, 0))),
  );

  const winners = results.filter((result) => result.ok);
  assert.equal(winners.length, 1, '并发抢单只能有一个成功');
  assert.equal(board.get(id)?.status, 'in_progress');
  assert.equal(board.get(id)?.owner, winners[0]?.ok ? winners[0].value.owner : null);
  assert.equal(board.get(id)?.revision, 1, 'revision 只加一次');
  for (const result of results) {
    if (result.ok) continue;
    assert.ok(
      result.error.code === 'REVISION_CONFLICT' || result.error.code === 'INVALID_TRANSITION',
      `失败原因应是冲突或非法迁移，实际 ${result.error.code}`,
    );
  }
});

// @spec TASK-005
test('ready 只含无依赖阻塞的 pending 任务，并按创建顺序返回', () => {
  const clock = fakeClock();
  const board = new TaskBoard({ now: clock.now });

  const a = board.create({ subject: 'A' });
  assert.ok(a.ok);
  const aId = a.ok ? a.value.id : '';
  const b = board.create({ subject: 'B', blockedBy: [aId] });
  assert.ok(b.ok);
  const bId = b.ok ? b.value.id : '';
  const c = board.create({ subject: 'C', blockedBy: [aId, bId] });
  assert.ok(c.ok);
  const cId = c.ok ? c.value.id : '';
  const e = board.create({ subject: 'E' });
  assert.ok(e.ok);
  const eId = e.ok ? e.value.id : '';

  assert.deepEqual(board.ready().map((t) => t.id), [aId, eId]);

  assert.equal(board.claim(aId, 'agent-a', 0).ok, true);
  assert.deepEqual(board.ready().map((t) => t.id), [eId], 'in_progress 的任务不 ready');

  assert.equal(board.complete(aId, 'agent-a', 1).ok, true);
  assert.deepEqual(board.ready().map((t) => t.id), [bId, eId]);
  assert.equal(board.claim(bId, 'agent-b', 0).ok, true);
  assert.equal(board.complete(bId, 'agent-b', 1).ok, true);
  assert.deepEqual(board.ready().map((t) => t.id), [cId, eId]);

  // 依赖未完成时 claim 直接报 BLOCKED
  const f = board.create({ subject: 'F', blockedBy: [cId] });
  assert.ok(f.ok);
  const fId = f.ok ? f.value.id : '';
  const blocked = board.claim(fId, 'agent-f', 0);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.ok === false && blocked.error.code, 'BLOCKED');
  assert.equal(board.get(fId)?.status, 'pending');
});

// @spec TASK-006
test('创建校验：未知依赖 / 重复 id / 空 subject 都不落库', () => {
  const board = new TaskBoard({ now: fakeClock().now });

  const unknownBlocker = board.create({ subject: 'B', blockedBy: ['task_missing'] });
  assert.equal(unknownBlocker.ok, false);
  assert.equal(unknownBlocker.ok === false && unknownBlocker.error.code, 'UNKNOWN_BLOCKER');
  assert.equal(board.list().length, 0);
  assert.equal(board.get('task_1'), undefined, '失败的创建不占用 id');

  const ok = board.create({ subject: 'A' });
  assert.equal(ok.ok, true);
  assert.equal(ok.ok ? ok.value.id : '', 'task_1', '失败创建不消耗 id 生成器');
  const duplicate = board.create({ subject: 'A again', id: 'task_1' });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.ok === false && duplicate.error.code, 'DUPLICATE_ID');
  assert.equal(board.list().length, 1);

  const emptySubject = board.create({ subject: '   ' });
  assert.equal(emptySubject.ok, false);
  assert.equal(emptySubject.ok === false && emptySubject.error.code, 'INVALID_INPUT');
  assert.equal(emptySubject.ok === false && emptySubject.error.field, 'subject');
  assert.equal(board.list().length, 1);
});

// @spec TASK-007
test('写作用域按路径前缀判定重叠，冲突只是警告不是锁', () => {
  assert.equal(scopesOverlap('src/kernel', 'src/kernel/pool.ts'), true);
  assert.equal(scopesOverlap('src/kernel/', 'src/kernel'), true);
  assert.equal(scopesOverlap('src/kernel', 'src/surface'), false);
  assert.equal(scopesOverlap('src/kernel-extra', 'src/kernel'), false, '前缀必须按路径分段');
  assert.equal(scopesOverlap('.', '任意/路径'), true);

  const clock = fakeClock();
  const events: TaskEvent[] = [];
  const board = new TaskBoard({ now: clock.now, onChange: (event) => events.push(event) });

  const a = board.create({ subject: 'A', writeScopes: ['src/kernel'] });
  assert.ok(a.ok);
  const aId = a.ok ? a.value.id : '';
  const b = board.create({ subject: 'B', writeScopes: ['src/kernel/pool.ts'] });
  assert.ok(b.ok);
  const bId = b.ok ? b.value.id : '';
  assert.equal(board.claim(aId, 'agent-a', 0).ok, true);

  assert.deepEqual(board.conflicts('agent-b', ['src/kernel/pool.ts']).map((t) => t.id), [aId]);
  assert.deepEqual(board.conflicts('agent-a', ['src/kernel']).map((t) => t.id), [], '排除自己的任务');
  assert.deepEqual(board.conflicts('agent-b', ['src/surface']).map((t) => t.id), []);

  // 与 agent-a 的 src/kernel 重叠，但 claim 仍然成功：契约不是锁
  const claimed = board.claim(bId, 'agent-b', 0);
  assert.equal(claimed.ok, true);
  const lastClaim = events.filter((event) => event.type === 'task.claimed').at(-1);
  assert.deepEqual(lastClaim?.conflicts?.map((t) => t.id), [aId], '警告随事件交给宿主');
  assert.equal(board.get(bId)?.status, 'in_progress');
});

// @spec TASK-008
test('每次成功变更 revision+1、updatedAt 前进，并派发事件与审计', () => {
  const clock = fakeClock();
  const events: TaskEvent[] = [];
  const board = new TaskBoard({ now: clock.now });
  const unsubscribe = board.onChange((event) => events.push(event));

  const created = board.create({ subject: 'A' });
  assert.ok(created.ok);
  const id = created.ok ? created.value.id : '';
  assert.equal(board.get(id)?.revision, 0);

  clock.tick();
  assert.equal(board.claim(id, 'agent-a', 0).ok, true);
  assert.equal(board.get(id)?.revision, 1);
  assert.equal(board.get(id)?.updatedAt, '2026-01-01T00:00:01.000Z');

  clock.tick();
  assert.equal(board.release(id, 'agent-a', 1).ok, true);
  assert.equal(board.get(id)?.revision, 2);
  clock.tick();
  assert.equal(board.claim(id, 'agent-a', 2).ok, true);
  clock.tick();
  assert.equal(board.complete(id, 'agent-a', 3).ok, true);
  clock.tick();
  assert.equal(board.reopen(id, 4).ok, true);
  assert.equal(board.get(id)?.revision, 5);
  assert.equal(board.get(id)?.updatedAt, '2026-01-01T00:00:05.000Z');

  assert.deepEqual(
    events.map((event) => event.type),
    ['task.created', 'task.claimed', 'task.released', 'task.claimed', 'task.completed', 'task.reopened'],
  );
  assert.equal(events[0]?.actor, null);
  assert.equal(events[1]?.actor, 'agent-a');
  assert.equal(events.at(-1)?.task.status, 'pending');
  assert.equal(events.at(-1)?.task.owner, null);
  assert.deepEqual(board.events().map((event) => event.type), events.map((event) => event.type));

  unsubscribe();
  assert.equal(board.create({ subject: 'B' }).ok, true);
  assert.equal(events.length, 6, '退订后不再收到事件');
  assert.equal(board.events().length, 7, '但审计仍在记录');
});

// @spec TASK-009
test('toJSON/fromJSON 与 save/load 往返后状态一致', () => {
  const clock = fakeClock();
  const board = new TaskBoard({ now: clock.now });
  const a = board.create({ subject: 'A', writeScopes: ['src/kernel'] });
  assert.ok(a.ok);
  const aId = a.ok ? a.value.id : '';
  const b = board.create({ subject: 'B', blockedBy: [aId] });
  assert.ok(b.ok);
  assert.equal(board.claim(aId, 'agent-a', 0).ok, true);

  const restored = TaskBoard.fromJSON(board.toJSON());
  assert.deepEqual(restored.list(), board.list());
  assert.deepEqual(restored.ready().map((t) => t.id), board.ready().map((t) => t.id));
  assert.deepEqual(restored.events(), [], '重建不派发事件');
  const afterRestore = restored.create({ subject: 'C' });
  assert.equal(afterRestore.ok && afterRestore.value.id, 'task_3', 'id 生成器不与既有 id 冲突');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskboard-'));
  const file = path.join(dir, 'board.jsonl');
  try {
    assert.equal(board.save(file).ok, true);
    const loaded = TaskBoard.load(file);
    assert.equal(loaded.ok, true);
    if (loaded.ok) {
      assert.deepEqual(loaded.value.list(), board.list());
      assert.deepEqual(loaded.value.ready().map((t) => t.id), board.ready().map((t) => t.id));
    }

    fs.writeFileSync(file, '{ 这不是合法 JSON }\n');
    const broken = TaskBoard.load(file);
    assert.equal(broken.ok, false);
    assert.equal(broken.ok === false && broken.error.code, 'PERSIST_ERROR');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// @spec TASK-010
test('失败操作无变更无事件；release 清 owner，reopen 回到 pending', () => {
  const clock = fakeClock();
  const events: TaskEvent[] = [];
  const board = new TaskBoard({ now: clock.now, onChange: (event) => events.push(event) });
  const created = board.create({ subject: 'A' });
  assert.ok(created.ok);
  const id = created.ok ? created.value.id : '';
  clock.tick();

  const before = board.get(id);
  const auditsBefore = board.events().length;
  const eventsBefore = events.length;
  assert.equal(board.claim(id, 'agent-a', 99).ok, false);
  assert.equal(board.claim('task_不存在', 'agent-a', 0).ok, false);
  assert.equal(board.release(id, 'agent-a', 0).ok, false);
  assert.equal(board.reopen(id, 0).ok, false);
  assert.deepEqual(board.get(id), before, '失败操作不改变任何字段');
  assert.equal(board.events().length, auditsBefore, '失败操作不进审计');
  assert.equal(events.length, eventsBefore, '失败操作不派发事件');

  assert.equal(board.claim(id, 'agent-a', 0).ok, true);
  const notOwner = board.release(id, 'agent-b', 1);
  assert.equal(notOwner.ok, false);
  assert.equal(notOwner.ok === false && notOwner.error.code, 'NOT_OWNER');
  assert.equal(board.get(id)?.owner, 'agent-a');

  clock.tick();
  assert.equal(board.release(id, 'agent-a', 1).ok, true);
  assert.equal(board.get(id)?.status, 'pending');
  assert.equal(board.get(id)?.owner, null);
  assert.equal(board.get(id)?.revision, 2);

  clock.tick();
  assert.equal(board.claim(id, 'agent-a', 2).ok, true);
  clock.tick();
  assert.equal(board.complete(id, 'agent-a', 3).ok, true);
  assert.equal(board.get(id)?.status, 'completed');
  assert.equal(board.get(id)?.owner, 'agent-a');

  clock.tick();
  assert.equal(board.reopen(id, 4).ok, true);
  assert.equal(board.get(id)?.status, 'pending');
  assert.equal(board.get(id)?.owner, null);
  assert.equal(board.get(id)?.revision, 5);
});
