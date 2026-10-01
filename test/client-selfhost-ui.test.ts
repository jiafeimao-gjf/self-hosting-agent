import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * SPEC-014 客户端自举的浏览器端呈现。
 *
 * 纯逻辑（归一化 / cache-bust / 横幅 / 源码行）直接 import 断言；DOM 接线部分
 * 沿用既有 UI-006 的做法：读源码结构断言。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.join(here, '..', 'src', 'client');

function readClient(name: string): string {
  return fs.readFileSync(path.join(clientDir, name), 'utf8');
}

const indexHtml = readClient('index.html');
const styleCss = readClient('style.css');
const appJs = readClient('app.js');

interface ClientChangeModel {
  kind: string;
  path: string;
  file: string;
  reason: string;
  selfTest: string;
  author: string;
  version: number | null;
  added: number | null;
  removed: number | null;
  isCss: boolean;
  needsRefresh: boolean;
  ts: string;
}

interface ClientSourceModel {
  path: string;
  bytes: number | null;
  versions: number | null;
}

interface AppModule {
  isCssClientPath(path: unknown): boolean;
  baseNameOf(path: unknown): string;
  cacheBustHref(href: unknown, version: unknown, nonce: unknown): string;
  findStyleLinkIndex(hrefs: unknown, path: unknown): number;
  normalizeClientChange(raw: unknown): ClientChangeModel;
  selfTestLabel(value: unknown): string;
  renderClientChange(raw: unknown): string;
  normalizeSources(raw: unknown): ClientSourceModel[];
  renderSourceRow(source: unknown): string;
}

// app.js 是浏览器端 ESM，Node 里 import 不应有副作用（UI-007 已守）；动态 URL 导入绕开 .js 的 TS 解析
const appUrl = new URL('../src/client/app.js', import.meta.url).href;
const app = (await import(appUrl)) as unknown as AppModule;

// @spec UI2-001
test('订阅 client.changed：写 / 回滚都归一化，并进事件时间线', () => {
  assert.ok(appJs.includes("addEventListener('client.changed'"), '必须订阅含点号的 client.changed 事件');
  assert.ok(appJs.includes('applyClientChange('), '缺少 client.changed 的处理函数');
  assert.ok(appJs.includes('normalizeClientChange('), '事件 data 必须先归一化成稳定模型');
  assert.ok(appJs.includes('parseData(event.data)'), '坏了也不能让界面停摆');
  assert.ok(appJs.includes('pushTimeline('), '任何变更都要进事件时间线');
  assert.ok(appJs.includes('type: `client.changed.${change.kind}`'), '时间线事件类型要带上 kind');
  assert.ok(appJs.includes("name.startsWith('client.')"), '时间线按类型上色要认得 client.*');

  const write = app.normalizeClientChange({
    kind: 'write',
    path: 'style.css',
    reason: '换主题',
    selfTest: 'passed',
    version: 2,
    diff: { added: 2, removed: 0 },
  });
  assert.equal(write.kind, 'write');
  assert.equal(write.isCss, true);

  const revert = app.normalizeClientChange({ kind: 'revert', path: 'app.js', version: 1 });
  assert.equal(revert.kind, 'revert');
  assert.equal(revert.isCss, false);
});

// @spec UI2-002
test('CSS 变更走无刷新热替换：按文件名定位 <link> 并加 cache-bust 查询串', () => {
  assert.equal(app.isCssClientPath('style.css'), true);
  assert.equal(app.isCssClientPath('src/client/theme.css'), true);
  assert.equal(app.isCssClientPath('STYLE.CSS'), true);
  assert.equal(app.isCssClientPath('style.css?v=1'), true);
  assert.equal(app.isCssClientPath('app.js'), false);
  assert.equal(app.isCssClientPath(''), false);
  assert.equal(app.isCssClientPath(null), false);

  assert.equal(app.cacheBustHref('/style.css', 2, 1700000000000), '/style.css?v=2&t=1700000000000');
  // 旧查询串先剥掉，避免 ?v=1&t=1?v=2 这种叠罗汉
  assert.equal(app.cacheBustHref('/style.css?v=1&t=1', 2, 5), '/style.css?v=2&t=5');
  assert.equal(app.cacheBustHref('/style.css#theme', 2, 5), '/style.css?v=2&t=5');
  assert.equal(app.cacheBustHref('/style.css', null, 5), '/style.css?t=5');
  assert.equal(app.cacheBustHref('', 2, 5), '', '空地址不替换');
  assert.equal(app.cacheBustHref(null, 2, 5), '');

  assert.equal(app.findStyleLinkIndex(['/style.css'], 'style.css'), 0);
  assert.equal(app.findStyleLinkIndex(['/a.css', '/style.css?v=1'], 'src/client/style.css'), 1);
  assert.equal(app.findStyleLinkIndex(['/a.css'], 'style.css'), -1, '匹配不到就不许乱改别的 link');
  assert.equal(app.findStyleLinkIndex('不是数组', 'style.css'), -1);

  // DOM 侧：按已有样式表定位，只写 href 属性（不整页刷新）
  assert.ok(appJs.includes('link[rel="stylesheet"]'));
  assert.ok(appJs.includes("setAttribute('href'"));
  assert.equal(appJs.includes('location.reload'), false, '不得出现被 UI-006 禁止的整页刷新字面量');
});

// @spec UI2-003
test('JS / HTML 变更显示横幅，刷新按钮只由人类点击触发，绝不自动刷新', () => {
  const js = app.renderClientChange({
    kind: 'write',
    path: 'app.js',
    reason: '加一个按钮',
    selfTest: 'passed',
    version: 3,
  });
  assert.ok(js.includes('客户端代码已更新（app.js）'));
  assert.ok(js.includes('刷新以生效'));
  assert.ok(js.includes('data-client-action="refresh"'), '横幅要有刷新按钮');
  assert.ok(js.includes('data-client-action="close"'));

  // .css 已热替换，不给刷新按钮（避免人类白刷一次丢掉对话）
  const css = app.renderClientChange({ kind: 'write', path: 'style.css', version: 2 });
  assert.ok(css.includes('已即时生效'));
  assert.equal(css.includes('data-client-action="refresh"'), false);

  // 点击用事件委托；只有 refresh 动作才可能导航
  assert.ok(appJs.includes("addEventListener('click'"));
  assert.ok(appJs.includes('data-client-action'));
  assert.ok(appJs.includes("action === 'refresh'"));
  assert.ok(
    appJs.includes('window.location.assign(window.location.href)'),
    '人类点击后做等价整页刷新（不用被 UI-006 禁止的 reload 字面量）',
  );
  assert.equal(appJs.includes('location.reload'), false);
  assert.equal(appJs.includes('location.href ='), false);

  // 要禁的是「自动刷新」，不是「任何定时器」：刷新不得被任何定时器调度。
  assert.equal(/setTimeout\([^)]*assign/.test(appJs), false, '刷新不得被自动调度');
  assert.equal(/setInterval\([^)]*assign/.test(appJs), false, '刷新不得被自动调度');

  // 定时器只允许忙碌态秒数跳动那一个（UI-010），多一个都得先解释清楚。
  const intervals = appJs.match(/setInterval\([^)]*\)/g) ?? [];
  assert.deepEqual(intervals, ['setInterval(paint, 1000)'], '只允许忙碌态计时器');
});

// @spec UI2-004
test('横幅显示 path / reason / 自检 / 版本 / 差异，可关闭，revert 文案不同且文本转义', () => {
  const banner = app.renderClientChange({
    kind: 'write',
    path: 'src/client/app.js',
    reason: '加一个按钮',
    selfTest: 'passed',
    version: 3,
    diff: { added: 2, removed: 1 },
    author: 'lead',
  });
  assert.ok(banner.includes('客户端代码已更新（app.js）'));
  assert.ok(banner.includes('加一个按钮'));
  assert.ok(banner.includes('自检 通过'));
  assert.ok(banner.includes('v3'));
  assert.ok(banner.includes('+2 / -1'));
  assert.ok(banner.includes('作者 lead'));
  assert.ok(banner.includes('data-client-action="close"'));

  // 归一化必须幂等：boot() 先归一化一次，渲染时再归一化一次，diff 不能在这一步丢掉
  const model = app.normalizeClientChange({
    kind: 'write',
    path: 'app.js',
    version: 3,
    diff: { added: 2, removed: 1 },
  });
  assert.ok(app.renderClientChange(model).includes('+2 / -1'), '归一化后的模型再渲染不得丢 diff');

  const revert = app.renderClientChange({
    kind: 'revert',
    path: 'app.js',
    reason: '自检没过，原样回滚',
    selfTest: 'failed',
    version: 1,
  });
  assert.ok(revert.includes('已回滚 app.js'));
  assert.equal(revert.includes('代码已更新'), false, '回滚文案必须与写入不同');
  assert.ok(revert.includes('自检 未通过'));
  assert.ok(revert.includes('tone-warning'));

  // 自检结果未知就是未知，不装作通过
  assert.equal(app.selfTestLabel('passed'), '通过');
  assert.equal(app.selfTestLabel('failed'), '未通过');
  assert.equal(app.selfTestLabel('weird'), 'weird');
  assert.equal(app.selfTestLabel(''), '未知');
  assert.equal(app.selfTestLabel(null), '未知');

  // reason / author 是 Agent 给的自由文本：必须转义
  const payload = '<img src=x onerror=alert(1)>';
  const dirty = app.renderClientChange({ kind: 'write', path: 'app.js', reason: payload, author: payload });
  assert.equal(dirty.includes('<img src=x'), false);
  assert.ok(dirty.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

// @spec UI2-005
test('检查器「客户端源码」区渲染 path / bytes / versions，缺字段退化为空列表', () => {
  assert.ok(indexHtml.includes('id="sources"'), 'index.html 缺少客户端源码区 #sources');
  assert.ok(indexHtml.includes('客户端源码'));
  assert.ok(appJs.includes('dom.sources'), '快照要刷新源码区');
  assert.ok(appJs.includes('normalizeSources('));
  assert.ok(appJs.includes('renderSourceRow('));
  assert.ok(styleCss.includes('.card-sources'));
  assert.ok(styleCss.includes('.source-row'));

  assert.deepEqual(app.normalizeSources({ sources: [{ path: 'style.css', bytes: 1234, versions: 2 }] }), [
    { path: 'style.css', bytes: 1234, versions: 2 },
  ]);
  // 常见别名 + 缺字段
  assert.deepEqual(app.normalizeSources({ client: { sources: [{ name: 'app.js', size: 10 }] } }), [
    { path: 'app.js', bytes: 10, versions: null },
  ]);
  assert.deepEqual(app.normalizeSources(null), []);
  assert.deepEqual(app.normalizeSources({ sources: '不是数组' }), []);
  assert.deepEqual(app.normalizeSources({ sources: [null, 42, {}] }), [{ path: '', bytes: null, versions: null }]);

  const row = app.renderSourceRow({ path: 'app.js', bytes: 10, versions: 3 });
  assert.ok(row.includes('data-source="app.js"'));
  assert.ok(row.includes('10 B'));
  assert.ok(row.includes('3 版'));
  const sparse = app.renderSourceRow({});
  assert.ok(sparse.includes('(未知文件)'));
  assert.ok(sparse.includes('—'));
});

// @spec UI2-006
test('防御性：坏输入不抛异常、未知字段退化，进入 DOM 的文本全部转义', () => {
  const empty = app.normalizeClientChange(null);
  assert.equal(empty.kind, 'unknown');
  assert.equal(empty.path, '');
  assert.equal(empty.file, '(未知文件)');
  assert.equal(empty.isCss, false);
  assert.equal(empty.needsRefresh, true);
  assert.equal(empty.version, null);
  assert.equal(empty.added, null);
  assert.equal(empty.removed, null);

  const weird = app.normalizeClientChange({
    kind: 42,
    path: {},
    reason: null,
    selfTest: [],
    diff: 'x',
    version: '2',
    author: 7,
  });
  assert.equal(weird.kind, 'unknown');
  assert.equal(weird.path, '');
  assert.equal(weird.reason, '');
  assert.equal(weird.version, null, '非数字版本号就是未知，不瞎猜');
  assert.equal(weird.author, '');

  assert.doesNotThrow(() => {
    for (const value of [null, undefined, 42, 'x', true, [], {}, { kind: 'write' }]) {
      app.normalizeClientChange(value);
      app.renderClientChange(value);
      app.renderSourceRow(value);
      app.normalizeSources(value);
      app.cacheBustHref(value, value, value);
      app.findStyleLinkIndex(value, value);
      app.isCssClientPath(value);
      app.baseNameOf(value);
    }
  });
  // 未知 kind 也有可读横幅，而不是白屏
  assert.ok(app.renderClientChange(null).includes('客户端源码有变更'));
  assert.ok(app.renderClientChange(null).includes('data-client-action="close"'));

  // path 进 data-* 属性同样要转义
  const payload = '" onmouseover="alert(1)';
  const row = app.renderSourceRow({ path: payload, bytes: 1, versions: 1 });
  assert.equal(row.includes('onmouseover="alert(1)"'), false);
  assert.ok(row.includes('&quot;'));

  // 新文件同样不得引入远程资源（UI-005 的禁令对新代码继续成立）
  for (const text of [indexHtml, styleCss, appJs]) {
    assert.equal(/https?:\/\//.test(text), false, '不得引用远程资源');
  }
});
