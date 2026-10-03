import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_SETTINGS,
  PRESETS,
  PROTOCOLS,
  activePresetId,
  apiKeyHint,
  apiKeyPlaceholder,
  createSettingsPage,
  currentModelText,
  defaultForm,
  effectiveModelFromState,
  emptyForm,
  fieldLabel,
  formFromPreset,
  formToListPayload,
  formToPayload,
  labelFor,
  modelsStatusText,
  normalizeModelOptions,
  normalizeSaveError,
  normalizeSettings,
  normalizeTestResult,
  presetById,
  readFormFields,
  readSettings,
  renderCurrentModel,
  renderFormErrors,
  renderLoadError,
  renderModelOptions,
  renderPresetButtons,
  renderProtocolHint,
  renderSaveError,
  renderTestResult,
  settingsToForm,
  validateForm,
} from '../src/client/settings.js';

/**
 * SPEC-017 浏览器端设置页。
 *
 * 纯逻辑（归一化 / 预设 / 校验 / 表单互转 / 结果渲染）直接 import 断言；
 * DOM 接线沿用既有 UI-006 / UI2-006 的做法：读源码结构断言。
 * `settings.js` 在 Node 里 import 无副作用——它连 `document` 都不碰（DOM 由 app.js 注入）。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.join(here, '..', 'src', 'client');

function readClient(name: string): string {
  return fs.readFileSync(path.join(clientDir, name), 'utf8');
}

const indexHtml = readClient('index.html');
const styleCss = readClient('style.css');
const appJs = readClient('app.js');
const settingsJs = readClient('settings.js');

const VALID_FORM = {
  protocol: 'openai',
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'qwen3:4b',
  apiKey: '',
  temperature: '',
  maxTokens: '',
  timeoutMs: '',
};

// @spec UI3-001
test('顶栏「设置」入口打开覆盖主区域的独立设置页，返回按钮回到对话且不刷新页面', () => {
  assert.ok(indexHtml.includes('id="settings-open"'), '顶栏缺少设置入口');
  assert.ok(indexHtml.includes('>设置<'), '入口文案应为「设置」');
  assert.ok(indexHtml.includes('id="settings"'));
  assert.ok(indexHtml.includes('class="settings-page"'));
  assert.match(indexHtml, /id="settings"[^>]*hidden/, '设置页默认隐藏');
  assert.ok(indexHtml.includes('id="settings-back"'));
  assert.ok(indexHtml.includes('返回对话'));
  assert.ok(indexHtml.includes('id="settings-form"'));

  // 纯逻辑里的控制器是函数；打开 / 关闭的接线在 app.js 与 settings.js
  assert.equal(typeof createSettingsPage, 'function');
  assert.ok(appJs.includes('createSettingsPage('), 'app.js 要实例化设置页');
  assert.ok(appJs.includes('settingsPage.open()'), '顶栏入口要打开设置页');
  assert.ok(settingsJs.includes('nodes.back.addEventListener'), '返回按钮在设置页控制器里绑定');
  assert.ok(settingsJs.includes('close();'), '返回 / 保存成功都要能关掉设置页');
  assert.ok(appJs.includes("addEventListener('settings'"), 'settings 事件要同步当前模型');

  // 覆盖主区域：固定定位 + 自己的 hidden 规则
  assert.ok(styleCss.includes('.settings-page'));
  assert.ok(styleCss.includes('.settings-page[hidden]'));
  for (const banned of ['location.reload', 'location.href =', 'document.write', 'window.open']) {
    assert.equal(appJs.includes(banned), false, `打开 / 关闭设置页不得刷新页面：${banned}`);
    assert.equal(settingsJs.includes(banned), false, `打开 / 关闭设置页不得刷新页面：${banned}`);
  }
});

// @spec UI3-002
test('当前生效模型显示为「模型 · 来源」，顶栏与设置页同步，缺字段退化为默认值', () => {
  assert.ok(indexHtml.includes('id="current-model"'), '顶栏缺少当前模型 chip');
  assert.ok(indexHtml.includes('id="settings-model"'), '设置页头部缺少当前模型');
  assert.ok(styleCss.includes('.model-chip'));
  assert.ok(appJs.includes('currentModelText('));
  assert.ok(settingsJs.includes('textContent = text'), 'chip 用 textContent 写入，不拼 HTML');
  assert.ok(appJs.includes('applyEffectiveModel('));
  assert.ok(appJs.includes('void settingsPage.load()'), '首屏要按已存设置显示当前模型');

  assert.equal(DEFAULT_SETTINGS.model, 'qwen3:4b');
  assert.equal(currentModelText({ model: 'qwen3:4b', label: '本机 Ollama' }), 'qwen3:4b · 本机 Ollama');
  assert.equal(
    currentModelText({ model: 'claude-sonnet-4-5', label: 'Anthropic 官方' }),
    'claude-sonnet-4-5 · Anthropic 官方',
  );
  // 缺字段 → SPEC-015 默认值，不显示 undefined
  assert.equal(currentModelText({}), 'qwen3:4b · 本机 Ollama');
  assert.equal(currentModelText(null), 'qwen3:4b · 本机 Ollama');
  // 没有 label 时按 Base URL 推断来源
  assert.equal(currentModelText({ baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }), 'deepseek-chat · DeepSeek');
  assert.equal(labelFor({ baseUrl: 'https://api.openai.com/v1' }), 'OpenAI 官方');
  assert.equal(labelFor({ baseUrl: 'http://127.0.0.1:11434/v1' }), '本机 Ollama');
  assert.equal(labelFor({ baseUrl: 'https://my-gateway.example.com/v1' }), '自定义端点');

  // /api/state 里没有模型信息时不冒充
  assert.equal(effectiveModelFromState({}), null);
  assert.equal(effectiveModelFromState(null), null);
  const fromState = effectiveModelFromState({ settings: { model: 'claude-sonnet-4-5', label: 'Anthropic 官方' } });
  assert.ok(fromState !== null);
  assert.equal(currentModelText(fromState), 'claude-sonnet-4-5 · Anthropic 官方');
  // 顶层 model 是字符串也认
  const flat = effectiveModelFromState({ model: 'qwen3:4b', label: '本机 Ollama' });
  assert.equal(flat?.model, 'qwen3:4b');
  assert.equal(flat?.label, '本机 Ollama');
});

// @spec UI3-003
test('表单字段齐全（协议二选一 / Base URL / 模型名 / password 的 Key / 三个可选数字）且说明端点差异', () => {
  for (const id of [
    'set-protocol-openai',
    'set-protocol-anthropic',
    'set-base-url',
    'set-model',
    'set-api-key',
    'set-temperature',
    'set-max-tokens',
    'set-timeout',
    'protocol-hint',
    'api-key-hint',
    'presets',
    'settings-test',
    'settings-save',
    'settings-result',
  ]) {
    assert.ok(indexHtml.includes(`id="${id}"`), `index.html 缺少 #${id}`);
  }
  assert.match(indexHtml, /id="set-api-key"[^>]*type="password"/, 'Key 必须是 password 输入框');
  assert.match(indexHtml, /<input id="set-protocol-openai" type="radio" name="protocol" value="openai"/);
  assert.match(indexHtml, /<input id="set-protocol-anthropic" type="radio" name="protocol" value="anthropic"/);

  assert.equal(emptyForm().baseUrl, '');
  assert.equal(defaultForm().model, 'qwen3:4b');
  assert.deepEqual(PROTOCOLS.map((meta) => meta.value), ['openai', 'anthropic']);

  const openai = renderProtocolHint('openai');
  assert.ok(openai.includes('/chat/completions'), 'OpenAI 兼容要说清端点');
  assert.ok(openai.includes('Authorization: Bearer'), 'OpenAI 兼容要说清鉴权');
  const anthropic = renderProtocolHint('anthropic');
  assert.ok(anthropic.includes('/v1/messages'));
  assert.ok(anthropic.includes('x-api-key'));
  assert.ok(anthropic.includes('anthropic-version'));

  // 未知协议退化，不抛异常
  assert.doesNotThrow(() => renderProtocolHint('不存在'));
  assert.ok(renderProtocolHint(42).includes('OpenAI 兼容'));
});

// @spec UI3-004
test('服务端设置 → 表单值：Key 留空 + placeholder 显示打码值 + 「留空表示不修改」；永不读明文', () => {
  const saved = {
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-5',
    apiKeyMasked: 'sk-…a1b2',
    hasApiKey: true,
    temperature: 0.3,
    maxTokens: 4096,
    timeoutMs: 30000,
    label: 'Anthropic 官方',
  };
  const form = settingsToForm(saved);
  assert.equal(form.protocol, 'anthropic');
  assert.equal(form.baseUrl, 'https://api.anthropic.com');
  assert.equal(form.model, 'claude-sonnet-4-5');
  assert.equal(form.apiKey, '', 'Key 输入框必须留空');
  assert.equal(form.temperature, '0.3');
  assert.equal(form.maxTokens, '4096');
  assert.equal(form.timeoutMs, '30000');

  assert.equal(apiKeyPlaceholder(saved), 'sk-…a1b2（留空表示不修改）');
  assert.ok(apiKeyHint(saved).includes('sk-…a1b2'));
  assert.ok(apiKeyHint(saved).includes('留空表示不修改'));
  assert.ok(apiKeyPlaceholder({ model: 'qwen3:4b' }).includes('可留空'), '没存过 Key 也要给出可读提示');

  // 归一化只认打码值：服务端误传明文也不能进模型 / 表单 / DOM
  const dirty = { model: 'x', apiKey: 'sk-plain-secret', apiKeyMasked: 'sk-…ecret', hasApiKey: true };
  assert.equal(normalizeSettings(dirty).apiKeyMasked, 'sk-…ecret');
  assert.equal(JSON.stringify(normalizeSettings(dirty)).includes('sk-plain-secret'), false);
  assert.equal(JSON.stringify(readSettings(dirty)).includes('sk-plain-secret'), false);
  assert.equal(settingsToForm(dirty).apiKey, '');

  // 外壳 / 别名 / 缺字段都能读
  assert.equal(readSettings({ settings: { model: 'm' } }).model, 'm');
  assert.equal(readSettings({ value: { model_name: 'm2', base_url: 'x' } }).model, 'm2');
  assert.equal(readSettings({ max_tokens: 10 }).maxTokens, 10);
  assert.equal(readSettings(null).model, '');

  // DOM 侧：打码值只进 placeholder，输入框 value 恒为空；settings.js 完全不碰 document
  assert.ok(settingsJs.includes('nodes.apiKey.placeholder = apiKeyPlaceholder(settings)'));
  assert.ok(settingsJs.includes("nodes.apiKey.value = ''"));
  assert.ok(settingsJs.includes('留空表示不修改'));
  assert.equal(settingsJs.includes('document.'), false, 'DOM 节点由 app.js 注入');
});

// @spec UI3-005
test('四个预设按钮一键填好协议 + Base URL + 模型名，且不动人类已输入的 Key', () => {
  assert.deepEqual(PRESETS.map((preset) => preset.id), ['ollama', 'openai', 'anthropic', 'deepseek']);
  for (const label of ['本机 Ollama', 'OpenAI 官方', 'Anthropic 官方', 'DeepSeek']) {
    assert.ok(PRESETS.some((preset) => preset.label === label), `缺少预设「${label}」`);
  }

  const anthropic = formFromPreset('anthropic', { apiKey: 'sk-keep', temperature: '0.2', model: '旧模型' });
  assert.equal(anthropic.protocol, 'anthropic');
  assert.equal(anthropic.baseUrl, 'https://api.anthropic.com');
  assert.equal(anthropic.model, 'claude-sonnet-4-5');
  assert.equal(anthropic.apiKey, 'sk-keep', '预设不得清空人类已输入的 Key');
  assert.equal(anthropic.temperature, '0.2');

  const ollama = formFromPreset('ollama', { apiKey: 'sk-keep' });
  assert.equal(ollama.protocol, 'openai');
  assert.equal(ollama.baseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(ollama.model, 'qwen3:4b');

  // 未知 id 保持原样、不抛异常
  const unknown = formFromPreset('不存在', { protocol: 'anthropic', baseUrl: 'u', model: 'm' });
  assert.equal(unknown.baseUrl, 'u');
  assert.equal(presetById('nope'), null);
  assert.doesNotThrow(() => formFromPreset(null, null));

  const html = renderPresetButtons('deepseek');
  for (const preset of PRESETS) {
    assert.ok(html.includes(`data-preset="${preset.id}"`), `缺少预设按钮 ${preset.id}`);
  }
  assert.ok(html.includes('is-active'), '当前预设要高亮');
  assert.equal(renderPresetButtons('').includes('is-active'), false);

  assert.equal(activePresetId({ protocol: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:4b' }), 'ollama');
  assert.equal(activePresetId({}), '');

  // DOM 侧：预设按钮用事件委托；点预设时不能顺手把人类敲进去的 Key 抹掉
  assert.ok(settingsJs.includes("closest('[data-preset]')"));
  assert.ok(
    settingsJs.includes('fillForm(formFromPreset(preset.id, readFormFields(nodes)), true)'),
    '预设只覆盖协议 / Base URL / 模型名，Key 保持原样',
  );
  assert.ok(indexHtml.includes('id="presets"'));
});

// @spec UI3-006
test('本地校验拦住非法输入且不发请求；合法则 PUT /api/settings，成功后回到对话并提示', () => {
  assert.equal(validateForm(VALID_FORM).ok, true);

  const empty = validateForm({ ...VALID_FORM, baseUrl: '', model: '' });
  assert.equal(empty.ok, false);
  assert.ok(empty.errors.baseUrl);
  assert.ok(empty.errors.model);
  assert.ok(validateForm({ ...VALID_FORM, protocol: 'gemini' }).errors.protocol);
  assert.ok(validateForm({ ...VALID_FORM, baseUrl: 'ftp://x' }).errors.baseUrl);
  assert.ok(validateForm({ ...VALID_FORM, temperature: 'abc' }).errors.temperature);
  assert.ok(validateForm({ ...VALID_FORM, temperature: '5' }).errors.temperature);
  assert.ok(validateForm({ ...VALID_FORM, maxTokens: '-1' }).errors.maxTokens);
  assert.ok(validateForm({ ...VALID_FORM, timeoutMs: 'abc' }).errors.timeoutMs);
  assert.equal(validateForm({ ...VALID_FORM, temperature: '0.7', maxTokens: '1024', timeoutMs: '30000' }).ok, true);

  const bad = formToPayload({ ...VALID_FORM, model: '' });
  assert.equal(bad.ok, false);
  assert.equal('payload' in bad, false, '非法输入不产生请求体');

  const payloadResult = formToPayload({ ...VALID_FORM, temperature: '0.2', maxTokens: '2048', timeoutMs: '15000' });
  assert.equal(payloadResult.ok, true);
  if (payloadResult.ok) {
    assert.deepEqual(payloadResult.payload, {
      protocol: 'openai',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen3:4b',
      temperature: 0.2,
      maxTokens: 2048,
      timeoutMs: 15000,
    });
    assert.equal('apiKey' in payloadResult.payload, false, '留空 = 不带字段，服务端保留原 Key');
  }
  const withKey = formToPayload({ ...VALID_FORM, apiKey: 'sk-typed' });
  assert.equal(withKey.ok && withKey.payload.apiKey, 'sk-typed');

  // 表单 → payload 走 DOM 读取；坏输入退化为空
  const read = readFormFields({
    protocolInputs: [
      { checked: false, value: 'openai' },
      { checked: true, value: 'anthropic' },
    ],
    baseUrl: { value: 'https://api.anthropic.com' },
    model: { value: 'claude-sonnet-4-5' },
    apiKey: { value: '' },
    temperature: { value: '' },
    maxTokens: { value: '' },
    timeoutMs: { value: '' },
  });
  assert.equal(read.protocol, 'anthropic');
  assert.equal(read.baseUrl, 'https://api.anthropic.com');
  assert.equal(readFormFields(null).protocol, 'openai');

  // DOM 接线：保存调 PUT /api/settings；本地错误就在页内显示；成功后回到对话并提示
  assert.ok(settingsJs.includes("request('/api/settings', { method: 'PUT'"));
  assert.ok(settingsJs.includes('formToPayload('));
  assert.ok(settingsJs.includes('renderFormErrors('));
  assert.ok(settingsJs.includes('close();'));
  assert.ok(appJs.includes('已保存模型设置'));
});

// @spec UI3-007
test('测试连接调 POST /api/settings/test：成功显示延迟与回复片段，失败显示可读错误', () => {
  assert.ok(settingsJs.includes("request('/api/settings/test', { method: 'POST'"));
  assert.ok(settingsJs.includes('renderTestResult('));
  assert.ok(indexHtml.includes('id="settings-test"'));

  const ok = renderTestResult({ ok: true, latencyMs: 42, reply: '你好，我是本机模型' });
  assert.ok(ok.includes('连接成功'));
  assert.ok(ok.includes('延迟 42 ms'));
  assert.ok(ok.includes('模型回复：你好，我是本机模型'));
  assert.ok(ok.includes('data-test-ok="true"'));

  const fail = renderTestResult({ ok: false, error: 'ECONNREFUSED 127.0.0.1:11434' });
  assert.ok(fail.includes('连接失败'));
  assert.ok(fail.includes('ECONNREFUSED 127.0.0.1:11434'));
  assert.ok(fail.includes('data-test-ok="false"'));

  // 缺字段 / 坏输入退化，不炸
  assert.ok(renderTestResult({ ok: true }).includes('连接成功'));
  assert.equal(renderTestResult({ ok: true }).includes('延迟'), false, '没有延迟就别说延迟');
  const degraded = normalizeTestResult(null);
  assert.equal(degraded.ok, false);
  assert.equal(degraded.latencyMs, null);
  assert.equal(degraded.reply, '');
  assert.ok(degraded.error.length > 0, '失败要有一句可读的话');
  assert.equal(normalizeTestResult({ ok: true, latency: 7, message: 'hi' }).latencyMs, 7);
  assert.equal(normalizeTestResult({ ok: true, latencyMs: '9' }).latencyMs, null, '数字字符串不算数字，未知就是未知');

  // 长回复截断，不刷屏
  const long = renderTestResult({ ok: true, latencyMs: 1, reply: 'x'.repeat(500) });
  assert.ok(long.length < 400);

  // 回复 / 错误是服务端自由文本：必须转义
  const payload = '<img src=x onerror=alert(1)>';
  const dirtyReply = renderTestResult({ ok: true, latencyMs: 1, reply: payload });
  assert.equal(dirtyReply.includes('<img src=x'), false);
  assert.ok(dirtyReply.includes('&lt;img src=x'));
  const dirtyError = renderTestResult({ ok: false, error: payload });
  assert.equal(dirtyError.includes('<img src=x'), false);
  assert.ok(dirtyError.includes('&lt;img src=x'));
});

// @spec UI3-008
test('防御与安全：Key 不进浏览器存储 / 日志 / URL，文本全部转义，坏输入不抛异常', () => {
  // settings.js 是密钥真正流经的地方：那里一律不许碰浏览器存储 / 日志 / 地址栏
  for (const banned of [
    'localStorage',
    'sessionStorage',
    'document.cookie',
    'console.log',
    'console.error',
    'console.warn',
    'indexedDB',
    'history.pushState',
  ]) {
    assert.equal(settingsJs.includes(banned), false, `settings.js 不得出现 ${banned}`);
  }

  // app.js 允许为**纯 UI 偏好**（比如检查器是否收起）用 localStorage —— 那条规则的本意
  // 是「密钥不进存储」，不是「任何偏好都不许记」。所以这里禁的是另外那些没有正当用途的 API，
  // 而 localStorage 用一条精确规则管住：只许写固定前缀的 UI 键，且**不能带任何密钥类字段**。
  for (const banned of [
    'sessionStorage',
    'document.cookie',
    'console.log',
    'console.error',
    'console.warn',
    'indexedDB',
    'history.pushState',
  ]) {
    assert.equal(appJs.includes(banned), false, `app.js 不得出现 ${banned}`);
  }

  const storageWrites = appJs.match(/localStorage\.setItem\([^)]*\)/g) ?? [];
  for (const call of storageWrites) {
    assert.equal(
      /apiKey|hasApiKey|maskedKey|api_key|token|secret|password/i.test(call),
      false,
      `浏览器存储里绝不许写密钥类字段：${call}`,
    );
    // 键要么是带命名空间的字面量，要么是一个 *_KEY 常量 —— 不允许现拼字符串
    assert.match(call, /'agent-client:|_KEY\b/, `只允许写带命名空间的 UI 偏好键：${call}`);
  }

  // 而这些常量本身也必须带命名空间前缀（防止有人绕成 `const K = 'k'`）
  const keyConstants = appJs.match(/const\s+\w*KEY\w*\s*=\s*'[^']*'/g) ?? [];
  assert.ok(keyConstants.length > 0, 'app.js 里的存储键应当是具名常量');
  for (const declaration of keyConstants) {
    assert.match(declaration, /'agent-client:/, `${declaration} 必须带命名空间前缀`);
  }
  // Key 只经请求体送出：端点固定，绝不拼进 URL
  assert.ok(settingsJs.includes("'/api/settings'"));
  assert.ok(settingsJs.includes("'/api/settings/test'"));
  assert.equal(settingsJs.includes('?apiKey'), false);
  assert.equal(/[?&](api_?key|key)=/.test(settingsJs), false);
  assert.equal(appJs.includes('?apiKey'), false);

  // 明文 Key 永不回显
  const dirty = { apiKey: 'sk-plain-abcdef123456', apiKeyMasked: '', hasApiKey: false, model: 'm' };
  assert.equal(settingsToForm(dirty).apiKey, '');
  assert.equal(apiKeyPlaceholder(dirty).includes('sk-plain-abcdef123456'), false);
  assert.equal(JSON.stringify(normalizeSettings(dirty)).includes('sk-plain-abcdef123456'), false);
  assert.equal(validateForm(dirty).errors.apiKey, undefined, 'Key 不做本地校验：空就是「不修改」');

  // 任意坏输入都不能炸
  const weird: unknown[] = [
    null,
    undefined,
    42,
    'x',
    true,
    [],
    {},
    { protocol: 42, baseUrl: {}, model: [], apiKeyMasked: null, temperature: 'x', maxTokens: {}, timeoutMs: [] },
  ];
  assert.doesNotThrow(() => {
    for (const value of weird) {
      readSettings(value);
      normalizeSettings(value);
      settingsToForm(value);
      apiKeyPlaceholder(value);
      apiKeyHint(value);
      currentModelText(value);
      renderCurrentModel(value);
      effectiveModelFromState(value);
      labelFor(value);
      validateForm(value);
      formToPayload(value);
      normalizeTestResult(value);
      renderTestResult(value);
      normalizeSaveError(value);
      renderSaveError(value);
      renderLoadError(value);
      renderFormErrors(value);
      renderProtocolHint(value);
      renderPresetButtons(value);
      activePresetId(value);
      formFromPreset(value, value);
      readFormFields(value);
      fieldLabel(value);
    }
  });

  // 进 DOM 的文本（模型名 / 标签 / 回复 / 错误 / 字段错误）全部转义
  const payload = '" onmouseover="alert(1)';
  const model = renderCurrentModel({ model: payload, label: payload });
  assert.equal(model.includes('onmouseover="alert(1)"'), false);
  assert.ok(model.includes('&quot;'));
  const saveError = renderSaveError({ error: '<img src=x onerror=alert(1)>' });
  assert.equal(saveError.includes('<img src=x'), false);
  assert.ok(saveError.includes('&lt;img src=x'));
  const formErrors = renderFormErrors({ baseUrl: '<script>alert(1)</script>' });
  assert.equal(formErrors.includes('<script>'), false);
  assert.ok(formErrors.includes('Base URL'));
  assert.ok(renderLoadError({ message: '<b>炸</b>' }).includes('&lt;b&gt;'));
  assert.ok(
    normalizeSaveError({ errors: { baseUrl: '必填', model: '必填', temperature: '坏', maxTokens: '坏', timeoutMs: '坏' } }).includes(
      'Base URL：必填',
    ),
  );
  assert.ok(renderSaveError({}).includes('保存失败'));

  // 既有禁令对新代码继续成立：离线单页不引远程资源（端点地址只在 settings.js 的预设常量里）
  for (const [name, text] of [
    ['index.html', indexHtml],
    ['style.css', styleCss],
    ['app.js', appJs],
  ] as [string, string][]) {
    assert.equal(/https?:\/\//.test(text), false, `${name} 不得引用远程资源`);
  }
  assert.equal(settingsJs.includes('@import'), false);
  assert.equal(settingsJs.includes('<script'), false);
});

// @spec SET-017
test('列模型：不要求先填模型名，候选可点选、全部转义、失败也不阻断手动输入', () => {
  // 请求体：只要 baseUrl 合法就够了（「还没决定用哪个，先列出来」正是这个功能的用途）
  const ok = formToListPayload({ protocol: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', model: '', apiKey: '' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.ok === true ? ok.payload : {}, { protocol: 'openai', baseUrl: 'http://127.0.0.1:11434/v1' });

  const missing = formToListPayload({ protocol: 'openai', baseUrl: '', model: '' });
  assert.equal(missing.ok, false);

  // 稳定模型：坏条目丢弃，不抛异常
  assert.deepEqual(normalizeModelOptions({ models: [{ id: 'a' }, { nope: 1 }, { id: '' }, null] }), [{ id: 'a', label: '' }]);
  assert.deepEqual(normalizeModelOptions('不是对象'), []);

  // 候选渲染：点一下即切换 + 全转义（模型名来自端点，属不可信输入）
  const html = renderModelOptions(
    [
      { id: 'qwen3.5:9b', label: '9.7B · 6.6 GB' },
      { id: '<img src=x onerror=alert(1)>', label: '' },
    ],
    'qwen3.5:9b',
  );
  assert.match(html, /data-model-id="qwen3\.5:9b"/);
  assert.match(html, /is-current/, '当前模型要高亮');
  assert.match(html, /9\.7B · 6\.6 GB/);
  assert.equal(html.includes('<img src=x'), false, '模型名必须转义');
  assert.equal(renderModelOptions([], 'x'), '');

  // 状态文案：成功说数量、失败说原因并明确「仍可手动填写」
  assert.match(modelsStatusText({ ok: true, count: 10 }), /共 10 个模型/);
  assert.match(modelsStatusText({ ok: true, count: 0 }), /一个模型都没有/);
  const failed = modelsStatusText({ ok: false, error: '连不上端点' });
  assert.match(failed, /连不上端点/);
  assert.match(failed, /仍可手动填写/);

  // 接线：按钮 + 事件委托 + 走 /api/models + 点选后调用保存
  assert.match(indexHtml, /id="set-models-refresh"/);
  assert.match(indexHtml, /id="model-options"/);
  assert.match(indexHtml, /id="model-options-list"/);
  assert.match(indexHtml, /id="models-status"/);
  assert.match(settingsJs, /'\/api\/models'/);
  assert.match(settingsJs, /function refreshModels/);
  assert.match(settingsJs, /function switchToModel/);
  assert.match(settingsJs, /dataset\.state|showModelsStatus/);
});
