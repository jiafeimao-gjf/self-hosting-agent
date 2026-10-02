#!/usr/bin/env node
/**
 * P0 垂直切片的入口：把 Kernel、Loop 子进程、帧协议、事件日志、Surface 串成一条线。
 *
 *   node src/cli.ts demo                       # 端到端演示
 *   node src/cli.ts demo --prompt "换个说法"    # 换个需求
 *   node src/cli.ts render spec.json           # 只渲染一份 View Spec
 */
import fs from 'node:fs';
import path from 'node:path';

import { EventLog } from './eventlog/log.ts';
import { ApprovalGate } from './kernel/approval.ts';
import { AgentPool } from './kernel/pool.ts';
import { TeamRunner } from './orchestrator/team.ts';
import { ClientSession } from './server/session.ts';
import type { ModelSettings } from './server/settings.ts';
import { startServer } from './server/http-server.ts';
import { ConversationRegistry } from './server/conversations.ts';
import { ViewDocument } from './surface/document.ts';
import { SurfaceIngest } from './surface/ingest.ts';
import { validateViewSpec } from './surface/viewspec.ts';
import { renderViewSpec } from './surface/renderer.ts';
import type { Frame } from './protocol/frames.ts';

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined || !token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}

function describe(frame: Frame): string {
  switch (frame.t) {
    case 'loop.state':
      return `loop.state      ${String(frame.state)}${frame.detail ? ` (${String(frame.detail)})` : ''}`;
    case 'agent.thinking':
      return `agent.thinking  ${String(frame.text)}`;
    case 'tool.call':
      return `tool.call       ${String(frame.name)} ${JSON.stringify(frame.args ?? {})}`;
    case 'tool.result':
      return `tool.result     ${String(frame.id)} ${frame.ok ? 'ok' : `失败：${String(frame.error)}`}`;
    case 'ui.patch':
      return `ui.patch        ${String(frame.op)} @ ${String(frame.scope)}`;
    case 'loop.step':
      return `loop.step       ${String(frame.step)}/5 ${String(frame.name)}`;
    case 'loop.done':
      return `loop.done       ${String(frame.reason)}`;
    default:
      return `${String(frame.t)}`;
  }
}

function runRender(argv: string[]): number {
  const args = parseArgs(argv);
  const target = argv.find((token) => !token.startsWith('--'));
  if (target === undefined) {
    console.error('用法：node src/cli.ts render <spec.json> [--out surface.html]');
    return 1;
  }

  const raw = JSON.parse(fs.readFileSync(target, 'utf8')) as unknown;
  const validation = validateViewSpec(raw);
  if (!validation.ok) {
    console.error(`✖ View Spec 不合法：${validation.error.code} ${validation.error.message}`);
    return 1;
  }

  const html = renderViewSpec(validation.spec, { title: path.basename(target) });
  const out = args.out ?? path.join(path.dirname(target), 'surface.html');
  fs.writeFileSync(out, html, 'utf8');
  console.log(`✔ 已渲染 ${out}`);
  return 0;
}

async function runDemo(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const cwd = process.cwd();
  const outDir = args.out ?? path.join(cwd, 'examples', 'out');
  const logDir = args['log-dir'] ?? path.join(cwd, '.agent-client', 'demo');
  const prompt = args.prompt ?? '把预算显示成进度条';

  fs.mkdirSync(outDir, { recursive: true });
  fs.rmSync(logDir, { recursive: true, force: true });

  const log = new EventLog({ dir: logDir });
  const document = new ViewDocument();
  const ingest = new SurfaceIngest({
    document,
    onReject: (patch, reason) => console.log(`   ✖ 拒绝 ${patch.scope}：${reason}`),
  });

  console.log('Agent Client · P0 垂直切片\n');
  console.log(`需求：${prompt}`);
  console.log(`事件日志：${logDir}`);
  console.log(`渲染产物：${outDir}\n`);

  // 审批门：默认拒绝，这里给一个「人类在旁边看着」的策略，L3 动作需要放行才动
  const approval = new ApprovalGate({ policy: () => 'allow_once' });
  const pool = new AgentPool({ log });
  const handle = pool.spawn({ agentId: 'lead', logDir: path.join(logDir, 'agent-lead') });

  console.log(`[spawn] lead pid=${handle.pid}（与宿主 ${process.pid} 不同进程）\n`);

  handle.onFrame((frame: Frame) => {
    console.log(`  ←  ${describe(frame)}`);
    if (frame.t === 'ui.patch') {
      const result = ingest.ingest({ scope: String(frame.scope), op: String(frame.op), spec: frame.spec });
      if (result.ok) console.log(`      界面文档 → v${result.version}（scope: ${result.scope}）`);
    }
  });

  const finished = new Promise<Frame>((resolve) => handle.onFrame((frame: Frame) => {
    if (frame.t === 'loop.done') resolve(frame);
  }));

  handle.send({ t: 'human.message', text: prompt });
  const done = await finished;

  const htmlPath = path.join(outDir, 'surface.html');
  fs.writeFileSync(htmlPath, document.render({ title: 'Agent Client · P0 演示' }), 'utf8');
  const specPath = path.join(outDir, 'surface.json');
  fs.writeFileSync(specPath, JSON.stringify(document.snapshot(), null, 2) + '\n', 'utf8');

  await pool.shutdown();

  const counts = log.replay(
    (state: Record<string, number>, event: { type: string }) => {
      state[event.type] = (state[event.type] ?? 0) + 1;
      return state;
    },
    {},
  );

  console.log(`\n终态：${String(done.reason)}`);
  console.log(`界面文档：v${document.version}，scopes=[${document.scopes().join(', ')}]`);
  console.log(`事件日志：${log.size} 条 ${JSON.stringify(counts)}`);
  console.log(`审批历史：${approval.history.length} 次`);
  console.log(`\n打开看看：${htmlPath}`);
  return 0;
}

const PANEL_SPEC = {
  type: 'panel',
  title: '今日预算',
  children: [
    { type: 'progress', label: 'token', value: 0.62, tone: 'warning' },
    { type: 'action', label: '提高上限', emit: 'ui.event:raise_budget' },
  ],
};

/** P1 演示：Lead 建任务 → 拉起队友 → 队友领活干完 → 回报 → Lead 改界面 */
const TEAM_LEAD_SCRIPT = [
  { toolCalls: [{ id: 'l1', name: 'task.create', args: { id: 'task_19', subject: '预算进度条组件', writeScopes: ['client-plugins/**'] } }] },
  { toolCalls: [{ id: 'l2', name: 'agent.spawn', args: { agentId: 'teammate:ui', brief: '请领取 task_19：把预算做成进度条' } }] },
  { toolCalls: [{ id: 'l3', name: 'agent.wait', args: { ids: ['teammate:ui'], timeoutMs: 20000 } }] },
  { text: '队友交付了，我把它挂到侧边栏。', toolCalls: [{ id: 'l4', name: 'ui.render', args: { scope: 'surface.sidebar', op: 'mount', spec: PANEL_SPEC } }] },
  { text: '界面已更新，收工。', done: true },
];

const TEAM_MATE_SCRIPT = [
  { text: '收到 brief，先领任务。', toolCalls: [{ id: 't1', name: 'task.claim', args: { id: 'task_19', expectedRevision: 0 } }] },
  { text: '写完组件，交付。', toolCalls: [{ id: 't2', name: 'task.complete', args: { id: 'task_19', expectedRevision: 1 } }] },
  { text: '组件写完，已交付', done: true },
];

async function runTeam(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const cwd = process.cwd();
  const outDir = args.out ?? path.join(cwd, 'examples', 'out');
  const runDir = args.dir ?? path.join(cwd, '.agent-client', 'team');
  const prompt = args.prompt ?? '给预算加一个进度条';

  fs.mkdirSync(outDir, { recursive: true });
  fs.rmSync(runDir, { recursive: true, force: true });

  console.log('Agent Client · P1 原生多 Agent 编排\n');
  console.log(`需求：${prompt}`);
  console.log(`工作目录：${runDir}\n`);

  const runner = new TeamRunner({
    dir: runDir,
    // 「人类在旁边看着」的审批策略：agent.spawn 属于 L3 动作，默认拒绝
    approval: new ApprovalGate({ policy: () => 'allow_once' }),
    scripts: { 'teammate:ui': TEAM_MATE_SCRIPT },
    onFrame: (agentId, frame) => console.log(`  ←  [${agentId}] ${describe(frame)}`),
  });

  const result = await runner.runLead({ prompt, script: TEAM_LEAD_SCRIPT });

  const htmlPath = path.join(outDir, 'team-surface.html');
  fs.writeFileSync(htmlPath, runner.document.render({ title: 'Agent Client · P1 编排演示' }), 'utf8');

  const counts = runner.log.replay(
    (state: Record<string, number>, event: { type: string }) => {
      state[event.type] = (state[event.type] ?? 0) + 1;
      return state;
    },
    {},
  );

  const task = runner.board.get('task_19');
  console.log(`\n终态：${result.reason}（${result.elapsedMs}ms）`);
  console.log(`子 Agent：${result.children.join(', ') || '（无）'}`);
  console.log(`任务板：task_19 → ${task?.status ?? '不存在'}${task?.owner ? ` @ ${task.owner}` : ''}`);
  console.log(`界面文档：v${runner.document.version}，scopes=[${runner.document.scopes().join(', ')}]`);
  console.log(`宿主工具调用：${counts['host.tool.call'] ?? 0} 次`);
  console.log(`事件日志：${runner.log.size} 条 ${JSON.stringify(counts)}`);
  console.log(`\n打开看看：${htmlPath}`);
  return 0;
}

/** 探一下模型端点是否活着（默认 Ollama），别让人类打开页面才发现连不上 */
async function probeEndpoint(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function runServe(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const cwd = process.cwd();
  const dir = args.dir ?? path.join(cwd, '.agent-client', 'client');
  const port = Number(args.port ?? process.env.PORT ?? 4311);
  const choice = args.model ?? process.env.AGENT_MODEL_CHOICE ?? 'auto';

  let agentEnv: Record<string, string> = {};
  let modelLabel: string;

  const baseUrl = args['base-url'] ?? process.env.AGENT_BASE_URL ?? 'http://127.0.0.1:11434/v1';
  const modelName = args['model-name'] ?? process.env.AGENT_MODEL_NAME ?? 'qwen3:4b';

  // 设置页可以随时改模型；命令行给的只是「还没配过时」的初值
  const modelSettings: Partial<ModelSettings> = {
    protocol: 'openai',
    baseUrl,
    model: modelName,
    apiKey: args['api-key'] ?? process.env.AGENT_API_KEY ?? '',
    timeoutMs: Number(args['model-timeout'] ?? process.env.AGENT_MODEL_TIMEOUT ?? '180000'),
  };

  if (choice === 'demo') {
    agentEnv = { AGENT_MODEL: 'demo' };
    modelLabel = '内置演示模型（确定性、秒回、不需要任何模型服务），可在设置页切到真模型';
  } else if (choice === 'auto' && !(await probeEndpoint(baseUrl))) {
    agentEnv = { AGENT_MODEL: 'demo' };
    modelLabel = `没找到 ${baseUrl}，先用内置演示模型（设置页可以改）`;
  } else {
    modelLabel = `${modelName} @ ${baseUrl}（可在设置页修改）`;
  }

  fs.mkdirSync(dir, { recursive: true });

  // SPEC-020：一个对话一个会话，各自独立的目录/子进程/文档/事件日志。
  // 会话是**惰性**打开的：只有真的用到某个对话时才建它、才拉起它的 Lead。
  const makeSessionOptions = (id: string, dir: string): ConstructorParameters<typeof ClientSession>[0] => ({
    dir,
    id,
    agentEnv,
    modelSettings,
    // 人类就坐在这个页面前面，所以审批门给「放行一次」的策略——但每一次都留痕可查
    approval: new ApprovalGate({ policy: () => 'allow_once' }),
    logEcho: args['log-echo'] === 'true' || process.env.AGENT_LOG_ECHO === '1',
    ...(args['log-level'] === undefined ? {} : { logLevel: args['log-level'] as 'debug' | 'info' | 'warn' | 'error' }),
  });

  const registry = new ConversationRegistry({
    root: dir,
    open: (id, conversationDir) => {
      const settings = JSON.parse(fs.readFileSync(path.join(conversationDir, 'meta.json'), 'utf8')) as { title?: string };
      return new ClientSession({ ...makeSessionOptions(id, conversationDir), title: settings.title ?? id });
    },
  });
  const session = registry.get('default');

  // 宿主崩溃兜底：不留一段没人看的堆栈
  process.on('uncaughtException', (err) => {
    session.logger.error('宿主未捕获异常', { message: err.message, stack: err.stack });
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    session.logger.error('宿主未处理的 Promise 拒绝', {
      reason: reason instanceof Error ? reason.message : String(reason),
    });
  });

  const server = await startServer({ session, registry, port, logger: session.logger.child('http') });

  console.log('Agent Client · 可用态\n');
  console.log(`  打开：${server.url}`);
  console.log(`  模型：${modelLabel}`);
  console.log(`  数据：${dir}`);
  console.log(`  可改源码：${session.clientSource?.root ?? '（未启用自举）'}`);
  console.log(`  设置页：顶栏「设置」——支持 OpenAI 兼容与 Anthropic 两种协议`);
  console.log(`  日志：${session.logger.file() ?? '（未开启文件日志）'}`);
  console.log('  排障：npm run serve -- --log-level debug --log-echo true（同时打到终端）');
  console.log('  审批：人类在场 → 自动放行，但每次动作都写进事件日志（审批 UI 属下一阶段）');
  console.log('\n  在页面里说话，Agent 会一边回你，一边把它自己的界面改给你看。');
  console.log('  试试说「换个配色」——它会去改自己的 style.css，自检通过后界面当场变色。Ctrl+C 退出。\n');

  const shutdown = async (): Promise<void> => {
    console.log('\n正在回收 Agent 进程…');
    await server.close();
    await session.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  // 常驻：不 resolve，等信号
  return new Promise<number>(() => {});
}

const command = process.argv[2];
const rest = process.argv.slice(3);

if (command === 'serve') {
  runServe(rest).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(`✖ serve 失败：${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      process.exit(1);
    },
  );
} else if (command === 'render') {
  process.exit(runRender(rest));
} else if (command === 'team') {
  runTeam(rest).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(`✖ team 失败：${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      process.exit(1);
    },
  );
} else if (command === 'demo' || command === undefined) {
  runDemo(rest).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(`✖ demo 失败：${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      process.exit(1);
    },
  );
} else {
  console.error(`未知命令：${command}\n可用：demo | render`);
  process.exit(1);
}
