/**
 * 由设置造一个模型端口。
 *
 * 两种协议在这里汇合：上层（会话、连接测试）不需要知道 wire 细节。
 */
import { createHttpModel } from '../loop/http-model.ts';
import { createAnthropicModel } from '../loop/anthropic-model.ts';
import type { ModelPort } from '../loop/loop.ts';
import type { ModelSettings } from './settings.ts';

export function createModelPort(settings: ModelSettings, options: { timeoutMs?: number } = {}): ModelPort {
  const timeoutMs = options.timeoutMs ?? settings.timeoutMs ?? 60_000;

  if (settings.protocol === 'anthropic') {
    return createAnthropicModel({
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.model,
      timeoutMs,
      ...(settings.maxTokens === undefined ? {} : { maxTokens: settings.maxTokens }),
      ...(settings.temperature === undefined ? {} : { temperature: settings.temperature }),
    });
  }

  return createHttpModel({
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    model: settings.model,
    timeoutMs,
    ...(settings.maxTokens === undefined ? {} : { maxTokens: settings.maxTokens }),
    ...(settings.temperature === undefined ? {} : { temperature: settings.temperature }),
  });
}
