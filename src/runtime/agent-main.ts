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
import { AgentLoop, DEFAULT_HOST_TOOL_TIMEOUT_MS, defineHostTool, defineTool } from '../loop/loop.ts';
import type { Frame } from '../protocol/frames.ts';
import type {
  HostBridgePort,
  HostToolReply,
  InboxMessage,
  ModelPort,
  ModelOutput,
  ToolSpec,
} from '../loop/loop.ts';
import { EventLog } from '../eventlog/log.ts';
import { scriptedModel } from '../loop/fake-model.ts';
import { createHttpModel } from '../loop/http-model.ts';
import { projectConversation } from './conversation.ts';

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
      // 用人类这句话算一个稳定的数，让每次对话界面都有变化（演示用）
      const seed = [...lastHuman].reduce((sum, char) => sum + char.charCodeAt(0), 0);
      const value = Number((0.25 + (seed % 60) / 100).toFixed(2));
      const panel = {
        type: 'panel',
        title: `Agent 的界面 · ${lastHuman.slice(0, 14)}`,
        children: [
          {
            type: 'progress',
            label: '占用',
            value,
            tone: value > 0.75 ? 'danger' : value > 0.55 ? 'warning' : 'success',
          },
          {
            type: 'kv',
            pairs: [
              { key: '需求', value: lastHuman.slice(0, 24) },
              { key: '模型', value: '内置演示模型' },
              { key: '界面版本', value: '每次对话都会前进' },
            ],
          },
          { type: 'action', label: '再来一句', emit: 'ui.event:again' },
        ],
      };

      return {
        text: '我把结果画到右边了——这块界面就是我发过去的 View Spec。',
        uiPatches: [{ scope: 'surface.main', op: 'upsert', spec: panel }],
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

/** 宿主工具：由 Kernel 代办（拉起进程、投递消息、落界面、改任务板） */
const hostToolNames = (args['host-tools'] ?? '')
  .split(',')
  .map((name) => name.trim())
  .filter((name) => name !== '');
const hostToolTimeoutMs = Number(args['host-tool-timeout'] ?? DEFAULT_HOST_TOOL_TIMEOUT_MS);

/** 宿主工具的自述：真模型靠它知道有哪些手段可用 */
const HOST_TOOL_DESCRIPTIONS: Record<string, string> = {
  'agent.spawn': '拉起一个新的 Agent 子进程（需要人类审批）并投递 brief。参数：agentId, brief',
  'agent.send': '经邮箱把消息投递给另一个 Agent。参数：to, body',
  'agent.wait': '等到列出的 Agent 都回报。参数：ids, timeoutMs',
  // 真模型不看源码，只能靠这段描述学会「界面能长什么样」——写细一点，界面才不会长歪
  'ui.render':
    '把一份 View Spec 落进人类眼前的界面面板（会立刻更新）。参数：scope(如 surface.main)、op(默认 upsert：有没有都画成这样；也可用 mount/replace/patch)、spec。' +
    'spec 必须是：{type:"panel", title:"标题", children:[...]}。可用组件（字段名必须完全一致）：' +
    'text{text} | progress{label, value:0~1, tone?} | action{label, emit} | list{items:["..."]} | ' +
    'kv{pairs:[{key, value}]} | columns{children:[...]} | badge{text, tone?} | panel{title?, children}。' +
    'tone 可选：default|muted|strong|info|success|warning|danger。一屏放一件事，不要把长文塞进界面。',
  'task.create': '在任务板上建任务。参数：id?, subject, description?, writeScopes?, blockedBy?',
  'task.claim': 'CAS 认领任务。参数：id, expectedRevision?',
  'task.complete': 'CAS 完成任务。参数：id, expectedRevision?',
};

/** 说话的对象是人类，不是日志——这段话决定了客户端好不好用 */
const SYSTEM_PROMPT = [
  '你是这个 Agent 客户端里的 Lead Agent，是人类唯一的对话者。',
  '你的每句话都会显示在人类眼前的对话面板里，你画的界面会显示在旁边的界面面板里。',
  '',
  '工作方式：',
  '1. 先弄清人类要什么。不确定就直接问，不要编造数据。',
  '2. 需要在界面上展示结果时，调用 ui.render 把界面画出来——人类会立刻看到，不需要刷新。',
  '3. 回复用中文、短句、说结论。长内容放进界面里，而不是堆在对话里。',
  '4. 只有确实需要并行干活时，才用 agent.spawn 拉起队友（这会请求人类审批）。',
  '5. 做完一件事，用一句话告诉人类你做了什么、下一步建议什么。',
].join('\n');

const tools: ToolSpec[] = [
  defineTool('budget', (toolArgs) => ({ range: toolArgs.range ?? 'today', used: 620000, limit: 1000000 }), '读取预算'),
  ...hostToolNames.map((name) => defineHostTool(name, HOST_TOOL_DESCRIPTIONS[name])),
];

// ── 宿主工具桥：把 tool.call 发出去，等 tool.reply 回来 ──
interface PendingReply {
  resolve: (reply: HostToolReply) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}
const pendingReplies = new Map<string, PendingReply>();

const hostBridge: HostBridgePort = {
  awaitToolReply(callId, options) {
    return new Promise<HostToolReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingReplies.delete(callId);
        reject(new Error(`HOST_TOOL_TIMEOUT: 宿主 ${options.timeoutMs}ms 未回填 ${callId}`));
      }, options.timeoutMs);
      pendingReplies.set(callId, { resolve, reject, timer });
    });
  },
};

function settleReply(callId: string, reply: HostToolReply): void {
  const pending = pendingReplies.get(callId);
  if (pending === undefined) return;
  clearTimeout(pending.timer);
  pendingReplies.delete(callId);
  pending.resolve(reply);
}

/** 人类夺权或宿主断开时，别让 Loop 挂在等回填上 */
function abortPendingReplies(reason: string): void {
  for (const [callId, pending] of pendingReplies) {
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
    pendingReplies.delete(callId);
  }
}

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

/**
 * 模型端口只建一次并全程复用。
 *
 * 关键点：剧本是**这个 Agent 的会话剧本**，不是「每一轮都从头念」——
 * 否则第二次说话时它会重复第一句，多轮对话直接坏掉。
 */
let cachedModel: ModelPort | undefined;

function makeModel(): ModelPort {
  if (cachedModel !== undefined) return cachedModel;
  cachedModel = buildModel();
  return cachedModel;
}

function buildModel(): ModelPort {
  if (args.script !== undefined) {
    const script = JSON.parse(args.script) as ModelOutput[];
    return withDelay(scriptedModel(script), stepDelayMs);
  }

  // 真模型端口：AGENT_MODEL=http 时走 OpenAI 兼容 HTTP 接口
  const kind = args.model ?? process.env.AGENT_MODEL ?? 'demo';
  if (kind === 'http') {
    const baseUrl = args['base-url'] ?? process.env.AGENT_BASE_URL ?? '';
    const apiKey = args['api-key'] ?? process.env.AGENT_API_KEY ?? '';
    const modelName = args['model-name'] ?? process.env.AGENT_MODEL_NAME ?? '';
    const timeoutRaw = args['model-timeout'] ?? process.env.AGENT_MODEL_TIMEOUT;

    if (baseUrl === '' || modelName === '') {
      // 配置不全就明确报错，而不是偷偷退回假模型假装一切正常
      return {
        async step() {
          throw new Error('模型端口配置不全：http 模式需要 AGENT_BASE_URL 与 AGENT_MODEL_NAME');
        },
      };
    }

    const port = createHttpModel({
      baseUrl,
      apiKey,
      model: modelName,
      ...(timeoutRaw === undefined ? {} : { timeoutMs: Number(timeoutRaw) }),
    });
    return withDelay(port, stepDelayMs);
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
    hostBridge,
    hostToolTimeoutMs,
    system: SYSTEM_PROMPT,
    // 历史上下文来自事件日志投影：进程重启也不丢
    seedContext: projectConversation(log.read()),
    maxContextItems: 60,
    budget: { maxTurns: 12, maxToolCalls: 40, maxTokens: 400000, maxWallClockMs: 600000 },
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
      abortPendingReplies(`HOST_TOOL_ABORTED: 人类中断（${String(frame.reason)}）`);
      currentLoop?.interrupt(String(frame.reason));
      break;
    }
    case 'tool.reply': {
      settleReply(String(frame.id), {
        ok: frame.ok === true,
        ...(typeof frame.result === 'string' ? { result: frame.result } : {}),
        ...(typeof frame.error === 'string' ? { error: frame.error } : {}),
      });
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
  abortPendingReplies('HOST_TOOL_ABORTED: 宿主连接已关闭');
  process.exit(0);
});

log.append({ type: 'agent.boot', agent: agentId, pid: process.pid, logDir });
send({ t: 'loop.state', state: 'idle', detail: `pid=${process.pid}` });
