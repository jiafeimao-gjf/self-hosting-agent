/**
 * SPEC-006 §1–§2 View Spec 的**唯一真相**。
 *
 * 组件表 `COMPONENT_SPECS` 是声明式的：校验器（validateViewSpec）、
 * JSON Schema（schemaOf）都由它派生；渲染器也从它判断「已知 / 未知组件」。
 * 新增一个组件只需要在这里加一行，三处实现不会各说各话（SURF-001）。
 *
 * 本文件永不抛异常：所有对外入口都返回结果对象（SURF-002）。
 */

/** 字段的声明式类型 */
export type ViewFieldKind =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'enum'
  | 'children'
  | 'stringArray'
  | 'pairs';

export interface FieldSpec {
  kind: ViewFieldKind;
  /** number / integer 的下界（含） */
  min?: number;
  /** number / integer 的上界（含） */
  max?: number;
  /** enum 的允许取值 */
  values?: readonly string[];
}

export interface ComponentSpec {
  /** 组件用途，同时写进 JSON Schema 的 description */
  summary: string;
  required: Record<string, FieldSpec>;
  optional: Record<string, FieldSpec>;
}

/** tone 的取值集合：语义色，由令牌层翻译成具体颜色 */
export const TONES = ['default', 'muted', 'strong', 'info', 'success', 'warning', 'danger'] as const;

const TONE_FIELD: FieldSpec = { kind: 'enum', values: TONES };

/**
 * 组件表 —— 组件类型的唯一清单。
 *
 * 顺序即 JSON Schema `oneOf` 的顺序，改动会触发漂移门禁（SURF-009）。
 */
export const COMPONENT_SPECS = {
  panel: {
    summary: '纵向容器，可带标题；children 允许为空数组',
    required: { children: { kind: 'children' } },
    optional: { title: { kind: 'string' } },
  },
  text: {
    summary: '一段文本',
    required: { text: { kind: 'string' } },
    optional: { tone: TONE_FIELD },
  },
  progress: {
    summary: '进度条，value 取值 0~1 的有限数',
    required: { label: { kind: 'string' }, value: { kind: 'number', min: 0, max: 1 } },
    optional: { tone: TONE_FIELD },
  },
  action: {
    summary: '可点击动作，emit 是回传宿主的事件名',
    required: { label: { kind: 'string' }, emit: { kind: 'string' } },
    optional: { tone: TONE_FIELD },
  },
  list: {
    summary: '字符串列表',
    required: { items: { kind: 'stringArray' } },
    optional: { title: { kind: 'string' }, tone: TONE_FIELD },
  },
  kv: {
    summary: '键值对表，pairs 是 {key, value}[]',
    required: { pairs: { kind: 'pairs' } },
    optional: { title: { kind: 'string' } },
  },
  columns: {
    summary: '横向分栏容器',
    required: { children: { kind: 'children' } },
    optional: { title: { kind: 'string' } },
  },
  badge: {
    summary: '状态徽标',
    required: { text: { kind: 'string' } },
    optional: { tone: TONE_FIELD },
  },
} as const satisfies Record<string, ComponentSpec>;

export type ComponentType = keyof typeof COMPONENT_SPECS;

/** 供内部循环使用的宽松视图，避免 `as const` 的只读字面量类型四处泄漏 */
const TABLE: Record<string, ComponentSpec> = COMPONENT_SPECS;

/** 嵌套深度上限：防御循环引用与构造出来的超深 JSON（SURF-002） */
export const MAX_VIEW_DEPTH = 32;

export interface ViewSpec {
  type: string;
  [field: string]: unknown;
}

export type ViewErrorCode =
  | 'NOT_OBJECT'
  | 'UNKNOWN_COMPONENT'
  | 'MISSING_FIELD'
  | 'BAD_FIELD_TYPE'
  | 'BAD_VALUE'
  | 'UNKNOWN_FIELD'
  | 'OUT_OF_RANGE'
  | 'TOO_DEEP';

export interface ViewSpecError {
  code: ViewErrorCode;
  message: string;
  /** JSON 路径风格的问题定位，如 `$.children[0].value` */
  path: string;
}

export type ViewSpecValidation = { ok: true; spec: ViewSpec } | { ok: false; error: ViewSpecError };

export function isComponentType(value: unknown): value is ComponentType {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(TABLE, value);
}

/** 组件表的全部类型，顺序稳定 */
export function componentTypes(): ComponentType[] {
  return Object.keys(TABLE) as ComponentType[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(code: ViewErrorCode, message: string, path: string): { ok: false; error: ViewSpecError } {
  return { ok: false, error: { code, message, path } };
}

function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === undefined) return '(缺失)';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function badType(expected: string, value: unknown, path: string): ViewSpecError {
  return { code: 'BAD_FIELD_TYPE', message: `${path} 期望 ${expected}，收到 ${describe(value)}`, path };
}

function checkRange(value: number, field: FieldSpec, path: string): ViewSpecError | null {
  if (field.min !== undefined && value < field.min) {
    return { code: 'OUT_OF_RANGE', message: `${path} 不得小于 ${field.min}，收到 ${value}`, path };
  }
  if (field.max !== undefined && value > field.max) {
    return { code: 'OUT_OF_RANGE', message: `${path} 不得大于 ${field.max}，收到 ${value}`, path };
  }
  return null;
}

/** 校验单个字段的值；通过返回 null，失败返回错误 */
function checkField(value: unknown, field: FieldSpec, path: string, depth: number): ViewSpecError | null {
  switch (field.kind) {
    case 'string':
      return typeof value === 'string' ? null : badType('string', value, path);

    case 'boolean':
      return typeof value === 'boolean' ? null : badType('boolean', value, path);

    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return badType('number', value, path);
      return checkRange(value, field, path);
    }

    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value)) return badType('integer', value, path);
      return checkRange(value, field, path);
    }

    case 'enum': {
      const allowed = field.values ?? [];
      if (typeof value !== 'string' || !allowed.includes(value)) {
        const expected = allowed.map((item) => JSON.stringify(item)).join(' | ');
        return { code: 'BAD_VALUE', message: `${path} 期望 ${expected}，收到 ${describe(value)}`, path };
      }
      return null;
    }

    case 'stringArray': {
      if (!Array.isArray(value)) return badType('string[]', value, path);
      for (let i = 0; i < value.length; i += 1) {
        if (typeof value[i] !== 'string') return badType('string', value[i], `${path}[${i}]`);
      }
      return null;
    }

    case 'children': {
      if (!Array.isArray(value)) return badType('ViewSpec[]', value, path);
      for (let i = 0; i < value.length; i += 1) {
        const child = validateNode(value[i], `${path}[${i}]`, depth + 1);
        if (!child.ok) return child.error;
      }
      return null;
    }

    case 'pairs': {
      if (!Array.isArray(value)) return badType('{key,value}[]', value, path);
      for (let i = 0; i < value.length; i += 1) {
        const entry: unknown = value[i];
        const entryPath = `${path}[${i}]`;
        if (!isPlainObject(entry)) return badType('{key,value}', entry, entryPath);
        for (const key of Object.keys(entry)) {
          if (key !== 'key' && key !== 'value') {
            return { code: 'UNKNOWN_FIELD', message: `键值对不接受字段 ${key}`, path: `${entryPath}.${key}` };
          }
        }
        for (const key of ['key', 'value']) {
          if (entry[key] === undefined) {
            return { code: 'MISSING_FIELD', message: `键值对缺少字段 ${key}`, path: `${entryPath}.${key}` };
          }
          if (typeof entry[key] !== 'string') return badType('string', entry[key], `${entryPath}.${key}`);
        }
      }
      return null;
    }
  }
}

function validateNode(value: unknown, path: string, depth: number): ViewSpecValidation {
  if (depth > MAX_VIEW_DEPTH) {
    return fail('TOO_DEEP', `View Spec 嵌套不得超过 ${MAX_VIEW_DEPTH} 层`, path);
  }
  if (!isPlainObject(value)) {
    return fail('NOT_OBJECT', `View Spec 节点必须是 JSON 对象，收到 ${describe(value)}`, path);
  }

  const type = value.type;
  if (!isComponentType(type)) {
    const shown = type === undefined ? '(缺失 type)' : describe(type);
    return fail('UNKNOWN_COMPONENT', `未知组件类型：${shown}`, `${path}.type`);
  }

  const spec: ComponentSpec = TABLE[type];
  const allowed = new Set<string>(['type', ...Object.keys(spec.required), ...Object.keys(spec.optional)]);

  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      return fail('UNKNOWN_FIELD', `组件 ${type} 不接受字段 ${key}`, `${path}.${key}`);
    }
  }

  for (const [name, field] of Object.entries(spec.required)) {
    const fieldValue = value[name];
    if (fieldValue === undefined) {
      return fail('MISSING_FIELD', `组件 ${type} 缺少必填字段 ${name}`, `${path}.${name}`);
    }
    const error = checkField(fieldValue, field, `${path}.${name}`, depth);
    if (error) return { ok: false, error };
  }

  for (const [name, field] of Object.entries(spec.optional)) {
    const fieldValue = value[name];
    if (fieldValue === undefined) continue;
    const error = checkField(fieldValue, field, `${path}.${name}`, depth);
    if (error) return { ok: false, error };
  }

  return { ok: true, spec: value as ViewSpec };
}

/**
 * 校验一个未知值是否是合法 View Spec。
 * **永不抛异常**：非法输入返回 `{ok:false, error}`（SURF-002 / SURF-003）。
 */
export function validateViewSpec(value: unknown): ViewSpecValidation {
  try {
    return validateNode(value, '$', 0);
  } catch (error) {
    // 兜底：即便出现未预料的运行时异常，契约也不允许它冒泡到调用方。
    const message = error instanceof Error ? error.message : String(error);
    return fail('NOT_OBJECT', `校验 View Spec 时发生内部异常：${message}`, '$');
  }
}

function jsonSchemaForField(field: FieldSpec): Record<string, unknown> {
  switch (field.kind) {
    case 'string':
      return { type: 'string' };
    case 'number': {
      const schema: Record<string, unknown> = { type: 'number' };
      if (field.min !== undefined) schema.minimum = field.min;
      if (field.max !== undefined) schema.maximum = field.max;
      return schema;
    }
    case 'integer': {
      const schema: Record<string, unknown> = { type: 'integer' };
      if (field.min !== undefined) schema.minimum = field.min;
      if (field.max !== undefined) schema.maximum = field.max;
      return schema;
    }
    case 'boolean':
      return { type: 'boolean' };
    case 'enum':
      return { enum: [...(field.values ?? [])] };
    case 'children':
      return { type: 'array', items: { $ref: '#/$defs/viewSpec' } };
    case 'stringArray':
      return { type: 'array', items: { type: 'string' } };
    case 'pairs':
      return {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['key', 'value'],
          properties: { key: { type: 'string' }, value: { type: 'string' } },
        },
      };
  }
}

/**
 * 由组件表派生 JSON Schema（draft 2020-12），与 `frameJsonSchema()` 同风格。
 * 磁盘副本 `specs/schemas/view-spec.schema.json` 由 SURF-009 守护，禁止手工修改。
 */
export function schemaOf(): Record<string, unknown> {
  const defs: Record<string, unknown> = {};

  for (const [type, spec] of Object.entries(TABLE)) {
    const properties: Record<string, unknown> = { type: { const: type } };
    const required: string[] = ['type'];

    for (const [name, field] of Object.entries(spec.required)) {
      properties[name] = jsonSchemaForField(field);
      required.push(name);
    }
    for (const [name, field] of Object.entries(spec.optional)) {
      properties[name] = jsonSchemaForField(field);
    }

    defs[type] = {
      title: type,
      description: spec.summary,
      type: 'object',
      additionalProperties: false,
      required,
      properties,
    };
  }

  defs.viewSpec = {
    oneOf: componentTypes().map((type) => ({ $ref: `#/$defs/${type}` })),
  };

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://agent-client.dev/schemas/view-spec.schema.json',
    title: 'Agent Client View Spec',
    description: 'SPEC-006 View Spec 组件契约。由 src/surface/viewspec.ts 生成，请勿手工修改。',
    $ref: '#/$defs/viewSpec',
    $defs: defs,
  };
}

/** 与 `frameJsonSchema` 命名对齐的别名 */
export const viewSpecJsonSchema = schemaOf;
