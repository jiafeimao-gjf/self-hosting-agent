import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { COMPONENT_SPECS, componentTypes, schemaOf, validateViewSpec } from '../src/surface/viewspec.ts';
import type { ComponentSpec, ComponentType, ViewSpec } from '../src/surface/viewspec.ts';
import { escapeHtml, renderFragment, renderViewSpec } from '../src/surface/renderer.ts';
import { DEFAULT_TOKENS, tokensToCss } from '../src/surface/tokens.ts';
import { ViewDocument } from '../src/surface/document.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(here, '..', 'specs', 'schemas', 'view-spec.schema.json');

/** 每个组件类型的合法样例：组件表加一行，这里也必须加一行（否则类型报错） */
const COMPONENT_SAMPLES: Record<ComponentType, ViewSpec> = {
  panel: { type: 'panel', title: '预算', children: [{ type: 'text', text: '还有 42%' }] },
  text: { type: 'text', text: '一段文本', tone: 'muted' },
  progress: { type: 'progress', label: '上下文预算', value: 0.42, tone: 'info' },
  action: { type: 'action', label: '重试一次', emit: 'retry', tone: 'danger' },
  list: { type: 'list', title: '待办', items: ['写规格', '写测试'], tone: 'default' },
  kv: { type: 'kv', title: '指标', pairs: [{ key: 'tokens', value: '12k' }] },
  columns: { type: 'columns', children: [{ type: 'badge', text: '就绪' }] },
  badge: { type: 'badge', text: '运行中', tone: 'success' },
};

interface SchemaComponentDefinition {
  title: string;
  description: string;
  type: string;
  additionalProperties: boolean;
  required: string[];
  properties: Record<string, unknown>;
}

interface ViewSpecSchema {
  $schema: string;
  $id: string;
  $ref: string;
  $defs: Record<string, SchemaComponentDefinition & { oneOf?: { $ref: string }[] }>;
}

// @spec SURF-001
test('组件表是唯一真相来源：校验 / 渲染 / schema 三处同步', () => {
  const types = componentTypes().sort();
  assert.deepEqual(types, Object.keys(COMPONENT_SAMPLES).sort(), '组件表与样例必须一一对应');

  // schema 的 oneOf 从组件表派生
  const schema = schemaOf() as unknown as ViewSpecSchema;
  const oneOf = (schema.$defs.viewSpec?.oneOf ?? []).map((ref) => ref.$ref.replace('#/$defs/', ''));
  assert.deepEqual([...oneOf].sort(), types, 'schema oneOf 必须与组件表一致');

  // 校验器接受每个组件的合法样例，渲染器都实现了它（不会降级成占位块）
  for (const type of componentTypes()) {
    const sample = COMPONENT_SAMPLES[type];
    const checked = validateViewSpec(sample);
    assert.equal(checked.ok, true, `${type} 的合法样例被拒绝：${checked.ok === false ? checked.error.message : ''}`);

    const html = renderFragment(sample);
    assert.equal(html.includes('data-unknown-component'), false, `${type} 被渲染器当成未知组件`);
    assert.equal(html.includes('data-invalid-spec'), false, `${type} 被渲染器当成非法节点`);
    assert.ok(html.includes(`ac-${type}`), `${type} 的渲染输出缺少 ac-${type} 标记`);
  }

  // 组件表里每个类型都声明了摘要，schema 的 description 与它同源
  for (const type of componentTypes()) {
    assert.equal(typeof COMPONENT_SPECS[type].summary, 'string');
    assert.ok(COMPONENT_SPECS[type].summary.length > 0, `${type} 缺少 summary`);
    assert.equal(schema.$defs[type]?.description, COMPONENT_SPECS[type].summary);
  }
});

// @spec SURF-002
test('validateViewSpec 接受合法 spec，且对任意输入永不抛异常', () => {
  const ok = validateViewSpec(COMPONENT_SAMPLES.panel);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.ok === true ? ok.spec : null, COMPONENT_SAMPLES.panel);

  const weird: unknown[] = [
    null,
    undefined,
    42,
    'panel',
    true,
    [],
    [1, 2, 3],
    {},
    { type: 1 },
    { type: '不存在' },
    { type: 'text', text: 1 },
    { type: 'kv', pairs: '不是数组' },
    Object.create(null) as unknown,
  ];
  assert.doesNotThrow(() => {
    for (const value of weird) validateViewSpec(value);
  });
  for (const value of weird) {
    assert.equal(validateViewSpec(value).ok, false, `${JSON.stringify(value)} 不应通过校验`);
  }

  // 循环引用与超深嵌套：靠深度上限兜底，不爆栈
  const cyclic: Record<string, unknown> = { type: 'panel', children: [] };
  (cyclic.children as unknown[]).push(cyclic);
  const cyc = validateViewSpec(cyclic);
  assert.equal(cyc.ok, false);
  assert.equal(cyc.ok === false && cyc.error.code, 'TOO_DEEP');
});

// @spec SURF-003
test('未知组件类型与结构错误在错误码上可区分，且都带 path', () => {
  const unknownComponent = validateViewSpec({ type: 'sparkline', series: [1, 2] });
  assert.equal(unknownComponent.ok, false);
  assert.equal(unknownComponent.ok === false && unknownComponent.error.code, 'UNKNOWN_COMPONENT');
  assert.equal(unknownComponent.ok === false && unknownComponent.error.path, '$.type');

  const missingType = validateViewSpec({ text: 'hi' });
  assert.equal(missingType.ok === false && missingType.error.code, 'UNKNOWN_COMPONENT');

  const missing = validateViewSpec({ type: 'progress', label: '预算' });
  assert.equal(missing.ok === false && missing.error.code, 'MISSING_FIELD');
  assert.equal(missing.ok === false && missing.error.path, '$.value');

  const badType = validateViewSpec({ type: 'progress', label: 1, value: 0.5 });
  assert.equal(badType.ok === false && badType.error.code, 'BAD_FIELD_TYPE');
  assert.equal(badType.ok === false && badType.error.path, '$.label');

  const extra = validateViewSpec({ type: 'badge', text: 'ok', 额外字段: true });
  assert.equal(extra.ok === false && extra.error.code, 'UNKNOWN_FIELD');
  assert.equal(extra.ok === false && extra.error.path, '$.额外字段');

  const badTone = validateViewSpec({ type: 'badge', text: 'ok', tone: 'loud' });
  assert.equal(badTone.ok === false && badTone.error.code, 'BAD_VALUE');

  const nested = validateViewSpec({ type: 'panel', children: [{ type: 'text' }] });
  assert.equal(nested.ok === false && nested.error.code, 'MISSING_FIELD');
  assert.equal(nested.ok === false && nested.error.path, '$.children[0].text');

  const notObject = validateViewSpec({ type: 'panel', children: ['x'] });
  assert.equal(notObject.ok === false && notObject.error.code, 'NOT_OBJECT');
  assert.equal(notObject.ok === false && notObject.error.path, '$.children[0]');
});

// @spec SURF-004
test('progress.value 必须是 0~1 的有限数，越界报 OUT_OF_RANGE', () => {
  for (const value of [0, 0.5, 1]) {
    assert.equal(validateViewSpec({ type: 'progress', label: '预算', value }).ok, true, `value=${value} 应当合法`);
  }
  for (const value of [-0.01, 1.01, 42]) {
    const result = validateViewSpec({ type: 'progress', label: '预算', value });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'OUT_OF_RANGE', `value=${value}`);
  }
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = validateViewSpec({ type: 'progress', label: '预算', value });
    assert.equal(result.ok === false && result.error.code, 'BAD_FIELD_TYPE');
  }
});

// @spec SURF-005
test('renderViewSpec 输出自包含 HTML，progress 宽度与百分比跟随 value', () => {
  const html = renderViewSpec(COMPONENT_SAMPLES.progress);
  assert.ok(html.startsWith('<!doctype html>'), '应当是完整文档');
  assert.ok(html.includes('<html lang="zh-CN">'));
  assert.ok(html.includes('<style>'));
  assert.ok(html.includes(':root {'));
  assert.ok(html.includes('--ac-accent'), '自包含：令牌变量内联在 <style> 里');
  assert.ok(html.includes('上下文预算'));
  assert.ok(html.includes('width:42%'), 'progress 宽度应与 value 一致');
  assert.ok(html.includes('>42%</span>'), 'progress 百分比应与 value 一致');
  assert.ok(html.includes('aria-valuenow="0.42"'));

  assert.ok(renderViewSpec({ type: 'progress', label: 'a', value: 0 }).includes('width:0%'));
  assert.ok(renderViewSpec({ type: 'progress', label: 'a', value: 1 }).includes('width:100%'));

  // 内联 style 属性必须是 kebab-case（驼峰属性名浏览器会直接忽略）
  const panel = renderFragment({
    type: 'panel',
    children: [{ type: 'progress', label: 'a', value: 0.5 }],
  });
  assert.ok(panel.includes('flex-direction:column'));
  assert.ok(panel.includes('justify-content:space-between'));
  assert.ok(panel.includes('padding-inline-start') === false, 'kebab 属性不应被二次转换');
  assert.equal(/[A-Z]/.test(panel), false, '内联 style 里不得出现驼峰属性名');
});

// @spec SURF-006
test('所有进入 HTML 的文本与属性值都被转义', () => {
  assert.equal(escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');

  const payload = '<script>alert("x")</script>';
  const emit = '" onmouseover="alert(1)';
  const html = renderViewSpec({
    type: 'panel',
    title: payload,
    children: [
      { type: 'text', text: payload },
      { type: 'badge', text: payload },
      { type: 'action', label: payload, emit },
      { type: 'list', items: [payload] },
      { type: 'kv', pairs: [{ key: payload, value: payload }] },
    ],
  });

  assert.equal(html.includes('<script>'), false, '注入的 script 标签不得原样出现');
  assert.equal(html.includes('</script>'), false);
  assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'));
  assert.ok(html.includes('data-emit="&quot; onmouseover=&quot;alert(1)"'), '属性值必须转义，不能越出属性');
  assert.equal(html.includes('onmouseover="alert(1)"'), false);
});

// @spec SURF-007
test('未知组件降级为占位块，不抛异常、不白屏，兄弟组件照常渲染', () => {
  const html = renderFragment({
    type: 'panel',
    children: [
      { type: 'sparkline', series: [1, 2, 3] },
      { type: 'text', text: '我还在' },
    ],
  });
  assert.ok(html.includes('data-unknown-component="sparkline"'));
  assert.ok(html.includes('未知组件'));
  assert.ok(html.includes('我还在'), '未知组件不能中断兄弟组件');
  assert.equal(html.includes('data-invalid-spec'), false);

  assert.doesNotThrow(() => renderFragment(null));
  assert.doesNotThrow(() => renderFragment({ type: 42 }));
  assert.ok(renderFragment(null).includes('data-invalid-spec="true"'));

  const page = renderViewSpec({ type: 'columns', children: [{ type: 'x' }, { type: 'badge', text: 'ok' }] });
  assert.ok(page.includes('data-unknown-component="x"'));
  assert.ok(page.includes('>ok</span>'));
});

// @spec SURF-008
test('令牌覆盖颜色/字号/圆角/密度，tokensToCss 生成 --ac-* 变量', () => {
  const css = tokensToCss(DEFAULT_TOKENS);
  assert.ok(css.startsWith(':root {'));
  assert.equal(css.split('{').length, 2, '只能有一个声明块');
  assert.ok(css.includes('--ac-bg:'));
  assert.ok(css.includes('--ac-font-md: 14px;'));
  assert.ok(css.includes('--ac-radius-md: 8px;'));
  assert.ok(css.includes('--ac-radius-pill: 999px;'));
  assert.ok(css.includes('--ac-density: normal;'));
  assert.ok(css.includes('--ac-space: 8px;'));

  // 紧凑档位的间距更小
  const compact = tokensToCss({ ...DEFAULT_TOKENS, density: { ...DEFAULT_TOKENS.density, scale: 'compact' } });
  assert.ok(compact.includes('--ac-space: 6px;'));

  // 净化：注入值不得拼出第二个声明块
  const dirty = tokensToCss({
    ...DEFAULT_TOKENS,
    color: { ...DEFAULT_TOKENS.color, bg: 'red; } body { display:none' },
  });
  assert.equal(dirty.split('{').length, 2);
  assert.equal(dirty.split('}').length, 2);
  assert.equal(dirty.split(':root').length, 2);
});

// @spec SURF-009
test('磁盘上的 view-spec.schema.json 与代码生成的 schema 完全一致（契约漂移门禁）', () => {
  const generated = JSON.stringify(schemaOf(), null, 2) + '\n';
  const onDisk = fs.readFileSync(schemaPath, 'utf8');
  assert.equal(onDisk, generated, 'schema 漂移：请用 schemaOf() 重新生成 specs/schemas/view-spec.schema.json');

  const schema = schemaOf() as unknown as ViewSpecSchema;
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.$ref, '#/$defs/viewSpec');

  for (const type of componentTypes()) {
    const definition = schema.$defs[type];
    assert.ok(definition, `schema 缺少组件 ${type} 的定义`);
    assert.equal(definition.type, 'object');
    assert.equal(definition.additionalProperties, false);
    assert.equal(definition.title, type);

    const spec = COMPONENT_SPECS[type] as ComponentSpec;
    assert.deepEqual(definition.required, ['type', ...Object.keys(spec.required)], `${type} 的 required 与组件表不一致`);
    const declared = [...Object.keys(spec.required), ...Object.keys(spec.optional)];
    for (const name of declared) {
      assert.ok(definition.properties[name], `${type}.${name} 没有出现在 schema properties 里`);
    }
    assert.deepEqual(
      Object.keys(definition.properties).sort(),
      ['type', ...declared].sort(),
      `${type} 的 properties 与组件表不一致`,
    );
  }

  // children 通过 $ref 递归到 viewSpec
  const panelSchema = schema.$defs.panel as unknown as { properties: { children: { items: { $ref: string } } } };
  assert.equal(panelSchema.properties.children.items.$ref, '#/$defs/viewSpec');
});

// @spec SURF-010
test('applyPatch 支持 mount / replace / patch 三种粒度，非法变更不改文档', () => {
  const doc = new ViewDocument();
  assert.equal(doc.version, 0);
  assert.deepEqual(doc.scopes(), []);

  const mounted = doc.applyPatch({
    scope: 'surface.main',
    op: 'mount',
    spec: { type: 'progress', label: '预算', value: 0.3, tone: 'info' },
  });
  assert.equal(mounted.ok, true);
  assert.equal(mounted.ok === true && mounted.version, 1);
  assert.deepEqual(doc.scopes(), ['surface.main']);

  // mount 到已存在的 scope：拒绝
  const remount = doc.applyPatch({ scope: 'surface.main', op: 'mount', spec: { type: 'text', text: 'x' } });
  assert.equal(remount.ok, false);
  assert.equal(remount.ok === false && remount.error.code, 'SCOPE_EXISTS');

  // patch：深合并，未提到的字段保留，数组/标量整体替换
  const merged = doc.applyPatch({ scope: 'surface.main', op: 'patch', spec: { value: 0.9 } });
  assert.equal(merged.ok, true);
  assert.equal(merged.ok === true && merged.version, 2);
  assert.deepEqual(doc.getScope('surface.main'), { type: 'progress', label: '预算', value: 0.9, tone: 'info' });

  // patch 到不存在的 scope：拒绝
  const orphanPatch = doc.applyPatch({ scope: 'surface.sidebar', op: 'patch', spec: { type: 'text', text: 'x' } });
  assert.equal(orphanPatch.ok === false && orphanPatch.error.code, 'SCOPE_NOT_FOUND');

  // replace：整块替换
  const replaced = doc.applyPatch({ scope: 'surface.main', op: 'replace', spec: { type: 'badge', text: '已完成' } });
  assert.equal(replaced.ok, true);
  assert.equal(replaced.ok === true && replaced.version, 3);
  assert.deepEqual(doc.getScope('surface.main'), { type: 'badge', text: '已完成' });

  const orphanReplace = doc.applyPatch({ scope: 'surface.sidebar', op: 'replace', spec: { type: 'text', text: 'x' } });
  assert.equal(orphanReplace.ok === false && orphanReplace.error.code, 'SCOPE_NOT_FOUND');

  // 非法输入：错误码明确，且文档纹丝不动
  const badScope = doc.applyPatch({ scope: '  ', op: 'mount', spec: { type: 'text', text: 'x' } });
  assert.equal(badScope.ok === false && badScope.error.code, 'BAD_SCOPE');

  const badOp = doc.applyPatch({ scope: 'surface.main', op: 'append', spec: { type: 'text', text: 'x' } });
  assert.equal(badOp.ok === false && badOp.error.code, 'UNKNOWN_OP');

  const badSpec = doc.applyPatch({ scope: 'surface.main', op: 'replace', spec: { type: 'nope' } });
  assert.equal(badSpec.ok === false && badSpec.error.code, 'INVALID_SPEC');

  // patch 合并出非法结构（改了 type）：整笔作废
  const breakingPatch = doc.applyPatch({ scope: 'surface.main', op: 'patch', spec: { type: 'sparkline' } });
  assert.equal(breakingPatch.ok === false && breakingPatch.error.code, 'INVALID_SPEC');

  assert.equal(doc.version, 3, '失败的变更不得推高版本号');
  assert.deepEqual(doc.scopes(), ['surface.main']);
});

// @spec SURF-011
test('版本号单调递增，rollback 回到历史内容并产生新的递增版本', () => {
  const doc = new ViewDocument();
  doc.applyPatch({ scope: 'a', op: 'mount', spec: { type: 'text', text: 'v1' } });
  doc.applyPatch({ scope: 'a', op: 'patch', spec: { text: 'v2' } });
  doc.applyPatch({ scope: 'b', op: 'mount', spec: { type: 'badge', text: 'b' } });
  assert.deepEqual(doc.history().map((snapshot) => snapshot.version), [0, 1, 2, 3]);
  assert.equal(doc.version, 3);

  const failed = doc.applyPatch({ scope: 'a', op: 'replace', spec: { type: '不存在' } });
  assert.equal(failed.ok, false);
  assert.equal(doc.version, 3, '失败不变');

  const rolled = doc.rollback(1);
  assert.equal(rolled.ok, true);
  assert.equal(rolled.ok === true && rolled.restored, 1);
  assert.equal(rolled.ok === true && rolled.version, 4);
  assert.equal(doc.version, 4, '回滚产生新版本而不是倒带');
  assert.deepEqual(doc.scopes(), ['a'], '回到 v1 时只有 scope a');
  assert.equal(doc.getScope('a')?.text, 'v1');

  const missing = doc.rollback(99);
  assert.equal(missing.ok === false && missing.error.code, 'UNKNOWN_VERSION');
  assert.equal(doc.rollback(1.5).ok, false);
  assert.equal(doc.version, 4);

  const snapshots = doc.history();
  assert.equal(snapshots.length, 5);
  assert.equal(snapshots[4]?.rolledBackTo, 1);
  // 历史是副本，外部改不动内部状态
  (snapshots[4] as { scopes: Record<string, ViewSpec> }).scopes.a = { type: 'text', text: '被篡改' };
  assert.equal(doc.getScope('a')?.text, 'v1');

  // 回滚之后还能继续改，版本继续涨
  const resumed = doc.applyPatch({ scope: 'a', op: 'patch', spec: { text: 'v5' } });
  assert.equal(resumed.ok === true && resumed.version, 5);
  assert.equal(doc.getScope('a')?.text, 'v5');
});

// @spec SURF-012
test('render 输出整页 HTML，包含全部 scope 区块并保持转义', () => {
  const doc = new ViewDocument();
  doc.applyPatch({ scope: 'surface.sidebar', op: 'mount', spec: { type: 'badge', text: '就绪' } });
  doc.applyPatch({
    scope: 'surface.main',
    op: 'mount',
    spec: { type: 'text', text: '<img src=x onerror=alert(1)>' },
  });

  const html = doc.render();
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('data-version="2"'));
  assert.ok(html.includes('data-scope="surface.sidebar"'));
  assert.ok(html.includes('data-scope="surface.main"'));
  assert.ok(html.includes('就绪'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.equal(html.includes('<img src=x'), false, 'render 也必须转义');
  assert.ok(html.includes('--ac-bg'), '整页也要内联令牌');

  const empty = new ViewDocument().render();
  assert.ok(empty.includes('（空文档）'));
  assert.ok(empty.includes('data-version="0"'));
});
