/**
 * SPEC-015 设置与模型配置。
 *
 * 两条安全规矩：
 *   1. API Key 落盘权限 0600，且**永不回传明文**给浏览器
 *   2. 更新时留空 = 不修改（否则界面上改个模型名就会把 Key 顺手抹掉）
 */
import fs from 'node:fs';
import path from 'node:path';

export type ModelProtocol = 'openai' | 'anthropic';

export interface ModelSettings {
  protocol: ModelProtocol;
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

/** 给浏览器看的形状：不含明文 Key */
export interface PublicSettings {
  protocol: ModelProtocol;
  baseUrl: string;
  model: string;
  apiKeyMasked: string;
  hasApiKey: boolean;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** 生效来源标签，如「本机 Ollama」 */
  label: string;
}

export const DEFAULT_MODEL_SETTINGS: ModelSettings = {
  protocol: 'openai',
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'qwen3:4b',
  apiKey: '',
};

export interface SettingsError {
  code: 'BAD_PROTOCOL' | 'BAD_BASE_URL' | 'BAD_MODEL' | 'BAD_NUMBER' | 'IO_ERROR';
  message: string;
}

export type SettingsResult<T> = { ok: true; value: T } | { ok: false; error: SettingsError };

/** 打码：足够长显示头尾，短的一律遮住 */
export function maskApiKey(key: string): string {
  const trimmed = typeof key === 'string' ? key.trim() : '';
  if (trimmed === '') return '';
  if (trimmed.length <= 8) return '•'.repeat(trimmed.length);
  return `${trimmed.slice(0, 3)}…${trimmed.slice(-4)}`;
}

/** 给人类看的来源标签 */
export function labelFor(settings: ModelSettings): string {
  const base = settings.baseUrl;
  if (settings.protocol === 'openai' && /:11434\b|\/\/11434/.test(base)) return '本机 Ollama';
  if (settings.protocol === 'openai' && /(localhost|127\.0\.0\.1)/.test(base)) return '本机端点';
  if (/anthropic\.com/.test(base)) return 'Anthropic 官方';
  if (/api\.openai\.com/.test(base)) return 'OpenAI 官方';
  if (/deepseek\.com/.test(base)) return 'DeepSeek';
  return '自定义端点';
}

function isProtocol(value: unknown): value is ModelProtocol {
  return value === 'openai' || value === 'anthropic';
}

export interface SettingsStoreOptions {
  file: string;
  defaults?: ModelSettings;
}

export class SettingsStore {
  #file: string;
  #defaults: ModelSettings;

  constructor(options: SettingsStoreOptions) {
    this.#file = options.file;
    this.#defaults = options.defaults ?? DEFAULT_MODEL_SETTINGS;
  }

  get file(): string {
    return this.#file;
  }

  /** 是否已经有持久化的设置（有则优先于命令行初值） */
  exists(): boolean {
    return fs.existsSync(this.#file);
  }

  /** 读设置；文件不存在或损坏时退回默认值（本机 Ollama） */
  load(): ModelSettings {
    if (!fs.existsSync(this.#file)) return { ...this.#defaults };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.#file, 'utf8')) as Partial<ModelSettings>;
      return {
        protocol: isProtocol(parsed.protocol) ? parsed.protocol : this.#defaults.protocol,
        baseUrl: typeof parsed.baseUrl === 'string' && parsed.baseUrl !== '' ? parsed.baseUrl : this.#defaults.baseUrl,
        model: typeof parsed.model === 'string' && parsed.model !== '' ? parsed.model : this.#defaults.model,
        apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : this.#defaults.apiKey,
        ...(typeof parsed.temperature === 'number' ? { temperature: parsed.temperature } : {}),
        ...(typeof parsed.maxTokens === 'number' ? { maxTokens: parsed.maxTokens } : {}),
        ...(typeof parsed.timeoutMs === 'number' ? { timeoutMs: parsed.timeoutMs } : {}),
      };
    } catch {
      return { ...this.#defaults };
    }
  }

  /** 只校验不落盘（连接测试用：试一下配置不该改存储） */
  validate(input: unknown, current: ModelSettings): SettingsResult<ModelSettings> {
    return this.#normalize(input, current);
  }

  /** 保存；空 apiKey = 保留原有 Key（SET-004） */
  save(input: unknown, current: ModelSettings): SettingsResult<ModelSettings> {
    const normalized = this.#normalize(input, current);
    if (!normalized.ok) return normalized;

    const next = normalized.value;
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      fs.writeFileSync(this.#file, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      fs.chmodSync(this.#file, 0o600); // 有的平台 umask 会放宽，显式再收紧一次
    } catch (err) {
      return { ok: false, error: { code: 'IO_ERROR', message: err instanceof Error ? err.message : String(err) } };
    }

    return { ok: true, value: next };
  }

  #normalize(input: unknown, current: ModelSettings): SettingsResult<ModelSettings> {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return { ok: false, error: { code: 'BAD_PROTOCOL', message: '设置必须是一个对象' } };
    }
    const raw = input as Record<string, unknown>;

    const protocol = raw.protocol ?? current.protocol;
    if (!isProtocol(protocol)) {
      return { ok: false, error: { code: 'BAD_PROTOCOL', message: `未知协议：${String(protocol)}（只支持 openai / anthropic）` } };
    }

    const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : current.baseUrl;
    if (baseUrl === '') {
      return { ok: false, error: { code: 'BAD_BASE_URL', message: 'Base URL 不能为空' } };
    }
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, error: { code: 'BAD_BASE_URL', message: 'Base URL 必须是 http(s) 地址' } };
      }
    } catch {
      return { ok: false, error: { code: 'BAD_BASE_URL', message: `Base URL 不是合法地址：${baseUrl}` } };
    }

    const model = typeof raw.model === 'string' ? raw.model.trim() : current.model;
    if (model === '') {
      return { ok: false, error: { code: 'BAD_MODEL', message: '模型名不能为空' } };
    }

    // 留空 = 不修改；只有明确传了非空字符串才覆盖
    const apiKey =
      typeof raw.apiKey === 'string' && raw.apiKey.trim() !== '' ? raw.apiKey.trim() : current.apiKey;

    const numeric = (value: unknown, label: string): SettingsResult<number | undefined> => {
      if (value === undefined || value === null || value === '') return { ok: true, value: undefined };
      const parsed = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(parsed)) {
        return { ok: false, error: { code: 'BAD_NUMBER', message: `${label} 必须是数字` } };
      }
      return { ok: true, value: parsed };
    };

    const temperature = numeric(raw.temperature, 'temperature');
    if (!temperature.ok) return temperature;
    const maxTokens = numeric(raw.maxTokens, 'maxTokens');
    if (!maxTokens.ok) return maxTokens;
    const timeoutMs = numeric(raw.timeoutMs, 'timeoutMs');
    if (!timeoutMs.ok) return timeoutMs;

    const next: ModelSettings = {
      protocol,
      baseUrl,
      model,
      apiKey,
      ...(temperature.value === undefined ? {} : { temperature: temperature.value }),
      ...(maxTokens.value === undefined ? {} : { maxTokens: maxTokens.value }),
      ...(timeoutMs.value === undefined ? {} : { timeoutMs: timeoutMs.value }),
    };

    return { ok: true, value: next };
  }

  /** 转成可以放心发给浏览器的形状（SET-003） */
  toPublic(settings: ModelSettings): PublicSettings {
    return {
      protocol: settings.protocol,
      baseUrl: settings.baseUrl,
      model: settings.model,
      apiKeyMasked: maskApiKey(settings.apiKey),
      hasApiKey: settings.apiKey.trim() !== '',
      ...(settings.temperature === undefined ? {} : { temperature: settings.temperature }),
      ...(settings.maxTokens === undefined ? {} : { maxTokens: settings.maxTokens }),
      ...(settings.timeoutMs === undefined ? {} : { timeoutMs: settings.timeoutMs }),
      label: labelFor(settings),
    };
  }
}

/** 设置 → 子进程环境变量（协议选择就靠它贯通到 Loop） */
export function settingsToAgentEnv(settings: ModelSettings): Record<string, string> {
  return {
    AGENT_MODEL: 'http',
    AGENT_PROTOCOL: settings.protocol,
    AGENT_BASE_URL: settings.baseUrl,
    AGENT_API_KEY: settings.apiKey,
    AGENT_MODEL_NAME: settings.model,
    ...(settings.timeoutMs === undefined ? {} : { AGENT_MODEL_TIMEOUT: String(settings.timeoutMs) }),
    ...(settings.temperature === undefined ? {} : { AGENT_TEMPERATURE: String(settings.temperature) }),
    ...(settings.maxTokens === undefined ? {} : { AGENT_MAX_TOKENS: String(settings.maxTokens) }),
  };
}
