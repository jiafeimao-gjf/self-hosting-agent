/**
 * SPEC-004 §3 子进程入口 —— 一个 Agent 就是这一个进程。
 *
 * 规矩：
 *   · stdin 只收帧，stdout 只发帧，stderr 只放诊断（不许污染帧流）。
 *   · 人来的消息一律**入队**，由 Loop 在 step boundary 取走，绝不打断正在进行的 step。
 */
import os from 'node:os';
import path from 'node:path';

import { FrameChannel } from '../protocol/channel.ts';
import { AgentLoop, defineTool } from '../loop/loop.ts';
import type { Frame } from '../protocol/frames.ts';
import type { InboxMessage, ModelPort, ModelOutput, ToolSpec } from '../loop/loop.ts';
import { EventLog } from '../eventlog/log.ts';
import { scriptedModel } from '../loop/fake-model.ts';

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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function withDelay(port: ModelPort, ms: number): ModelPort {
  if (ms <= 0) return port;
  return {
    async step(input) {
      await sleep(ms);
      return port.step(input);
    },
  };
}

/** P0 的确定性演示模型：两轮完成，含一次工具调用与一次界面改造 */
function demoModel(): ModelPort {
  return {
    async step({ turn, context }) {
      const lastHuman = [...context].reverse().find((item) => item.role === 'human')?.text ?? '（没有需求）';
      if (turn === 1) {
        return {
          text: `收到：${lastHuman}。先看一眼预算数据。`,
          toolCalls: [{ id: 'c1', name: 'budget', args: { range: 'today' } }],
          usage: { tokens: 42 },
        };
      }
      return {
        text: '数据到手，我把它做成进度条放到侧边栏——这一步是在改我自己的界面。',
        uiPatches: [
          {
            scope: 'surface.sidebar',
            op: 'mount',
            spec: {
              type: 'panel',
              title: '今日预算',
              children: [
                { type: 'progress', label: 'token', value: 0.62, tone: 'warning' },
                { type: 'action', label: '提高上限', emit: 'ui.event:raise_budget' },
              ],
            },
          },
        ],
        done: true,
        usage: { tokens: 58 },
      };
    },
  };
}

const args = parseArgs(process.argv.slice(2));
const agentId = args.agent ?? 'lead';
const logDir = args['log-dir'] ?? path.join(os.tmpdir(), 'agent-client', 'agents', agentId);
const stepDelayMs = Number(args['step-delay'] ?? 0);

const log = new EventLog({ dir: logDir });
const channel = new FrameChannel({ input: process.stdin, output: process.stdout });
const tools: ToolSpec[] = [
  defineTool('budget', (toolArgs) => ({ range: toolArgs.range ?? 'today', used: 620000, limit: 1000000 }), '读取预算'),
];

const pending: InboxMessage[] = [];
let seq = 0;
let running = false;
let currentLoop: AgentLoop | undefined;
let messageCounter = 0;

/** 边界投递的队列：谁都不许在收帧时直接执行 */
const inbox = {
  drainAt() {
    return pending.splice(0, pending.length);
  },
};

function send(frame: Frame): void {
  seq += 1;
  try {
    channel.send({ ...frame, agent: agentId, seq } as Frame);
  } catch (err) {
    // 丢帧必须响亮：既喊到 stderr，也如实记账，绝不静默
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[agent-main] 发包失败：${message}\n`);
    log.append({ type: 'frame.invalid', agent: agentId, frame, message });
  }
}

function makeModel(): ModelPort {
  if (args.script !== undefined) {
    const script = JSON.parse(args.script) as ModelOutput[];
    return withDelay(scriptedModel(script), stepDelayMs);
  }
  return withDelay(demoModel(), stepDelayMs);
}

async function runOnce(): Promise<void> {
  if (running) return;
  running = true;
  const loop = new AgentLoop({
    agentId,
    model: makeModel(),
    tools,
    log,
    inbox,
    sink: { onFrame: send },
    system: '你是 Lead Agent：唯一与人类对话的进程，负责拆解、执行与收口。',
    maxContextItems: 40,
    budget: { maxTurns: 8, maxToolCalls: 20, maxTokens: 200000, maxWallClockMs: 120000 },
  });
  currentLoop = loop;
  send({ t: 'loop.state', state: 'running' });

  const result = await loop.run();
  currentLoop = undefined;
  running = false;
  send({ t: 'loop.state', state: result.reason, detail: `turns=${result.turns} tools=${result.toolCalls}` });

  // 跑的过程中排队的消息，在这里立刻开启下一轮（仍然是边界投递）
  if (pending.length > 0) await runOnce();
}

channel.on('frame', (frame: Frame) => {
  log.append({ type: 'host.frame', agent: agentId, frame });
  switch (frame.t) {
    case 'human.message': {
      messageCounter += 1;
      pending.push({ id: `msg_${messageCounter}`, from: 'human', body: String(frame.text) });
      void runOnce();
      break;
    }
    case 'peer.message': {
      messageCounter += 1;
      pending.push({
        id: `msg_${messageCounter}`,
        from: String(frame.from),
        body: String(frame.body),
        ...(frame.kind === undefined ? {} : { kind: String(frame.kind) }),
      });
      void runOnce();
      break;
    }
    case 'interrupt': {
      process.stderr.write(`[agent-main] 人类夺权：${String(frame.reason)}\n`);
      currentLoop?.interrupt(String(frame.reason));
      break;
    }
    case 'ui.event':
    case 'approval.reply': {
      log.append({ type: 'host.event', agent: agentId, frame });
      break;
    }
    default:
      process.stderr.write(`[agent-main] 未识别的帧类型 ${String(frame.t)}\n`);
  }
});

channel.on('error', (error: { code: string; message: string }) => {
  process.stderr.write(`[agent-main] 协议错误 ${error.code}: ${error.message}\n`);
  log.append({ type: 'protocol.error', agent: agentId, ...error });
});

channel.on('close', () => {
  process.exit(0);
});

log.append({ type: 'agent.boot', agent: agentId, pid: process.pid, logDir });
send({ t: 'loop.state', state: 'idle', detail: `pid=${process.pid}` });
