/**
 * 脚本化假模型端口。
 *
 * P0 的取舍：先把**协议与状态机**做成真的，把模型换成可脚本化的假实现。
 * 好处是整条协作链可以在 CI 里离线、确定性地复现——测试和 demo 都不需要 API Key。
 */
import type { ModelInput, ModelOutput, ModelPort, ModelStepOptions } from './loop.ts';

export interface ScriptedModel extends ModelPort {
  readonly calls: ModelInput[];
}

/**
 * 按剧本依次返回；剧本用完后重复最后一条（便于测预算耗尽这类「一直有活干」的场景）。
 */
export function scriptedModel(script: ModelOutput[]): ScriptedModel {
  if (script.length === 0) throw new Error('scriptedModel 至少需要一个输出');
  const calls: ModelInput[] = [];
  let index = 0;

  return {
    calls,
    async step(input: ModelInput, stepOptions: ModelStepOptions = {}): Promise<ModelOutput> {
      calls.push(input);
      const output = script[Math.min(index, script.length - 1)] as ModelOutput;
      index += 1;
      streamOut(output, stepOptions);
      return output;
    },
  };
}

/**
 * SPEC-022：被要求流式时，把文本按字切成几条**累积全文**发出去。
 * 假模型也走这条路，流式相关的状态机才能在没有网络的情况下被确定性地测。
 */
export function streamOut(output: ModelOutput, options: ModelStepOptions): void {
  if (typeof options.onDelta !== 'function') return;
  const text = output.text ?? '';
  if (text === '') return;

  const chunks = Math.min(3, Math.max(1, Math.ceil(text.length / 8)));
  const size = Math.ceil(text.length / chunks);
  for (let end = size; end < text.length; end += size) options.onDelta(text.slice(0, end));
  options.onDelta(text);
}

/** 需要根据上下文做判断的测试，用函数式端口更方便 */
export function dynamicModel(fn: (input: ModelInput) => ModelOutput | Promise<ModelOutput>): ModelPort {
  return {
    async step(input: ModelInput, stepOptions: ModelStepOptions = {}): Promise<ModelOutput> {
      const output = await fn(input);
      streamOut(output, stepOptions);
      return output;
    },
  };
}
