/**
 * 多轮记忆：**上下文是事件日志的投影**。
 *
 * 不靠进程内存里的一个数组——因为「界面 = f(事件日志)」这条不变式，
 * 对上下文同样成立。好处是进程重启后历史还在（日志在磁盘上）。
 */
import type { LoggedEvent } from '../eventlog/log.ts';
import type { ContextItem } from '../loop/loop.ts';

/** 只投影「对话内容」：谁说了什么、Agent 说了什么。工具噪音不进上下文。 */
export function projectConversation(events: LoggedEvent[]): ContextItem[] {
  const items: ContextItem[] = [];

  for (const event of events) {
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
