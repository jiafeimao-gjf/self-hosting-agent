/**
 * 工具名的**线上格式**约束。
 *
 * 我们的内部工具名是带点的（`ui.render`、`agent.spawn`、`client.write`），可读性好，
 * 也是宿主与子进程之间约定的能力名。但两家提供方都不接受点号：
 *
 *   OpenAI 兼容端点：Invalid 'tools[0].function.name': string does not match
 *                    pattern '^[a-zA-Z0-9_-]+$'
 *   Anthropic：工具名同样只允许 `[a-zA-Z0-9_-]`
 *
 * 所以：**内部名字不动，出网时改名，回程时改回来**。
 * 约束属于「线上协议」，就修在协议边界上，不污染内部命名。
 */

/** 两家提供方共通的合法工具名模式 */
export const WIRE_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** 把内部名压成线上合法的名字（点号等非法字符统一换成下划线） */
export function toWireName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

export interface WireNameMap {
  /** 内部名 → 线上名 */
  toWire(name: string): string;
  /** 线上名 → 内部名；不认识就返回 undefined（模型可能报出一个不存在的名字） */
  toInternal(wire: string): string | undefined;
}

/**
 * 为一组工具建立双向映射。
 *
 * 必须检测冲突：若两个不同的内部名压成同一个线上名（例如 `a.b` 与 `a_b`），
 * 模型回传的名字就无法判断到底调的是哪一个——宁可当场报错，也不要猜。
 */
export function createWireNameMap(names: string[]): WireNameMap {
  const forward = new Map<string, string>();
  const reverse = new Map<string, string>();

  for (const name of names) {
    const wire = toWireName(name);
    const existing = reverse.get(wire);
    if (existing !== undefined && existing !== name) {
      throw new Error(`工具名冲突：${existing} 与 ${name} 都会映射成线上名 ${wire}`);
    }
    forward.set(name, wire);
    reverse.set(wire, name);
  }

  return {
    toWire: (name) => forward.get(name) ?? toWireName(name),
    toInternal: (wire) => reverse.get(wire),
  };
}
