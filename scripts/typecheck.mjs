#!/usr/bin/env node
/**
 * 类型检查。仓库零运行时依赖，所以 tsc 不是必需品而是可选工具：
 *   1. 有本地 tsc（npm i -D typescript @types/node）→ 直接用仓库 tsconfig
 *   2. 只有别处的 tsc → 用临时配置 + 同级的 @types
 *   3. 都没有 → 明确说「跳过」，不伪装成通过
 *
 * 用法：node scripts/typecheck.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function exists(file) {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

function resolveTsc() {
  const local = path.join(root, 'node_modules', '.bin', 'tsc');
  if (exists(local)) return { bin: local, kind: 'local' };

  const candidates = [
    process.env.TSC_PATH,
    path.join(os.homedir(), 'oh-my-ppt', 'node_modules', '.bin', 'tsc'),
    '/opt/homebrew/lib/node_modules/typescript/bin/tsc',
    '/usr/local/lib/node_modules/typescript/bin/tsc',
    path.join(os.homedir(), '.bun', 'install', 'global', 'node_modules', 'typescript', 'bin', 'tsc'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (exists(candidate)) return { bin: candidate, kind: 'external' };
  }

  const npxRoot = path.join(os.homedir(), '.npm', '_npx');
  if (exists(npxRoot)) {
    for (const entry of fs.readdirSync(npxRoot)) {
      const candidate = path.join(npxRoot, entry, 'node_modules', '.bin', 'tsc');
      if (exists(candidate)) return { bin: candidate, kind: 'external' };
    }
  }

  return null;
}

const tsc = resolveTsc();
if (tsc === null) {
  console.log('⚠ 未找到 tsc，跳过类型检查。');
  console.log('  想要真跑一遍：npm i -D typescript @types/node && npm run typecheck');
  console.log('  或将已有 tsc 指给环境变量：TSC_PATH=/path/to/tsc npm run typecheck');
  process.exit(0);
}

function run(args, label) {
  console.log(`▸ ${label}`);
  try {
    execFileSync(tsc.bin, args, { cwd: root, stdio: 'inherit' });
    console.log('✔ 类型检查通过（strict + erasableSyntaxOnly + verbatimModuleSyntax）');
    return 0;
  } catch (err) {
    return typeof err.status === 'number' ? err.status : 1;
  }
}

if (tsc.kind === 'local') {
  process.exit(run(['--noEmit'], path.relative(root, tsc.bin)));
}

// 外部的 tsc 看不到本仓库的 @types（也没装），因此显式指向它旁边的 @types
const typesRoot = path.resolve(path.dirname(tsc.bin), '..', '@types');
const tempConfig = path.join(os.tmpdir(), `agent-client-tsconfig-${process.pid}.json`);
const config = {
  compilerOptions: {
    target: 'es2023',
    lib: ['es2023'],
    module: 'nodenext',
    moduleResolution: 'nodenext',
    strict: true,
    noEmit: true,
    allowImportingTsExtensions: true,
    erasableSyntaxOnly: true,
    verbatimModuleSyntax: true,
    isolatedModules: true,
    skipLibCheck: true,
    ...(exists(typesRoot) ? { typeRoots: [typesRoot] } : {}),
  },
  include: [`${root}/src/**/*.ts`, `${root}/test/**/*.ts`, `${root}/scripts/**/*.mjs`],
};
fs.writeFileSync(tempConfig, JSON.stringify(config, null, 2), 'utf8');

const code = run(['-p', tempConfig], `${tsc.bin} -p <临时配置>`);
fs.rmSync(tempConfig, { force: true });
process.exit(code);
