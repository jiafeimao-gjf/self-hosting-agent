import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { HttpModelError, HttpModelTimeoutError, createHttpModel } from '../src/loop/http-model.ts';
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
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
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

/** 组装一个 OpenAI 兼容的完成响应 */
function completion(message: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: 'stop' }],
    ...extra,
  };
}

function toolCall(id: string, name: string, args: string): Record<string, unknown> {
  return { id, type: 'function', function: { name, arguments: args } };
}

function baseOptions(server: FakeServer) {
  return { baseUrl: server.baseUrl, model: 'gpt-test', apiKey: 'sk-test' };
}

// @spec MODEL-001
test('createHttpModel 用全局 fetch 把请求发到 {baseUrl}/chat/completions，带鉴权头与 model', async () => {
  const server = await startFakeServer(() => ({ json: completion({ content: '你好' }) }));
  try {
    // 故意给一个带尾斜杠的 baseUrl，验证归一化；不注入 fetchImpl，走 Node 24 全局 fetch
    const model = createHttpModel({ ...baseOptions(server), baseUrl: `${server.baseUrl}/` });
    const output = await model.step(input([{ role: 'human', text: '在吗' }]));

    assert.equal(output.text, '你好');
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0]?.url, '/v1/chat/completions');
    assert.equal(server.requests[0]?.method, 'POST');
    assert.equal(server.requests[0]?.headers.authorization, 'Bearer sk-test');
    assert.match(String(server.requests[0]?.headers['content-type']), /application\/json/);
    assert.equal(server.requests[0]?.body.model, 'gpt-test');
  } finally {
    await server.close();
  }
});

// @spec MODEL-002
test('上下文角色映射：system/human/assistant 直译，peer 转 user 并前缀标注来源', async () => {
  const server = await startFakeServer(() => ({ json: completion({ content: 'ok' }) }));
  try {
    const model = createHttpModel(baseOptions(server));
    await model.step(
      input([
        { role: 'system', text: '你是 Lead' },
        { role: 'human', text: '开始' },
        { role: 'peer', text: '我查到了资料', meta: { from: 'researcher' } },
        { role: 'peer', text: '匿名同伴的话' },
        { role: 'assistant', text: '收到' },
      ]),
    );

    const messages = server.requests[0]?.body.messages as Array<Record<string, unknown>>;
    assert.deepEqual(
      messages.map((m) => m.role),
      ['system', 'user', 'user', 'user', 'assistant'],
    );
    assert.equal(messages[0]?.content, '你是 Lead');
    assert.equal(messages[1]?.content, '开始');
    assert.equal(messages[2]?.content, '[来自 researcher] 我查到了资料');
    assert.equal(messages[3]?.content, '[来自 peer] 匿名同伴的话');
    assert.equal(messages[4]?.content, '收到');
  } finally {
    await server.close();
  }
});

// @spec MODEL-003
test('role:tool 的上下文映射为 tool 消息并带上 meta.id 作为 tool_call_id', async () => {
  const server = await startFakeServer(() => ({ json: completion({ content: 'ok' }) }));
  try {
    const model = createHttpModel(baseOptions(server));
    await model.step(
      input([
        { role: 'tool', text: '[echo] 结果一', meta: { id: 'call_1', ok: true } },
        { role: 'tool', text: '[echo] 结果二' },
      ]),
    );

    const messages = server.requests[0]?.body.messages as Array<Record<string, unknown>>;
    assert.deepEqual(messages[0], { role: 'tool', content: '[echo] 结果一', tool_call_id: 'call_1' });
    assert.deepEqual(messages[1], { role: 'tool', content: '[echo] 结果二' });
    assert.equal('tool_call_id' in (messages[1] ?? {}), false, '没有 meta.id 时不该伪造 tool_call_id');
  } finally {
    await server.close();
  }
});

// @spec MODEL-004
test('ToolSpec 映射为 function 工具，parameters 用空对象 schema；无工具时不发 tools', async () => {
  const server = await startFakeServer(() => ({ json: completion({ content: 'ok' }) }));
  try {
    const model = createHttpModel(baseOptions(server));
    await model.step(
      input([{ role: 'human', text: '跑工具' }], [
        { name: 'echo', description: '回显入参', run: (args) => args },
        { name: 'silent', run: () => null },
      ]),
    );
    assert.deepEqual(server.requests[0]?.body.tools, [
      {
        type: 'function',
        function: { name: 'echo', description: '回显入参', parameters: { type: 'object', properties: {} } },
      },
      {
        type: 'function',
        function: { name: 'silent', description: '', parameters: { type: 'object', properties: {} } },
      },
    ]);

    await model.step(input([{ role: 'human', text: '不用工具' }]));
    assert.equal('tools' in (server.requests[1]?.body ?? {}), false, '工具为空时不该出现 tools 字段');
  } finally {
    await server.close();
  }
});

// @spec MODEL-005
test('temperature 与 maxTokens 只有显式给出才发送，0 也是有效值', async () => {
  const server = await startFakeServer(() => ({ json: completion({ content: 'ok' }) }));
  try {
    const withKnobs = createHttpModel({ ...baseOptions(server), temperature: 0, maxTokens: 256 });
    await withKnobs.step(input([{ role: 'human', text: 'x' }]));
    assert.equal(server.requests[0]?.body.temperature, 0);
    assert.equal(server.requests[0]?.body.max_tokens, 256);

    const withoutKnobs = createHttpModel(baseOptions(server));
    await withoutKnobs.step(input([{ role: 'human', text: 'x' }]));
    const body = server.requests[1]?.body ?? {};
    assert.equal('temperature' in body, false);
    assert.equal('max_tokens' in body, false);
  } finally {
    await server.close();
  }
});

// @spec MODEL-006
test('解析 content 与 usage.total_tokens；无 usage 时不产生 usage 字段', async () => {
  const server = await startFakeServer(({ index }) =>
    index === 0
      ? { json: completion({ content: '有 token' }, { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 42 } }) }
      : { json: completion({ content: '没 token' }) },
  );
  try {
    const model = createHttpModel(baseOptions(server));
    const withUsage = await model.step(input([{ role: 'human', text: 'x' }]));
    assert.equal(withUsage.text, '有 token');
    assert.deepEqual(withUsage.usage, { tokens: 42 });

    const withoutUsage = await model.step(input([{ role: 'human', text: 'x' }]));
    assert.equal(withoutUsage.text, '没 token');
    assert.equal(withoutUsage.usage, undefined);
  } finally {
    await server.close();
  }
});

// @spec MODEL-007
test('空字符串或缺失的 content 统一归一化为 undefined', async () => {
  const server = await startFakeServer(({ index }) =>
    index === 0 ? { json: completion({ content: '' }) } : { json: completion({}) },
  );
  try {
    const model = createHttpModel(baseOptions(server));
    const empty = await model.step(input([{ role: 'human', text: 'x' }]));
    assert.equal(empty.text, undefined);
    const missing = await model.step(input([{ role: 'human', text: 'x' }]));
    assert.equal(missing.text, undefined);
  } finally {
    await server.close();
  }
});

// @spec MODEL-008
test('tool_calls 映射为 toolCalls，arguments 的 JSON 字符串被解析，空串等价于空对象', async () => {
  const server = await startFakeServer(() => ({
    json: completion({
      content: '我来查',
      tool_calls: [toolCall('call_1', 'read_file', '{"path":"a.txt"}'), toolCall('call_2', 'noop', '')],
    }),
  }));
  try {
    const model = createHttpModel(baseOptions(server));
    const output = await model.step(input([{ role: 'human', text: '读文件' }]));
    assert.deepEqual(output.toolCalls, [
      { id: 'call_1', name: 'read_file', args: { path: 'a.txt' } },
      { id: 'call_2', name: 'noop', args: {} },
    ]);
    assert.equal(output.text, '我来查');
  } finally {
    await server.close();
  }
});

// @spec MODEL-009
test('arguments 不是合法 JSON 或不是对象时抛 bad_arguments，绝不降级为空参数', async () => {
  const server = await startFakeServer(({ index }) =>
    index === 0
      ? { json: completion({ tool_calls: [toolCall('call_1', 'read_file', '这不是 JSON')] }) }
      : { json: completion({ tool_calls: [toolCall('call_1', 'read_file', '[1,2]')] }) },
  );
  try {
    const model = createHttpModel(baseOptions(server));
    for (let i = 0; i < 2; i += 1) {
      await assert.rejects(
        () => model.step(input([{ role: 'human', text: '读文件' }])),
        (err: unknown) => {
          assert.ok(err instanceof HttpModelError, '必须是导出的 HttpModelError');
          assert.equal(err.kind, 'bad_arguments');
          assert.match(err.message, /read_file/);
          return true;
        },
      );
    }
  } finally {
    await server.close();
  }
});

// @spec MODEL-010
test('终止约定：有待办动作 done:false，纯文本 done:true，两者皆无 done 为 undefined', async () => {
  const server = await startFakeServer(({ index }) => {
    if (index === 0) return { json: completion({ content: '先查一下', tool_calls: [toolCall('call_1', 'echo', '{}')] }) };
    if (index === 1) return { json: completion({ content: '做完了' }) };
    return { json: completion({}) };
  });
  try {
    const model = createHttpModel(baseOptions(server));
    const withCall = await model.step(input([{ role: 'human', text: 'x' }]));
    assert.equal(withCall.done, false);

    const textOnly = await model.step(input([{ role: 'human', text: 'x' }]));
    assert.equal(textOnly.done, true);

    const nothing = await model.step(input([{ role: 'human', text: 'x' }]));
    assert.equal(nothing.done, undefined);
    assert.equal(nothing.text, undefined);
    assert.equal(nothing.toolCalls, undefined);
  } finally {
    await server.close();
  }
});

// @spec MODEL-011
test('uiToolName 命中的调用转成 uiPatches，且不进入 toolCalls', async () => {
  const patch = { scope: 'surface.sidebar', op: 'replace', spec: { type: 'panel', children: [] } };
  const server = await startFakeServer(() => ({
    json: completion({
      content: '我改一下界面',
      tool_calls: [toolCall('call_ui', 'render_ui', JSON.stringify(patch)), toolCall('call_1', 'echo', '{"v":1}')],
    }),
  }));
  try {
    const model = createHttpModel({ ...baseOptions(server), uiToolName: 'render_ui' });
    const output = await model.step(input([{ role: 'human', text: '把侧栏换掉' }]));
    assert.deepEqual(output.uiPatches, [patch]);
    assert.deepEqual(output.toolCalls, [{ id: 'call_1', name: 'echo', args: { v: 1 } }]);
    assert.equal(output.done, false, '有待办动作（UI patch）就不算完成');
  } finally {
    await server.close();
  }
});

// @spec MODEL-012
test('uiToolName 调用的 arguments 形状非法时抛 bad_ui_patch', async () => {
  const illegal = [
    { op: 'replace', spec: { type: 'panel' } }, // 缺 scope
    { scope: 'surface.sidebar', op: 'destroy', spec: { type: 'panel' } }, // op 不在枚举内
    { scope: 'surface.sidebar', op: 'replace', spec: [1, 2] }, // spec 不是对象
  ];
  const server = await startFakeServer(({ index }) => ({
    json: completion({ tool_calls: [toolCall('call_ui', 'render_ui', JSON.stringify(illegal[index]))] }),
  }));
  try {
    const model = createHttpModel({ ...baseOptions(server), uiToolName: 'render_ui' });
    for (let i = 0; i < illegal.length; i += 1) {
      await assert.rejects(
        () => model.step(input([{ role: 'human', text: '改界面' }])),
        (err: unknown) => {
          assert.ok(err instanceof HttpModelError);
          assert.equal(err.kind, 'bad_ui_patch');
          return true;
        },
      );
    }
  } finally {
    await server.close();
  }
});

// @spec MODEL-013
test('非 2xx 抛 HttpModelError，带 status 与截断后的响应片段', async () => {
  const server = await startFakeServer(() => ({
    status: 400,
    text: JSON.stringify({ error: { message: 'invalid api key' } }),
  }));
  try {
    const model = createHttpModel(baseOptions(server));
    await assert.rejects(
      () => model.step(input([{ role: 'human', text: 'x' }])),
      (err: unknown) => {
        assert.ok(err instanceof HttpModelError);
        assert.equal(err.kind, 'http');
        assert.equal(err.status, 400);
        assert.match(String(err.bodySnippet), /invalid api key/);
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

// @spec MODEL-014
test('超过 timeoutMs 时中止请求并抛 HttpModelTimeoutError，信息含 timeoutMs', async () => {
  const server = await startFakeServer(() => ({ hang: true }));
  try {
    const model = createHttpModel({ ...baseOptions(server), timeoutMs: 50 });
    const startedAt = Date.now();
    await assert.rejects(
      () => model.step(input([{ role: 'human', text: 'x' }])),
      (err: unknown) => {
        assert.ok(err instanceof HttpModelTimeoutError);
        assert.ok(err instanceof HttpModelError, '超时错误也是 HttpModelError，宿主可用基类兜底');
        assert.equal(err.kind, 'timeout');
        assert.equal(err.timeoutMs, 50);
        assert.match(err.message, /50/);
        assert.equal(err.status, undefined);
        return true;
      },
    );
    assert.ok(Date.now() - startedAt < 2000, '不该等到天荒地老');
    assert.equal(server.requests.length, 1, '超时不重试');
  } finally {
    await server.close();
  }
});

// @spec MODEL-015
test('429/5xx/网络错误按 maxRetries 退避重试，用尽后抛最后一次错误', async () => {
  // 429 → 500 → 200：默认 maxRetries = 2，共 3 次尝试
  const server = await startFakeServer(({ index }) => {
    if (index === 0) return { status: 429, text: '{"error":"rate limited"}' };
    if (index === 1) return { status: 500, text: '{"error":"boom"}' };
    return { json: completion({ content: '终于成功' }) };
  });
  try {
    const model = createHttpModel({ ...baseOptions(server), retryBaseDelayMs: 1 });
    const output = await model.step(input([{ role: 'human', text: 'x' }]));
    assert.equal(output.text, '终于成功');
    assert.equal(server.requests.length, 3);
  } finally {
    await server.close();
  }

  // 网络错误：maxRetries = 1 → 2 次尝试后抛出最后一次
  let attempts = 0;
  const networkModel = createHttpModel({
    ...baseOptions(server),
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
      assert.ok(err instanceof HttpModelError);
      assert.equal(err.kind, 'network');
      assert.match(err.message, /socket hang up/);
      return true;
    },
  );
  assert.equal(attempts, 2);
});

// @spec MODEL-016
test('非 429 的 4xx 不重试，只发一次请求就抛错', async () => {
  const server = await startFakeServer(() => ({ status: 404, text: '{"error":"no such model"}' }));
  try {
    const model = createHttpModel({ ...baseOptions(server), retryBaseDelayMs: 1 });
    await assert.rejects(
      () => model.step(input([{ role: 'human', text: 'x' }])),
      (err: unknown) => {
        assert.ok(err instanceof HttpModelError);
        assert.equal(err.status, 404);
        return true;
      },
    );
    assert.equal(server.requests.length, 1, '4xx 不该重试');
  } finally {
    await server.close();
  }
});

// @spec MODEL-017
test('响应结构不可信（非 JSON / 缺 choices / 工具调用缺 name）抛 bad_response', async () => {
  const server = await startFakeServer(({ index }) => {
    if (index === 0) return { text: '这不是 JSON' };
    if (index === 1) return { json: { id: 'chatcmpl-1', object: 'chat.completion' } };
    return { json: completion({ tool_calls: [{ id: 'call_1', type: 'function', function: { arguments: '{}' } }] }) };
  });
  try {
    const model = createHttpModel(baseOptions(server));
    for (let i = 0; i < 3; i += 1) {
      await assert.rejects(
        () => model.step(input([{ role: 'human', text: 'x' }])),
        (err: unknown) => {
          assert.ok(err instanceof HttpModelError);
          assert.equal(err.kind, 'bad_response');
          return true;
        },
      );
    }
  } finally {
    await server.close();
  }
});
