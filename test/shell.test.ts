import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ENV_ALLOWLIST, buildEnv, createShellRunner } from '../src/kernel/shell.ts';
import { createHostTools } from '../src/orchestrator/host-tools.ts';
import type { HostRuntime } from '../src/orchestrator/host-tools.ts';
import { ApprovalGate } from '../src/kernel/approval.ts';
import { WorkspaceStore } from '../src/workspace/store.ts';
import { BrowserHost } from '../src/browser/document.ts';
import { ClientSession } from '../src/server/session.ts';
import { startServer } from '../src/server/http-server.ts';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agent-client-shell-${prefix}-`));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function runtimeFor(options: {
  decision?: 'allow_once' | 'deny';
  workspace?: WorkspaceStore;
  shell?: ReturnType<typeof createShellRunner>;
  audit?: Array<Record<string, unknown>>;
} = {}): HostRuntime {
  const decision = options.decision ?? 'allow_once';
  return {
    workspace: options.workspace ?? new WorkspaceStore({ root: tempDir('ws') }),
    browser: new BrowserHost(),
    shell: options.shell ?? createShellRunner(),
    approval: new ApprovalGate({ policy: () => decision }),
    ...(options.audit === undefined
      ? {}
      : { logShell: (entry: Record<string, unknown>) => options.audit?.push(entry) }),
  } as unknown as HostRuntime;
}

function shellTool() {
  const tool = createHostTools({ shell: true }).find((candidate) => candidate.name === 'shell.run');
  assert.ok(tool, 'shell.run 应当被注册');
  return tool as { run: (a: Record<string, unknown>, r: HostRuntime, c: string) => Promise<{ ok: boolean; result?: string; error?: string }> };
}

// @spec SHELL-001
test('默认不注册 shell：不启用就看不到这个工具，启用才在', () => {
  const without = createHostTools();
  assert.equal(without.some((tool) => tool.name === 'shell.run'), false, '默认不给 shell');
  assert.equal(without.every((tool) => tool.name !== 'shell.run'), true);

  const withShell = createHostTools({ shell: true });
  assert.equal(withShell.some((tool) => tool.name === 'shell.run'), true);
  // 工具名要写到 schema 里，声明与实现不许漂移
  const manifest = createHostTools({ shell: true }).find((tool) => tool.name === 'shell.run');
  assert.equal(typeof manifest?.description, 'string');
  assert.match(String(manifest?.description), /批准/, '描述里必须写清「每次都要人批准」');
});

// @spec SHELL-001
test('子进程只声明宿主真正注册的工具（没启用就不声明 shell.run）', async () => {
  const { TeamRunner } = await import('../src/orchestrator/team.ts');
  const plain = new TeamRunner({ dir: tempDir('runner-plain') });
  assert.equal(plain.hostToolNames.includes('shell.run'), false, '没给执行器就不该声明');

  const withShell = new TeamRunner({ dir: tempDir('runner-shell'), shell: createShellRunner() });
  assert.equal(withShell.hostToolNames.includes('shell.run'), true);
});

// @spec SHELL-002
test('审批说拒绝就一行命令都不执行', async () => {
  const audit: Array<Record<string, unknown>> = [];
  const runtime = runtimeFor({ decision: 'deny', audit });
  const result = await shellTool().run({ command: 'touch should-not-exist' }, runtime, 'lead');

  assert.equal(result.ok, false);
  assert.match(String(result.error), /审批被拒绝/);
  assert.equal(fs.existsSync(path.join(runtime.workspace.root, 'should-not-exist')), false, '拒绝后不得留下任何痕迹');
  assert.equal(audit.length, 1, '被拒绝也要留痕');
  assert.equal(audit[0]?.decision, 'deny');
  assert.equal(audit[0]?.note, '审批被拒绝');
});

// @spec SHELL-003
test('执行结果形状稳定：退出码原样透传，非 0 不算异常', async () => {
  const runtime = runtimeFor();
  const ok = await shellTool().run({ command: 'echo 你好; echo 警告 >&2' }, runtime, 'lead');
  assert.equal(ok.ok, true);
  const first = JSON.parse(String(ok.result)) as { code: number; stdout: string; stderr: string; durationMs: number };
  assert.equal(first.code, 0);
  assert.match(first.stdout, /你好/);
  assert.match(first.stderr, /警告/);
  assert.equal(typeof first.durationMs, 'number');

  const failed = await shellTool().run({ command: 'exit 3' }, runtime, 'lead');
  assert.equal(failed.ok, true, '非 0 退出码是结果，不是工具失败');
  assert.equal((JSON.parse(String(failed.result)) as { code: number }).code, 3);
});

// @spec SHELL-004
test('超时后进程组里的后台进程确实死了', async () => {
  const cwd = tempDir('tree2');
  const runner = createShellRunner();
  const result = await runner.run({
    command: 'sleep 30 & echo $! > bg.pid; sleep 30',
    cwd,
    timeoutMs: 800,
  });
  assert.equal(result.timedOut, true);
  await sleep(200);

  const pidText = fs.readFileSync(path.join(cwd, 'bg.pid'), 'utf8').trim();
  const pid = Number(pidText);
  assert.ok(Number.isFinite(pid) && pid > 0, '后台进程 pid 应被写下来');
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false, `后台 sleep(${pid}) 必须随进程组一起被回收`);
});

// @spec SHELL-005
test('输出有上限：超大输出被截断并标记，字节数如实', async () => {
  const runner = createShellRunner();
  const result = await runner.run({
    command: 'yes 0123456789 | head -c 300000',
    cwd: tempDir('big'),
    maxBytes: 4096,
  });
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.stdout, 'utf8') <= 4096, '截断到上限之内');
  assert.ok(result.stdout.length > 100, '也不是什么都没拿到');
});

// @spec SHELL-006
test('环境变量白名单：AGENT_* 与密钥绝不进 shell', async () => {
  const previous = process.env.AGENT_API_KEY;
  process.env.AGENT_API_KEY = 'sk-must-not-leak-123456';
  process.env.SUPER_SECRET = 'also-must-not-leak';
  try {
    const runner = createShellRunner();
    const result = await runner.run({ command: 'env', cwd: tempDir('env') });
    assert.equal(result.stdout.includes('sk-must-not-leak'), false, 'API Key 不能出现在子进程环境里');
    assert.equal(result.stdout.includes('also-must-not-leak'), false, '白名单之外的一律不传');
    assert.match(result.stdout, /^PATH=/m, 'PATH 要留着，否则命令都跑不起来');

    // 白名单本身就是契约：里面不许出现任何 AGENT_*
    for (const key of ENV_ALLOWLIST) {
      assert.equal(key.startsWith('AGENT_'), false, `${key} 不该在白名单里`);
    }
    assert.equal('AGENT_API_KEY' in buildEnv(process.env), false);
  } finally {
    if (previous === undefined) delete process.env.AGENT_API_KEY;
    else process.env.AGENT_API_KEY = previous;
    delete process.env.SUPER_SECRET;
  }
});

// @spec SHELL-007
test('cwd 落在该对话的工作空间，不存在时自动创建', async () => {
  const workspace = new WorkspaceStore({ root: path.join(tempDir('conv'), 'workspace') });
  assert.equal(fs.existsSync(workspace.root), false);
  const runtime = runtimeFor({ workspace });

  const result = await shellTool().run({ command: 'pwd; echo hi > from-shell.txt' }, runtime, 'lead');
  assert.equal(result.ok, true);
  const parsed = JSON.parse(String(result.result)) as { stdout: string };
  assert.match(parsed.stdout.trim(), new RegExp(workspace.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(fs.existsSync(path.join(workspace.root, 'from-shell.txt')), true, '随手写的文件落在工作空间里');
});

// @spec SHELL-009
test('审批交互：发出 approval 事件，人类回复后放行；重复回复只认第一次', async () => {
  const session = new ClientSession({
    dir: tempDir('approve'),
    lead: { script: [{ text: 'ok', done: true }] },
    shell: createShellRunner(),
  });
  const server = await startServer({ session, port: 0 });

  // 打开 SSE（有人连着，才不会被 fail-closed 拒掉）
  const controller = new AbortController();
  const response = await fetch(`${server.url}/api/stream?conversation=default`, {
    signal: controller.signal,
    headers: { accept: 'text/event-stream' },
  });
  const reader = response.body?.getReader();
  assert.ok(reader);

  try {
    await sleep(100);
    const pending = session.runner.approval.request({
      id: 'appr_test_1',
      action: 'shell.run',
      risk: 'high',
      agentId: 'lead',
      detail: 'ls -la',
    });

    // 等到 state 里能看到待批项
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && session.state().approval === null) await sleep(20);
    assert.equal(session.state().approval?.detail, 'ls -la', '刷新页面也要能看到待批命令');

    const ok = await fetch(`${server.url}/api/approval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'appr_test_1', decision: 'allow_once' }),
    });
    assert.equal(ok.status, 200);
    assert.equal(await pending, 'allow_once', '人类批准后动作应当放行');
    assert.equal(session.state().approval, null, '批完就不该再挂着');

    // 重复回复 / 未知 id / 非法 decision
    const again = await fetch(`${server.url}/api/approval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'appr_test_1', decision: 'deny' }),
    });
    assert.equal(again.status, 400, '同一个 id 只认第一次');

    const unknown = await fetch(`${server.url}/api/approval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'nope', decision: 'allow_once' }),
    });
    assert.equal(unknown.status, 400);

    const bad = await fetch(`${server.url}/api/approval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'appr_test_1', decision: 'maybe' }),
    });
    assert.equal(bad.status, 400);
  } finally {
    controller.abort();
    await server.close();
    await session.close();
  }
});

// @spec SHELL-010
test('没人在就是拒绝：无客户端连接时审批立刻 deny，不挂住', async () => {
  const session = new ClientSession({ dir: tempDir('nobody'), lead: { script: [{ text: 'ok', done: true }] } });
  try {
    const started = Date.now();
    const decision = await session.runner.approval.request({
      id: 'appr_nobody',
      action: 'shell.run',
      risk: 'high',
      agentId: 'lead',
      detail: 'rm -rf /',
    });
    assert.equal(decision, 'deny', '没人在场必须 fail closed');
    assert.ok(Date.now() - started < 1000, '不能挂着等人');
    assert.equal(session.state().approval, null);
  } finally {
    await session.close();
  }
});

// @spec SHELL-010
test('等人超时按拒绝处理', async () => {
  const session = new ClientSession({
    dir: tempDir('timeout'),
    lead: { script: [{ text: 'ok', done: true }] },
    approvalTimeoutMs: 300,
  });
  const server = await startServer({ session, port: 0 });
  const controller = new AbortController();
  const response = await fetch(`${server.url}/api/stream`, {
    signal: controller.signal,
    headers: { accept: 'text/event-stream' },
  });
  const reader = response.body?.getReader();
  assert.ok(reader);

  try {
    await sleep(100);
    const started = Date.now();
    const decision = await session.runner.approval.request({
      id: 'appr_timeout',
      action: 'shell.run',
      risk: 'high',
      agentId: 'lead',
      detail: 'echo hi',
    });
    assert.equal(decision, 'deny', '超时按拒绝');
    assert.ok(Date.now() - started >= 250, '应当真的等了一会儿');
    assert.equal(session.state().approval, null, '超时后不该还挂着');
  } finally {
    controller.abort();
    await server.close();
    await session.close();
  }
});

// @spec SHELL-010
test('默认审批超时足够长：人不可能守着屏幕等（真机上吃过 120s 的亏）', () => {
  const session = new ClientSession({ dir: tempDir('timeout-default'), lead: { script: [{ text: 'ok', done: true }] } });
  // 通过公开行为间接验证：默认值不该在 2 分钟量级
  const source = fs.readFileSync(new URL('../src/server/session.ts', import.meta.url), 'utf8');
  assert.match(source, /options\.approvalTimeoutMs \?\? 600_000/, '默认 10 分钟');
  void session;
});

// @spec SHELL-008
test('每次调用（含被拒绝的）都写事件日志', async () => {
  const session = new ClientSession({
    dir: tempDir('audit'),
    lead: { script: [{ text: 'ok', done: true }] },
    shell: createShellRunner(),
  });
  const server = await startServer({ session, port: 0 });
  const controller = new AbortController();
  const stream = await fetch(`${server.url}/api/stream`, {
    signal: controller.signal,
    headers: { accept: 'text/event-stream' },
  });
  const reader = stream.body?.getReader();
  assert.ok(reader);

  const respond = async (decision: string): Promise<number> => {
    // 等到人类看得见这条待批
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && session.state().approval === null) await sleep(20);
    const id = session.state().approval?.id ?? '';
    const response = await fetch(`${server.url}/api/approval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, decision }),
    });
    return response.status;
  };

  try {
    await sleep(100);
    const runtime = session.runner as unknown as HostRuntime;

    // 批准 → 真的执行
    const allowed = shellTool().run({ command: 'echo 审计' }, runtime, 'lead');
    assert.equal(await respond('allow_once'), 200);
    assert.equal((await allowed).ok, true);

    // 拒绝 → 什么都不做，但照样留痕
    const denied = shellTool().run({ command: 'echo 这个会被拒' }, runtime, 'lead');
    assert.equal(await respond('deny'), 200);
    assert.equal((await denied).ok, false);

    const logged = session.runner.log.read().filter((event) => event.type === 'shell.run');
    assert.equal(logged.length, 2, `两次调用都要留痕，实际 ${logged.length}`);
    assert.match(String(logged[0]?.command), /审计/);
    assert.equal(logged[0]?.code, 0, '批准那次要记下退出码');
    assert.equal(logged[0]?.decision, 'allow_once');
    assert.equal(logged[1]?.decision, 'deny', '被拒绝也要记下决定');
    assert.equal(logged[1]?.note, '审批被拒绝');
  } finally {
    controller.abort();
    await server.close();
    await session.close();
  }
});

// @spec SHELL-002
test('端到端：子进程调 shell.run → 人类批准 → 命令真的执行 → 结果回给 Agent', async () => {
  const dir = tempDir('e2e');
  const session = new ClientSession({
    dir,
    lead: {
      script: [
        { toolCalls: [{ id: 'c1', name: 'shell.run', args: { command: 'echo 从子进程来 > from-agent.txt && echo 完成' } }] },
        { text: '命令跑完了', done: true },
      ],
    },
    shell: createShellRunner(),
  });
  const server = await startServer({ session, port: 0 });
  const controller = new AbortController();
  const stream = await fetch(`${server.url}/api/stream`, {
    signal: controller.signal,
    headers: { accept: 'text/event-stream' },
  });
  const reader = stream.body?.getReader();
  assert.ok(reader);

  try {
    await sleep(100);
    const sent = await fetch(`${server.url}/api/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '跑个命令' }),
    });
    assert.equal(sent.status, 202);

    // 人类批准（真实路径：SSE 事件 + POST 回复）
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && session.state().approval === null) {
      await sleep(20);
      if (session.state().messages.some((item) => item.body.includes('命令跑完了'))) break;
    }
    const pending = session.state().approval;
    assert.ok(pending, 'Agent 调 shell 时必须拦下来等人批准');
    assert.equal(pending?.action, 'shell.run');
    assert.match(String(pending?.detail), /from-agent\.txt/, '人类要看到完整命令原文');

    await fetch(`${server.url}/api/approval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: pending?.id, decision: 'allow_once' }),
    });

    const finished = Date.now() + 15000;
    while (Date.now() < finished && !session.state().messages.some((item) => item.body.includes('命令跑完了'))) {
      await sleep(25);
    }
    assert.equal(
      session.state().messages.some((item) => item.body.includes('命令跑完了')),
      true,
      '批准之后命令要真的执行并把结果回给 Agent',
    );
    assert.equal(
      fs.existsSync(path.join(session.runner.workspace.root, 'from-agent.txt')),
      true,
      '命令的副作用落在工作空间里',
    );
  } finally {
    controller.abort();
    await server.close();
    await session.close();
  }
});
