import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { ClientSession } from '../src/server/session.ts';
import { startServer } from '../src/server/http-server.ts';
import type { RunningServer } from '../src/server/http-server.ts';

const PANEL = {
  type: 'panel',
  title: '今日预算',
  children: [{ type: 'progress', label: 'token', value: 0.62, tone: 'warning' }],
};

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agent-client-server-${prefix}-`));
}

interface SseClient {
  events: Array<{ event: string; data: unknown }>;
  waitFor(predicate: (event: { event: string; data: unknown }) => boolean, timeoutMs?: number): Promise<{ event: string; data: unknown }>;
  close(): void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 极简 SSE 客户端：够测试用，不引依赖 */
async function openSse(url: string): Promise<SseClient> {
  const controller = new AbortController();
  const response = await fetch(url, {
    signal: controller.signal,
    headers: { accept: 'text/event-stream' },
  });
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('没有 SSE 响应体');

  const events: Array<{ event: string; data: unknown }> = [];
  const decoder = new TextDecoder();

  void (async () => {
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let separator = buffer.indexOf('\n\n');
        while (separator >= 0) {
          const chunk = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          separator = buffer.indexOf('\n\n');
          if (chunk.startsWith(':')) continue; // 心跳
          let name = 'message';
          const dataLines: string[] = [];
          for (const line of chunk.split('\n')) {
            if (line.startsWith('event:')) name = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          }
          if (dataLines.length === 0) continue;
          try {
            events.push({ event: name, data: JSON.parse(dataLines.join('\n')) });
          } catch {
            /* 忽略坏块 */
          }
        }
      }
    } catch {
      /* abort 或断开 */
    }
  })();

  return {
    events,
    async waitFor(predicate, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = events.find(predicate);
        if (hit !== undefined) return hit;
        if (Date.now() >= deadline) {
          throw new Error(`等待 SSE 事件超时，已收到：${events.map((event) => event.event).join(',')}`);
        }
        await sleep(20);
      }
    },
    close: () => controller.abort(),
  };
}

async function postJson(url: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await response.json()) as Record<string, unknown>;
  return { status: response.status, json };
}

async function withServer(
  sessionOptions: ConstructorParameters<typeof ClientSession>[0],
  fn: (ctx: { session: ClientSession; server: RunningServer; sse: SseClient }) => Promise<void>,
): Promise<void> {
  const session = new ClientSession({ dir: tempDir('s'), ...sessionOptions });
  const server = await startServer({ session, port: 0 });
  const sse = await openSse(`${server.url}/api/stream`);
  try {
    await fn({ session, server, sse });
  } finally {
    sse.close();
    await server.close();
    await session.close();
  }
}

// @spec CLI-001
test('GET /api/state 返回界面文档、进程表、任务板、消息与事件尾部', async () => {
  await withServer({ lead: { script: [{ text: '你好', uiPatches: [{ scope: 'surface.main', op: 'mount', spec: PANEL }], done: true }] } }, async ({ session, server }) => {
    session.start();
    const response = await fetch(`${server.url}/api/state`);
    assert.equal(response.status, 200);
    const state = (await response.json()) as Record<string, unknown>;

    for (const key of ['busy', 'document', 'agents', 'tasks', 'events', 'messages']) {
      assert.ok(key in state, `state 缺少字段 ${key}`);
    }
    const agents = state.agents as Array<{ id: string; pid: number }>;
    assert.equal(agents.some((agent) => agent.id === 'lead'), true);
    assert.equal(typeof agents[0]?.pid, 'number');
  });
});

// @spec CLI-002
test('SSE 建立连接后先收到一次 state 快照', async () => {
  await withServer({ lead: { script: [{ text: 'hi', done: true }] } }, async ({ sse }) => {
    const first = await sse.waitFor((event) => event.event === 'state', 5000);
    assert.ok(first.data && typeof first.data === 'object');
  });
});

// @spec CLI-003
test('POST /api/message 把人类输入交给 Lead，帧通过 SSE 实时推流', async () => {
  await withServer({ lead: { script: [{ text: '我收到了', done: true }] } }, async ({ server, sse }) => {
    const posted = await postJson(`${server.url}/api/message`, { text: '你好' });
    assert.equal(posted.status, 202);
    assert.equal(posted.json.ok, true);

    const frame = await sse.waitFor(
      (event) => event.event === 'frame' && (event.data as { frame: { t: string } }).frame.t === 'agent.thinking',
    );
    assert.match(String((frame.data as { frame: { text: string } }).frame.text), /我收到了/);

    const done = await sse.waitFor((event) => event.event === 'done');
    assert.equal((done.data as { reason: string }).reason, 'completed');
  });
});

// @spec CLI-004
test('Agent 改界面后客户端收到 document 事件，版本前进且 HTML 含该组件', async () => {
  await withServer({ lead: { script: [{ text: '画好了', uiPatches: [{ scope: 'surface.main', op: 'mount', spec: PANEL }], done: true }] } }, async ({ server, sse }) => {
    await postJson(`${server.url}/api/message`, { text: '把预算画出来' });

    const document = await sse.waitFor(
      (event) => event.event === 'document' && (event.data as { version: number }).version >= 1,
    );
    const payload = document.data as { version: number; html: string; scopes: string[] };
    assert.equal(payload.version, 1);
    assert.deepEqual(payload.scopes, ['surface.main']);
    assert.match(payload.html, /今日预算/);
  });
});

// @spec CLI-005
test('POST /api/interrupt 让在跑的一轮在边界停下，SSE 收到 done{interrupted}', async () => {
  await withServer(
    { lead: { script: [{ text: '一直在想', toolCalls: [{ id: 'x', name: 'budget', args: {} }] }], stepDelayMs: 300 } },
    async ({ server, sse }) => {
      await postJson(`${server.url}/api/message`, { text: '慢慢来' });
      await sleep(150);
      const interrupted = await postJson(`${server.url}/api/interrupt`, { reason: 'human_took_over' });
      assert.equal(interrupted.json.ok, true);

      const done = await sse.waitFor((event) => event.event === 'done');
      assert.equal((done.data as { reason: string }).reason, 'interrupted');
    },
  );
});

// @spec CLI-006
test('POST /api/rollback 把界面退回指定版本并广播新的 document 事件', async () => {
  await withServer(
    {
      lead: {
        script: [
          { uiPatches: [{ scope: 'surface.main', op: 'mount', spec: PANEL }], done: true },
          { uiPatches: [{ scope: 'surface.main', op: 'replace', spec: { type: 'panel', title: '第二版', children: [] } }], done: true },
        ],
      },
    },
    async ({ server, sse }) => {
      await postJson(`${server.url}/api/message`, { text: '第一版' });
      await sse.waitFor((event) => event.event === 'document' && (event.data as { version: number }).version === 1);

      await postJson(`${server.url}/api/message`, { text: '第二版' });
      await sse.waitFor((event) => event.event === 'document' && (event.data as { version: number }).version === 2);

      const rolled = await postJson(`${server.url}/api/rollback`, { version: 1 });
      assert.equal(rolled.status, 200);
      assert.equal(rolled.json.ok, true);

      const back = await sse.waitFor(
        (event) => event.event === 'document' && (event.data as { html: string }).html.includes('今日预算'),
      );
      assert.match((back.data as { html: string }).html, /今日预算/);
    },
  );
});

// @spec CLI-007
test('静态资源只允许 src/client 目录内：路径穿越被拒绝', async () => {
  await withServer({ lead: { script: [{ text: 'hi', done: true }] } }, async ({ server }) => {
    const escaped = await fetch(`${server.url}/../package.json`);
    assert.notEqual(escaped.status, 200, '不能读到仓库里的文件');

    const encoded = await fetch(`${server.url}/%2e%2e%2fpackage.json`);
    const text = await encoded.text();
    assert.equal(text.includes('"agent-client"'), false, '编码过的穿越同样不行');

    const ok = await fetch(`${server.url}/style.css`);
    assert.equal([200, 404].includes(ok.status), true, '正常路径不应被 403 拦掉');
  });
});

// @spec CLI-008
test('多轮记忆：第二轮上下文包含第一轮的人类消息与 Agent 回复（事件日志投影）', async () => {
  await withServer(
    {
      lead: {
        script: [
          { text: '第一轮回复', done: true },
          { text: '第二轮回复', done: true },
        ],
      },
    },
    async ({ session, server, sse }) => {
      await postJson(`${server.url}/api/message`, { text: '第一轮提问' });
      await sse.waitFor((event) => event.event === 'done');
      await postJson(`${server.url}/api/message`, { text: '第二轮提问' });
      await sse.waitFor((event) => event.event === 'done' && (event.data as { reason: string }).reason === 'completed');

      // 等第二条 done（两次 done 事件）
      const deadline = Date.now() + 10000;
      while (sse.events.filter((event) => event.event === 'done').length < 2 && Date.now() < deadline) {
        await sleep(20);
      }

      const conversation = session.conversation();
      const texts = conversation.map((item) => item.text);
      assert.deepEqual(texts, ['第一轮提问', '第一轮回复', '第二轮提问', '第二轮回复']);
      assert.equal(conversation[0]?.role, 'human');
      assert.equal(conversation[1]?.role, 'assistant');
    },
  );
});

// @spec CLI-009
test('模型不可用时客户端收到可读的错误帧，服务本身不崩', async () => {
  await withServer(
    { agentEnv: { AGENT_MODEL: 'http', AGENT_BASE_URL: 'http://127.0.0.1:9/v1', AGENT_MODEL_NAME: 'nope' } },
    async ({ server, sse }) => {
      await postJson(`${server.url}/api/message`, { text: '你好' });

      const error = await sse.waitFor(
        (event) => event.event === 'frame' && (event.data as { frame: { t: string } }).frame.t === 'loop.error',
        30000,
      );
      assert.ok(String((error.data as { frame: { message: string } }).frame.message).length > 0);

      // 服务还活着：state 仍可访问
      const state = await fetch(`${server.url}/api/state`);
      assert.equal(state.status, 200);
    },
  );
});

// @spec CLI-012
test('对话投影同时包含人类消息与 Agent 说过的话（只投影邮件会冲掉回复）', async () => {
  await withServer(
    { lead: { script: [{ text: '我收到了，这就去办', done: true }] } },
    async ({ session, server, sse }) => {
      await postJson(`${server.url}/api/message`, { text: '帮我看下预算' });
      await sse.waitFor((event) => event.event === 'done');

      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && !session.state().messages.some((item) => item.kind === 'assistant')) {
        await sleep(50);
      }

      const messages = session.state().messages;
      const humanAt = messages.findIndex((item) => item.kind === 'human' && item.body === '帮我看下预算');
      const agentAt = messages.findIndex((item) => item.kind === 'assistant' && item.body.includes('这就去办'));

      assert.equal(humanAt >= 0, true, '人类消息要在投影里');
      assert.equal(agentAt >= 0, true, 'Agent 的回复也要在投影里——前端整体重建才不会把回复冲掉');
      assert.ok(humanAt < agentAt, '顺序应当是人类先说、Agent 后答');
    },
  );
});

// @spec CLI-011
test('POST /api/client/revert 让人类不经过 Agent 就能回滚客户端源码', async () => {
  const clientRoot = tempDir('client-src');
  fs.writeFileSync(path.join(clientRoot, 'style.css'), ':root { --cyan: #22d3ee; }\n', 'utf8');

  const session = new ClientSession({
    dir: tempDir('revert-session'),
    clientRoot,
    selfTest: async () => ({ ok: true, checks: [], output: '' }),
    lead: { script: [{ text: 'hi', done: true }] },
  });
  const server = await startServer({ session, port: 0 });

  try {
    const source = session.clientSource;
    assert.ok(source, '应当接上源码管理器');
    const written = await source.write('style.css', ':root { --cyan: #f472b6; }\n', { reason: '换色' });
    assert.equal(written.ok, true);

    const response = await fetch(`${server.url}/api/client/revert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'style.css' }),
    });
    assert.equal(response.status, 200);
    const json = (await response.json()) as { ok: boolean };

    assert.equal(fs.readFileSync(path.join(clientRoot, 'style.css'), 'utf8'), ':root { --cyan: #22d3ee; }\n');
    assert.equal(fs.existsSync(path.join(clientRoot, 'style.css')), true);

    // 越界路径同样被拒
    const escaped = await fetch(`${server.url}/api/client/revert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '../package.json' }),
    });
    assert.equal(escaped.status, 400);
    assert.equal(json.ok, true);
  } finally {
    await server.close();
    await session.close();
  }
});

// @spec CLI-010
test('默认只监听 127.0.0.1，不对外暴露', async () => {
  const session = new ClientSession({ dir: tempDir('bind'), lead: { script: [{ text: 'hi', done: true }] } });
  const server = await startServer({ session, port: 0 });
  try {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const address = server.server.address();
    assert.equal(typeof address === 'object' && address !== null ? address.address : '', '127.0.0.1');

    // 明确拒绝被外部绑定：显式传 0.0.0.0 才可能对外
    const external = await fetch(`http://localhost:${server.port}/api/state`).catch(() => undefined);
    assert.ok(external === undefined || external.status === 200);
  } finally {
    await server.close();
    await session.close();
  }
});
