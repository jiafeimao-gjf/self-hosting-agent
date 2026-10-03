import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ClientSession } from '../src/server/session.ts';
import { startServer } from '../src/server/http-server.ts';
import { ConversationRegistry } from '../src/server/conversations.ts';
import { DEFAULT_MODEL_SETTINGS } from '../src/server/settings.ts';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agent-client-model-${prefix}-`));
}

/** 造一个带指定文件的运行目录 */
function writeSettings(file: string, model: string, extra: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ protocol: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', model, apiKey: '', ...extra }),
    { mode: 0o600 },
  );
}

/**
 * 等这一轮结束。
 *
 * 别用 `await session.send(...)` 代替：`send()` 是同步投递，它返回时回合**还没跑**。
 * 这个坑我在这条测试上先踩了一次——是测试的假设错了，不是实现的。
 */
async function waitIdle(session: ClientSession, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (session.state().busy !== true) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('等待本轮结束超时');
}

function openSession(root: string, id = 'default'): ClientSession {
  const dir = path.join(root, 'conversations', id);
  fs.mkdirSync(dir, { recursive: true });
  return new ClientSession({ dir, id, root, lead: { script: [{ text: 'ok', done: true }] } });
}

// @spec SET-018
test('配置解析顺序：对话覆盖 > 全局 > 内置默认', async () => {
  const sessions: ClientSession[] = [];
  try {
    // ① 两个文件都没有 → 内置默认
    const a = tempDir('a');
    sessions.push(openSession(a));
    assert.equal(sessions[0]?.publicSettings().model, DEFAULT_MODEL_SETTINGS.model);

    // ② 只有全局 → 用全局
    const b = tempDir('b');
    writeSettings(path.join(b, 'global-settings.json'), '全局模型');
    sessions.push(openSession(b));
    assert.equal(sessions[1]?.publicSettings().model, '全局模型');

    // ③ 两个都有 → 对话覆盖优先
    const c = tempDir('c');
    writeSettings(path.join(c, 'global-settings.json'), '全局模型');
    writeSettings(path.join(c, 'conversations', 'default', 'settings.json'), '对话模型');
    sessions.push(openSession(c));
    assert.equal(sessions[2]?.publicSettings().model, '对话模型');
  } finally {
    for (const session of sessions) await session.close();
  }
});

// @spec SET-019
test('新对话跟随全局；全局不存在时用当前活跃对话建立（幂等）', async () => {
  const root = tempDir('follow');
  writeSettings(path.join(root, 'conversations', 'default', 'settings.json'), '我的模型');

  const registry = new ConversationRegistry({
    root,
    open: (id, dir) => new ClientSession({ dir, id, root, lead: { script: [{ text: 'ok', done: true }] } }),
  });

  const source = registry.get('default');
  assert.equal(source.publicSettings().model, '我的模型');

  // 全局还不存在 → 由活跃对话建立
  const ensured = registry.ensureGlobalFrom(source);
  assert.equal(ensured.created, true);
  assert.equal(registry.globalSettings().model, '我的模型');

  // 幂等：再调一次不改写
  source.updateSettings({ model: '改过的' });
  assert.equal(registry.ensureGlobalFrom(source).created, false);
  assert.equal(registry.globalSettings().model, '我的模型', '全局不该被后续调用改写');

  // 新对话不写自己的文件 → 跟随全局
  const created = registry.create();
  const child = registry.get(created.id);
  assert.equal(child.publicSettings().model, '我的模型');
  assert.equal(
    fs.existsSync(path.join(root, 'conversations', created.id, 'settings.json')),
    false,
    '新对话不该复制一份自己的配置，否则"全局"形同虚设',
  );

  await source.close();
  await child.close();
});

// @spec SET-020
test('改全局：影响没有覆盖的对话，不影响已有覆盖的对话', async () => {
  const root = tempDir('global');
  writeSettings(path.join(root, 'global-settings.json'), '全局模型');
  writeSettings(path.join(root, 'conversations', 'overridden', 'settings.json'), '自己的模型');

  const registry = new ConversationRegistry({
    root,
    open: (id, dir) => new ClientSession({ dir, id, root, lead: { script: [{ text: 'ok', done: true }] } }),
  });

  const follower = registry.get('default');
  const own = registry.get('overridden');
  assert.equal(follower.publicSettings().model, '全局模型');
  assert.equal(own.publicSettings().model, '自己的模型');

  const saved = follower.updateGlobalSettings({ model: '新的全局模型' });
  assert.equal(saved.ok, true);
  assert.equal(registry.globalSettings().model, '新的全局模型');

  // 没有覆盖的对话跟着变（重新解析）
  assert.equal(follower.publicSettings().model, '新的全局模型');
  // 有覆盖的不动
  assert.equal(own.publicSettings().model, '自己的模型');
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(root, 'conversations', 'overridden', 'settings.json'), 'utf8')).model,
    '自己的模型',
  );

  await follower.close();
  await own.close();
});

// @spec SET-021
test('本轮进行中拒绝设置变更：不落盘、不重启，回合结束后成功', async () => {
  const root = tempDir('busy');
  const session = openSession(root);
  const before = session.publicSettings().model;

  try {
    // 注意：`send()` 是**同步投递**（不等待回合结束），所以同一 tick 内必然还在忙。
    session.send('第一问');
    const rejected = session.updateSettings({ model: '忙碌时不许换' });
    assert.equal(rejected.ok, false, '忙的时候必须拒绝');
    assert.match(String(rejected.error), /BUSY/, '要给出可读原因，别只说失败');
    assert.equal(session.publicSettings().model, before, '被拒绝的请求不许落盘');

    // 等 busy 被 loop.done 清掉（这才是"回合结束"）
    await waitIdle(session);

    const ok = session.updateSettings({ model: '空闲时换成这个' });
    assert.equal(ok.ok, true);
    assert.equal(session.publicSettings().model, '空闲时换成这个');
  } finally {
    await session.close();
  }
});

// @spec SET-022
test('输入框旁的切换器：当前模型一定在列表里，busy 时禁用并说明原因', async () => {
  const settings = (await import(new URL('../src/client/settings.js', import.meta.url).href)) as {
    modelSwitchOptions(models: unknown, current: unknown): Array<{ id: string; label: string }>;
    modelSwitchDisabled(busy: unknown): boolean;
    modelSwitchTitle(busy: unknown): string;
    renderModelSwitchOptions(options: unknown, current: unknown): string;
  };

  // 端点返回的列表里**没有**当前模型（模型被改名/下线）也不能丢——否则选择器显示空
  const options = settings.modelSwitchOptions([{ id: 'qwen3:4b' }, { id: 'glm-5:cloud' }], 'deepseek-flash');
  assert.equal(options[0]?.id, 'deepseek-flash', '当前模型必须排在第一位（它是最该显示出来的那个）');
  assert.equal(options.some((item) => item.id === 'qwen3:4b'), true);
  assert.equal(options.length, 3);

  // 去重：列表里已经有了就不重复加
  assert.equal(settings.modelSwitchOptions([{ id: 'deepseek-flash' }], 'deepseek-flash').length, 1);

  // 坏输入不炸
  assert.deepEqual(settings.modelSwitchOptions(null, '').length, 0);

  // 忙碌状态
  assert.equal(settings.modelSwitchDisabled(true), true);
  assert.equal(settings.modelSwitchDisabled(false), false);
  assert.match(settings.modelSwitchTitle(true), /结束|本轮/);
  assert.equal(settings.modelSwitchTitle(false), '切换本对话的模型');

  const html = settings.renderModelSwitchOptions(options, 'deepseek-flash');
  assert.match(html, /<option value="deepseek-flash" selected>/);
  assert.match(html, /<option value="qwen3:4b">/);

  // 接线：切换器在输入框旁边、改的是当前对话、模型清单走 /api/models
  const appSource = fs.readFileSync(new URL('../src/client/app.js', import.meta.url), 'utf8');
  assert.match(appSource, /modelSwitch/);
  assert.match(appSource, /\/api\/models/);
  assert.match(appSource, /scoped\('\/api\/settings'\)/);
  assert.match(appSource, /renderModelSwitchOptions/);
  const html2 = fs.readFileSync(new URL('../src/client/index.html', import.meta.url), 'utf8');
  assert.match(html2, /id="model-switch"/);
  assert.match(html2, /id="composer"[\s\S]*id="model-switch"[\s\S]*id="send"/, '切换器要在输入区里、发送键旁边');
});

// @spec SET-023
test('切换真的生效：Agent 按新模型重启，历史不丢', async () => {
  const root = tempDir('restart');
  const session = openSession(root);
  const server = await startServer({ session, port: 0 });

  try {
    await fetch(`${server.url}/api/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '先聊一句' }),
    });
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && session.state().messages.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const messagesBefore = session.state().messages.length;
    await waitIdle(session); // 本轮结束之后才允许改配置（SET-021）

    const response = await fetch(`${server.url}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: '换一个模型' }),
    });
    const body = (await response.json()) as { ok: boolean; restarted?: boolean; settings?: { model: string } };
    assert.equal(body.ok, true);
    assert.equal(body.settings?.model, '换一个模型');
    assert.equal(body.restarted, true, '换了模型必须让 Agent 用新配置重启');

    assert.ok(session.state().messages.length >= messagesBefore, '历史由事件日志投影而来，不该丢');
  } finally {
    await server.close();
    await session.close();
  }
});

// @spec SET-020
test('设为全局默认：Key 不经浏览器，由服务端内部复制', async () => {
  const root = tempDir('copy-global');
  const session = openSession(root);
  const server = await startServer({ session, port: 0 });

  try {
    await fetch(`${server.url}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocol: 'openai',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-flash',
        apiKey: 'sk-copy-global-1234',
      }),
    });

    // 浏览器只有打码后的 Key，所以只能发这个信号
    const response = await fetch(`${server.url}/api/settings?scope=global`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ copyFromConversation: true }),
    });
    assert.equal(response.status, 200);

    // 全局文件里必须**有**真实的 Key（否则新对话拿这份配置根本用不了）
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'global-settings.json'), 'utf8')) as {
      apiKey: string;
      model: string;
    };
    assert.equal(saved.apiKey, 'sk-copy-global-1234');
    assert.equal(saved.model, 'deepseek-flash');

    // 而回给浏览器的仍然是打码的
    const view = (await (await fetch(`${server.url}/api/settings?scope=global`)).json()) as {
      isSet: boolean;
      model: string;
      apiKeyMasked: string;
      hasApiKey: boolean;
    };
    assert.equal(view.isSet, true);
    assert.equal(view.model, 'deepseek-flash');
    assert.equal(view.hasApiKey, true);
    assert.equal(view.apiKeyMasked.includes('sk-copy-global-1234'), false, 'Key 永不回传明文');
  } finally {
    await server.close();
    await session.close();
  }
});
