import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EventLog } from '../src/eventlog/log.ts';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-client-log-'));
}

// @spec LOG-001
test('append 返回自增 seq 与合法 ts，且立即落盘（新实例可读回）', () => {
  const dir = tempDir();
  const log = new EventLog({ dir });
  const first = log.append({ type: 'loop.step', name: 'assemble' });
  const second = log.append({ type: 'loop.step', name: 'infer' });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(first.event.seq, 1);
  assert.equal(second.event.seq, 2);
  assert.equal(Number.isNaN(Date.parse(first.event.ts)), false);

  const reopened = new EventLog({ dir });
  assert.deepEqual(
    reopened.read().map((e) => e.seq),
    [1, 2],
  );
  assert.equal(reopened.read()[0]?.name, 'assemble');
});

// @spec LOG-002
test('交错 append 不产生重复或跳号的 seq', async () => {
  const log = new EventLog({ dir: tempDir() });
  const results = await Promise.all(
    Array.from({ length: 25 }, async (_, i) => {
      await new Promise((r) => setTimeout(r, i % 3));
      return log.append({ type: 'tick', i });
    }),
  );
  const seqs = results.filter((r) => r.ok).map((r) => (r.ok ? r.event.seq : -1));
  assert.equal(new Set(seqs).size, 25);
  assert.deepEqual([...seqs].sort((a, b) => a - b), Array.from({ length: 25 }, (_, i) => i + 1));
});

// @spec LOG-003
test('read 升序返回全部事件，readFrom 返回水位之后的子集', () => {
  const log = new EventLog({ dir: tempDir() });
  for (let i = 0; i < 5; i += 1) log.append({ type: 'e', i });
  assert.deepEqual(
    log.read().map((e) => e.seq),
    [1, 2, 3, 4, 5],
  );
  assert.deepEqual(
    log.readFrom(3).map((e) => e.seq),
    [3, 4, 5],
  );
  assert.deepEqual(log.readFrom(99), []);
});

// @spec LOG-004
test('snapshot 落盘并带水位，latestSnapshot 取最近一次', () => {
  const dir = tempDir();
  const log = new EventLog({ dir });
  log.append({ type: 'e' });
  log.append({ type: 'e' });
  const snap = log.snapshot({ unread: 2 });
  assert.equal(snap.seq, 2);

  log.append({ type: 'e' });
  const latest = log.latestSnapshot<{ unread: number }>();
  assert.equal(latest?.seq, 2);
  assert.deepEqual(latest?.state, { unread: 2 });

  const reopened = new EventLog({ dir });
  assert.deepEqual(reopened.latestSnapshot()?.state, { unread: 2 });
});

// @spec LOG-005
test('replay 能从空态或从快照水位起跳折叠出状态', () => {
  const log = new EventLog({ dir: tempDir() });
  log.append({ type: 'tool', n: 2 });
  log.append({ type: 'tool', n: 3 });
  log.snapshot(5);
  const snap = log.latestSnapshot<number>();
  assert.equal(snap?.seq, 2, '快照必须记录当时的水位');
  assert.equal(snap?.state, 5);
  log.append({ type: 'tool', n: 4 });

  const reducer = (state: number, event: { type: string; n?: number }): number =>
    state + (event.type === 'tool' ? (event.n ?? 0) : 0);

  const fromZero = log.replay(reducer, 0);
  assert.equal(fromZero, 9);

  const fromSnap = log.replay(reducer, snap?.state ?? 0, { fromSeq: (snap?.seq ?? 0) + 1 });
  assert.equal(fromSnap, 9, '快照起跳与从零回放必须一致');
});

// @spec LOG-006
test('损坏行被跳过并上报，其余事件仍可读', () => {
  const dir = tempDir();
  const log = new EventLog({ dir });
  log.append({ type: 'good', i: 1 });
  fs.appendFileSync(path.join(dir, 'events.jsonl'), '{ 这不是 JSON\n', 'utf8');
  log.append({ type: 'good', i: 2 });

  const reopened = new EventLog({ dir });
  const events = reopened.read();
  assert.deepEqual(
    events.map((e) => e.i),
    [1, 2],
  );
  const issues = reopened.issues();
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.line, 2);
  assert.equal(issues[0]?.reason.length > 0, true);
});

// @spec LOG-007
test('非法事件被拒绝：空 type 不写入，ts 单调不减', () => {
  const log = new EventLog({ dir: tempDir() });
  const bad = log.append({ type: '' });
  assert.equal(bad.ok, false);
  assert.equal(bad.ok === false && bad.error.code, 'BAD_EVENT');
  assert.equal(log.read().length, 0, '脏事件不得落盘');

  const missing = log.append({ n: 1 } as never);
  assert.equal(missing.ok, false);

  for (let i = 0; i < 3; i += 1) log.append({ type: 'e' });
  const stamps = log.read().map((e) => Date.parse(e.ts));
  for (let i = 1; i < stamps.length; i += 1) {
    assert.ok((stamps[i] as number) >= (stamps[i - 1] as number), 'ts 必须单调不减');
  }
});

// @spec LOG-008
test('同一份日志两次 replay 深度相等；快照起跳与从零回放一致', () => {
  const log = new EventLog({ dir: tempDir() });
  log.append({ type: 'msg', text: '一' });
  log.append({ type: 'msg', text: '二' });
  log.snapshot(['一', '二']);
  const snap = log.latestSnapshot<string[]>();
  log.append({ type: 'msg', text: '三' });

  const reducer = (state: string[], event: { type: string; text?: string }): string[] =>
    event.type === 'msg' ? [...state, event.text as string] : state;

  const once = log.replay(reducer, []);
  const twice = log.replay(reducer, []);
  assert.deepEqual(once, twice);

  const fromSnap = log.replay(reducer, snap?.state ?? [], { fromSeq: (snap?.seq ?? 0) + 1 });
  assert.deepEqual(fromSnap, once);
  assert.deepEqual(once, ['一', '二', '三']);
});
