/**
 * SPEC-013 §3 自检门禁。
 *
 * Agent 改完自己的界面代码，必须**自己通过项目自己的测试**才算数。
 * 这不是装饰：写入前跑一遍，不通过就回滚，坏代码没有机会留在磁盘上。
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface SelfTestCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SelfTestResult {
  ok: boolean;
  checks: SelfTestCheck[];
  output: string;
}

export interface SelfTestOptions {
  /** 项目根：跑 `node --test` 的地方 */
  projectRoot: string;
  /** 可改根目录（真实是 src/client） */
  clientRoot: string;
  /** 本次改动的文件（相对 clientRoot） */
  changed: string[];
  timeoutMs?: number;
  /** 跑不跑项目测试（默认跑） */
  runProjectTests?: boolean;
  /** 项目测试的目标文件（相对 projectRoot） */
  projectTest?: string;
}

interface RunOutcome {
  ok: boolean;
  output: string;
  error?: string;
}

async function run(command: string, args: string[], options: { cwd: string; timeoutMs: number }): Promise<RunOutcome> {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1' },
    });
    return { ok: true, output: `${result.stdout}${result.stderr}` };
  } catch (err) {
    const failure = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
    return {
      ok: false,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
      error: failure.killed === true ? '自检超时' : (failure.message ?? '自检失败'),
    };
  }
}

/**
 * 用 stdin 喂内容做 ESM 语法检查。
 *
 * 为什么不直接 `node --check <file>`：那样 Node 会按**文件所在目录**的模块类型解析，
 * 文件若不在 `type: module` 的项目里，坏掉的 ESM 语法会被当成 CJS 解析而意外通过。
 * 走 stdin + `--input-type=module` 就与位置无关了。
 */
function checkModuleSyntax(source: string, options: { cwd: string; timeoutMs: number }): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '--check'], {
      cwd: options.cwd,
      env: { ...process.env, NO_COLOR: '1' },
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (outcome: RunOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, output: `${stdout}${stderr}`, error: '语法自检超时' });
    }, options.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err: Error) => finish({ ok: false, output: '', error: err.message }));
    child.on('close', (code) => finish({ ok: code === 0, output: `${stdout}${stderr}` }));
    child.stdin?.end(source, 'utf8');
  });
}

function tail(text: string, max = 2000): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`;
}

export async function runClientSelfTest(options: SelfTestOptions): Promise<SelfTestResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const checks: SelfTestCheck[] = [];
  const outputs: string[] = [];

  // ① 语法自检：每个改动的 .js 都按 ESM 解析一遍（与文件所在目录无关）
  for (const relative of options.changed.filter((file) => file.endsWith('.js'))) {
    const absolute = path.resolve(options.clientRoot, relative);
    if (!fs.existsSync(absolute)) {
      checks.push({ name: `语法 ${relative}`, ok: false, detail: '文件不存在' });
      outputs.push(`[${relative}] 文件不存在`);
      continue;
    }
    const outcome = await checkModuleSyntax(fs.readFileSync(absolute, 'utf8'), {
      cwd: options.projectRoot,
      timeoutMs,
    });
    checks.push({
      name: `语法 ${relative}`,
      ok: outcome.ok,
      detail: outcome.ok ? 'ok' : tail(outcome.output || outcome.error || '解析失败'),
    });
    if (!outcome.ok) outputs.push(`[${relative}]\n${outcome.output || outcome.error}`);
  }

  // ② 契约自检：跑项目自己的客户端测试（漂移门禁、降级、转义都在里面）
  if (options.runProjectTests !== false) {
    const projectTest = options.projectTest ?? path.join('test', 'client-ui.test.ts');
    const outcome = await run(process.execPath, ['--test', projectTest], { cwd: options.projectRoot, timeoutMs });
    checks.push({
      name: `项目测试 ${projectTest}`,
      ok: outcome.ok,
      detail: outcome.ok ? '通过' : tail(outcome.output || outcome.error || '未通过'),
    });
    if (!outcome.ok) outputs.push(outcome.output || outcome.error || '');
  }

  return {
    ok: checks.every((check) => check.ok),
    checks,
    output: tail(outputs.join('\n\n')),
  };
}
