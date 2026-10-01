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
  settingsToAgentEnv,
} from '../src/server/settings.ts';
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
