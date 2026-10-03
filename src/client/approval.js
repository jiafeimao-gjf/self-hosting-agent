/**
 * SPEC-023 §三 客户端审批对话框：把「Agent 想跑一条 shell 命令」摆到人类面前，
 * 由人**亲手点击**决定。
 *
 * 安全立场（SHELL-011）：不给「安全的 shell」，给「被看着的 shell」。
 * 所以这个模块的三条底线是**结构性**的，不是靠文案提醒：
 *
 * 1. **必须人工点击**：没有任何定时器、没有键盘快捷键、没有「默认允许」；
 *    对话框不是 `<form>`，三个按钮全是 `type="button"`，初始焦点刻意放在
 *    **「拒绝」**上（安全默认）——按回车只会拒绝，绝不会同意。
 * 2. **完整命令原文只走 `textContent`**：`detail` 是人做判断的唯一依据，
 *    一字不改地展示（不 trim、不截断、不省略），绝不 `innerHTML`。
 * 3. **失败不关窗**：回复被拒（400）/ 网络失败时，原因显示在对话框里且
 *    对话框保持打开，人可以原样重试；只有回复成功才关闭。
 *
 * 分工与 `browser.js` / `settings.js` / `conversations.js` 完全一致：
 *
 * - 上半部分是**纯函数**：契约常量、归一化、决策白名单校验、POST 请求体、
 *   展示模型。不碰 DOM、不碰网络，`node --test` 里 import 进来没有副作用。
 * - 下半部分 `createApprovalDialog()` 只做 DOM 接线与一次 POST，由 `app.js`
 *   在浏览器里实例化（依赖注入 request，Node 里也能用假 DOM 测）。
 */

// ---------------------------------------------------------------------------
// SPEC-023 §三 冻结契约里的固定值
// ---------------------------------------------------------------------------

/** 人类回复审批的端点（契约：`POST /api/approval?conversation=<id>`） */
export const APPROVAL_PATH = '/api/approval';

/** 允许的三个决定，**一个都不能多**（`decision` 只认这三个） */
export const APPROVAL_DECISIONS = ['allow_once', 'allow_always', 'deny'];

/** 决定 → 按钮文案（SHELL-011 明令三个按钮就是这个语义） */
export const DECISION_LABELS = {
  allow_once: '允许一次',
  allow_always: '一直允许',
  deny: '拒绝',
};

/** `detail` 缺失时的占位：宁可让人看出「没有命令原文」，也不装作看过 */
export const EMPTY_DETAIL_TEXT = '（服务端没有给出命令原文）';

/** 发起者缺失时的占位 */
export const UNKNOWN_AGENT_TEXT = '未知发起者';

/** 动作名缺失时的占位 */
export const UNKNOWN_ACTION_TEXT = '未知动作';

/** 风险等级缺失 / 认不出时的占位 */
export const UNKNOWN_RISK_TEXT = '未知风险';

/** 风险等级 → 人话 */
const RISK_LABELS = { high: '高风险', medium: '中风险', low: '低风险', critical: '严重风险' };

/** 风险等级 → 配色语义（CSS 用 `[data-tone=…]`） */
const RISK_TONES = { high: 'danger', medium: 'warning', low: 'info', critical: 'danger' };

// ---------------------------------------------------------------------------
// 基础取值：坏输入一律退化成安全值，绝不抛异常
// ---------------------------------------------------------------------------

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value) {
  return typeof value === 'string' ? value : '';
}

// ---------------------------------------------------------------------------
// 归一化：SSE `approval` 事件与 `/api/state.approval` 共用同一套
// ---------------------------------------------------------------------------

/**
 * SSE `approval` / `/api/state.approval` 的 data → 稳定模型；没有待批时返回 `null`。
 *
 * 判据是 `id`：没有 id 的条目人类**回复不了**（POST 认 id），所以一律当「没有待批」，
 * 宁可不显示，也不给一个点了没反应的对话框。
 *
 * `detail` 是**完整命令原文**：原样保留（不 trim、不截断、不改写），
 * 因为它是人类判断「这条命令能不能跑」的唯一依据。
 */
export function normalizeApproval(raw) {
  if (raw === null || raw === undefined) return null;
  const item = isRecord(raw) ? raw : {};
  const id = str(item.id).trim();
  if (id.length === 0) return null;
  // 发起者：契约写的是 `agent`，但内核的 ApprovalRequest 叫 `agentId`
  // （见 src/kernel/approval.ts）。两个都认——显示「谁在请求」比争字段名重要。
  const agent = str(item.agent).trim() || str(item.agentId).trim();
  return {
    id,
    action: str(item.action).trim(),
    risk: str(item.risk).trim(),
    agent,
    detail: str(item.detail),
  };
}

/**
 * `/api/state` → 待批条目。
 *
 * 三种返回值刻意区分开：
 * - `undefined`：快照里**根本没有** `approval` 字段（老服务端），调用方保持现状，
 *   不误清掉 SSE 刚送来的那条；
 * - `null`：字段存在且明确是「没有待批」→ 关窗；
 * - 模型：有待批 → 显示。
 */
export function approvalFromState(raw) {
  const state = isRecord(raw) ? raw : {};
  if (!Object.prototype.hasOwnProperty.call(state, 'approval')) return undefined;
  return normalizeApproval(state.approval);
}

// ---------------------------------------------------------------------------
// 决策合法性：把「只能点这三个按钮」变成可测的规则
// ---------------------------------------------------------------------------

/** `decision` 是否在冻结契约的白名单里 */
export function isApprovalDecision(raw) {
  return typeof raw === 'string' && APPROVAL_DECISIONS.includes(raw);
}

/** 按钮文案；非法 decision 返回空串（调用方据此判断「这个按钮不该存在」） */
export function decisionLabel(raw) {
  return isApprovalDecision(raw) ? DECISION_LABELS[raw] : '';
}

/**
 * 稳定模型 → `POST /api/approval` 的请求体。
 *
 * **任何一条校验不过都返回 `null`**（调用方据此不发请求）：
 * 没有 id、decision 不在白名单（`allow` / `yes` / 大写 / 数字一律拒绝）。
 * 这条是「客户端先挡一道」：服务端仍然会再校验，但脏请求根本不出去。
 */
export function approvalRequest(id, decision) {
  const value = str(id).trim();
  if (value.length === 0) return null;
  if (!isApprovalDecision(decision)) return null;
  return { id: value, decision };
}

// ---------------------------------------------------------------------------
// 展示模型（纯字符串，供控制器用 textContent 写入）
// ---------------------------------------------------------------------------

/** 风险等级 → 人话；认不出的等级原样显示，而不是假装是低风险 */
export function riskLabel(raw) {
  const value = str(raw).trim().toLowerCase();
  if (value.length === 0) return UNKNOWN_RISK_TEXT;
  return RISK_LABELS[value] ?? value;
}

/** 风险等级 → 配色语义；认不出时用中性色（绝不把未知风险画成「安全」） */
export function riskTone(raw) {
  const value = str(raw).trim().toLowerCase();
  return RISK_TONES[value] ?? 'default';
}

/**
 * 对话框的展示模型。
 *
 * `detail` 这里可能被换成占位文案（原文为空时），其余情况**逐字**等于服务端给的原文；
 * `detailIsPlaceholder` 让调用方（与测试）能区分「原文为空」和「原文就是这行字」。
 */
export function approvalView(raw) {
  const approval = normalizeApproval(raw);
  if (approval === null) {
    return {
      visible: false,
      id: '',
      action: '',
      risk: '',
      agent: '',
      riskLabel: UNKNOWN_RISK_TEXT,
      riskTone: 'default',
      agentLabel: UNKNOWN_AGENT_TEXT,
      actionLabel: UNKNOWN_ACTION_TEXT,
      detail: '',
      detailIsPlaceholder: false,
    };
  }
  const detailIsPlaceholder = approval.detail.length === 0;
  return {
    visible: true,
    id: approval.id,
    action: approval.action,
    risk: approval.risk,
    agent: approval.agent,
    riskLabel: riskLabel(approval.risk),
    riskTone: riskTone(approval.risk),
    agentLabel: approval.agent.length > 0 ? approval.agent : UNKNOWN_AGENT_TEXT,
    actionLabel: approval.action.length > 0 ? approval.action : UNKNOWN_ACTION_TEXT,
    detail: detailIsPlaceholder ? EMPTY_DETAIL_TEXT : approval.detail,
    detailIsPlaceholder,
  };
}

/** 服务端拒绝 / 网络失败 → 可读中文（与 browser.js 的口径一致） */
export function approvalErrorText(raw, status) {
  const item = isRecord(raw) ? raw : {};
  const direct = str(item.error) || str(item.message) || str(item.reason);
  if (direct.length > 0) return direct;
  if (typeof status === 'number' && Number.isFinite(status) && status > 0) return `HTTP ${status}`;
  return '服务端没有返回可读信息';
}

// ---------------------------------------------------------------------------
// 审批对话框控制器（只在浏览器里实例化，由 app.js 注入 DOM 与 request）
// ---------------------------------------------------------------------------

/**
 * 把一个待批条目接到对话框上。
 *
 * 所有节点由调用方传入，本模块**不直接碰 `document`**：这样 Node 里 import
 * 无副作用，控制器也能用假 DOM + 假 request 直接测（含失败重试、幂等）。
 *
 * 控制器**没有任何自动决定路径**：
 * - 创建时不发请求、不决定任何东西；
 * - 不注册 `keydown` / 定时器；
 * - `decide()` 只在人类点击按钮（或测试显式调用）时才会走到 POST。
 */
export function createApprovalDialog(options) {
  const config = isRecord(options) ? options : {};
  const nodes = isRecord(config.nodes) ? config.nodes : {};
  const request = typeof config.request === 'function' ? config.request : null;
  const onAsked = typeof config.onAsked === 'function' ? config.onAsked : null;
  const onDecided = typeof config.onDecided === 'function' ? config.onDecided : null;
  const onError = typeof config.onError === 'function' ? config.onError : null;

  const root = nodes.root ?? null;
  const detailNode = nodes.detail ?? null;
  const riskNode = nodes.risk ?? null;
  const agentNode = nodes.agent ?? null;
  const actionNode = nodes.action ?? null;
  const errorNode = nodes.error ?? null;
  /** 三个按钮按 decision 索引；「拒绝」必须在最前，见下方 focusDeny() */
  const buttons = {
    deny: nodes.deny ?? null,
    allow_once: nodes.allowOnce ?? null,
    allow_always: nodes.allowAlways ?? null,
  };

  /** 当前待批条目；null = 没有待批（对话框隐藏） */
  let pending = null;
  /** 回复请求在飞：期间的点击一律忽略，避免重复 POST */
  let busy = false;

  function setVisible(visible) {
    if (root !== null && root !== undefined) root.hidden = !visible;
  }

  function setError(text) {
    const message = str(text);
    if (errorNode === null || errorNode === undefined) return;
    errorNode.textContent = message;
    errorNode.hidden = message.length === 0;
  }

  function setBusy(value) {
    busy = value;
    for (const node of Object.values(buttons)) {
      if (node !== null && node !== undefined) node.disabled = value;
    }
  }

  /**
   * 安全默认：焦点放在**「拒绝」**上。
   * 这样「弹窗一出来就按回车」的结果是拒绝，而不是同意。
   */
  function focusDeny() {
    const node = buttons.deny;
    if (node !== null && node !== undefined && typeof node.focus === 'function') node.focus();
  }

  /** 关窗并清干净：命令原文与错误文案都不留在 DOM 里 */
  function close() {
    pending = null;
    setError('');
    if (detailNode !== null && detailNode !== undefined) detailNode.textContent = '';
    if (riskNode !== null && riskNode !== undefined) {
      riskNode.textContent = '';
      if (riskNode.dataset !== undefined && riskNode.dataset !== null) riskNode.dataset.tone = '';
    }
    if (agentNode !== null && agentNode !== undefined) agentNode.textContent = '';
    if (actionNode !== null && actionNode !== undefined) actionNode.textContent = '';
    setVisible(false);
  }

  /**
   * 应用一个待批条目（SSE `approval` 事件 / `/api/state.approval`）。
   *
   * **幂等**：同一个 id 重复到达时不再重画，也不重置人类已经看到的错误提示与焦点
   * （网络抖动 / 刷新后重复推送都不应该叠出第二个对话框）。
   */
  function apply(raw) {
    const view = approvalView(raw);
    if (!view.visible) {
      close();
      return false;
    }
    if (pending !== null && pending.id === view.id) return false;

    pending = {
      id: view.id,
      action: view.action,
      risk: view.risk,
      agent: view.agent,
      detail: view.detail,
    };
    // 完整命令原文的唯一入口：textContent。绝不 innerHTML（SHELL-011）。
    if (detailNode !== null && detailNode !== undefined) detailNode.textContent = view.detail;
    if (riskNode !== null && riskNode !== undefined) {
      riskNode.textContent = view.riskLabel;
      if (riskNode.dataset !== undefined && riskNode.dataset !== null) riskNode.dataset.tone = view.riskTone;
    }
    if (agentNode !== null && agentNode !== undefined) agentNode.textContent = view.agentLabel;
    if (actionNode !== null && actionNode !== undefined) actionNode.textContent = view.actionLabel;

    setError('');
    setBusy(false);
    setVisible(true);
    focusDeny();
    if (onAsked !== null) onAsked(view);
    return true;
  }

  /** `/api/state`：没有 `approval` 字段就保持现状（老服务端不该让待批对话框消失） */
  function applyState(raw) {
    const approval = approvalFromState(raw);
    if (approval === undefined) return false;
    return apply(approval);
  }

  /**
   * 人类的决定。只有这条路会发出 `POST /api/approval`。
   *
   * 返回 `true` = 服务端确认并已关窗；`false` = 没发（没有待批 / 决策非法 / 在飞）
   * 或发送失败（**对话框保持打开**，原因显示在窗口里，人可以重试）。
   */
  async function decide(decision) {
    if (busy) return false;
    const current = pending;
    if (current === null) return false; // 没有待批：什么都不做，绝不「顺手同意」

    const body = approvalRequest(current.id, decision);
    if (body === null) {
      setError(`未知的决定：${String(decision)}（只允许 ${APPROVAL_DECISIONS.join(' / ')}）`);
      return false;
    }

    setBusy(true);
    let response = null;
    try {
      response = request === null ? null : await request(APPROVAL_PATH, { method: 'POST', body });
    } catch {
      response = null; // 网络层失败：下面统一转成「保持打开 + 可见原因」
    }
    setBusy(false);

    const stillCurrent = pending !== null && pending.id === current.id;

    if (response === null) {
      if (stillCurrent) setError('回复失败：服务端没有响应，请重试');
      if (stillCurrent && onError !== null) onError('审批回复失败：服务端没有响应');
      return false;
    }
    if (response.ok !== true || (isRecord(response.data) && response.data.ok === false)) {
      const reason = approvalErrorText(response.data, response.status);
      if (stillCurrent) setError(`回复失败：${reason}`);
      if (stillCurrent && onError !== null) onError(`审批回复被拒绝：${reason}`);
      return false;
    }

    // 成功：只有 pending 还是这一条时才关窗（免得把刚到达的新待批关掉）
    if (stillCurrent) close();
    if (onDecided !== null) onDecided(decision, current);
    return true;
  }

  /** 按钮 → 决定的接线；**只有 click**，没有任何键盘快捷方式 */
  function bind(node, decision) {
    if (node === null || node === undefined) return;
    if (typeof node.addEventListener !== 'function') return;
    node.addEventListener('click', () => {
      void decide(decision);
    });
  }
  bind(buttons.deny, 'deny');
  bind(buttons.allow_once, 'allow_once');
  bind(buttons.allow_always, 'allow_always');

  // 初始就是「没有待批」：隐藏 + 清空。创建本身绝不决定任何事。
  close();

  return {
    apply,
    applyState,
    decide,
    close,
    isOpen: () => pending !== null,
    isBusy: () => busy,
    getPending: () => (pending === null ? null : { ...pending }),
  };
}
