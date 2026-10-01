import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  AnthropicModelError,
  AnthropicModelTimeoutError,
  createAnthropicModel,
} from '../src/loop/anthropic-model.ts';
import type { ContextItem, ModelInput, ToolSpec } from '../src/loop/loop.ts';

// ── 本地假服务：全程离线，随机端口，绝不碰真实网络 ──

interface RecordedRequest {
  url: string;
  method: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

interface FakeReply {
  status?: number;
  json?: unknown;
  /** 直接给原始响应体（用于故意返回非 JSON） */
  text?: string;
  /** true = 收下请求但不回应，交给客户端超时 */
  hang?: boolean;
}

interface FakeServer {
  baseUrl: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

async function startFakeServer(
  handler: (ctx: { index: number; body: Record<string, unknown>; headers: http.IncomingHttpHeaders }) => FakeReply | Promise<FakeReply>,
): Promise<FakeServer> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
      } catch {
        body = { __raw: raw };
      }
      const index = requests.length;
      const headers = req.headers;
      requests.push({ url: req.url ?? '', method: req.method ?? '', headers, body });
      void Promise.resolve(handler({ index, body, headers })).then((reply) => {
        if (reply.hang === true) return; // 吊住不答，测超时
        res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
        res.end(reply.text ?? JSON.stringify(reply.json ?? {}));
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    // 注意：刻意不带 /v1——适配器自己拼 /v1/messages，与真实 baseUrl（如 https://api.anthropic.com）一致
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

function input(context: ContextItem[], tools: ToolSpec[] = []): ModelInput {
  return { agentId: 'lead', turn: 1, context, tools };
}

/** 组装一个 Anthropic Messages 响应 */
function message(content: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-test', content, ...extra };
}

function baseOptions(server: FakeServer) {
  return { baseUrl: server.baseUrl, apiKey: 'sk-ant-test', model: 'claude-test' };
}

// @spec ANTH-001
test('createAnthropicModel 把请求发到 {baseUrl}/v1/messages，带 x-api-key / anthropic-version，max_tokens 缺省为 4096', async () => {
  const server = await startFakeServer(() => ({ json: message([{ type: 'text', text: '你好' }]) }));
  try {
    // 故意给一个带尾斜杠的 baseUrl，验证归一化；不注入 fetchImpl，走 Node 24 全局 fetch
    const model = createAnthropicModel({ ...baseOptions(server), baseUrl: `${server.baseUrl}/` });
    const output = await model.step(input([{ role: 'human', text: '在吗' }]));

    assert.equal(output.text, '你好');
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0]?.url, '/v1/messages');
    assert.equal(server.requests[0]?.method, 'POST');
    assert.equal(server.requests[0]?.headers['x-api-key'], 'sk-ant-test');
    assert.equal(server.requests[0]?.headers['anthropic-version'], '2023-06-01');
    assert.match(String(server.requests[0]?.headers['content-type']), /application\/json/);
    assert.equal(server.requests[0]?.body.model, 'claude-test');
    assert.equal(server.requests[0]?.body.max_tokens, 4096);

    // anthropicVersion 可覆盖
    const versioned = createAnthropicModel({ ...baseOptions(server), anthropicVersion: '2024-01-01' });
    await versioned.step(input([{ role: 'human', text: 'x' }]));
    assert.equal(server.requests[1]?.headers['anthropic-version'], '2024-01-01');
  } finally {
    await server.close();
  }
});

// @spec ANTH-002
test('system 上下文合并进请求体顶层 system 字段，且不出现在 messages 里', async () => {
  const server = await startFakeServer(() => ({ json: message([{ type: 'text', text: 'ok' }]) }));
  try {
    const model = createAnthropicModel(baseOptions(server));
    await model.step(
      input([
        { role: 'system', text: '你是 Lead' },
        { role: 'system', text: '只说中文' },
        { role: 'human', text: '开始' },
      ]),
    );

    const body = server.requests[0]?.body ?? {};
    assert.equal(body.system, '你是 Lead\n\n只说中文');
    const messages = body.messages as Array<Record<string, unknown>>;
    assert.deepEqual(messages.map((m) => m.role), ['user']);
    assert.equal(messages.some((m) => m.role === 'system'), false, 'messages 里绝不能出现 system 角色');

    await model.step(input([{ role: 'human', text: '没有系统提示' }]));
    assert.equal('system' in (server.requests[1]?.body ?? {}), false, '没有 system 项时不该发 system 字段');
  } finally {
    await server.close();
  }
});

// @spec ANTH-003
test('human/assistant 上下文映射为 text 内容块消息', async () => {
  const server = await startFakeServer(() => ({ json: message([{ type: 'text', text: 'ok' }]) }));
  try {
    const model = createAnthropicModel(baseOptions(server));
    await model.step(input([{ role: 'human', text: '开始' }, { role: 'assistant', text: '收到' }]));

    assert.deepEqual(server.requests[0]?.body.messages, [
      { role: 'user', content: [{ type: 'text', text: '开始' }] },
      { role: 'assistant', content: [{ type: 'text', text: '收到' }] },
    ]);
  } finally {
    await server.close();
  }
});

// @spec ANTH-004
test('peer 转 user 并前缀标注来源（缺失时用 peer），相邻 user 消息合并为一条', async () => {
  const server = await startFakeServer(() => ({ json: message([{ type: 'text', text: 'ok' }]) }));
  try {
    const model = createAnthropicModel(baseOptions(server));
    await model.step(
      input([
        { role: 'peer', text: '我查到了资料', meta: { from: 'researcher' } },
        { role: 'peer', text: '匿名同伴的话' },
        { role: 'assistant', text: '收到' },
      ]),
    );

    const messages = server.requests[0]?.body.messages as Array<Record<string, unknown>>;
    assert.equal(messages.length, 2, '相邻的两条 user 必须合成一条消息');
    assert.equal(messages[0]?.role, 'user');
    assert.deepEqual(messages[0]?.content, [
      { type: 'text', text: '[来自 researcher] 我查到了资料' },
      { type: 'text', text: '[来自 peer] 匿名同伴的话' },
    ]);
    assert.deepEqual(messages[1], { role: 'assistant', content: [{ type: 'text', text: '收到' }] });
  } finally {
    await server.close();
  }
});

// @spec ANTH-005
test('tool 上下文映射为 user 消息的 tool_result 块；meta.id 缺失时不伪造 id 而降级为文本块', async () => {
  const server = await startFakeServer(() => ({ json: message([{ type: 'text', text: 'ok' }]) }));
  try {
    const model = createAnthropicModel(baseOptions(server));
    await model.step(
      input([
        { role: 'assistant', text: '我来查' },
        { role: 'tool', text: '[echo] 结果一', meta: { id: 'call_1', ok: true } },
        { role: 'tool', text: '[echo] 结果二' },
      ]),
    );

    const messages = server.requests[0]?.body.messages as Array<Record<string, unknown>>;
    assert.deepEqual(messages[0], { role: 'assistant', content: [{ type: 'text', text: '我来查' }] });
    assert.deepEqual(messages[1], {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: '[echo] 结果一' },
        { type: 'text', text: '[工具结果] [echo] 结果二' },
      ],
    });
    const blocks = messages[1]?.content as Array<Record<string, unknown>>;
    assert.equal('tool_use_id' in (blocks[1] ?? {}), false, '没有 meta.id 时绝不能编一个 tool_use_id');
  } finally {
    await server.close();
  }
});

// @spec ANTH-006
test('连续多条工具结果合并进同一条 user 消息的多个 tool_result 块', async () => {
  const server = await startFakeServer(() => ({ json: message([{ type: 'text', text: 'ok' }]) }));
  try {
    const model = createAnthropicModel(baseOptions(server));
    await model.step(
      input([
        { role: 'assistant', text: '批量执行' },
        { role: 'tool', text: '结果一', meta: { id: 'call_a' } },
        { role: 'tool', text: '结果二', meta: { id: 'call_b' } },
        { role: 'tool', text: '结果三', meta: { id: 'call_c' } },
      ]),
    );

    const messages = server.requests[0]?.body.messages as Array<Record<string, unknown>>;
    assert.deepEqual(messages.map((m) => m.role), ['assistant', 'user'], '必须保持 user/assistant 交替');
    assert.deepEqual(messages[1]?.content, [
      { type: 'tool_result', tool_use_id: 'call_a', content: '结果一' },
      { type: 'tool_result', tool_use_id: 'call_b', content: '结果二' },
      { type: 'tool_result', tool_use_id: 'call_c', content: '结果三' },
    ]);
  } finally {
    await server.close();
  }
});

// @spec ANTH-007
test('ToolSpec 映射为 tools[{name, description, input_schema}]，无工具时不发 tools 字段', async () => {
  const server = await startFakeServer(() => ({ json: message([{ type: 'text', text: 'ok' }]) }));
  try {
    const model = createAnthropicModel(baseOptions(server));
    await model.step(
      input([{ role: 'human', text: '跑工具' }], [
        { name: 'echo', description: '回显入参', run: (args) => args },
        { name: 'silent', run: () => null },
      ]),
    );
    assert.deepEqual(server.requests[0]?.body.tools, [
      { name: 'echo', description: '回显入参', input_schema: { type: 'object', properties: {} } },
      { name: 'silent', description: '', input_schema: { type: 'object', properties: {} } },
    ]);

    await model.step(input([{ role: 'human', text: '不用工具' }]));
    assert.equal('tools' in (server.requests[1]?.body ?? {}), false, '工具为空时不该出现 tools 字段');
  } finally {
    await server.close();
  }
});

// @spec ANTH-008
test('maxTokens 映射为 max_tokens，temperature 只有显式给出才发送（0 也是有效值）', async () => {
  const server = await startFakeServer(() => ({ json: message([{ type: 'text', text: 'ok' }]) }));
  try {
    const withKnobs = createAnthropicModel({ ...baseOptions(server), temperature: 0, maxTokens: 256 });
    await withKnobs.step(input([{ role: 'human', text: 'x' }]));
    assert.equal(server.requests[0]?.body.temperature, 0);
    assert.equal(server.requests[0]?.body.max_tokens, 256);

    const withoutKnobs = createAnthropicModel(baseOptions(server));
    await withoutKnobs.step(input([{ role: 'human', text: 'x' }]));
    const body = server.requests[1]?.body ?? {};
    assert.equal('temperature' in body, false);
    assert.equal(body.max_tokens, 4096);
  } finally {
    await server.close();
  }
});

// @spec ANTH-009
test('解析 content 的 text 块（按 \\n 拼接、跳过未知块）与 tool_use 块（input 已是对象，不 JSON.parse）', async () => {
  const server = await startFakeServer(({ index }) => {
    if (index === 0) {
      return {
        json: message([
          { type: 'text', text: '第一段' },
          { type: 'thinking', thinking: '内部思考不该出现在 text 里' },
          { type: 'text', text: '第二段' },
        ]),
      };
    }
    if (index === 1) {
      return {
        json: message([
          { type: 'tool_use', id: 'toolu_real', name: 'read_file', input: { path: 'a.txt' } },
          { type: 'tool_use', name: 'noop', input: {} },
        ]),
      };
    }
    return { json: message([{ type: 'text', text: '' }]) };
  });
  try {
    const model = createAnthropicModel(baseOptions(server));

    const textOutput = await model.step(input([{ role: 'human', text: 'x' }]));
    assert.equal(textOutput.text, '第一段\n第二段', '未知类型块必须被跳过');
    assert.equal(textOutput.toolCalls, undefined);

    const toolOutput = await model.step(input([{ role: 'human', text: 'x' }]));
    assert.deepEqual(toolOutput.toolCalls, [
      { id: 'toolu_real', name: 'read_file', args: { path: 'a.txt' } },
      { id: 'toolu_1', name: 'noop', args: {} },
    ]);
    assert.equal(toolOutput.text, undefined);

    const emptyOutput = await model.step(input([{ role: 'human', text: 'x' }]));
    assert.equal(emptyOutput.text, undefined, '空文本块不算说话');
    assert.equal(emptyOutput.toolCalls, undefined);
  } finally {
    await server.close();
  }
});

// @spec ANTH-010
test('usage 的 input_tokens + output_tokens 合成 tokens；终止约定按待办动作与文本判定', async () => {
  const server = await startFakeServer(({ index }) => {
    if (index === 0) {
      return { json: message([{ type: 'text', text: '好的' }], { usage: { input_tokens: 10, output_tokens: 5 } }) };
    }
    if (index === 1) {
      return {
        json: message([
          { type: 'text', text: '先查一下' },
          { type: 'tool_use', id: 'toolu_1', name: 'echo', input: {} },
        ]),
      };
    }
    return { json: message([]) };
  });
  try {
    const model = createAnthropicModel(baseOptions(server));

    const textOnly = await model.step(input([{ role: 'human', text: 'x' }]));
    assert.equal(textOnly.done, true);
    assert.deepEqual(textOnly.usage, { tokens: 15 });

    const withCall = await model.step(input([{ role: 'human', text: 'x' }]));
    assert.equal(withCall.done, false, '有 tool_use 就不算完成');
    assert.equal(withCall.usage, undefined, '没有 usage 时不该产生 usage 字段');

    const nothing = await model.step(input([{ role: 'human', text: 'x' }]));
    assert.equal(nothing.done, undefined, '两者皆无时交给 Loop 的预算护栏');
    assert.equal(nothing.text, undefined);
    assert.equal(nothing.toolCalls, undefined);
  } finally {
    await server.close();
  }
});

// @spec ANTH-011
test('响应不可信抛 bad_response；非 2xx 抛带 status 与响应片段的 http 错误', async () => {
  const server = await startFakeServer(({ index }) => {
    if (index === 0) return { text: '这不是 JSON' };
    if (index === 1) return { json: { id: 'msg_1', type: 'message' } };
    if (index === 2) return { json: message([{ type: 'tool_use', id: 'toolu_1', input: {} }]) };
    if (index === 3) return { json: message([{ type: 'tool_use', id: 'toolu_1', name: 'echo', input: '{}' }]) };
    return { status: 400, text: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: field required' } }) };
  });
  try {
    const model = createAnthropicModel(baseOptions(server));

    for (let i = 0; i < 4; i += 1) {
      await assert.rejects(
        () => model.step(input([{ role: 'human', text: 'x' }])),
        (err: unknown) => {
          assert.ok(err instanceof AnthropicModelError, '必须是导出的 AnthropicModelError');
          assert.equal(err.kind, 'bad_response');
          return true;
        },
      );
    }

    await assert.rejects(
      () => model.step(input([{ role: 'human', text: 'x' }])),
      (err: unknown) => {
        assert.ok(err instanceof AnthropicModelError);
        assert.equal(err.kind, 'http');
        assert.equal(err.status, 400);
        assert.match(String(err.bodySnippet), /max_tokens: field required/);
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

// @spec ANTH-012
test('超时用 AbortController 中止且不重试；429/5xx/网络错误退避重试；非 429 的 4xx 不重试', async () => {
  // 超时：吊住不答，50ms 后中止
  const hangServer = await startFakeServer(() => ({ hang: true }));
  try {
    const model = createAnthropicModel({ ...baseOptions(hangServer), timeoutMs: 50, retryBaseDelayMs: 1 });
    const startedAt = Date.now();
    await assert.rejects(
      () => model.step(input([{ role: 'human', text: 'x' }])),
      (err: unknown) => {
        assert.ok(err instanceof AnthropicModelTimeoutError);
        assert.ok(err instanceof AnthropicModelError, '超时错误也是 AnthropicModelError，宿主可用基类兜底');
        assert.equal(err.kind, 'timeout');
        assert.equal(err.timeoutMs, 50);
        assert.match(err.message, /50/);
        assert.equal(err.status, undefined);
        return true;
      },
    );
    assert.ok(Date.now() - startedAt < 2000, '不该等到天荒地老');
    assert.equal(hangServer.requests.length, 1, '超时不重试');
  } finally {
    await hangServer.close();
  }

  // 429 → 500 → 200：默认 maxRetries = 2，共 3 次尝试
  const retryServer = await startFakeServer(({ index }) => {
    if (index === 0) return { status: 429, text: '{"type":"error","error":{"type":"rate_limit_error"}}' };
    if (index === 1) return { status: 500, text: '{"type":"error","error":{"type":"api_error"}}' };
    return { json: message([{ type: 'text', text: '终于成功' }]) };
  });
  try {
    const model = createAnthropicModel({ ...baseOptions(retryServer), retryBaseDelayMs: 1 });
    const output = await model.step(input([{ role: 'human', text: 'x' }]));
    assert.equal(output.text, '终于成功');
    assert.equal(retryServer.requests.length, 3);
  } finally {
    await retryServer.close();
  }

  // 非 429 的 4xx：只发一次请求就抛错
  const notFoundServer = await startFakeServer(() => ({ status: 404, text: '{"type":"error","error":{"type":"not_found_error"}}' }));
  try {
    const model = createAnthropicModel({ ...baseOptions(notFoundServer), retryBaseDelayMs: 1 });
    await assert.rejects(
      () => model.step(input([{ role: 'human', text: 'x' }])),
      (err: unknown) => {
        assert.ok(err instanceof AnthropicModelError);
        assert.equal(err.status, 404);
        return true;
      },
    );
    assert.equal(notFoundServer.requests.length, 1, '4xx 不该重试');
  } finally {
    await notFoundServer.close();
  }

  // 网络错误：maxRetries = 1 → 2 次尝试后抛出最后一次
  let attempts = 0;
  const networkModel = createAnthropicModel({
    baseUrl: 'http://127.0.0.1:1',
    apiKey: 'sk-ant-test',
    model: 'claude-test',
    retryBaseDelayMs: 1,
    maxRetries: 1,
    fetchImpl: async () => {
      attempts += 1;
      throw new TypeError('socket hang up');
    },
  });
  await assert.rejects(
    () => networkModel.step(input([{ role: 'human', text: 'x' }])),
    (err: unknown) => {
      assert.ok(err instanceof AnthropicModelError);
      assert.equal(err.kind, 'network');
      assert.match(err.message, /socket hang up/);
      return true;
    },
  );
  assert.equal(attempts, 2);
});

// @spec ANTH-013
test('助手消息带 toolCalls 时输出 tool_use 块，tool_result 与之配对', async () => {
  const server = await startFakeServer(() => ({ json: message([{ type: 'text', text: '收到' }]) }));
  try {
    const model = createAnthropicModel(baseOptions(server));
    await model.step(
      input([
        { role: 'human', text: '查一下预算' },
        { role: 'assistant', text: '我去查', toolCalls: [{ id: 'toolu_1', name: 'budget', args: { range: 'today' } }] },
        { role: 'tool', text: '{"used":620000}', meta: { id: 'toolu_1' } },
      ]),
    );

    const messages = server.requests[0]?.body.messages as Array<Record<string, unknown>>;
    const assistant = messages.find((item) => item.role === 'assistant');
    const blocks = (assistant?.content ?? []) as Array<Record<string, unknown>>;
    assert.deepEqual(
      blocks.map((block) => block.type),
      ['text', 'tool_use'],
      '文本与工具调用落在同一条助手消息的两个块里',
    );

    const use = blocks.find((block) => block.type === 'tool_use');
    assert.equal(use?.id, 'toolu_1');
    assert.equal(use?.name, 'budget');
    assert.deepEqual(use?.input, { range: 'today' });

    // 关键：tool_result 的 tool_use_id 必须对应上一条助手消息里的 tool_use
    const toolResult = messages
      .filter((item) => item.role === 'user')
      .flatMap((item) => (item.content ?? []) as Array<Record<string, unknown>>)
      .find((block) => block.type === 'tool_result');
    assert.equal(toolResult?.tool_use_id, 'toolu_1', '不允许出现孤儿 tool_result（Anthropic 会 400）');
  } finally {
    await server.close();
  }
});
