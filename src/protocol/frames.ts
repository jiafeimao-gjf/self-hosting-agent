/**
 * SPEC-001 帧协议 —— 单一协议真相。
 *
 * 这里是唯一的帧表。JSON Schema、校验器、方向判定都由它派生，
 * 因此「规格」与「实现」不可能各说各话（见 test/protocol.test.ts PROTO-007）。
 */

export type FieldType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
export type FrameDirection = 'in' | 'out';

export interface FrameSpec {
  /** in = 宿主 → Loop；out = Loop → 宿主 */
  direction: FrameDirection;
  required: Record<string, FieldType>;
  optional: Record<string, FieldType>;
}

export const FRAME_SPECS = {
  'human.message': {
    direction: 'in',
    required: { text: 'string' },
    optional: { at: 'string' },
  },
  'peer.message': {
    direction: 'in',
    required: { from: 'string', body: 'string' },
    // kind 是编排语义（brief / report / note），邮箱按它落盘，就必须能过线
    optional: { kind: 'string', taskId: 'string', artifacts: 'array' },
  },
  'ui.event': {
    direction: 'in',
    required: { target: 'string', event: 'string' },
    optional: { payload: 'object' },
  },
  'approval.reply': {
    direction: 'in',
    required: { id: 'string', decision: 'string' },
    optional: { reason: 'string' },
  },
  interrupt: {
    direction: 'in',
    required: { reason: 'string' },
    optional: {},
  },
  /**
   * 宿主工具桥：Loop 调不动「拉起一个进程」这种事，只能请 Kernel 代办。
   * Loop 发 tool.call（out），宿主执行后用它把结果回填（in）。
   */
  'conversation.clear': {
    direction: 'in',
    required: {},
    // `/clear`：宿主与子进程各写一条边界标记，投影只看标记之后的内容
    optional: {},
  },
  'browser.event': {
    direction: 'in',
    required: { name: 'string' },
    // 文档自己决定 payload 内容；形状固定为对象，非对象由桥包成 {value:…}
    optional: { payload: 'object', source: 'string' },
  },
  'tool.reply': {
    direction: 'in',
    required: { id: 'string', ok: 'boolean' },
    optional: { result: 'string', error: 'string' },
  },
  'agent.delta': {
    direction: 'out',
    // SPEC-022：流式增量。`text` 是**累积全文**（幂等），不是分片。
    // 它是瞬态提示，会被最终的 agent.thinking 取代，因此不写进事件日志。
    required: { agent: 'string', text: 'string' },
    optional: {},
  },
  'agent.thinking': {
    direction: 'out',
    required: { text: 'string' },
    optional: {},
  },
  'tool.call': {
    direction: 'out',
    required: { id: 'string', name: 'string' },
    optional: { args: 'object' },
  },
  'tool.result': {
    direction: 'out',
    required: { id: 'string', ok: 'boolean' },
    optional: { result: 'string', error: 'string' },
  },
  'ui.patch': {
    direction: 'out',
    required: { scope: 'string', op: 'string', spec: 'object' },
    optional: {},
  },
  'approval.ask': {
    direction: 'out',
    required: { id: 'string', action: 'string', risk: 'string' },
    optional: {},
  },
  'loop.step': {
    direction: 'out',
    required: { step: 'integer', name: 'string' },
    optional: {},
  },
  'loop.state': {
    direction: 'out',
    required: { state: 'string' },
    optional: { detail: 'string' },
  },
  'loop.done': {
    direction: 'out',
    required: { reason: 'string' },
    optional: {},
  },
  'loop.error': {
    direction: 'out',
    required: { message: 'string' },
    optional: { stack: 'string' },
  },
} as const;

export type FrameType = keyof typeof FRAME_SPECS;

/** 信封字段：所有帧共用 */
const ENVELOPE: Record<string, FieldType> = {
  t: 'string',
  agent: 'string',
  seq: 'integer',
  ts: 'string',
};

export interface Frame {
  t: FrameType;
  agent?: string;
  seq?: number;
  ts?: string;
  [field: string]: unknown;
}

export type FrameErrorCode =
  | 'BAD_JSON'
  | 'NOT_OBJECT'
  | 'UNKNOWN_TYPE'
  | 'MISSING_FIELD'
  | 'BAD_FIELD_TYPE'
  | 'UNKNOWN_FIELD';

export interface FrameError {
  code: FrameErrorCode;
  message: string;
  field?: string;
}

export type ValidationResult = { ok: true; frame: Frame } | { ok: false; error: FrameError };
export type DecodeResult = { ok: true; frame: Frame; raw: string } | { ok: false; error: FrameError; raw: string };

export class ProtocolError extends Error {
  readonly code: FrameErrorCode;
  readonly field: string | undefined;

  constructor(error: FrameError) {
    super(`${error.code}${error.field ? ` (${error.field})` : ''}: ${error.message}`);
    this.name = 'ProtocolError';
    this.code = error.code;
    this.field = error.field;
  }
}

function typeOk(value: unknown, type: FieldType): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value) && value >= 0;
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    default:
      return false;
  }
}

/** 校验一个未知值是否是合法帧（SPEC-001 §1–§3） */
export function validateFrame(value: unknown): ValidationResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      ok: false,
      error: { code: 'NOT_OBJECT', message: '帧必须是一个 JSON 对象' },
    };
  }

  const record = value as Record<string, unknown>;
  const t = record.t;

  if (typeof t !== 'string' || !(t in FRAME_SPECS)) {
    return {
      ok: false,
      error: {
        code: 'UNKNOWN_TYPE',
        message: `未知帧类型：${t === undefined ? '(缺失 t)' : JSON.stringify(t)}`,
        field: 't',
      },
    };
  }

  const spec: FrameSpec = FRAME_SPECS[t as FrameType];
  const allowed = new Set<string>([...Object.keys(ENVELOPE), ...Object.keys(spec.required), ...Object.keys(spec.optional)]);

  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      return {
        ok: false,
        error: { code: 'UNKNOWN_FIELD', message: `帧 ${t} 不接受字段 ${key}`, field: key },
      };
    }
  }

  for (const [key, type] of Object.entries(ENVELOPE)) {
    const fieldValue = record[key];
    if (fieldValue === undefined) continue;
    if (!typeOk(fieldValue, type)) {
      return {
        ok: false,
        error: { code: 'BAD_FIELD_TYPE', message: `信封字段 ${key} 期望 ${type}`, field: key },
      };
    }
  }

  for (const [key, type] of Object.entries(spec.required)) {
    if (record[key] === undefined) {
      return {
        ok: false,
        error: { code: 'MISSING_FIELD', message: `帧 ${t} 缺少必填字段 ${key}`, field: key },
      };
    }
    if (!typeOk(record[key], type)) {
      return {
        ok: false,
        error: { code: 'BAD_FIELD_TYPE', message: `帧 ${t} 的 ${key} 期望 ${type}`, field: key },
      };
    }
  }

  for (const [key, type] of Object.entries(spec.optional)) {
    const fieldValue = record[key];
    if (fieldValue === undefined) continue;
    if (!typeOk(fieldValue, type)) {
      return {
        ok: false,
        error: { code: 'BAD_FIELD_TYPE', message: `帧 ${t} 的 ${key} 期望 ${type}`, field: key },
      };
    }
  }

  return { ok: true, frame: record as Frame };
}

/** 编码为一帧：单行 JSON + 换行（PROTO-001） */
export function encodeFrame(frame: Frame): string {
  const checked = validateFrame(frame);
  if (!checked.ok) throw new ProtocolError(checked.error);
  return `${JSON.stringify(checked.frame)}\n`;
}

/** 解码一行：永不抛异常（PROTO-002） */
export function decodeFrame(line: string): DecodeResult {
  const raw = line.replace(/\r?\n$/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: { code: 'BAD_JSON', message: '不是合法 JSON' }, raw };
  }
  const checked = validateFrame(parsed);
  if (!checked.ok) return { ok: false, error: checked.error, raw };
  return { ok: true, frame: checked.frame, raw };
}

export function directionOf(type: FrameType): FrameDirection {
  return FRAME_SPECS[type].direction;
}

export function isInbound(frame: Frame | { t: string }): boolean {
  const spec = FRAME_SPECS[frame.t as FrameType];
  return spec !== undefined && spec.direction === 'in';
}

export function isOutbound(frame: Frame | { t: string }): boolean {
  const spec = FRAME_SPECS[frame.t as FrameType];
  return spec !== undefined && spec.direction === 'out';
}

const JSON_SCHEMA_TYPE: Record<FieldType, Record<string, unknown>> = {
  string: { type: 'string' },
  number: { type: 'number' },
  integer: { type: 'integer', minimum: 0 },
  boolean: { type: 'boolean' },
  object: { type: 'object' },
  array: { type: 'array' },
};

/** 由帧表派生 JSON Schema（draft 2020-12），磁盘副本由 PROTO-007 守护 */
export function frameJsonSchema(): Record<string, unknown> {
  const variants = Object.entries(FRAME_SPECS).map(([type, spec]) => {
    const properties: Record<string, unknown> = {
      t: { const: type },
      agent: JSON_SCHEMA_TYPE.string,
      seq: JSON_SCHEMA_TYPE.integer,
      ts: JSON_SCHEMA_TYPE.string,
    };
    const required: string[] = ['t'];

    for (const [field, fieldType] of Object.entries(spec.required)) {
      properties[field] = JSON_SCHEMA_TYPE[fieldType];
      required.push(field);
    }
    for (const [field, fieldType] of Object.entries(spec.optional)) {
      properties[field] = JSON_SCHEMA_TYPE[fieldType];
    }

    return {
      title: type,
      type: 'object',
      additionalProperties: false,
      required,
      properties,
    };
  });

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://agent-client.dev/schemas/frame.schema.json',
    title: 'Agent Client Frame',
    description: 'SPEC-001 帧协议。由 src/protocol/frames.ts 生成，请勿手工修改。',
    oneOf: variants,
  };
}
