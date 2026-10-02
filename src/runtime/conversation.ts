/**
 * 多轮记忆：**上下文是事件日志的投影**。
 *
 * 不靠进程内存里的一个数组——因为「界面 = f(事件日志)」这条不变式，
 * 对上下文同样成立。好处是进程重启后历史还在（日志在磁盘上）。
 */
import type { LoggedEvent } from '../eventlog/log.ts';
import type { ContextItem } from '../loop/loop.ts';

/**
 * `/clear` 之后，投影只看标记之后的那些事件。
 *
 * 关键：**宿主显示与子进程上下文用的是同一个函数**，所以「清空」只需要写一条标记，
 * 两边同时生效，不存在「界面清了但 Agent 还记得」这种漂移。
 * 磁盘上的旧日志一个字都不删（审计还在）。
 */
export function clearBoundary(events: LoggedEvent[]): number {
  let boundary = 0;
  for (const event of events) {
    if (event.type === 'conversation.cleared') boundary = event.seq;
  }
  return boundary;
}

/** 只投影「对话内容」：谁说了什么、Agent 说了什么。工具噪音不进上下文。 */
export function projectConversation(events: LoggedEvent[]): ContextItem[] {
  const items: ContextItem[] = [];
  const boundary = clearBoundary(events);

  for (const event of events) {
    if (event.seq <= boundary) continue;
    if (event.type === 'message.received') {
      items.push({
        role: event.from === 'human' ? 'human' : 'peer',
        text: String(event.body ?? ''),
        meta: { id: event.id, from: event.from, kind: event.kind },
      });
      continue;
    }
    if (event.type === 'agent.thinking') {
      items.push({ role: 'assistant', text: String(event.text ?? '') });
    }
  }

  return items;
}
