#!/usr/bin/env node
/**
 * SDD ⇄ TDD 咬合点：规格追溯门禁。
 *
 * 双向校验，任一条不满足就以非零码退出：
 *   1. 规格里有验收标准，却没有任何测试引用它  → 文档里的空头承诺
 *   2. 测试引用了不存在的规格 ID               → 测试在验证幻觉
 *
 * 用法：node scripts/trace.mjs [--quiet]
 * 产物：specs/traceability.md（自动生成，请勿手工修改）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quiet = process.argv.includes('--quiet');

// 前缀允许带数字（例如 E2E-001）且允许两字母前缀（例如 UI-001），否则规格 ID 会被静默漏掉——门禁自己也会骗人
const ID_PATTERN = '[A-Z][A-Z0-9]{1,5}-\\d{3}';

function walk(dir, filter) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      out.push(...walk(full, filter));
    } else if (filter(full)) {
      out.push(full);
    }
  }
  return out;
}

/** 从 specs/**\/*.md 收集验收标准 */
function collectCriteria() {
  const criteria = new Map();
  const specFiles = walk(path.join(root, 'specs'), (f) => f.endsWith('.md') && !f.endsWith('traceability.md'));
  for (const file of specFiles.sort()) {
    const rel = path.relative(root, file);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      const match = /^\s*-\s+\*\*([A-Z][A-Z0-9]{1,5}-\d{3})\*\*\s*(.*)$/.exec(line);
      if (!match) return;
      const [, id, summary] = match;
      if (criteria.has(id)) {
        throw new Error(`验收标准 ID 重复：${id}（${rel}:${index + 1} 与 ${criteria.get(id).spec}）`);
      }
      criteria.set(id, { id, summary: summary.trim(), spec: rel, line: index + 1 });
    });
  }
  return criteria;
}

/** 从 test/**.test.ts 收集用例，并把 `// @spec ID` 绑定到紧随其后的 test(...) */
function collectTests() {
  const tests = [];
  const testFiles = walk(path.join(root, 'test'), (f) => f.endsWith('.test.ts'));
  for (const file of testFiles.sort()) {
    const rel = path.relative(root, file);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    let pending = [];
    lines.forEach((line, index) => {
      const tags = [...line.matchAll(new RegExp(`@spec\\s+(${ID_PATTERN})`, 'g'))].map((m) => m[1]);
      if (tags.length > 0) {
        pending.push(...tags);
        return;
      }
      const testMatch = /^\s*(?:await\s+)?test\(\s*(['"`])(.*?)\1/.exec(line);
      if (testMatch) {
        tests.push({
          name: testMatch[2],
          file: rel,
          line: index + 1,
          specs: [...new Set(pending)],
        });
        pending = [];
      }
    });
    if (pending.length > 0) {
      tests.push({ name: '(未绑定到 test 的 @spec)', file: rel, line: lines.length, specs: pending });
    }
  }
  return tests;
}

const criteria = collectCriteria();
const tests = collectTests();

const coveredIds = new Set();
const dangling = [];
for (const t of tests) {
  if (t.specs.length === 0) {
    dangling.push({ kind: 'missing-tag', file: t.file, line: t.line, name: t.name });
    continue;
  }
  for (const id of t.specs) {
    if (!criteria.has(id)) {
      dangling.push({ kind: 'unknown-id', file: t.file, line: t.line, name: t.name, id });
      continue;
    }
    coveredIds.add(id);
  }
}

const uncovered = [...criteria.values()].filter((c) => !coveredIds.has(c.id));

const lines = [];
lines.push('# 规格 ⇄ 测试 追溯矩阵');
lines.push('');
lines.push('> 由 `node scripts/trace.mjs` 自动生成，**请勿手工修改**。');
lines.push('');
lines.push('| 验收标准 | 规格文件 | 说明 | 覆盖测试 |');
lines.push('| --- | --- | --- | --- |');
for (const c of [...criteria.values()].sort((a, b) => a.id.localeCompare(b.id))) {
  const owners = tests.filter((t) => t.specs.includes(c.id));
  const cell = owners.length === 0 ? '❌ **未覆盖**' : owners.map((t) => `\`${t.file}\` · ${t.name}`).join('<br>');
  lines.push(`| **${c.id}** | ${c.spec} | ${c.summary.replace(/\|/g, '\\|')} | ${cell} |`);
}
lines.push('');
lines.push('## 统计');
lines.push('');
lines.push(`- 验收标准：**${criteria.size}** 条`);
lines.push(`- 已覆盖：**${coveredIds.size}** 条`);
lines.push(`- 未覆盖：**${uncovered.length}** 条`);
lines.push(`- 悬空引用／未标注用例：**${dangling.length}** 处`);
lines.push('');

if (uncovered.length > 0) {
  lines.push('### 未覆盖的验收标准');
  lines.push('');
  for (const c of uncovered) lines.push(`- **${c.id}** ${c.summary} （${c.spec}）`);
  lines.push('');
}
if (dangling.length > 0) {
  lines.push('### 需要修的测试');
  lines.push('');
  for (const d of dangling) {
    if (d.kind === 'unknown-id') lines.push(`- ❌ ${d.file}:${d.line} 引用了不存在的规格 ID \`${d.id}\``);
    else lines.push(`- ❌ ${d.file}:${d.line} 用例「${d.name}」没有 \`@spec\` 标注`);
  }
  lines.push('');
}

const outPath = path.join(root, 'specs', 'traceability.md');
fs.writeFileSync(outPath, lines.join('\n'), 'utf8');

if (!quiet) {
  console.log(`specs/traceability.md 已生成：验收标准 ${criteria.size} 条，已覆盖 ${coveredIds.size} 条`);
}

if (uncovered.length > 0 || dangling.length > 0) {
  console.error('');
  console.error('✖ 规格追溯门禁未通过：');
  for (const c of uncovered) console.error(`  · 未覆盖：${c.id} ${c.summary}（${c.spec}）`);
  for (const d of dangling) {
    console.error(
      d.kind === 'unknown-id'
        ? `  · 悬空引用：${d.file}:${d.line} → ${d.id}（规格里没有这条）`
        : `  · 缺少标注：${d.file}:${d.line} 用例「${d.name}」没有 @spec`,
    );
  }
  process.exit(1);
}

console.log('✔ 规格追溯门禁通过：每条验收标准都有测试守着。');
