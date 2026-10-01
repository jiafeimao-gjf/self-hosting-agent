import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { FRAME_SPECS } from '../src/protocol/frames.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');

function walk(dir: string, filter: (file: string) => boolean): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, filter));
    else if (filter(full)) out.push(full);
  }
  return out;
}

/**
 * 只看**运行时**依赖：`import type` 会被 Node 的类型擦除抹掉，
 * 不产生真实耦合，所以扫描前先剔除（这是依赖方向规则的一部分定义）。
 */
function runtimeImports(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  const stripped = text
    .replace(/^\s*import\s+type\s+[\s\S]*?from\s*['"][^'"]+['"];?/gm, '')
    .replace(/^\s*export\s+type\s+[\s\S]*?from\s*['"][^'"]+['"];?/gm, '');

  const specifiers: string[] = [];
  for (const match of stripped.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) specifiers.push(match[1] as string);
  for (const match of stripped.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) specifiers.push(match[1] as string);
  for (const match of stripped.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.push(match[1] as string);
  return specifiers;
}

function resolveSpecifier(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined; // 内置模块或裸包，不参与分层判定
  return path.resolve(path.dirname(fromFile), specifier.replace(/[?#].*$/, ''));
}

function inside(target: string, dir: string): boolean {
  const relative = path.relative(dir, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

// @spec ARCH-001
test('四层目录齐备，且每层都能被独立导入', async () => {
  const layers = [
    ['src/surface', path.join(srcDir, 'surface')],
    ['src/protocol', path.join(srcDir, 'protocol')],
    ['src/runtime', path.join(srcDir, 'runtime')],
    ['src/kernel', path.join(srcDir, 'kernel')],
  ] as const;

  for (const [label, dir] of layers) {
    assert.ok(fs.existsSync(dir), `${label} 必须存在`);
    const files = walk(dir, (file) => file.endsWith('.ts'));
    assert.ok(files.length > 0, `${label} 不能是空目录`);
  }

  const entryPoints = [
    'protocol/frames.ts',
    'protocol/channel.ts',
    'eventlog/log.ts',
    'loop/loop.ts',
    'kernel/pool.ts',
    'kernel/approval.ts',
    'surface/renderer.ts',
    'surface/viewspec.ts',
    'surface/document.ts',
    'surface/tokens.ts',
  ];
  for (const relative of entryPoints) {
    const url = pathToFileURL(path.join(srcDir, relative)).href;
    await assert.doesNotReject(import(url), `${relative} 必须能被独立导入`);
  }
});

// @spec ARCH-002
test('依赖方向：协议层最底层，界面层拿不到系统权限，Loop 不能反向控制内核', () => {
  const files = walk(srcDir, (file) => file.endsWith('.ts'));
  assert.ok(files.length >= 10);
  const violations: string[] = [];

  for (const file of files) {
    for (const specifier of runtimeImports(file)) {
      const target = resolveSpecifier(file, specifier);
      if (target === undefined) continue;
      const from = path.relative(root, file);
      const to = path.relative(root, target);

      if (inside(file, path.join(srcDir, 'protocol')) && !inside(target, path.join(srcDir, 'protocol'))) {
        violations.push(`${from} → ${to}（协议层必须自洽，不得依赖任何上层）`);
      }
      if (inside(file, path.join(srcDir, 'surface'))) {
        for (const forbidden of ['kernel', 'runtime', 'loop']) {
          if (inside(target, path.join(srcDir, forbidden))) {
            violations.push(`${from} → ${to}（界面层不得依赖 ${forbidden}）`);
          }
        }
      }
      if (inside(file, path.join(srcDir, 'loop')) && inside(target, path.join(srcDir, 'kernel'))) {
        violations.push(`${from} → ${to}（Loop 是被内核托管的进程，不得反向依赖内核）`);
      }
      if (!inside(file, path.join(root, 'test')) && inside(target, path.join(root, 'test'))) {
        violations.push(`${from} → ${to}（产品代码不得依赖测试代码）`);
      }
    }
  }

  assert.deepEqual(violations, []);
});

// @spec ARCH-004
test('跨层数据只能是协议帧：src 里出现的帧字面量必须都在帧表里', () => {
  const files = walk(srcDir, (file) => file.endsWith('.ts'));
  const unknown: string[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\bt\s*:\s*['"]([a-z][a-z0-9]*\.[a-z][a-z0-9.]*)['"]/g)) {
      const literal = match[1] as string;
      seen.add(literal);
      if (!(literal in FRAME_SPECS)) {
        unknown.push(`${path.relative(root, file)} 使用了未定义的帧类型 "${literal}"`);
      }
    }
  }

  assert.deepEqual(unknown, []);
  assert.ok(seen.size >= 8, `扫描到的帧类型太少（${seen.size}），检查扫描规则是否失效`);
});

// @spec ARCH-005
test('规格追溯门禁必须通过：每条验收标准都有测试守着', () => {
  try {
    const output = execFileSync(process.execPath, [path.join(root, 'scripts', 'trace.mjs')], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.match(output, /规格追溯门禁通过/);
  } catch (err) {
    const stdout = (err as { stdout?: string }).stdout ?? '';
    const stderr = (err as { stderr?: string }).stderr ?? '';
    assert.fail(`规格追溯门禁未通过：\n${stdout}${stderr}`);
  }
});
