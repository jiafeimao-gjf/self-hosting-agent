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

const command = process.argv[2];
const rest = process.argv.slice(3);

if (command === 'render') {
  process.exit(runRender(rest));
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
