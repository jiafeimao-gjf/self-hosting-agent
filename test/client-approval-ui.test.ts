import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  APPROVAL_DECISIONS,
  APPROVAL_PATH,
  DECISION_LABELS,
  EMPTY_DETAIL_TEXT,
  UNKNOWN_ACTION_TEXT,
  UNKNOWN_AGENT_TEXT,
  UNKNOWN_RISK_TEXT,
  approvalErrorText,
  approvalFromState,
  approvalRequest,
  approvalView,
  createApprovalDialog,
  decisionLabel,
  isApprovalDecision,
  normalizeApproval,
  riskLabel,
  riskTone,
} from '../src/client/approval.js';

/**
 * SPEC-023 §三 / SHELL-011 客户端审批对话框。
 *
 * 纯逻辑（归一化 / 决策白名单 / 请求体 / 展示模型）直接 import 断言；
 * DOM 接线沿用既有 BROWSER-011 / UI-003 的做法：读源码结构断言 + 假 DOM + 假 request。
 * `approval.js` 在 Node 里 import 无副作用——它连 `document` 都不碰（DOM 由 app.js 注入）。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.join(here, '..', 'src', 'client');

function readClient(name: string): string {
  return fs.readFileSync(path.join(clientDir, name), 'utf8');
}

const indexHtml = readClient('index.html');
const styleCss = readClient('style.css');
const appJs = readClient('app.js');
const approvalJs = readClient('approval.js');

/** 契约样例（SPEC-023 §三）：detail 就是完整命令原文 */
const SAMPLE = {
  id: 'appr_1712345678',
  action: 'shell.run',
  risk: 'high',
  agent: 'lead',
  detail: 'ls -la && echo hi',
};

interface HttpResult {
  status: number;
  ok: boolean;
  data: unknown;
}

/** 假 request：记录每次调用的路径 / 方法 / 请求体，按 handler 返回固定响应 */
function fakeRequest(handler: (path: string, init?: { method?: string; body?: unknown }) => HttpResult | null) {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const request = async (p: string, init?: { method?: string; body?: unknown }) => {
    calls.push({ path: p, method: init?.method ?? 'GET', body: init?.body });
    return handler(p, init);
  };
  return { calls, request };
}

/** 最小假节点：只提供控制器实际用到的那几个成员 */
function fakeNode(): any {
  const node: any = {
    textContent: '',
    innerHTML: '',
    hidden: false,
    disabled: false,
    dataset: {},
    focusCount: 0,
    listeners: [] as Array<() => void>,
  };
  node.addEventListener = (type: string, fn: () => void) => {
    if (type === 'click') node.listeners.push(fn);
  };
  node.focus = () => {
    node.focusCount += 1;
  };
  return node;
}

/** 命令原文节点：记录写入次数，并让 `innerHTML` 直接抛错（SHELL-011 的硬底线） */
function makeDetailNode() {
  const state = { text: '', sets: 0, innerHTMLSets: 0 };
  const node: any = {
    hidden: false,
    focusCount: 0,
    get textContent() {
      return state.text;
    },
    set textContent(value: string) {
      state.text = value;
      state.sets += 1;
    },
    set innerHTML(_value: string) {
      state.innerHTMLSets += 1;
      throw new Error('完整命令原文绝不当 HTML 插入');
    },
  };
  node.focus = () => {
    node.focusCount += 1;
  };
  return { node, state };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** 造一个接了假 DOM 的对话框，返回全部可断言的把手 */
function buildDialog(
  handler: (path: string, init?: { method?: string; body?: unknown }) => HttpResult | null,
  options: { throwOnRequest?: boolean } = {},
) {
  const { calls, request } = fakeRequest(handler);
  const { node: detail, state: detailState } = makeDetailNode();
  const nodes: any = {
    root: fakeNode(),
    detail,
    risk: fakeNode(),
    agent: fakeNode(),
    action: fakeNode(),
    error: fakeNode(),
    deny: fakeNode(),
    allowOnce: fakeNode(),
    allowAlways: fakeNode(),
  };
  const asked: unknown[] = [];
  const decided: unknown[] = [];
  const errors: string[] = [];
  const dialog = createApprovalDialog({
    nodes,
    request: options.throwOnRequest
      ? async () => {
          throw new Error('net down');
        }
      : request,
    onAsked: (view) => asked.push(view),
    onDecided: (decision, pending) => decided.push([decision, pending]),
    onError: (message) => errors.push(message),
  });
  // 控制器创建时会先关一次窗（清空 DOM）：从「创建之后」开始计写入次数
  detailState.sets = 0;
  detailState.innerHTMLSets = 0;
  return { nodes, dialog, calls, asked, decided, errors, detailState };
}
// @spec SHELL-011
test('审批归一化：detail 是完整命令原文一字不改；没有 id 就是没有待批', () => {
  // 契约样例：五个字段都要留下来
  const approval = normalizeApproval(SAMPLE);
  assert.equal(approval?.id, 'appr_1712345678');
  assert.equal(approval?.action, 'shell.run');
  assert.equal(approval?.risk, 'high');
  assert.equal(approval?.agent, 'lead');
  assert.equal(approval?.detail, 'ls -la && echo hi');

  // 原文一字不改：前后空白 / 换行 / 引号 / 分号 / `$()` 都原样保留（不 trim、不截断）
  const verbatim = '  echo "  spaced  " \nrm -rf /tmp/x; $(whoami)\n';
  assert.equal(normalizeApproval({ id: 'a1', detail: verbatim })?.detail, verbatim);
  const long = `echo ${'x'.repeat(5000)}`;
  assert.equal(normalizeApproval({ id: 'a2', detail: long })?.detail, long, '长命令不得被截断');
  assert.equal(normalizeApproval({ id: 'a3', detail: 42 })?.detail, '', '非字符串 detail 退化为空串');

  // 发起者：契约字段是 agent，但内核 ApprovalRequest 用的是 agentId（src/kernel/approval.ts）——
  // 两个都认，「谁在请求」不能因为字段名不一致就消失
  assert.equal(normalizeApproval({ id: 'a4', agentId: 'lead' })?.agent, 'lead');
  assert.equal(normalizeApproval({ id: 'a5', agent: 'lead', agentId: 'worker' })?.agent, 'lead', '契约字段优先');
  assert.equal(normalizeApproval({ id: 'a6', agent: '', agentId: 'worker' })?.agent, 'worker');
  assert.equal(normalizeApproval({ id: 'a7' })?.agent, '');

  // 没有 id = 人类回复不了 → 一律当「没有待批」，不给一个点了没反应的弹窗
  for (const raw of [null, undefined, {}, { id: '' }, { id: '   ' }, { id: 42 }, 'x', 42, []]) {
    assert.equal(normalizeApproval(raw), null, `坏输入必须退化为 null：${JSON.stringify(raw)}`);
  }

  // /api/state.approval：字段缺席（老服务端）与明确 null（没有待批）必须分开
  assert.equal(approvalFromState({}), undefined, '没有这个字段 → 保持现状');
  assert.equal(approvalFromState(null), undefined);
  assert.equal(approvalFromState({ approval: null }), null, '明确 null → 关窗');
  assert.equal(approvalFromState({ approval: SAMPLE })?.id, SAMPLE.id);

  // 决策白名单：只有冻结契约里的三个，别的一律不认（大小写 / 别名都不行）
  assert.deepEqual([...APPROVAL_DECISIONS], ['allow_once', 'allow_always', 'deny']);
  for (const value of ['allow_once', 'allow_always', 'deny']) {
    assert.equal(isApprovalDecision(value), true);
    assert.notEqual(decisionLabel(value), '');
  }
  for (const value of ['allow', 'ALLOW_ONCE', 'Allow_Always', 'yes', '', ' deny', 'deny ', null, undefined, 42, true, {}]) {
    assert.equal(isApprovalDecision(value), false, `非法决策必须被拒：${String(value)}`);
    assert.equal(decisionLabel(value), '');
  }
  assert.deepEqual(DECISION_LABELS, { allow_once: '允许一次', allow_always: '一直允许', deny: '拒绝' });

  // POST 请求体：只带 id 与 decision；脏请求根本不出门
  assert.deepEqual(approvalRequest('appr_1', 'allow_once'), { id: 'appr_1', decision: 'allow_once' });
  assert.deepEqual(approvalRequest('  appr_1  ', 'deny'), { id: 'appr_1', decision: 'deny' });
  assert.deepEqual(approvalRequest('appr_1', 'allow_always'), { id: 'appr_1', decision: 'allow_always' });
  for (const [id, decision] of [
    ['', 'deny'],
    ['   ', 'allow_once'],
    [null, 'deny'],
    ['appr_1', 'allow'],
    ['appr_1', 'ALLOW_ONCE'],
    ['appr_1', null],
    ['appr_1', undefined],
    ['appr_1', 1],
  ] as Array<[unknown, unknown]>) {
    assert.equal(approvalRequest(id, decision), null, `非法组合不得构造请求：${String(id)} / ${String(decision)}`);
  }

  // 服务端拒绝 / 网络失败 → 可读中文
  assert.equal(approvalErrorText({ ok: false, error: 'UNKNOWN_APPROVAL' }, 400), 'UNKNOWN_APPROVAL');
  assert.equal(approvalErrorText({ ok: false, message: '已回复过' }, 400), '已回复过');
  assert.equal(approvalErrorText(null, 500), 'HTTP 500');
  assert.equal(approvalErrorText(null, 0), '服务端没有返回可读信息');
});

// @spec SHELL-011
test('展示模型：显示风险等级与发起者，命令原文逐字保留（含注入串）', () => {
  const view = approvalView(SAMPLE);
  assert.equal(view.visible, true);
  assert.equal(view.id, 'appr_1712345678');
  assert.equal(view.riskLabel, '高风险');
  assert.equal(view.riskTone, 'danger');
  assert.equal(view.agentLabel, 'lead', '必须显示发起者');
  assert.equal(view.actionLabel, 'shell.run');
  assert.equal(view.detail, 'ls -la && echo hi');
  assert.equal(view.detailIsPlaceholder, false);

  // 风险等级 → 人话 + 配色；认不出的等级原样显示且**不得**画成「安全」的低风险色
  assert.equal(riskLabel('high'), '高风险');
  assert.equal(riskLabel('medium'), '中风险');
  assert.equal(riskLabel('low'), '低风险');
  assert.equal(riskLabel('HIGH'), '高风险', '大小写不敏感');
  assert.equal(riskLabel('critical'), '严重风险', '内核声明了 critical，不能显示成未知');
  assert.equal(riskTone('critical'), 'danger');
  assert.equal(riskLabel('weird'), 'weird');
  assert.equal(riskLabel(''), UNKNOWN_RISK_TEXT);
  assert.equal(riskTone('high'), 'danger');
  assert.equal(riskTone('medium'), 'warning');
  assert.equal(riskTone('low'), 'info');
  assert.equal(riskTone(''), 'default');

  // 缺字段只占位、不冒充；原文为空时给明确占位（人能看出「没看到命令」）
  const bare = approvalView({ id: 'a1' });
  assert.equal(bare.agentLabel, UNKNOWN_AGENT_TEXT);
  assert.equal(bare.actionLabel, UNKNOWN_ACTION_TEXT);
  assert.equal(bare.riskLabel, UNKNOWN_RISK_TEXT);
  assert.equal(bare.detail, EMPTY_DETAIL_TEXT);
  assert.equal(bare.detailIsPlaceholder, true);
  assert.equal(approvalView(null).visible, false);
  assert.equal(approvalView(null).detail, '');
  assert.equal(approvalView('x').visible, false);

  // 注入串：textContent 路线下必须**原样**保留（不转义、不改写），才能逐字核对
  const payload = '<img src=x onerror=alert(1)> && rm -rf ~';
  assert.equal(approvalView({ id: 'a2', detail: payload }).detail, payload);

  // 坏输入绝不抛异常
  assert.doesNotThrow(() => {
    for (const raw of [null, undefined, 42, 'x', true, [], { id: NaN }, { id: [], detail: {} }]) {
      normalizeApproval(raw);
      approvalView(raw);
      approvalFromState({ approval: raw });
    }
  });
});

// @spec SHELL-011
test('对话框：弹出后显示完整命令（只走 textContent），初始焦点在「拒绝」', () => {
  const { nodes, dialog, calls, asked, detailState } = buildDialog(() => ({ status: 200, ok: true, data: { ok: true } }));

  // 创建本身绝不决定任何事：没有请求、没有待批、窗口隐藏
  assert.equal(calls.length, 0, '创建时不得发任何请求');
  assert.equal(dialog.isOpen(), false);
  assert.equal(nodes.root.hidden, true);

  assert.equal(dialog.apply(SAMPLE), true);
  assert.equal(nodes.root.hidden, false, '有待批时必须显示');
  assert.equal(dialog.isOpen(), true);
  assert.deepEqual(dialog.getPending(), {
    id: 'appr_1712345678',
    action: 'shell.run',
    risk: 'high',
    agent: 'lead',
    detail: 'ls -la && echo hi',
  });

  // 完整命令原文只进 textContent；innerHTML 的 setter 会抛错
  assert.equal(detailState.text, 'ls -la && echo hi');
  assert.equal(detailState.sets, 1);
  assert.equal(detailState.innerHTMLSets, 0, '命令原文绝不当 HTML 插入');

  // 风险 / 发起者 / 动作都显示出来
  assert.equal(nodes.risk.textContent, '高风险');
  assert.equal(nodes.risk.dataset.tone, 'danger');
  assert.equal(nodes.agent.textContent, 'lead');
  assert.equal(nodes.action.textContent, 'shell.run');
  assert.equal(nodes.error.hidden, true);
  assert.equal(nodes.error.textContent, '');

  // 安全默认：焦点在「拒绝」上；同意类按钮绝不被自动聚焦
  assert.equal(nodes.deny.focusCount, 1, '初始焦点必须在「拒绝」');
  assert.equal(nodes.allowOnce.focusCount, 0);
  assert.equal(nodes.allowAlways.focusCount, 0);

  // 上报给 app.js 的信息里有发起者（进时间线用）
  assert.equal((asked[0] as { agent: string }).agent, 'lead');
  assert.equal((asked[0] as { detail: string }).detail, 'ls -la && echo hi');

  // 三个按钮的点击接线：一个不落，且每个只绑一次
  assert.equal(nodes.deny.listeners.length, 1);
  assert.equal(nodes.allowOnce.listeners.length, 1);
  assert.equal(nodes.allowAlways.listeners.length, 1);
});

// @spec SHELL-011
test('幂等与状态同步：同一 id 不叠窗；没有待批就隐藏；老服务端缺字段不清掉待批', () => {
  const { nodes, dialog, detailState } = buildDialog(() => ({ status: 200, ok: true, data: { ok: true } }));

  dialog.apply(SAMPLE);
  assert.equal(dialog.apply({ ...SAMPLE }), false, '同一 id 重复到达：不再重画');
  assert.equal(detailState.sets, 1, '重复事件不得重复写命令原文');
  assert.equal(nodes.deny.focusCount, 1, '重复事件不得抢走人类的焦点');
  assert.equal(dialog.getPending()?.id, SAMPLE.id);

  // 旧服务端（快照里没有 approval 字段）：保持现状，不误清
  assert.equal(dialog.applyState({ document: { version: 1 } }), false);
  assert.equal(dialog.isOpen(), true, '缺字段不得让待批消失');
  assert.equal(detailState.text, 'ls -la && echo hi');

  // 明确 null：没有待批 → 关窗，并且命令原文不留在 DOM 里
  dialog.applyState({ approval: null });
  assert.equal(dialog.isOpen(), false);
  assert.equal(nodes.root.hidden, true, '没有待批时对话框必须隐藏');
  assert.equal(detailState.text, '', '关窗时清掉命令原文');

  // 快照里有待批（刷新页面后仍能看到并回复）
  const refreshed = { approval: { id: 'appr_9', action: 'shell.run', risk: 'low', agent: 'worker', detail: 'pwd' } };
  assert.equal(dialog.applyState(refreshed), true);
  assert.equal(dialog.isOpen(), true);
  assert.equal(detailState.text, 'pwd');
  assert.equal(nodes.risk.textContent, '低风险');

  // 新 id 到达：刷新内容并重新聚焦「拒绝」；apply(null) 也能直接关窗
  assert.equal(dialog.apply({ ...SAMPLE, id: 'appr_10' }), true);
  assert.equal(detailState.text, 'ls -la && echo hi');
  assert.equal(nodes.deny.focusCount, 3);
  assert.equal(dialog.apply(null), false);
  assert.equal(nodes.root.hidden, true);
  assert.equal(dialog.isOpen(), false);
});

// @spec SHELL-011
test('三个按钮：点击才发 POST /api/approval，请求体是 {id, decision}，成功后关窗', async () => {
  const { nodes, dialog, calls, decided } = buildDialog(() => ({ status: 200, ok: true, data: { ok: true } }));

  // 没有待批时 decide 什么都不做（绝不「顺手同意」）
  assert.equal(await dialog.decide('allow_once'), false);
  assert.equal(calls.length, 0);
  assert.equal(decided.length, 0);

  // 「允许一次」：点击按钮 → 一次 POST，成功后关窗
  dialog.apply(SAMPLE);
  nodes.allowOnce.listeners[0]();
  await tick();
  assert.deepEqual(calls[0], { path: APPROVAL_PATH, method: 'POST', body: { id: SAMPLE.id, decision: 'allow_once' } });
  assert.equal(dialog.isOpen(), false);
  assert.equal(nodes.root.hidden, true);
  assert.equal((decided[0] as unknown[])[0], 'allow_once');
  assert.equal(((decided[0] as unknown[])[1] as { id: string }).id, SAMPLE.id);

  // 「一直允许」 → allow_always
  dialog.apply({ ...SAMPLE, id: 'appr_2' });
  assert.equal(await dialog.decide('allow_always'), true);
  assert.deepEqual(calls[1], { path: APPROVAL_PATH, method: 'POST', body: { id: 'appr_2', decision: 'allow_always' } });
  assert.equal(dialog.isOpen(), false);

  // 「拒绝」 → deny
  dialog.apply({ ...SAMPLE, id: 'appr_3' });
  nodes.deny.listeners[0]();
  await tick();
  assert.deepEqual(calls[2], { path: APPROVAL_PATH, method: 'POST', body: { id: 'appr_3', decision: 'deny' } });
  assert.equal(dialog.isOpen(), false);
  assert.equal(calls.length, 3, '每一次点击只发一次请求');

  // 非法 decision：界面按钮之外的路（例如手改 data-decision）不许造出脏请求
  dialog.apply({ ...SAMPLE, id: 'appr_4' });
  assert.equal(await dialog.decide('allow'), false);
  assert.equal(calls.length, 3, '非法决策不得发请求');
  assert.match(nodes.error.textContent, /未知的决定/);
  assert.equal(dialog.isOpen(), true, '非法决策后对话框仍然开着');
});

// @spec SHELL-011
test('回复失败（400 / 网络）显示原因并保持对话框打开，人可以原样重试', async () => {
  let mode: 'fail' | 'ok' = 'fail';
  const { nodes, dialog, calls, errors } = buildDialog(() =>
    mode === 'fail'
      ? { status: 400, ok: false, data: { ok: false, error: 'UNKNOWN_APPROVAL: 未知的审批 id' } }
      : { status: 200, ok: true, data: { ok: true } },
  );

  dialog.apply(SAMPLE);
  assert.equal(await dialog.decide('allow_once'), false);
  assert.equal(dialog.isOpen(), true, '失败必须保持打开');
  assert.equal(nodes.root.hidden, false);
  assert.equal(nodes.error.hidden, false, '失败原因必须可见');
  assert.match(nodes.error.textContent, /UNKNOWN_APPROVAL/);
  assert.equal(dialog.getPending()?.id, SAMPLE.id, '待批条目不得被失败清掉');
  assert.equal(nodes.deny.disabled, false, '按钮要恢复可用，人能重试');
  assert.equal(nodes.allowOnce.disabled, false);
  assert.equal(errors.length, 1);
  assert.match(errors[0] as string, /被拒绝/);

  // 原地重试：同一条待批，第二次成功 → 这时才关窗
  mode = 'ok';
  assert.equal(await dialog.decide('allow_once'), true);
  assert.equal(calls.length, 2);
  assert.equal(dialog.isOpen(), false);
  assert.equal(nodes.root.hidden, true);

  // 网络层失败（request 返回 null）
  const net = buildDialog(() => null);
  net.dialog.apply(SAMPLE);
  assert.equal(await net.dialog.decide('deny'), false);
  assert.equal(net.dialog.isOpen(), true);
  assert.match(net.nodes.error.textContent, /没有响应/);
  assert.match(net.errors[0] as string, /没有响应/);

  // 网络层抛异常：同样转成可读原因，不冒泡
  const boom = buildDialog(() => null, { throwOnRequest: true });
  boom.dialog.apply(SAMPLE);
  assert.equal(await boom.dialog.decide('deny'), false);
  assert.equal(boom.dialog.isOpen(), true);
  assert.match(boom.nodes.error.textContent, /没有响应/);

  // 连点：请求在飞时第二次点击被忽略，不会发两条回复
  let release: (value: HttpResult) => void = () => {};
  const gate = new Promise<HttpResult>((resolve) => {
    release = resolve;
  });
  const slow = createApprovalDialog({
    nodes: {
      root: fakeNode(),
      detail: makeDetailNode().node,
      deny: fakeNode(),
      allowOnce: fakeNode(),
      allowAlways: fakeNode(),
    },
    request: async () => gate,
  });
  slow.apply(SAMPLE);
  const first = slow.decide('deny');
  assert.equal(await slow.decide('allow_once'), false, '在飞期间的第二次点击必须被忽略');
  release({ status: 200, ok: true, data: { ok: true } });
  assert.equal(await first, true, '第一次回复照常成功');
  assert.equal(slow.isOpen(), false);
});

// @spec SHELL-011
test('必须人工点击才能决定：没有定时器 / 键盘快捷键 / 默认允许，且 DOM 不为同意留后门', () => {
  // approval.js：不许有任何自动决定路径
  assert.equal(/setTimeout|setInterval/.test(approvalJs), false, '不许有定时器（更不能超时自动同意）');
  assert.equal(/addEventListener\(\s*['"`]key/.test(approvalJs), false, '不许把按键当同意快捷键');
  assert.equal(/addEventListener\(\s*['"`]pointer/.test(approvalJs), false);
  assert.equal(/\.innerHTML\s*=/.test(approvalJs), false, '命令原文绝不当 HTML 插入');
  assert.ok(approvalJs.includes('buttons.deny'), '默认焦点要落在「拒绝」上');
  assert.ok(approvalJs.includes('detailNode.textContent'), '命令原文只走 textContent');

  // index.html：对话框不是 <form>，三个按钮都是 type="button"
  const section = /<section\s+id="approval"[\s\S]*?<\/section>/.exec(indexHtml)?.[0] ?? '';
  assert.ok(section.length > 0, 'index.html 必须有对话框');
  assert.equal(section.includes('<form'), false, '不是 <form>：没有「回车提交」这条路');
  assert.equal(section.includes('autofocus'), false, '不许靠 autofocus 把焦点放到同意按钮上');
  assert.equal(/type="submit"/.test(section), false);
  for (const id of ['approval-deny', 'approval-once', 'approval-always']) {
    assert.match(section, new RegExp(`id="${id}"[^>]*type="button"`), `${id} 必须是 type="button"`);
  }
  // 按钮文案与 decision 一一对应（三个按钮：允许一次 / 一直允许 / 拒绝）
  assert.match(section, /id="approval-once"[^>]*data-decision="allow_once"[^>]*>允许一次</);
  assert.match(section, /id="approval-always"[^>]*data-decision="allow_always"[^>]*>一直允许</);
  assert.match(section, /id="approval-deny"[^>]*data-decision="deny"[^>]*>拒绝</);
  assert.match(section, /id="approval"[^>]*hidden/, '没有待批时默认隐藏');

  // 只有一个对话框节点：同 id 重复事件不可能叠出两个
  assert.equal((indexHtml.match(/id="approval"/g) ?? []).length, 1);

  // 控制器侧：焦点只在「拒绝」，同意类按钮不会被自动触发；没有人点按钮 → 零请求
  const { nodes, dialog, calls } = buildDialog(() => ({ status: 200, ok: true, data: { ok: true } }));
  dialog.apply(SAMPLE);
  assert.equal(nodes.deny.focusCount >= 1, true);
  assert.equal(nodes.allowOnce.focusCount, 0);
  assert.equal(nodes.allowAlways.focusCount, 0);
  assert.equal(calls.length, 0, '收到待批本身绝不自动回复');
});

// @spec SHELL-011
test('DOM / 样式 / app.js 接线：完整命令可换行看全，回复带当前对话，既有 id 不动', () => {
  // 对话框结构：命令原文节点、风险 / 发起者 / 动作、错误行、三个按钮
  for (const id of [
    'approval',
    'approval-title',
    'approval-risk',
    'approval-agent',
    'approval-action',
    'approval-detail',
    'approval-error',
    'approval-deny',
    'approval-once',
    'approval-always',
  ]) {
    assert.ok(indexHtml.includes(`id="${id}"`), `index.html 缺少 #${id}`);
  }
  assert.match(indexHtml, /role="dialog"/);
  assert.match(indexHtml, /aria-modal="true"/);
  assert.match(indexHtml, /id="approval-error"[^>]*role="alert"/);
  assert.equal(indexHtml.includes(EMPTY_DETAIL_TEXT), false, '占位文案由 approval.js 提供，不在 HTML 里写死');

  // 样式：等宽 + 保留换行 + 长行折行 + 可滚动；**不截断、不省略**
  assert.ok(styleCss.includes('.approval {'));
  assert.ok(styleCss.includes('.approval[hidden]'), 'display:flex 会盖掉 [hidden]，必须显式写');
  assert.ok(styleCss.includes('.approval-detail {'));
  assert.ok(styleCss.includes('.approval-error[hidden]'));
  const detailRule = /\.approval-detail\s*\{[^}]*\}/.exec(styleCss)?.[0] ?? '';
  assert.ok(detailRule.length > 0);
  assert.match(detailRule, /white-space:\s*pre-wrap/, '命令原文必须保留换行');
  assert.match(detailRule, /overflow:\s*auto/, '太长就滚动，而不是截断');
  assert.match(detailRule, /max-height:/);
  assert.equal(/text-overflow/.test(detailRule), false, '不许省略关键部分');
  assert.equal(/line-clamp/.test(detailRule), false);
  assert.ok(styleCss.includes('.approval-risk[data-tone="danger"]'), '风险等级要有配色区分');
  assert.ok(styleCss.includes('.approval-btn:disabled'), '请求在飞时按钮禁用，防连点');
  assert.equal(/https?:\/\//.test(styleCss), false, '离线单页不引远程资源');
  assert.equal(/@import/.test(styleCss), false);

  // app.js 接线：订阅 SSE approval、应用 /api/state.approval、控制器实例化
  assert.ok(appJs.includes('createApprovalDialog('), 'app.js 只负责实例化对话框');
  assert.ok(appJs.includes("source.addEventListener('approval'"));
  assert.ok(appJs.includes('approvalPanel.apply(parseData(event.data))'));
  assert.ok(appJs.includes('approvalPanel.applyState(raw)'), '刷新页面后 /api/state.approval 也要应用');
  assert.ok(appJs.includes('approvalPanel.close()'), '切对话时清掉上一个对话的待批');
  // 回复必须带当前对话（宿主按对话隔离审批）
  assert.ok(appJs.includes('request: conversationRequest'));
  assert.ok(appJs.includes('function conversationRequest('));
  assert.ok(appJs.includes('requestJson(scoped(path)'));
  assert.equal(appJs.includes('location.reload'), false);

  // 既有 DOM id 一个都不能动（别的测试在断言它们）
  for (const id of [
    'messages',
    'surface',
    'browser',
    'input',
    'settings',
    'composer',
    'agents',
    'tasks',
    'timeline',
    'panel-files',
    'conversation-select',
  ]) {
    assert.ok(indexHtml.includes(`id="${id}"`), `index.html 缺少 #${id}`);
  }
});
