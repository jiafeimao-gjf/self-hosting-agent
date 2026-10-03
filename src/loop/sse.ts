/**
 * SPEC-022 流式输出：最小的 SSE 解析器。
 *
 * 两家协议的流式都是 `text/event-stream`，但事件形状完全不同（OpenAI 只发 `data:` 的 JSON，
 * Anthropic 还带 `event:` 名）。所以这里只做**分帧**这一件事：把字节流切成一条条事件，
 * 具体怎么解释交给各自的适配器。
 *
 * 三个容易踩的点，都在这里处理掉：
 *   1. 一个 chunk 可能切开半条事件（要留缓冲）；
 *   2. 一条事件可能被 CRLF 切断（\r\n\r\n 也要算边界）；
 *   3. `data:` 可以出现多次，按规范要用 \n 拼起来。
 */

export interface SseEvent {
  /** `event:` 字段；OpenAI 不发这个字段，就是 undefined */
  event: string | undefined;
  /** `data:` 拼接后的内容（不含结尾换行） */
  data: string;
}

export interface SseParser {
  /** 喂一块数据，可能触发 0..n 次 onEvent */
  push(chunk: string): void;
  /** 流结束时调用：把缓冲区里最后一条不完整的事件也吐出来 */
  flush(): void;
}

export function createSseParser(onEvent: (event: SseEvent) => void): SseParser {
  let buffer = '';

  const emitBlock = (block: string): void => {
    let event: string | undefined;
    const dataLines: string[] = [];

    for (const rawLine of block.split('\n')) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (line === '' || line.startsWith(':')) continue; // 空行与注释（心跳）都跳过
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1); // 规范：冒号后最多去掉一个空格
      if (field === 'event') event = value;
      else if (field === 'data') dataLines.push(value);
    }

    if (dataLines.length === 0 && event === undefined) return;
    onEvent({ event, data: dataLines.join('\n') });
  };

  const drain = (final: boolean): void => {
    for (;;) {
      // 事件之间用空行分隔；\r\n\r\n 与 \n\n 都要认
      const match = /\r?\n\r?\n/.exec(buffer);
      if (match === null) break;
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      emitBlock(block);
    }
    if (final && buffer.trim() !== '') {
      emitBlock(buffer);
      buffer = '';
    }
  };

  return {
    push(chunk: string): void {
      buffer += chunk;
      drain(false);
    },
    flush(): void {
      drain(true);
    },
  };
}

/** 从 `data: [DONE]` 这类约定里判断流是否结束（OpenAI 用它收尾） */
export function isDoneSentinel(data: string): boolean {
  return data.trim() === '[DONE]';
}

/**
 * 按时间节流地把「累积全文」交出去。
 *
 * 为什么传累积全文而不是分片：分片一旦丢一条、重一条、乱序一条，客户端拼出来的就是错的；
 * 传全文则天然幂等——重放多少次结果都一样。代价是每条都带上前缀，但几十毫秒一条、
 * 一条也就几百字节，换来的是「不可能画出错文本」。
 */
export function createDeltaThrottle(
  onDelta: (text: string) => void,
  options: { minIntervalMs?: number; now?: () => number } = {},
): { push(text: string): void; finish(text: string): void } {
  const minIntervalMs = options.minIntervalMs ?? 120;
  const now = options.now ?? (() => Date.now());
  let lastAt = Number.NEGATIVE_INFINITY;
  let lastText = '';

  return {
    push(text: string): void {
      if (text === lastText) return; // 内容没变就别打扰界面
      const at = now();
      if (at - lastAt < minIntervalMs) return;
      lastAt = at;
      lastText = text;
      onDelta(text);
    },
    /** 收尾：无论节流与否，最后一次一定发出去（否则界面会停在半句话上） */
    finish(text: string): void {
      if (text === lastText) return;
      lastAt = now();
      lastText = text;
      onDelta(text);
    },
  };
}
