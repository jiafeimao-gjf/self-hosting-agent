/** 浏览器端界面逻辑的类型声明（实现是纯 JS，浏览器与 Node 共用同一份文件） */

export interface ApplySurfaceInput {
  nextHtml: unknown;
  prevHtml: unknown;
  painted: unknown;
  force?: boolean;
}

/** 要不要把这份 html 写进沙箱：看的是「画没画上」，不是「内容变没变」 */
export function shouldApplySurface(input: ApplySurfaceInput): boolean;

export interface NormalizedState {
  version: number;
  html: string;
  scopes: unknown[];
  agents: unknown[];
  tasks: unknown[];
  messages: unknown[];
  events: unknown[];
}

/** 把 /api/state 的任意输入收敛成界面需要的形状，坏输入退化为空 */
export function normalizeState(raw: unknown): NormalizedState;
