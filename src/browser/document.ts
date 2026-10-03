/**
 * SPEC-019 内置浏览器 —— 宿主侧的文档与事件受理。
 *
 * 与 `src/surface/document.ts`（View Spec 界面文档）的分工：
 *   · ViewDocument：结构化组件 → 我们渲染成 HTML（Agent 说「画什么」）；
 *   · BrowserHost ：Agent 直接给一份 HTML（Agent 说「这就是文档」）。
 *
 * 两条路各有各的沙箱面板，互不覆盖 —— 这就是规格里说的「独立渲染」。
 */
import { BRIDGE_CHANNEL, BRIDGE_MARK, composeDocument } from './bootstrap.ts';

/** 单文档上限：这是「不可信内容」的第一道闸 */
export const MAX_HTML_BYTES = 256 * 1024;
/** 单条回传事件上限：桥可能被文档里的脚本滥用 */
export const MAX_EVENT_BYTES = 8 * 1024;
/** 事件名长度上限 */
export const MAX_NAME_LENGTH = 128;

export const EVENT_KINDS = ['ready', 'emit', 'log', 'error'] as const;
export type BrowserEventKind = (typeof EVENT_KINDS)[number];

export interface BrowserRenderInput {
  html: string;
  title?: string;
  allowNetwork?: boolean;
  /** 这份文档是从哪个文件来的（渲染 HTML 文件时记下，界面上显示"正在看哪个文件"） */
  path?: string;
}

/** 发给客户端 / 存进状态的那一份（html 是已组合好的完整文档） */
export interface BrowserDocument {
  version: number;
  title: string;
  html: string;
  allowNetwork: boolean;
  ts: string;
  /** 来源文件（相对工作空间的路径）；直接给 HTML 时没有这个字段 */
  path?: string;
}

export interface BrowserEvent {
  kind: BrowserEventKind;
  name?: string;
  payload?: unknown;
  text?: string;
  level?: string;
  ts: string;
}

export type RenderResult =
  | { ok: true; version: number; title: string }
  | { ok: false; code: string; reason: string };

export type AcceptResult = { ok: true; event: BrowserEvent } | { ok: false; code: string; reason: string };

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function serializableSize(value: unknown): number | undefined {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? undefined : byteLength(json);
  } catch {
    return undefined; // 循环引用等
  }
}

export class BrowserHost {
  #version = 0;
  #raw: BrowserRenderInput | undefined;
  #doc: BrowserDocument | undefined;
  #events: BrowserEvent[] = [];
  #now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  /** 渲染一份新文档：独立于 View Spec 界面文档，版本号自成一路 */
  render(input: BrowserRenderInput): RenderResult {
    if (typeof input.html !== 'string') {
      return { ok: false, code: 'INVALID_ARGS', reason: 'html 必须是字符串' };
    }
    if (input.html.trim() === '') {
      return { ok: false, code: 'INVALID_ARGS', reason: 'html 不能是空文档' };
    }
    if (byteLength(input.html) > MAX_HTML_BYTES) {
      return {
        ok: false,
        code: 'HTML_TOO_LARGE',
        reason: `html 超过上限（${byteLength(input.html)} > ${MAX_HTML_BYTES} 字节）`,
      };
    }

    const title = typeof input.title === 'string' && input.title.trim() !== '' ? input.title.trim() : '未命名文档';
    const allowNetwork = input.allowNetwork === true;

    this.#version += 1;
    const fromPath = typeof input.path === 'string' && input.path.trim() !== '' ? input.path.trim() : undefined;
    this.#raw = { html: input.html, title, allowNetwork, ...(fromPath === undefined ? {} : { path: fromPath }) };
    this.#doc = {
      version: this.#version,
      title,
      html: composeDocument({ html: input.html, title, allowNetwork }),
      allowNetwork,
      ts: this.#now().toISOString(),
      ...(fromPath === undefined ? {} : { path: fromPath }),
    };
    return { ok: true, version: this.#version, title };
  }

  /** 当前文档（发给客户端的那一份）；从未渲染过则为 undefined */
  current(): BrowserDocument | undefined {
    return this.#doc === undefined ? undefined : { ...this.#doc };
  }

  /** 原始（未组合）HTML：留作回看与排障 */
  raw(): BrowserRenderInput | undefined {
    return this.#raw === undefined ? undefined : { ...this.#raw };
  }

  version(): number {
    return this.#version;
  }

  /**
   * 受理窗口消息形态的桥消息：`{__ac:1, channel, …}`。
   *
   * 信封校验只在**窗口边界**有意义——它挡的是「别的 iframe / 别的窗口冒充」。
   * 到了 HTTP 入口（`POST /api/browser/event`）已经没有窗口可冒充，
   * 客户端按契约只发 `{kind,name,payload}`，所以那里走 acceptEvent。
   */
  acceptBridge(raw: unknown): AcceptResult {
    if (!isRecord(raw)) return { ok: false, code: 'BAD_EVENT', reason: '事件必须是对象' };
    if (raw[BRIDGE_MARK] !== 1) return { ok: false, code: 'BAD_EVENT', reason: '缺少桥标记' };
    if (raw.channel !== BRIDGE_CHANNEL) return { ok: false, code: 'BAD_EVENT', reason: 'channel 不匹配' };
    return this.acceptEvent(raw);
  }

  /**
   * 受理一条浏览器事件本体（`{kind, name?, payload?, text?, level?}`）。
   *
   * 这是**不可信输入的入口**，所以逐条硬校验：kind 白名单、name 长度、
   * payload 可序列化且不超限。宁可直接拒，也不要放进一条来路不明的数据。
   */
  acceptEvent(raw: unknown): AcceptResult {
    if (!isRecord(raw)) return { ok: false, code: 'BAD_EVENT', reason: '事件必须是对象' };

    const rawKind = raw.kind;
    if (typeof rawKind !== 'string' || !(EVENT_KINDS as readonly string[]).includes(rawKind)) {
      return { ok: false, code: 'BAD_EVENT', reason: `未知事件类型：${String(rawKind)}` };
    }
    const kind = rawKind as BrowserEventKind;

    if (kind === 'emit') {
      if (typeof raw.name !== 'string' || raw.name.trim() === '') {
        return { ok: false, code: 'BAD_EVENT', reason: 'emit 事件缺少 name' };
      }
      if (raw.name.length > MAX_NAME_LENGTH) {
        return { ok: false, code: 'BAD_EVENT', reason: `name 超过 ${MAX_NAME_LENGTH} 字符` };
      }
      const payload = raw.payload ?? {};
      const size = serializableSize(payload);
      if (size === undefined) {
        return { ok: false, code: 'BAD_EVENT', reason: 'payload 必须能被 JSON 序列化' };
      }
      if (size > MAX_EVENT_BYTES) {
        return { ok: false, code: 'BAD_EVENT', reason: `payload 超过上限（${size} > ${MAX_EVENT_BYTES} 字节）` };
      }
      const event: BrowserEvent = { kind, name: raw.name, payload, ts: this.#now().toISOString() };
      this.#record(event);
      return { ok: true, event };
    }

    if (kind === 'ready') {
      const event: BrowserEvent = {
        kind,
        text: typeof raw.title === 'string' ? raw.title : '',
        ts: this.#now().toISOString(),
      };
      this.#record(event);
      return { ok: true, event };
    }

    // log / error
    const text = typeof raw.text === 'string' ? raw.text : '';
    if (text === '') return { ok: false, code: 'BAD_EVENT', reason: `${kind} 事件缺少 text` };
    const size = byteLength(text);
    if (size > MAX_EVENT_BYTES) {
      return { ok: false, code: 'BAD_EVENT', reason: `text 超过上限（${size} > ${MAX_EVENT_BYTES} 字节）` };
    }
    const event: BrowserEvent = {
      kind,
      text,
      ...(typeof raw.level === 'string' ? { level: raw.level } : {}),
      ts: this.#now().toISOString(),
    };
    this.#record(event);
    return { ok: true, event };
  }

  /** 最近的事件尾巴（排障与界面展示用） */
  events(limit = 50): BrowserEvent[] {
    return this.#events.slice(-limit);
  }

  #record(event: BrowserEvent): void {
    this.#events.push(event);
    if (this.#events.length > 200) this.#events.shift();
  }
}
