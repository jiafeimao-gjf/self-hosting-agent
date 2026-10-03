import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ClientSession } from '../src/server/session.ts';
import { startServer } from '../src/server/http-server.ts';
import { EventLog } from '../src/eventlog/log.ts';
import { ViewDocument } from '../src/surface/document.ts';
import { SurfaceIngest } from '../src/surface/ingest.ts';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agent-client-surface-${prefix}-`));
}

const PANEL = {
  type: 'panel',
  title: '预算',
  children: [{ type: 'text', text: '还有 42%' }],
};

// @spec SURF-014
test('界面改动落成事件；被拒绝的改动不写事件', () => {
  const dir = tempDir('log');
  const log = new EventLog({ dir });
  const document = new ViewDocument();
  const ingest = new SurfaceIngest({ document, log });

  const ok = ingest.ingest({ scope: 'surface.main', op: 'upsert', spec: PANEL });
  assert.equal(ok.ok, true);

  const events = log.read().filter((event) => event.type === 'ui.patch');
  assert.equal(events.length, 1, '成功的改动要写成事实');
  assert.equal(events[0]?.version, 1);
  assert.equal(events[0]?.scope, 'surface.main');
  assert.equal(events[0]?.op, 'upsert');
  assert.deepEqual((events[0]?.spec as { title?: string } | undefined)?.title, '预算');

  // 非法 spec → 拒绝，且**不**写事件
  const bad = ingest.ingest({ scope: 'surface.main', op: 'upsert', spec: { type: '不存在的组件' } });
  assert.equal(bad.ok, false);
  assert.equal(log.read().filter((event) => event.type === 'ui.patch').length, 1, '被拒绝的不留事件');
});

// @spec SURF-015
test('重启不丢：按事件日志回放，界面与版本号原样回来（且回放不产生新事件）', () => {
  const dir = tempDir('replay');
  const eventsDir = path.join(dir, 'events');

  // 第一次「运行」：画两版
  const log1 = new EventLog({ dir: eventsDir });
  const session1 = new ClientSession({ dir, log: log1, lead: { script: [{ text: 'ok', done: true }] } });
  session1.runner.ingest.ingest({ scope: 'surface.main', op: 'upsert', spec: PANEL });
  session1.runner.ingest.ingest({
    scope: 'surface.sidebar',
    op: 'mount',
    spec: { type: 'badge', text: '就绪', tone: 'success' },
  });
  const before = session1.surfaceVersions();
  const sizeBefore = fs.statSync(path.join(eventsDir, 'events.jsonl')).size;
  assert.equal(session1.state().document.version, 2);

  // 「重启」：新会话读同一份日志
  const log2 = new EventLog({ dir: eventsDir });
  const session2 = new ClientSession({ dir, log: log2, lead: { script: [{ text: 'ok', done: true }] } });

  assert.equal(session2.state().document.version, 2, '版本号要回到重启前');
  assert.deepEqual(session2.state().document.scopes.sort(), ['surface.main', 'surface.sidebar']);
  assert.match(String(session2.state().document.html), /还有 42%/);
  assert.match(String(session2.state().document.html), /就绪/);

  const after = session2.surfaceVersions();
  assert.deepEqual(
    after.map((item) => item.version),
    before.map((item) => item.version),
    '版本清单也要回来',
  );

  // 回放不能再写事件：否则每重启一次日志就滚一倍
  assert.equal(
    fs.statSync(path.join(eventsDir, 'events.jsonl')).size,
    sizeBefore,
    '回放必须是幂等的（不产生新事件）',
  );
});

// @spec SURF-016
test('回滚也是一次变更：回滚后重启，文档停在回滚后的版本', () => {
  const dir = tempDir('rollback');
  const eventsDir = path.join(dir, 'events');

  const log1 = new EventLog({ dir: eventsDir });
  const session1 = new ClientSession({ dir, log: log1, lead: { script: [{ text: 'ok', done: true }] } });
  session1.runner.ingest.ingest({ scope: 'surface.main', op: 'upsert', spec: PANEL });
  session1.runner.ingest.ingest({ scope: 'surface.main', op: 'upsert', spec: { type: 'text', text: '第二版' } });
  assert.equal(session1.state().document.version, 2);

  const rolled = session1.rollback(1);
  assert.equal(rolled.ok, true);
  assert.equal(
    session1.runner.log.read().some((event) => event.type === 'surface.rollback'),
    true,
    '回滚要留痕，否则重启后回滚就丢了',
  );
  const versionAfterRollback = session1.state().document.version;
  assert.equal(versionAfterRollback, 3, '版本号只增不减：回滚是新的一版');
  assert.match(String(session1.state().document.html), /还有 42%/);

  // 重启
  const session2 = new ClientSession({
    dir,
    log: new EventLog({ dir: eventsDir }),
    lead: { script: [{ text: 'ok', done: true }] },
  });
  assert.match(
    String(session2.state().document.html),
    /还有 42%/,
    '重启后应当停在回滚后的内容，而不是回滚之前',
  );
  assert.equal(session2.state().document.version, 3, '回放产生的版本序列要与重启前完全一致（不多长出版本）');
  assert.deepEqual(session2.surfaceVersions().map((item) => item.version), [3, 2, 1, 0]);
  assert.equal(String(session2.state().document.html).includes('第二版'), false);
});

// @spec SURF-017
test('版本清单接口：从新到旧、带时间与区块数，时间取不到不编造', async () => {
  const dir = tempDir('list');
  const log = new EventLog({ dir: path.join(dir, 'events') });
  const session = new ClientSession({ dir, log, lead: { script: [{ text: 'ok', done: true }] } });
  session.runner.ingest.ingest({ scope: 'surface.main', op: 'upsert', spec: PANEL });
  session.runner.ingest.ingest({ scope: 'surface.sidebar', op: 'mount', spec: { type: 'badge', text: '就绪' } });

  const server = await startServer({ session, port: 0 });
  try {
    const body = (await (await fetch(`${server.url}/api/surface/versions`)).json()) as {
      ok: boolean;
      current: number;
      versions: Array<{ version: number; ts: string; scopes: string[]; note: string }>;
    };
    assert.equal(body.ok, true);
    assert.equal(body.current, 2);
    assert.deepEqual(body.versions.map((item) => item.version), [2, 1, 0], '最新的排最前');
    assert.deepEqual(body.versions[0]?.scopes, ['surface.main', 'surface.sidebar']);
    assert.match(String(body.versions[0]?.ts), /^\d{4}-\d{2}-\d{2}T/, '时间戳来自事件日志');
    assert.equal(body.versions[2]?.ts, '', 'v0 没有对应事件：给空串，不编造时间');
  } finally {
    await server.close();
    await session.close();
  }
});

// @spec SURF-018
test('客户端版本列表：vN · 时间 · 区块数，当前标注、坏输入不炸', async () => {
  const module = (await import(new URL('../src/client/conversations.js', import.meta.url).href)) as {
    renderSurfaceVersions(raw: unknown): string;
    surfaceVersionLabel(entry: unknown): string;
    normalizeSurfaceVersions(raw: unknown): { current: number | null; versions: unknown[] };
  };

  const raw = {
    ok: true,
    current: 7,
    versions: [
      { version: 7, ts: '2026-10-03T13:04:12.000Z', scopes: ['surface.main'], note: '' },
      { version: 6, ts: '', scopes: [], note: '初始空文档' },
    ],
  };
  const html = module.renderSurfaceVersions(raw);
  assert.match(html, /value="7" selected/);
  assert.match(html, /（当前）/);
  assert.match(html, /1 个区块/);
  assert.match(html, /空文档/, '没有区块就说空文档');
  assert.match(html, /v6/);

  // 坏输入退化为空，不抛异常
  assert.equal(module.renderSurfaceVersions(null), '');
  assert.equal(module.renderSurfaceVersions({ versions: 'nope' }), '');
  assert.deepEqual(module.normalizeSurfaceVersions(null).versions, []);

  // 接线：下拉 + 恢复按钮 + 两个接口路径都在
  const appSource = fs.readFileSync(new URL('../src/client/app.js', import.meta.url), 'utf8');
  assert.match(appSource, /loadSurfaceVersions/);
  assert.match(appSource, /renderSurfaceVersions/);
  assert.match(appSource, /\/api\/rollback/);
  assert.equal(appSource.includes('window.prompt('), false, '不再让人凭记忆敲版本号');
});

// @spec SURF-019
test('重启后的第一帧必须真的画出来：兜底要主动认定 iframe 就绪，重绘要在加载之后', () => {
  const appSource = fs.readFileSync(new URL('../src/client/app.js', import.meta.url), 'utf8');
  const browserSource = fs.readFileSync(new URL('../src/client/browser.js', import.meta.url), 'utf8');

  // 真 bug：首次 load 早于挂监听时 iframeLoaded 永远为 false，
  // 之后所有界面都堆在 pendingHtml 里 —— 面板空白、srcdoc 为空（重启后就是这个现象）。
  assert.match(
    appSource,
    /requestAnimationFrame\(\(\) => \{[^}]*state\.iframeLoaded = true;[^}]*flushPendingSurface\(\);/s,
    '启动兜底必须先把 iframe 认定成就绪，再补画待画内容',
  );
  assert.match(
    browserSource,
    /requestAnimationFrame\(\(\) => \{[^}]*loaded = true;[^}]*flushPendingBrowser\(\);/s,
    '浏览器面板的兜底同理：不能只补画，不认就绪',
  );

  // 重绘必须在 load 之后：导航没起来就藏起来会把这次导航撤掉（第一版就是这么错的）
  assert.match(appSource, /if \(surfaceNudgePending\) \{\s*surfaceNudgePending = false;\s*nudgeSurface\(\);/);
  assert.match(browserSource, /if \(nudgePending\) \{\s*nudgePending = false;\s*nudgePaint\(\);/);
  // 并且两个面板都写了「消失一帧」这个动作本身
  assert.match(appSource, /style\.display = 'none';[\s\S]{0,400}requestAnimationFrame\(restore\)/);
  assert.match(browserSource, /style\.display = 'none';[\s\S]{0,400}requestAnimationFrame\(restore\)/);
});
