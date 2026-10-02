/**
 * SPEC-020 `/` 常用命令。
 *
 * 命令放在**服务端**执行，客户端只按前缀路由。理由：命令要直接碰会话状态
 * （清空、写历史、读工作空间），放服务端才能保证「清空」对宿主显示与 Agent 记忆
 * 同时生效；客户端保持"哑"，也就不会出现两处实现各说各话。
 *
 * 另一条硬规矩：命令**绝不惊动模型**（CMD-006）。未知命令也必须明确报错，
 * 而不是顺手丢给模型当普通消息（CMD-005）。
 */
import type { ClientSession } from './session.ts';
import { ConversationRegistry } from './conversations.ts';

export interface CommandAction {
  type: 'switch' | 'created' | 'cleared';
  conversation?: string;
}

export interface CommandResult {
  ok: boolean;
  command: string;
  output: string;
  action?: CommandAction;
  error?: string;
}

export interface CommandContext {
  session: ClientSession;
  registry: ConversationRegistry;
}

export interface CommandSpec {
  name: string;
  usage: string;
  summary: string;
}

/** 命令表：`/help` 直接由它生成，所以不存在"帮助里写了但实际没有"的幽灵命令 */
export const COMMANDS: CommandSpec[] = [
  { name: 'help', usage: '/help', summary: '列出全部命令' },
  { name: 'clear', usage: '/clear', summary: '清空当前对话的显示与上下文（磁盘日志保留）' },
  { name: 'history', usage: '/history [list]', summary: '把当前对话导出成 Markdown 文件' },
  { name: 'new', usage: '/new [标题]', summary: '新建对话并切过去' },
  { name: 'list', usage: '/list', summary: '列出全部对话' },
  { name: 'switch', usage: '/switch <id>', summary: '切换到指定对话' },
  { name: 'files', usage: '/files', summary: '列出当前工作空间的文件' },
  { name: 'cat', usage: '/cat <路径>', summary: '读取并展示工作空间里的文件' },
  { name: 'whoami', usage: '/whoami', summary: '显示当前对话与模型' },
];

export interface ParsedCommand {
  name: string;
  args: string;
}

/** 解析一行输入：不是命令就返回 undefined */
export function parseCommand(text: string): ParsedCommand | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return undefined;

  const body = trimmed.slice(1).trim();
  if (body === '') return { name: '', args: '' };

  const spaceAt = body.search(/\s/);
  if (spaceAt < 0) return { name: body.toLowerCase(), args: '' };
  return { name: body.slice(0, spaceAt).toLowerCase(), args: body.slice(spaceAt + 1).trim() };
}

export function helpText(): string {
  const width = Math.max(...COMMANDS.map((command) => command.usage.length));
  return ['可用命令：', ...COMMANDS.map((command) => `  ${command.usage.padEnd(width + 2)}${command.summary}`)].join('\n');
}

function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function runCommand(text: string, context: CommandContext): CommandResult {
  const parsed = parseCommand(text);
  if (parsed === undefined) {
    return { ok: false, command: '', output: '', error: 'NOT_A_COMMAND' };
  }

  const { session, registry } = context;
  const { name, args } = parsed;

  switch (name) {
    case '':
    case 'help':
      return { ok: true, command: 'help', output: helpText() };

    case 'clear': {
      session.clear();
      return {
        ok: true,
        command: 'clear',
        output: '已清空当前对话：界面上的往来与 Agent 的上下文都清掉了（磁盘上的历史日志仍然保留）。',
        action: { type: 'cleared' },
      };
    }

    case 'history': {
      if (args === 'list') {
        const files = session.listHistory();
        if (files.length === 0) return { ok: true, command: 'history', output: '还没有导出过历史文件。' };
        return {
          ok: true,
          command: 'history',
          output: ['已保存的历史文件：', ...files.map((file) => `  ${file.name}  ${bytesLabel(file.bytes)}  ${file.mtime}`)].join('\n'),
        };
      }
      const saved = session.exportHistory();
      return {
        ok: true,
        command: 'history',
        output: `已导出 ${saved.lines} 行 / ${bytesLabel(saved.bytes)}：\n  ${saved.path}\n（用 /history list 可以看到全部历史文件）`,
      };
    }

    case 'new': {
      const created = registry.create(args === '' ? undefined : args);
      return {
        ok: true,
        command: 'new',
        output: `已新建对话「${created.title}」（id=${created.id}）并切了过去。`,
        action: { type: 'created', conversation: created.id },
      };
    }

    case 'list': {
      const conversations = registry.list();
      return {
        ok: true,
        command: 'list',
        output: [
          '全部对话：',
          ...conversations.map(
            (item) => `  ${item.id === registry.active ? '*' : ' '} ${item.id.padEnd(10)} ${item.title}（${item.messages} 条）`,
          ),
        ].join('\n'),
      };
    }

    case 'switch': {
      if (args === '') {
        return { ok: false, command: 'switch', output: '', error: '用法：/switch <id>（用 /list 看有哪些）' };
      }
      if (!ConversationRegistry.isValidId(args)) {
        return { ok: false, command: 'switch', output: '', error: `非法的对话 id：${args}` };
      }
      if (!registry.exists(args) && registry.active !== args) {
        return { ok: false, command: 'switch', output: '', error: `没有这个对话：${args}（用 /list 看有哪些）` };
      }
      registry.get(args);
      return {
        ok: true,
        command: 'switch',
        output: `已切换到对话 ${args}。`,
        action: { type: 'switch', conversation: args },
      };
    }

    case 'files': {
      const files = session.runner.workspace.list();
      if (files.length === 0) {
        return { ok: true, command: 'files', output: '工作空间还没有文件。让 Agent 用 workspace.write 写一个试试。' };
      }
      return {
        ok: true,
        command: 'files',
        output: [
          `工作空间 ${session.runner.workspace.root}`,
          ...files.map((file) => `  ${file.path.padEnd(28)} ${bytesLabel(file.bytes)}  ${file.mtime}`),
        ].join('\n'),
      };
    }

    case 'cat': {
      if (args === '') return { ok: false, command: 'cat', output: '', error: '用法：/cat <路径>（用 /files 看有哪些）' };
      const read = session.runner.workspace.read({ path: args });
      if (!read.ok) return { ok: false, command: 'cat', output: '', error: `${read.code}: ${read.reason}` };
      const tail = read.truncated ? '\n…（已截断，文件更大）' : '';
      return { ok: true, command: 'cat', output: `### ${read.path}（${bytesLabel(read.bytes)}）\n\n${read.content}${tail}` };
    }

    case 'whoami': {
      return {
        ok: true,
        command: 'whoami',
        output: [
          `对话：${session.id}（${session.title}）`,
          `模型：${session.publicSettings().model} @ ${session.publicSettings().label}`,
          `工作空间：${session.runner.workspace.root}`,
        ].join('\n'),
      };
    }

    default:
      return {
        ok: false,
        command: name,
        output: '',
        error: `未知命令：/${name}（用 /help 看可用命令）`,
      };
  }
}
