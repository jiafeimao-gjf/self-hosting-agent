import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createDeltaThrottle, createSseParser, isDoneSentinel } from '../src/loop/sse.ts';
import { createHttpModel } from '../src/loop/http-model.ts';
import { createAnthropicModel } from '../src/loop/anthropic-model.ts';
import { scriptedModel } from '../src/loop/fake-model.ts';
import { AgentLoop } from '../src/loop/loop.ts';
import type { ContextItem, ModelInput } from '../src/loop/loop.ts';
import { EventLog } from '../src/eventlog/log.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agent-client-stream-${prefix}-`));
}

function input(context: ContextItem[] = [{ role: 'human', text: '你好' }]): ModelInput {
  return { agentId: 'lead', turn: 1, context, tools: [] };
}

/** 一个只会吐 SSE 的假服务：把写好的块按原样发出去 */
async function startSseServer(chunks: string[], options: { contentType?: string; status?: number } = {}) {
  const seen: Array<{ url: string; body: string }> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      seen.push({ url: req.url ?? '', body });
      res.writeHead(options.status ?? 200, {
        'content-type': options.contentType ?? 'text/event-stream',
      });
      for (const chunk of chunks) res.write(chunk);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    origin: `http://127.0.0.1:${port}`,
    seen,
    close: async () => {
      server.close();
      server.closeAllConnections?.();
    },
  };
}

// @spec STREAM-001
test('SSE 解析：跨 chunk 切断、CRLF、多行 data、注释心跳、[DONE]', () => {
  const events: Array<{ event: string | undefined; data: string }> = [];
  const parser = createSseParser((event) => events.push(event));

  // 故意在半条事件中间切断
  parser.push('event: message_start\ndata: {"a":');
  parser.push('1}\n\ndata: {"b":2}\n\n');
  parser.push(': 心跳注释\n\n');
  parser.push('event: x\r\ndata: 多行\r\ndata: 拼接\r\n\r\n');
  parser.push('data: [DONE]\n\n');

  assert.deepEqual(events[0], { event: 'message_start', data: '{"a":1}' });
  assert.deepEqual(events[1], { event: undefined, data: '{"b":2}' });
  assert.deepEqual(events[2], { event: 'x', data: '多行\n拼接' });
  assert.deepEqual(events[3], { event: undefined, data: '[DONE]' });
  assert.equal(events.length, 4, '注释心跳不该被当成事件');
  assert.equal(isDoneSentinel(events[3]?.data ?? ''), true);

  // 流结束时缓冲区里的最后一条半截事件也要吐出来
  const tail: string[] = [];
  const parser2 = createSseParser((event) => tail.push(event.data));
  parser2.push('data: 没有结尾空行');
  parser2.flush();
  assert.deepEqual(tail, ['没有结尾空行']);
});

// @spec STREAM-001
test('增量节流：按时间合流，收尾那一条一定发出去', () => {
  let clock = 0;
  const sent: string[] = [];
  const throttle = createDeltaThrottle((text) => sent.push(text), { minIntervalMs: 100, now: () => clock });

  clock = 0;
  throttle.push('你');
  clock = 10;
  throttle.push('你好');
  clock = 20;
  throttle.push('你好世');
  assert.deepEqual(sent, ['你'], '间隔不够的中间态不该打扰界面');

  clock = 150;
  throttle.push('你好世界');
  assert.deepEqual(sent, ['你', '你好世界']);

  // 内容没变就不重复发
  clock = 999;
  throttle.push('你好世界');
  assert.equal(sent.length, 2);

  // 收尾：即使刚发过也要保证最后一条是完整的
  throttle.finish('你好世界！');
  assert.deepEqual(sent, ['你', '你好世界', '你好世界！']);
});

// @spec STREAM-002
test('OpenAI 流式：文本增量 + 分批 tool_calls 拼接，结果与非流式完全一致', async () => {
  const server = await startSseServer([
    'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"预算"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"还剩 62%"}}]}\n\n',
    // tool_calls 是分批来的：先 id+name，再一段一段 arguments
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"ui.render","arguments":"{\\"scope\\":"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"surface.main\\"}"}}]}}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  try {
    const deltas: string[] = [];
    const model = createHttpModel({ baseUrl: server.baseUrl, apiKey: 'k', model: 'm' });
    const output = await model.step(input(), { onDelta: (text) => deltas.push(text) });

    assert.equal(output.text, '预算还剩 62%');
    assert.equal(output.done, false, '有工具调用就不算收尾');
    assert.deepEqual(output.toolCalls, [
      { id: 'call_1', name: 'ui.render', args: { scope: 'surface.main' } },
    ]);
    assert.ok(deltas.length >= 1, '应当收到增量');
    assert.equal(deltas.at(-1), '预算还剩 62%', '最后一条增量是完整文本');
    for (const text of deltas) {
      assert.equal('预算还剩 62%'.startsWith(text), true, `增量必须是累积全文：${text}`);
    }
    // 请求里确实带了 stream: true
    assert.equal(JSON.parse(server.seen[0]?.body ?? '{}').stream, true);
  } finally {
    await server.close();
  }
});

// @spec STREAM-002
test('Anthropic 流式：text_delta 与 input_json_delta 拼回同一条 message', async () => {
  const server = await startSseServer([
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"我在"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"算预算"}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_9","name":"ui.render"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"scope\\":"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"surface.main\\"}"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ]);
  try {
    const deltas: string[] = [];
    const model = createAnthropicModel({ baseUrl: server.origin, apiKey: 'sk-ant', model: 'claude' });
    const output = await model.step(input(), { onDelta: (text) => deltas.push(text) });

    assert.equal(output.text, '我在算预算');
    assert.deepEqual(output.toolCalls, [{ id: 'toolu_9', name: 'ui.render', args: { scope: 'surface.main' } }]);
    assert.equal(deltas.at(-1), '我在算预算');
    assert.equal(JSON.parse(server.seen[0]?.body ?? '{}').stream, true);
  } finally {
    await server.close();
  }
});

// @spec STREAM-003
test('流式失败要降级为非流式，而不是把整轮搞死', async () => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      calls += 1;
      const wantsStream = JSON.parse(body).stream === true;
      if (wantsStream) {
        // 网关不认 stream：直接 400
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'stream not supported' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '非流式也能答' } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  try {
    const fallbacks: string[] = [];
    const deltas: string[] = [];
    const model = createHttpModel({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'k',
      model: 'm',
      onStreamFallback: (reason) => fallbacks.push(reason),
    });
    const output = await model.step(input(), { onDelta: (text) => deltas.push(text) });

    assert.equal(output.text, '非流式也能答', '降级之后照样要有答案');
    assert.equal(calls, 2, '先试流式、再退回非流式');
    assert.equal(fallbacks.length, 1, '降级要留下可查的原因');
    assert.match(fallbacks[0] ?? '', /400|stream/);
    assert.deepEqual(deltas, [], '降级路径没有增量，也不该假装有');
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
});

// @spec STREAM-004
test('Loop 把增量作为 agent.delta 帧外发，且最终文本仍然完整', async () => {
  const log = new EventLog({ dir: tempDir('loop') });
  const frames: Array<{ t: string; text?: string }> = [];
  const model = scriptedModel([{ text: '这是一段会分几次吐出来的回答', done: true }]);

  const loop = new AgentLoop({
    agentId: 'lead',
    model,
    tools: [],
    log,
    sink: { onFrame: (frame) => frames.push(frame as unknown as { t: string; text?: string }) },
  });
  await loop.run({ seed: '开始' });

  const deltas = frames.filter((frame) => frame.t === 'agent.delta');
  assert.ok(deltas.length >= 2, `应当有多条增量，实际 ${deltas.length}`);
  for (const frame of deltas) {
    assert.equal('这是一段会分几次吐出来的回答'.startsWith(frame.text ?? ''), true, '增量是累积全文');
  }
  assert.equal(deltas.at(-1)?.text, '这是一段会分几次吐出来的回答');

  const thinking = frames.filter((frame) => frame.t === 'agent.thinking');
  assert.equal(thinking.length, 1);
  assert.equal(thinking[0]?.text, '这是一段会分几次吐出来的回答', '最终文本必须完整');

  // 增量是瞬态：不该进事件日志（否则一次回答就淹没几十上百条）
  const types = log.read().map((event) => event.type);
  assert.equal(types.includes('agent.thinking'), true);
  assert.equal(
    log.read().some((event) => event.type === 'agent.frame' && (event.frame as { t?: string })?.t === 'agent.delta'),
    false,
    '池子不该把 agent.delta 记成事件',
  );
});

// @spec STREAM-004
test('池子把 agent.delta 只转发、不落日志，其余帧照旧全记', async () => {
  const { AgentPool } = await import('../src/kernel/pool.ts');
  const dir = tempDir('pool');
  const log = new EventLog({ dir });
  const pool = new AgentPool({ log });

  try {
    const handle = pool.spawn({ agentId: 'lead', logDir: tempDir('pool-child'), env: { AGENT_MODEL: 'demo' } });
    const seen: string[] = [];
    let fast = false;
    const done = new Promise<void>((resolve) => {
      handle.onFrame((frame) => {
        if (frame.t !== undefined) seen.push(frame.t);
        if (frame.t === 'agent.delta') fast = true;
        if (frame.t === 'loop.done') resolve();
      });
    });
    handle.send({ t: 'human.message', text: '帮我看下预算' });
    await done;
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(fast, true, '子进程应当真的吐过增量帧');
    const framedTypes = log
      .read()
      .filter((event) => event.type === 'agent.frame')
      .map((event) => (event.frame as { t?: string } | undefined)?.t);
    assert.equal(framedTypes.includes('agent.delta'), false, '瞬态增量不落日志');
    assert.equal(framedTypes.includes('agent.thinking'), true, '最终文本照旧要记账');
  } finally {
    await pool.shutdown();
  }
});

// @spec STREAM-006
test('确定性演示模型也走流式：没有网络也能测整条链路', async () => {
  const deltas: string[] = [];
  const model = scriptedModel([{ text: '演示模型也会分几次吐字', done: true }]);
  const output = await model.step(input(), { onDelta: (text) => deltas.push(text) });

  assert.ok(deltas.length >= 2, `演示/脚本模型应当分批发增量，实际 ${deltas.length}`);
  assert.equal(deltas.at(-1), '演示模型也会分几次吐字');
  assert.equal(output.text, '演示模型也会分几次吐字');

  // 不给 onDelta 时完全不流式（老路径不受影响）
  const silent = scriptedModel([{ text: '不给回调就不流式', done: true }]);
  await silent.step(input());
  assert.equal(silent.calls.length, 1);
});
