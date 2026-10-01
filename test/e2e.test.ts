import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EventLog } from '../src/eventlog/log.ts';
import { AgentPool } from '../src/kernel/pool.ts';
import { ViewDocument } from '../src/surface/document.ts';
import { SurfaceIngest } from '../src/surface/ingest.ts';
import type { Frame } from '../src/protocol/frames.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agent-client-e2e-${prefix}-`));
}

const PANEL = {
  type: 'panel',
  title: '今日预算',
  children: [
    { type: 'progress', label: 'token', value: 0.62, tone: 'warning' },
    { type: 'action', label: '提高上限', emit: 'ui.event:raise_budget' },
  ],
};

// @spec E2E-001
test('端到端：子进程跑完 Loop → ui.patch → 界面文档出新版本并渲染出 HTML', async () => {
  const log = new EventLog({ dir: tempDir('log') });
  const document = new ViewDocument();
  const ingest = new SurfaceIngest({ document });
  const pool = new AgentPool({ log });
  const handle = pool.spawn({ agentId: 'lead', logDir: tempDir('agent') });

  handle.onFrame((frame: Frame) => {
    if (frame.t === 'ui.patch') {
      ingest.ingest({ scope: String(frame.scope), op: String(frame.op), spec: frame.spec });
    }
  });

  const done = new Promise<Frame>((resolve) =>
    handle.onFrame((frame: Frame) => {
      if (frame.t === 'loop.done') resolve(frame);
    }),
  );

  handle.send({ t: 'human.message', text: '把预算显示成进度条' });
  assert.equal((await done).reason, 'completed');
  await pool.shutdown();

  assert.ok(document.scopes().length >= 1, '界面文档里应当出现 Agent 给的区块');
  assert.ok(document.version >= 1);

  const html = document.render({ title: 'e2e' });
  assert.match(html, /Agent 的界面/, 'Agent 发来的面板必须真的渲染出来');

  // 审计链条完整：帧 → 事件日志 → 可回放
  const frameEvents = log.read().filter((event) => event.type === 'agent.frame');
  const patched = frameEvents.some(
    (event) => (event.frame as Frame | undefined)?.t === 'ui.patch',
  );
  assert.equal(patched, true, '每一帧都要进事件日志，且能回放出 ui.patch');
});

// @spec E2E-002
test('非法 View Spec 被拒绝：版本不前进、有留痕、界面依然可用', () => {
  const document = new ViewDocument();
  const rejected: string[] = [];
  const ingest = new SurfaceIngest({ document, onReject: (_patch, reason) => rejected.push(reason) });

  const good = ingest.ingest({ scope: 'surface.sidebar', op: 'mount', spec: PANEL });
  assert.equal(good.ok, true);

  const bad = ingest.ingest({ scope: 'surface.sidebar', op: 'replace', spec: { type: '不存在的组件' } });
  assert.equal(bad.ok, false);
  assert.equal(document.version, 1, '被拒绝的 patch 不得让版本前进');
  assert.equal(ingest.rejected.length, 1);
  assert.equal(rejected.length, 1);

  const html = document.render();
  assert.match(html, /今日预算/, '拒绝之后界面必须还在');
  assert.doesNotMatch(html, /不存在的组件/);
});

// @spec E2E-003
test('回滚：多次改造后可回到任意版本，渲染结果随之回退', () => {
  const document = new ViewDocument();
  const ingest = new SurfaceIngest({ document });

  ingest.ingest({ scope: 'surface.sidebar', op: 'mount', spec: PANEL });
  const v1 = document.version;
  ingest.ingest({
    scope: 'surface.sidebar',
    op: 'replace',
    spec: { type: 'panel', title: '预算总览', children: [{ type: 'text', text: '第二版' }] },
  });
  const v2 = document.version;
  assert.ok(v2 > v1);
  assert.match(document.render(), /预算总览/);

  const rolled = document.rollback(v1);
  assert.equal(rolled.ok, true);
  const html = document.render();
  assert.match(html, /今日预算/);
  assert.doesNotMatch(html, /预算总览/);
});

// @spec E2E-005
test('局部补丁：op=patch 能穿过入口闸门做深合并；合并后非法则整笔作废', () => {
  const document = new ViewDocument();
  const ingest = new SurfaceIngest({ document });

  ingest.ingest({ scope: 'surface.sidebar', op: 'mount', spec: PANEL });
  const v1 = document.version;

  const merged = ingest.ingest({ scope: 'surface.sidebar', op: 'patch', spec: { title: '预算（已改）' } });
  assert.equal(merged.ok, true, '局部补丁不该被入口闸门拦下');
  assert.equal(document.version, v1 + 1);
  const afterPatch = document.render();
  assert.match(afterPatch, /预算（已改）/);
  assert.match(afterPatch, /提高上限/, '未提及的字段必须被保留');

  const broken = ingest.ingest({ scope: 'surface.sidebar', op: 'patch', spec: { children: '不是数组' } });
  assert.equal(broken.ok, false);
  assert.equal(document.version, v1 + 1, '合并后非法的补丁整笔作废');
  assert.equal(ingest.rejected.length, 1);
  assert.match(document.render(), /预算（已改）/, '作废之后界面必须还是上一版');
});

// @spec E2E-006
test('CLI team 命令跑通一次真实的多进程编排并落盘产物', () => {
  const outDir = tempDir('team-out');
  const runDir = tempDir('team-run');

  const stdout = execFileSync(
    process.execPath,
    [path.join(root, 'src', 'cli.ts'), 'team', '--out', outDir, '--dir', runDir],
    { cwd: root, encoding: 'utf8', timeout: 60000 },
  );

  assert.match(stdout, /终态：completed/);
  assert.match(stdout, /子 Agent：teammate:ui/);
  assert.match(stdout, /任务板：task_19 → completed @ teammate:ui/);

  const html = fs.readFileSync(path.join(outDir, 'team-surface.html'), 'utf8');
  assert.match(html, /今日预算/);
  assert.ok(fs.existsSync(path.join(runDir, 'mailbox', 'mailbox.jsonl')), '邮箱要落盘');
});

// @spec E2E-004
test('CLI demo 作为真实进程跑通并落盘产物', () => {
  const outDir = tempDir('out');
  const logDir = tempDir('clilog');

  const stdout = execFileSync(
    process.execPath,
    [path.join(root, 'src', 'cli.ts'), 'demo', '--out', outDir, '--log-dir', logDir, '--prompt', '把预算显示成进度条'],
    { cwd: root, encoding: 'utf8', timeout: 60000 },
  );

  assert.match(stdout, /loop\.done\s+completed/);
  assert.match(stdout, /界面文档 → v\d+/);

  const html = fs.readFileSync(path.join(outDir, 'surface.html'), 'utf8');
  assert.match(html, /Agent 的界面/);
  const spec = JSON.parse(fs.readFileSync(path.join(outDir, 'surface.json'), 'utf8')) as { version: number };
  assert.ok(spec.version >= 1);
  assert.ok(fs.existsSync(path.join(logDir, 'events.jsonl')));
});
