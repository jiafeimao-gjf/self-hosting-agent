/**
 * 脚本化假模型端口。
 *
 * P0 的取舍：先把**协议与状态机**做成真的，把模型换成可脚本化的假实现。
 * 好处是整条协作链可以在 CI 里离线、确定性地复现——测试和 demo 都不需要 API Key。
 */
import type { ModelInput, ModelOutput, ModelPort } from './loop.ts';

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
    async step(input: ModelInput): Promise<ModelOutput> {
      calls.push(input);
      const output = script[Math.min(index, script.length - 1)] as ModelOutput;
      index += 1;
      return output;
    },
  };
}

/** 需要根据上下文做判断的测试，用函数式端口更方便 */
export function dynamicModel(fn: (input: ModelInput) => ModelOutput | Promise<ModelOutput>): ModelPort {
  return {
    async step(input: ModelInput): Promise<ModelOutput> {
      return fn(input);
    },
  };
}
