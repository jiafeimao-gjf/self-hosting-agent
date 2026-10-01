/**
 * SPEC-012 §1 浏览器端 View Spec 渲染器。
 *
 * **纯函数模块**：输入 View Spec，输出 HTML 字符串，全程不触碰任何 DOM
 * （所以 `node --test` 里能直接 import 它做断言，浏览器里也能直接 `<script type="module">` 加载）。
 *
 * 规则与服务端 `src/surface/renderer.ts` 同源：
 *
 * 1. 所有进入 HTML 的文本与属性值必须转义（UI-003）；
 * 2. 未知组件降级为占位块（`data-unknown-component`），非法节点降级为无效块
 *    （`data-invalid-spec`）——绝不抛异常、绝不白屏，兄弟组件照常渲染（UI-004）；
 * 3. 组件词汇表镜像服务端的唯一真相来源 `COMPONENT_SPECS`，漂移由
 *    `test/client-ui.test.ts` 的门禁拦住（UI-002）。
 *
 * 浏览器拿不到 TS 模块，所以这里是一份等价的纯 JS 实现；两份实现只共享契约，不共享代码。
 */

/** 嵌套深度上限：防御循环引用与构造出来的超深 JSON（与 viewspec.ts 一致） */
export const MAX_VIEW_DEPTH = 32;

/**
 * 组件词汇表（顺序即渲染表顺序）。
 * 必须与 `src/surface/viewspec.ts` 的 `Object.keys(COMPONENT_SPECS)` 完全一致（UI-002）。
 */
export const COMPONENT_TYPES = ['panel', 'text', 'progress', 'action', 'list', 'kv', 'columns', 'badge'];

const KNOWN_TYPES = new Set(COMPONENT_TYPES);

/**
 * 客户端主题令牌（L0）。沙箱 iframe 里的文档必须自包含，
 * 因此颜色/字号/圆角全部内联成 `--ac-*` 变量，不依赖宿主页面样式表。
 */
const TOKENS = {
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  color: {
    bg: '#05060a',
    surface: '#0b101c',
    surfaceAlt: '#141b2d',
    border: '#1e2a44',
    text: '#e6f1ff',
    textMuted: '#8ea0bd',
    accent: '#22d3ee',
    accentText: '#04121a',
    info: '#22d3ee',
    success: '#34d399',
    warning: '#fbbf24',
    danger: '#f87171',
    violet: '#a78bfa',
  },
  fontSize: { xs: 11, sm: 12, md: 14, lg: 18, xl: 24 },
  radius: { sm: 4, md: 8, lg: 14, pill: 999 },
  space: 8,
};

const CSS_VALUES = [
  ['--ac-font-family', TOKENS.fontFamily],
  ['--ac-bg', TOKENS.color.bg],
  ['--ac-surface', TOKENS.color.surface],
  ['--ac-surface-alt', TOKENS.color.surfaceAlt],
  ['--ac-border', TOKENS.color.border],
  ['--ac-text', TOKENS.color.text],
  ['--ac-text-muted', TOKENS.color.textMuted],
  ['--ac-accent', TOKENS.color.accent],
  ['--ac-accent-text', TOKENS.color.accentText],
  ['--ac-info', TOKENS.color.info],
  ['--ac-success', TOKENS.color.success],
  ['--ac-warning', TOKENS.color.warning],
  ['--ac-danger', TOKENS.color.danger],
  ['--ac-violet', TOKENS.color.violet],
  ['--ac-font-xs', `${TOKENS.fontSize.xs}px`],
  ['--ac-font-sm', `${TOKENS.fontSize.sm}px`],
  ['--ac-font-md', `${TOKENS.fontSize.md}px`],
  ['--ac-font-lg', `${TOKENS.fontSize.lg}px`],
  ['--ac-font-xl', `${TOKENS.fontSize.xl}px`],
  ['--ac-radius-sm', `${TOKENS.radius.sm}px`],
  ['--ac-radius-md', `${TOKENS.radius.md}px`],
  ['--ac-radius-lg', `${TOKENS.radius.lg}px`],
  ['--ac-radius-pill', `${TOKENS.radius.pill}px`],
  ['--ac-space', `${TOKENS.space}px`],
];

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** 所有进入 HTML 的文本与属性值都必须经过它（UI-003） */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/** 拼一个 style 属性：驼峰属性名转 kebab-case，值先剔除能越出声明块的字符 */
function style(declarations) {
  const parts = [];
  for (const [property, value] of Object.entries(declarations)) {
    if (value === undefined || value === '') continue;
    const name = property.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
    parts.push(`${name}:${String(value).replace(/[";{}<>\\]/g, '')}`);
  }
  return parts.join(';');
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOf(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

function numberOf(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** tone 是语义色：渲染器不写死颜色，只做名字到令牌的翻译 */
function toneColor(tone) {
  switch (tone) {
    case 'muted':
      return TOKENS.color.textMuted;
    case 'strong':
      return TOKENS.color.violet;
    case 'info':
      return TOKENS.color.info;
    case 'success':
      return TOKENS.color.success;
    case 'warning':
      return TOKENS.color.warning;
    case 'danger':
      return TOKENS.color.danger;
    default:
      return TOKENS.color.text;
  }
}

/** tone → 半透明底色（徽标等用） */
function toneSurface(tone) {
  switch (tone) {
    case 'info':
    case 'success':
    case 'warning':
    case 'danger':
      return `${toneColor(tone)}22`;
    case 'strong':
      return `${TOKENS.color.violet}22`;
    default:
      return TOKENS.color.surfaceAlt;
  }
}

function clamp01(value) {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** 未知组件：降级为占位块（UI-004） */
function unknownPlaceholder(type) {
  const shown = type === '' ? '(缺失 type)' : type;
  return `<div class="ac-unknown" data-unknown-component="${escapeHtml(type)}" style="${style({
    padding: `${TOKENS.space * 1.5}px`,
    border: `1px dashed ${TOKENS.color.warning}`,
    borderRadius: `${TOKENS.radius.md}px`,
    color: TOKENS.color.warning,
    background: TOKENS.color.surfaceAlt,
    fontSize: `${TOKENS.fontSize.sm}px`,
  })}">未知组件：${escapeHtml(shown)}</div>`;
}

/** 非对象 / 超深节点：同样降级，不白屏（UI-004） */
function invalidPlaceholder(reason) {
  return `<div class="ac-invalid" data-invalid-spec="true" style="${style({
    padding: `${TOKENS.space * 1.5}px`,
    border: `1px dashed ${TOKENS.color.danger}`,
    borderRadius: `${TOKENS.radius.md}px`,
    color: TOKENS.color.danger,
    background: TOKENS.color.surfaceAlt,
    fontSize: `${TOKENS.fontSize.sm}px`,
  })}">无效的 View Spec：${escapeHtml(reason)}</div>`;
}

function heading(title) {
  if (typeof title !== 'string' || title.length === 0) return '';
  return `<h3 class="ac-title" style="${style({
    margin: `0 0 ${TOKENS.space}px`,
    fontSize: `${TOKENS.fontSize.sm}px`,
    fontWeight: 600,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    color: TOKENS.color.textMuted,
  })}">${escapeHtml(title)}</h3>`;
}

function container(title, body, extra = {}) {
  return `<section class="ac-panel" style="${style({
    display: 'flex',
    flexDirection: 'column',
    padding: `${TOKENS.space * 1.5}px`,
    background: TOKENS.color.surface,
    border: `1px solid ${TOKENS.color.border}`,
    borderRadius: `${TOKENS.radius.md}px`,
    ...extra,
  })}">${heading(title)}${body}</section>`;
}

function renderChildren(spec, depth) {
  const children = Array.isArray(spec.children) ? spec.children : [];
  return children
    .map((child) => renderNode(child, depth + 1))
    .filter((html) => html.length > 0)
    .map((html) => `<div class="ac-child" style="${style({ minWidth: 0 })}">${html}</div>`)
    .join(`<div style="${style({ height: `${TOKENS.space}px` })}"></div>`);
}

/** 每种组件一个渲染函数：新增组件时这里与 COMPONENT_TYPES 一起改（UI-002） */
const RENDERERS = {
  panel: (spec, depth) => container(textOf(spec.title) || undefined, renderChildren(spec, depth)),

  text: (spec) =>
    `<p class="ac-text" style="${style({
      margin: 0,
      color: toneColor(spec.tone),
      fontSize: `${TOKENS.fontSize.md}px`,
      whiteSpace: 'pre-wrap',
    })}">${escapeHtml(textOf(spec.text))}</p>`,

  progress: (spec) => {
    const value = clamp01(numberOf(spec.value));
    const percent = Math.round(value * 100);
    const color = toneColor(spec.tone);
    return `<div class="ac-progress" style="${style({ display: 'flex', flexDirection: 'column', gap: `${TOKENS.space * 0.75}px` })}">
<span class="ac-progress-head" style="${style({ display: 'flex', justifyContent: 'space-between', gap: `${TOKENS.space}px`, fontSize: `${TOKENS.fontSize.sm}px` })}"><span class="ac-progress-label" style="${style({ color: TOKENS.color.text })}">${escapeHtml(textOf(spec.label))}</span><span class="ac-progress-value" style="${style({ color: TOKENS.color.textMuted, fontVariantNumeric: 'tabular-nums' })}">${percent}%</span></span>
<span class="ac-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="1" aria-valuenow="${value}" style="${style({ display: 'block', height: `${TOKENS.radius.sm}px`, background: TOKENS.color.surfaceAlt, borderRadius: `${TOKENS.radius.pill}px`, overflow: 'hidden' })}"><span class="ac-progress-bar" style="${style({ display: 'block', width: `${percent}%`, height: '100%', background: color, borderRadius: `${TOKENS.radius.pill}px` })}"></span></span>
</div>`;
  },

  action: (spec) =>
    `<button class="ac-action" type="button" data-emit="${escapeHtml(textOf(spec.emit))}" style="${style({
      alignSelf: 'flex-start',
      padding: `${TOKENS.space * 0.75}px ${TOKENS.space * 1.5}px`,
      border: `1px solid ${TOKENS.color.border}`,
      borderRadius: `${TOKENS.radius.md}px`,
      background: actionBackground(spec.tone),
      color: actionText(spec.tone),
      fontSize: `${TOKENS.fontSize.md}px`,
      cursor: 'pointer',
    })}">${escapeHtml(textOf(spec.label))}</button>`,

  list: (spec) => {
    const items = Array.isArray(spec.items) ? spec.items : [];
    const body = items
      .map(
        (item) =>
          `<li class="ac-list-item" style="${style({ margin: `0 0 ${TOKENS.space * 0.5}px`, color: toneColor(spec.tone) })}">${escapeHtml(item)}</li>`,
      )
      .join('');
    return container(
      textOf(spec.title) || undefined,
      `<ul class="ac-list" style="${style({ margin: 0, paddingInlineStart: `${TOKENS.space * 2.5}px` })}">${body}</ul>`,
    );
  },

  kv: (spec) => {
    const pairs = Array.isArray(spec.pairs) ? spec.pairs : [];
    const rows = pairs
      .map((pair) => {
        const entry = isRecord(pair) ? pair : {};
        return `<div class="ac-kv-row" style="${style({ display: 'flex', justifyContent: 'space-between', gap: `${TOKENS.space * 1.5}px`, padding: `${TOKENS.space * 0.5}px 0`, borderBottom: `1px solid ${TOKENS.color.border}` })}"><span class="ac-kv-key" style="${style({ color: TOKENS.color.textMuted, fontSize: `${TOKENS.fontSize.sm}px` })}">${escapeHtml(entry.key)}</span><span class="ac-kv-value" style="${style({ color: TOKENS.color.text, fontVariantNumeric: 'tabular-nums' })}">${escapeHtml(entry.value)}</span></div>`;
      })
      .join('');
    return container(textOf(spec.title) || undefined, `<div class="ac-kv">${rows}</div>`);
  },

  columns: (spec, depth) => {
    const children = Array.isArray(spec.children) ? spec.children : [];
    const body = children
      .map(
        (child) =>
          `<div class="ac-column" style="${style({ flex: '1 1 0', minWidth: 0 })}">${renderNode(child, depth + 1)}</div>`,
      )
      .join('');
    return container(
      textOf(spec.title) || undefined,
      `<div class="ac-columns" style="${style({ display: 'flex', gap: `${TOKENS.space * 1.5}px`, alignItems: 'flex-start' })}">${body}</div>`,
    );
  },

  badge: (spec) => {
    const tone = spec.tone;
    return `<span class="ac-badge" style="${style({
      display: 'inline-block',
      padding: `${TOKENS.space * 0.25}px ${TOKENS.space}px`,
      borderRadius: `${TOKENS.radius.pill}px`,
      background: toneSurface(tone),
      color: toneColor(tone),
      fontSize: `${TOKENS.fontSize.xs}px`,
      fontWeight: 600,
    })}">${escapeHtml(textOf(spec.text))}</span>`;
  },
};

/** action 用实心按钮，语义色直接做底色 */
function actionBackground(tone) {
  switch (tone) {
    case 'info':
      return TOKENS.color.info;
    case 'success':
      return TOKENS.color.success;
    case 'warning':
      return TOKENS.color.warning;
    case 'danger':
      return TOKENS.color.danger;
    case 'muted':
    case 'strong':
      return TOKENS.color.surfaceAlt;
    default:
      return TOKENS.color.accent;
  }
}

function actionText(tone) {
  switch (tone) {
    case 'muted':
    case 'strong':
      return TOKENS.color.text;
    default:
      return TOKENS.color.accentText;
  }
}

/** 渲染一个节点；任何异常输入都变成占位块，绝不抛出（UI-004） */
function renderNode(value, depth) {
  if (depth > MAX_VIEW_DEPTH) return invalidPlaceholder(`嵌套超过 ${MAX_VIEW_DEPTH} 层`);
  if (!isRecord(value)) return invalidPlaceholder('节点不是对象');
  const type = value.type;
  // 已知 / 未知由词汇表判定：渲染器不维护第二份清单（UI-002 / UI-004）
  if (typeof type !== 'string' || !KNOWN_TYPES.has(type)) {
    return unknownPlaceholder(typeof type === 'string' ? type : '');
  }
  const renderer = RENDERERS[type];
  if (typeof renderer !== 'function') return unknownPlaceholder(type);
  return renderer(value, depth);
}

/** 渲染组件片段（不带 HTML 文档外壳），供对话流 / 整页拼装使用 */
export function renderFragment(spec) {
  try {
    return renderNode(spec, 0);
  } catch (error) {
    // 兜底：契约不允许异常冒泡到调用方
    const message = error instanceof Error ? error.message : String(error);
    return invalidPlaceholder(`渲染时发生内部异常：${message}`);
  }
}

const BASE_CSS = `*{box-sizing:border-box}
body{margin:0;background:var(--ac-bg);color:var(--ac-text);font-family:var(--ac-font-family);font-size:var(--ac-font-md);line-height:1.55;-webkit-font-smoothing:antialiased}
.ac-root{max-width:880px;margin:0 auto;padding:calc(var(--ac-space) * 3)}
.ac-empty{color:var(--ac-text-muted);font-size:var(--ac-font-sm)}`;

/**
 * 渲染一份**自包含** HTML 文档（沙箱 iframe 的 srcdoc）。
 * 样式内联 + `:root` 令牌变量，无任何外部依赖，离线可用（UI-003 / UI-006）。
 */
export function renderViewSpec(spec, options = {}) {
  const title = typeof options === 'object' && options !== null && typeof options.title === 'string'
    ? options.title
    : 'Agent Client · 界面';
  const tokens = CSS_VALUES.map(([name, value]) => `  ${name}: ${String(value).replace(/[;{}<>\\]/g, '')};`).join('\n');
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${escapeHtml(title)}</title>`,
    '<style>',
    `:root {\n${tokens}\n}`,
    BASE_CSS,
    '</style>',
    '</head>',
    `<body><main class="ac-root">${renderFragment(spec)}</main></body>`,
    '</html>',
    '',
  ].join('\n');
}
