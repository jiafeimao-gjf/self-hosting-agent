import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { ClientSession } from '../src/server/session.ts';
import { startServer } from '../src/server/http-server.ts';
import {
  DEFAULT_MODEL_SETTINGS,
  SettingsStore,
  labelFor,
  maskApiKey,
  migrateLegacySettings,
  settingsToAgentEnv,
} from '../src/server/settings.ts';
import { ConversationRegistry } from '../src/server/conversations.ts';
import { fetchModelList } from '../src/server/models.ts';
import type { ModelSettings } from '../src/server/settings.ts';
import { AgentPool } from '../src/kernel/pool.ts';
import type { Frame } from '../src/protocol/frames.ts';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agent-client-settings-${prefix}-`));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate: () => boolean, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error('waitUntil 超时');
}

function waitForFrame(handle: { onFrame: (cb: (frame: Frame) => void) => () => void }, predicate: (frame: Frame) => boolean, timeoutMs = 20000): Promise<Frame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error('等待帧超时'));
    }, timeoutMs);
    const off = handle.onFrame((frame) => {
      if (!predicate(frame)) return;
      clearTimeout(timer);
      off();
      resolve(frame);
    });
  });
}

interface FakeServer {
  url: string;
  requests: Array<{ url: string; headers: http.IncomingHttpHeaders; body: string }>;
  close(): Promise<void>;
}

/** 起一个假的 OpenAI / Anthropic 服务，用来验证协议真的发出去了 */
async function fakeModelServer(responder: (request: { url: string; body: unknown }) => unknown): Promise<FakeServer> {
  const requests: FakeServer['requests'] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      let parsed: unknown = undefined;
      try {
        parsed = JSON.parse(body);
      } catch {
        /* 忽略 */
      }
      requests.push({ url: req.url ?? '', headers: req.headers, body });
      const payload = responder({ url: req.url ?? '', body: parsed });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    // fetch 走 keep-alive，光 close() 会一直等存量连接 —— 必须主动断开
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

async function withServer(
  options: ConstructorParameters<typeof ClientSession>[0],
  fn: (ctx: { session: ClientSession; url: string }) => Promise<void>,
): Promise<void> {
  const session = new ClientSession(options);
  const server = await startServer({ session, port: 0 });
  try {
    await fn({ session, url: server.url });
  } finally {
    await server.close();
    await session.close();
  }
}

// @spec SET-001
test('无配置时的默认值是本机 Ollama（openai 协议），且未设 Key 也能用', () => {
  const store = new SettingsStore({ file: path.join(tempDir('default'), 'settings.json') });
  const settings = store.load();
  assert.equal(settings.protocol, 'openai');
  assert.match(settings.baseUrl, /11434/);
  assert.equal(settings.model.length > 0, true);
  assert.equal(settings.apiKey, '');

  const publicSettings = store.toPublic(settings);
  assert.equal(publicSettings.hasApiKey, false);
  assert.equal(publicSettings.apiKeyMasked, '');
  assert.equal(publicSettings.label, '本机 Ollama');
  assert.deepEqual(DEFAULT_MODEL_SETTINGS.protocol, 'openai');
});

// @spec SET-002
test('保存后可读回并落盘，文件权限 0600', () => {
  const dir = tempDir('persist');
  const file = path.join(dir, 'settings.json');
  const store = new SettingsStore({ file });

  const saved = store.save(
    { protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5', apiKey: 'sk-ant-1234567890' },
    store.load(),
  );
  assert.equal(saved.ok, true);

  assert.equal(fs.existsSync(file), true);
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, `设置文件必须只有本人可读，实际 ${mode.toString(8)}`);

  const reloaded = new SettingsStore({ file }).load();
  assert.equal(reloaded.protocol, 'anthropic');
  assert.equal(reloaded.model, 'claude-sonnet-4-5');
  assert.equal(reloaded.apiKey, 'sk-ant-1234567890');
});

// @spec SET-003
test('永不回传明文 Key：GET /api/settings 只给打码串', async () => {
  const secret = 'sk-ant-super-secret-value';
  await withServer(
    {
      dir: tempDir('mask'),
      modelSettings: { protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-x', apiKey: secret },
      lead: { script: [{ text: 'hi', done: true }] },
    },
    async ({ url }) => {
      const response = await fetch(`${url}/api/settings`);
      const raw = await response.text();
      assert.equal(response.status, 200);
      assert.equal(raw.includes(secret), false, '响应里不许出现明文 Key');

      const json = JSON.parse(raw) as { apiKeyMasked: string; hasApiKey: boolean; apiKey?: string };
      assert.equal(json.hasApiKey, true);
      assert.equal(json.apiKey, undefined);
      assert.match(json.apiKeyMasked, /^sk-…/);
    },
  );
});

// @spec SET-004
test('PUT 省略或传空 apiKey → 保留原 Key；传新 Key → 覆盖', async () => {
  await withServer(
    {
      dir: tempDir('keep'),
      modelSettings: { protocol: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:4b', apiKey: 'sk-old-key-123456' },
      lead: { script: [{ text: 'hi', done: true }] },
    },
    async ({ session, url }) => {
      const put = async (body: Record<string, unknown>): Promise<void> => {
        const response = await fetch(`${url}/api/settings`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        assert.equal(response.status, 200, JSON.stringify(await response.json()));
      };

      await put({ model: 'qwen3:8b' }); // 不带 apiKey
      const store = new SettingsStore({ file: path.join(session.dir, 'settings.json') });
      assert.equal(store.load().apiKey, 'sk-old-key-123456', '省略 Key 时必须保留');
      assert.equal(store.load().model, 'qwen3:8b');

      await put({ apiKey: '' });
      assert.equal(store.load().apiKey, 'sk-old-key-123456', '空字符串同样视为不修改');

      await put({ apiKey: 'sk-new-key-abcdef' });
      assert.equal(store.load().apiKey, 'sk-new-key-abcdef');
    },
  );
});

// @spec SET-005
test('保存设置会重启 Lead，历史上下文仍在（事件日志投影）', async () => {
  const session = new ClientSession({
    dir: tempDir('restart'),
    modelSettings: { protocol: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:4b' },
    lead: { script: [{ text: '第一轮回复', done: true }] },
    agentEnv: { AGENT_MODEL: 'demo' },
  });

  try {
    session.start();
    const firstPid = (await waitUntil(() => session.runner.pool.get('lead') !== undefined), session.state().agents[0]?.pid);
    void firstPid;

    const doneCount = (): number => session.state().events.filter((event) => event.type === 'agent.frame').length;
    const before = doneCount();

    session.send('第一轮提问');
    await waitUntil(() => session.conversation().some((item) => item.text === '第一轮提问'));
    await waitUntil(() => session.state().busy === false, 20000);

    const pidBefore = session.runner.pool.get('lead')?.pid;

    const updated = session.updateSettings({ model: 'another-model' });
    assert.equal(updated.ok, true);
    assert.equal(updated.restarted, true);

    await waitUntil(() => {
      const handle = session.runner.pool.get('lead');
      return handle !== undefined && handle.pid !== pidBefore;
    }, 20000);

    session.send('第二轮提问');
    await waitUntil(() => session.conversation().some((item) => item.text === '第二轮提问'), 20000);

    const texts = session.conversation().map((item) => item.text);
    assert.equal(texts.includes('第一轮提问'), true, '重启后第一轮的人类消息仍在');
    assert.equal(texts.includes('第一轮回复'), true, '重启后第一轮的回复仍在');
    assert.equal(texts.includes('第二轮提问'), true);
    assert.equal(before >= 0, true);
  } finally {
    await session.close();
  }
});

// @spec SET-006
test('连接测试：通就返回延迟与回复，不通就返回可读错误', async () => {
  const fake = await fakeModelServer(() => ({
    choices: [{ message: { role: 'assistant', content: '你好' } }],
    usage: { total_tokens: 3 },
  }));

  try {
    await withServer(
      { dir: tempDir('test-ok'), lead: { script: [{ text: 'hi', done: true }] } },
      async ({ session }) => {
        const ok = await session.testSettings({
          protocol: 'openai',
          baseUrl: `${fake.url}/v1`,
          model: 'fake-model',
          apiKey: 'sk-test',
        });
        assert.equal(ok.ok, true, JSON.stringify(ok));
        assert.equal(typeof ok.latencyMs, 'number');
        assert.match(String(ok.reply), /你好/);
        assert.equal(fake.requests.length, 1);
        assert.equal(fake.requests[0]?.url, '/v1/chat/completions');
      },
    );

    await withServer(
      { dir: tempDir('test-fail'), lead: { script: [{ text: 'hi', done: true }] } },
      async ({ session }) => {
        const bad = await session.testSettings({
          protocol: 'openai',
          baseUrl: 'http://127.0.0.1:9/v1',
          model: 'nope',
          apiKey: '',
        });
        assert.equal(bad.ok, false);
        assert.equal(String(bad.error).length > 0, true);
      },
    );
  } finally {
    await fake.close();
  }
});

// @spec SET-007
test('协议贯通到子进程：AGENT_PROTOCOL=anthropic 时走 /v1/messages', async () => {
  const fake = await fakeModelServer(() => ({
    content: [{ type: 'text', text: '来自 Anthropic 适配器' }],
    usage: { input_tokens: 5, output_tokens: 7 },
  }));

  const pool = new AgentPool();
  try {
    const handle = pool.spawn({
      agentId: 'lead',
      logDir: tempDir('anthropic-agent'),
      env: {
        AGENT_MODEL: 'http',
        AGENT_PROTOCOL: 'anthropic',
        AGENT_BASE_URL: fake.url,
        AGENT_API_KEY: 'sk-ant-test',
        AGENT_MODEL_NAME: 'claude-test',
      },
    });

    const thinking = waitForFrame(handle, (frame) => frame.t === 'agent.thinking');
    handle.send({ t: 'human.message', text: '你好' });
    assert.match(String((await thinking).text), /Anthropic 适配器/);

    assert.equal(fake.requests.length, 1);
    assert.equal(fake.requests[0]?.url, '/v1/messages');
    assert.equal(fake.requests[0]?.headers['x-api-key'], 'sk-ant-test');
    assert.equal(typeof fake.requests[0]?.headers['anthropic-version'], 'string');

    const body = JSON.parse(fake.requests[0]?.body ?? '{}') as { model?: string; system?: string };
    assert.equal(body.model, 'claude-test');
    assert.equal(typeof body.system, 'string', 'system 必须提到顶层');
  } finally {
    await pool.shutdown();
    await fake.close();
  }
});

// @spec SET-008
test('设置变更广播 settings 事件，state.model 同步更新', async () => {
  await withServer(
    { dir: tempDir('broadcast'), lead: { script: [{ text: 'hi', done: true }] } },
    async ({ session, url }) => {
      const events: string[] = [];
      session.onEvent((event) => events.push(event.type));

      const response = await fetch(`${url}/api/settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5' }),
      });
      assert.equal(response.status, 200);
      assert.equal(events.includes('settings'), true, '必须广播 settings 事件');

      const state = session.state();
      assert.equal(state.model.protocol, 'anthropic');
      assert.equal(state.model.model, 'claude-sonnet-4-5');
      assert.equal(state.model.label, 'Anthropic 官方');
    },
  );
});

// @spec SET-009
test('非法输入被拒绝且不落盘', async () => {
  await withServer(
    { dir: tempDir('invalid'), lead: { script: [{ text: 'hi', done: true }] } },
    async ({ session, url }) => {
      const cases: Array<Record<string, unknown>> = [
        { protocol: 'gemini' },
        { baseUrl: '' },
        { baseUrl: '不是网址' },
        { model: '' },
        { model: 'x', temperature: '热' },
      ];

      for (const body of cases) {
        const response = await fetch(`${url}/api/settings`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        assert.equal(response.status, 400, `${JSON.stringify(body)} 应当被拒绝`);
      }

      assert.equal(fs.existsSync(path.join(session.dir, 'settings.json')), false, '被拒的输入不得落盘');
      assert.equal(session.publicSettings().model.length > 0, true);
    },
  );
});

// @spec SET-010
test('打码规则：足够长显示头尾，短的一律遮住', () => {
  assert.equal(maskApiKey(''), '');
  assert.equal(maskApiKey('short'), '•••••');
  assert.equal(maskApiKey('12345678'), '••••••••');
  assert.equal(maskApiKey('sk-ant-1234567890abcd'), 'sk-…abcd');
  assert.equal(maskApiKey('sk-ant-1234567890abcd').includes('1234567890'), false);

  // 来源标签
  const label = (settings: Partial<ModelSettings>): string => labelFor({ ...DEFAULT_MODEL_SETTINGS, ...settings });
  assert.equal(label({ protocol: 'openai', baseUrl: 'http://127.0.0.1:11434/v1' }), '本机 Ollama');
  // 本机的自定义端口不该被冒充成 Ollama
  assert.equal(label({ protocol: 'openai', baseUrl: 'http://127.0.0.1:4399/v1' }), '本机端点');
  assert.equal(label({ protocol: 'anthropic', baseUrl: 'https://api.anthropic.com' }), 'Anthropic 官方');
  assert.equal(label({ baseUrl: 'https://api.deepseek.com' }), 'DeepSeek');
  assert.equal(label({ baseUrl: 'https://my-gateway.internal/v1' }), '自定义端点');

  // 设置 → 环境变量
  const env = settingsToAgentEnv({ protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'm', apiKey: 'k' });
  assert.equal(env.AGENT_PROTOCOL, 'anthropic');
  assert.equal(env.AGENT_BASE_URL, 'https://api.anthropic.com');
  assert.equal(env.AGENT_MODEL, 'http');
});

// @spec SET-013
test('模型配置按对话隔离：设置接口跟着 ?conversation= 走', async () => {
  const root = tempDir('scope-root');
  const registry = new ConversationRegistry({
    root,
    open: (id, dir) => new ClientSession({ dir, id, lead: { script: [{ text: 'ok', done: true }] } }),
  });
  const session = registry.get('default');
  session.updateSettings({ protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKey: 'sk-default-key-1' });

  const server = await startServer({ session, registry, port: 0 });
  try {
    const created = await fetch(`${server.url}/api/conversations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '另一个对话' }),
    });
    const id = String(((await created.json()) as { conversation: { id: string } }).conversation.id);

    // 在新对话里改成另一套配置
    const put = await fetch(`${server.url}/api/settings?conversation=${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:4b', apiKey: '' }),
    });
    assert.equal(put.status, 200);

    const readDefault = (await (await fetch(`${server.url}/api/settings?conversation=default`)).json()) as { model: string };
    const readOther = (await (await fetch(`${server.url}/api/settings?conversation=${id}`)).json()) as { model: string };
    assert.equal(readDefault.model, 'deepseek-flash', 'default 的配置不能被另一个对话改掉');
    assert.equal(readOther.model, 'qwen3:4b');

    // 连接测试同理：必须打的是该对话自己的端点
    assert.equal(session.publicSettings().model, 'deepseek-flash');
    assert.equal(registry.get(id).publicSettings().model, 'qwen3:4b');
  } finally {
    await server.close();
    await registry.closeAll();
  }
});

// @spec SET-014
test('新建对话继承当前对话的模型配置，而不是回落到内置默认', async () => {
  const root = tempDir('inherit-root');
  const registry = new ConversationRegistry({
    root,
    open: (id, dir) => new ClientSession({ dir, id, lead: { script: [{ text: 'ok', done: true }] } }),
  });
  const session = registry.get('default');
  session.updateSettings({
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-flash',
    apiKey: 'sk-inherit-me-9876',
    timeoutMs: 120000,
  });

  const server = await startServer({ session, registry, port: 0 });
  try {
    const response = await fetch(`${server.url}/api/conversations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '继承者' }),
    });
    const id = String(((await response.json()) as { conversation: { id: string } }).conversation.id);

    const settings = (await (await fetch(`${server.url}/api/settings?conversation=${id}`)).json()) as {
      model: string;
      baseUrl: string;
      apiKeyMasked: string;
      timeoutMs: number;
      label: string;
    };
    assert.equal(settings.model, 'deepseek-flash', '新对话必须继承模型，而不是回到 qwen3:4b');
    assert.equal(settings.baseUrl, 'https://api.deepseek.com/v1');
    assert.equal(settings.timeoutMs, 120000);
    assert.match(settings.apiKeyMasked, /9876$/, 'Key 也要继承，否则新对话根本用不了');
    assert.notEqual(settings.label, '本机 Ollama');

    // 已配过的对话不被覆盖
    const again = registry.get(id);
    const before = again.publicSettings().model;
    again.inheritSettingsFrom(session);
    assert.equal(again.publicSettings().model, before);
  } finally {
    await server.close();
    await registry.closeAll();
  }
});

// @spec SET-015
test('旧位置 <root>/settings.json 幂等迁移进默认对话，老文件保留', () => {
  const root = tempDir('legacy-root');
  const legacy = path.join(root, 'settings.json');
  const target = path.join(root, 'conversations', 'default', 'settings.json');
  fs.writeFileSync(
    legacy,
    `${JSON.stringify({ protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKey: 'sk-legacy-key-4242', timeoutMs: 180000 })}\n`,
    'utf8',
  );

  const first = migrateLegacySettings(root);
  assert.equal(first.migrated, true);
  assert.equal(fs.existsSync(target), true);
  assert.equal(fs.existsSync(legacy), true, '老文件保留，不悄悄删掉带 Key 的东西');
  assert.equal((JSON.parse(fs.readFileSync(target, 'utf8')) as { model: string }).model, 'deepseek-flash');

  // 幂等：再来一次不覆盖（用户后来配的优先）
  fs.writeFileSync(target, `${JSON.stringify({ protocol: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:4b', apiKey: '', timeoutMs: 180000 })}\n`, 'utf8');
  const second = migrateLegacySettings(root);
  assert.equal(second.migrated, false);
  assert.equal((JSON.parse(fs.readFileSync(target, 'utf8')) as { model: string }).model, 'qwen3:4b', '已有配置不能被旧文件盖回去');

  // 没有旧文件时什么都不做
  const empty = tempDir('legacy-empty');
  assert.equal(migrateLegacySettings(empty).migrated, false);
});

// @spec SET-016
test('列模型：两家协议各走各的端点，错误可归因且绝不回显 Key', async () => {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const fake = (payload: unknown, status = 200): typeof fetch =>
    (async (url: string, init: { headers?: Record<string, string> }) => {
      seen.push({ url: String(url), headers: init.headers ?? {} });
      return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

  const openai = await fetchModelList(
    { protocol: 'openai', baseUrl: 'https://gw.example.com/v1', model: 'x', apiKey: 'sk-secret-123' },
    { fetchImpl: fake({ data: [{ id: 'b-model' }, { id: 'a-model' }] }) },
  );
  assert.equal(openai.ok, true);
  assert.deepEqual(openai.ok === true ? openai.models.map((m) => m.id) : [], ['a-model', 'b-model'], '结果要排序，便于点选');
  assert.equal(seen[0]?.url, 'https://gw.example.com/v1/models');
  assert.equal(seen[0]?.headers.authorization, 'Bearer sk-secret-123');

  // Anthropic：端点与鉴权头都不同
  const anthropic = await fetchModelList(
    { protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'x', apiKey: 'sk-ant-999' },
    { fetchImpl: fake({ data: [{ id: 'claude-x', display_name: 'Claude X' }] }) },
  );
  assert.equal(anthropic.ok, true);
  assert.deepEqual(anthropic.ok === true ? anthropic.models : [], [{ id: 'claude-x', label: 'Claude X' }]);
  assert.equal(seen[1]?.url, 'https://api.anthropic.com/v1/models');
  assert.equal(seen[1]?.headers['x-api-key'], 'sk-ant-999');

  // 空 Key 的本机端点不带 Bearer（带一个空的反而可能被网关拒）
  await fetchModelList(
    { protocol: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', model: 'x', apiKey: '' },
    { fetchImpl: fake({ data: [] }) },
  );
  assert.equal('authorization' in (seen[2]?.headers ?? {}), false);

  // 鉴权失败：错误里绝不能出现 Key
  const denied = await fetchModelList(
    { protocol: 'openai', baseUrl: 'https://gw.example.com/v1', model: 'x', apiKey: 'sk-secret-123' },
    { fetchImpl: fake({ error: 'invalid api key' }, 401) },
  );
  assert.equal(denied.ok, false);
  assert.equal(denied.ok === false && denied.code, 'UNAUTHORIZED');
  assert.equal(JSON.stringify(denied).includes('sk-secret-123'), false, '错误信息里不得回显 Key');

  // 响应格式不对 / 超时
  const badShape = await fetchModelList(
    { protocol: 'openai', baseUrl: 'https://gw.example.com/v1', model: 'x', apiKey: '' },
    { fetchImpl: fake({ nope: true }) },
  );
  assert.equal(badShape.ok === false && badShape.code, 'BAD_RESPONSE');

  // 真 fetch 在 abort 时会 reject —— 夹具必须照做，否则测的是「响应格式不对」而不是超时
  const stalled = ((_url: string, init: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
    })) as unknown as typeof fetch;
  const timedOut = await fetchModelList(
    { protocol: 'openai', baseUrl: 'https://gw.example.com/v1', model: 'x', apiKey: '' },
    { fetchImpl: stalled, timeoutMs: 30 },
  );
  assert.equal(timedOut.ok === false && timedOut.code, 'TIMEOUT');

  // 条目上限
  const many = await fetchModelList(
    { protocol: 'openai', baseUrl: 'https://gw.example.com/v1', model: 'x', apiKey: '' },
    { fetchImpl: fake({ data: Array.from({ length: 500 }, (_, i) => ({ id: `m-${i}` })) }) },
  );
  assert.equal(many.ok === true && many.models.length, 200);
});

// @spec SET-016
test('列模型的 HTTP 接口：候选配置不写盘，非法配置 400', async () => {
  const session = new ClientSession({
    dir: tempDir('models-http'),
    lead: { script: [{ text: 'ok', done: true }] },
  });
  const server = await startServer({ session, port: 0 });
  try {
    const invalid = await fetch(`${server.url}/api/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: 'openai', baseUrl: '', model: '' }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(session.publicSettings().baseUrl, DEFAULT_MODEL_SETTINGS.baseUrl, '列模型不得改动已生效的配置');
  } finally {
    await server.close();
    await session.close();
  }
});
