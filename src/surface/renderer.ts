/**
 * SPEC-006 §3 渲染器。
 *
 * 输入 View Spec，输出 HTML 字符串。两条硬要求：
 *
 * 1. **自包含**：所有样式内联或来自 `:root` 令牌变量，产物可以直接落盘打开；
 * 2. **降级而非白屏**：未知组件（SURF-007）、非法节点、超深嵌套都渲染成占位块，
 *    绝不抛异常、绝不中断同级的其它组件。
 *
 * 渲染器不 import 校验器：它把 spec 当作不可信输入做防御性读取，
 * 这样即使调用方跳过校验也不会炸掉界面。
 */

import type { ThemeTokens } from './tokens.ts';
import { DEFAULT_TOKENS, spacing, tokensToCss, toneColor, toneSurface } from './tokens.ts';
import { MAX_VIEW_DEPTH, isComponentType } from './viewspec.ts';
import type { ViewSpec } from './viewspec.ts';

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** 所有进入 HTML 的文本与属性值都必须经过它（SURF-006） */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/** 拼一个 style 属性：驼峰属性名转 kebab-case，令牌值先剔除能越出声明块的字符 */
function style(declarations: Record<string, string | number | undefined>): string {
  const parts: string[] = [];
  for (const [property, value] of Object.entries(declarations)) {
    if (value === undefined || value === '') continue;
    const name = property.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
    parts.push(`${name}:${String(value).replace(/[";{}<>\\]/g, '')}`);
  }
  return parts.join(';');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

function numberOf(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function toneOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

type Renderer = (spec: ViewSpec, tokens: ThemeTokens, depth: number) => string;

function renderChildren(spec: ViewSpec, tokens: ThemeTokens, depth: number, gap: number): string {
  const children = spec.children;
  if (!Array.isArray(children)) return '';
  return children
    .map((child) => renderNode(child, tokens, depth + 1))
    .filter((html) => html.length > 0)
    .map((html) => `<div class="ac-child" style="${style({ minWidth: 0 })}">${html}</div>`)
    .join(`<div style="${style({ height: `${gap}px` })}"></div>`);
}

function heading(spec: ViewSpec, tokens: ThemeTokens): string {
  const title = spec.title;
  if (typeof title !== 'string' || title.length === 0) return '';
  return `<h3 class="ac-title" style="${style({
    margin: `0 0 ${spacing(tokens, 1)}px`,
    fontSize: `${tokens.fontSize.sm}px`,
    fontWeight: 600,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    color: tokens.color.textMuted,
  })}">${escapeHtml(title)}</h3>`;
}

function container(title: string | undefined, body: string, tokens: ThemeTokens, extra: Record<string, string | number> = {}): string {
  return `<section class="ac-panel" style="${style({
    display: 'flex',
    flexDirection: 'column',
    padding: `${spacing(tokens, 1.5)}px`,
    background: tokens.color.surface,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: `${tokens.radius.md}px`,
    ...extra,
  })}">${title ? heading({ type: 'panel', title }, tokens) : ''}${body}</section>`;
}

/** 未知组件：降级为占位块（SURF-007） */
function unknownPlaceholder(tokens: ThemeTokens, type: string): string {
  return `<div class="ac-unknown" data-unknown-component="${escapeHtml(type)}" style="${style({
    padding: `${spacing(tokens, 1.5)}px`,
    border: `1px dashed ${tokens.color.warning}`,
    borderRadius: `${tokens.radius.md}px`,
    color: tokens.color.warning,
    background: tokens.color.surfaceAlt,
    fontSize: `${tokens.fontSize.sm}px`,
  })}">未知组件：${escapeHtml(type === '' ? '(缺失 type)' : type)}</div>`;
}

/** 非对象 / 缺失 type 的节点：同样降级，不白屏 */
function invalidPlaceholder(tokens: ThemeTokens, reason: string): string {
  return `<div class="ac-invalid" data-invalid-spec="true" style="${style({
    padding: `${spacing(tokens, 1.5)}px`,
    border: `1px dashed ${tokens.color.danger}`,
    borderRadius: `${tokens.radius.md}px`,
    color: tokens.color.danger,
    background: tokens.color.surfaceAlt,
    fontSize: `${tokens.fontSize.sm}px`,
  })}">无效的 View Spec：${escapeHtml(reason)}</div>`;
}

const RENDERERS: Record<string, Renderer> = {
  panel: (spec, tokens, depth) => {
    const gap = spacing(tokens, 1);
    return container(textOf(spec.title) || undefined, renderChildren(spec, tokens, depth, gap), tokens);
  },

  text: (spec, tokens) =>
    `<p class="ac-text" style="${style({
      margin: 0,
      color: toneColor(tokens, toneOf(spec.tone)),
      fontSize: `${tokens.fontSize.md}px`,
      whiteSpace: 'pre-wrap',
    })}">${escapeHtml(textOf(spec.text))}</p>`,

  progress: (spec, tokens) => {
    const value = clamp01(numberOf(spec.value));
    const percent = Math.round(value * 100);
    const color = toneColor(tokens, toneOf(spec.tone));
    return `<div class="ac-progress" style="${style({ display: 'flex', flexDirection: 'column', gap: `${spacing(tokens, 0.75)}px` })}">
<span class="ac-progress-head" style="${style({ display: 'flex', justifyContent: 'space-between', gap: `${spacing(tokens, 1)}px`, fontSize: `${tokens.fontSize.sm}px` })}"><span class="ac-progress-label" style="${style({ color: tokens.color.text })}">${escapeHtml(textOf(spec.label))}</span><span class="ac-progress-value" style="${style({ color: tokens.color.textMuted, fontVariantNumeric: 'tabular-nums' })}">${percent}%</span></span>
<span class="ac-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="1" aria-valuenow="${value}" style="${style({ display: 'block', height: `${Math.max(4, tokens.radius.sm)}px`, background: tokens.color.surfaceAlt, borderRadius: `${tokens.radius.pill}px`, overflow: 'hidden' })}"><span class="ac-progress-bar" style="${style({ display: 'block', width: `${percent}%`, height: '100%', background: color, borderRadius: `${tokens.radius.pill}px` })}"></span></span>
</div>`;
  },

  action: (spec, tokens) =>
    `<button class="ac-action" type="button" data-emit="${escapeHtml(textOf(spec.emit))}" style="${style({
      alignSelf: 'flex-start',
      padding: `${spacing(tokens, 0.75)}px ${spacing(tokens, 1.5)}px`,
      border: `1px solid ${tokens.color.border}`,
      borderRadius: `${tokens.radius.md}px`,
      background: actionBackground(tokens, toneOf(spec.tone)),
      color: toneOf(spec.tone) === 'default' || toneOf(spec.tone) === undefined ? tokens.color.accentText : toneColor(tokens, toneOf(spec.tone)),
      fontSize: `${tokens.fontSize.md}px`,
      cursor: 'pointer',
    })}">${escapeHtml(textOf(spec.label))}</button>`,

  list: (spec, tokens) => {
    const items = Array.isArray(spec.items) ? spec.items : [];
    const body = items
      .map(
        (item) =>
          `<li style="${style({ margin: `0 0 ${spacing(tokens, 0.5)}px`, color: toneColor(tokens, toneOf(spec.tone)) })}">${escapeHtml(item)}</li>`,
      )
      .join('');
    return container(textOf(spec.title) || undefined, `<ul class="ac-list" style="${style({ margin: 0, paddingInlineStart: `${spacing(tokens, 2.5)}px` })}">${body}</ul>`, tokens);
  },

  kv: (spec, tokens) => {
    const pairs = Array.isArray(spec.pairs) ? spec.pairs : [];
    const rows = pairs
      .map((pair) => {
        const entry = isRecord(pair) ? pair : {};
        return `<div class="ac-kv-row" style="${style({ display: 'flex', justifyContent: 'space-between', gap: `${spacing(tokens, 1.5)}px`, padding: `${spacing(tokens, 0.5)}px 0`, borderBottom: `1px solid ${tokens.color.border}` })}"><span class="ac-kv-key" style="${style({ color: tokens.color.textMuted, fontSize: `${tokens.fontSize.sm}px` })}">${escapeHtml(entry.key)}</span><span class="ac-kv-value" style="${style({ color: tokens.color.text, fontVariantNumeric: 'tabular-nums' })}">${escapeHtml(entry.value)}</span></div>`;
      })
      .join('');
    return container(textOf(spec.title) || undefined, `<div class="ac-kv">${rows}</div>`, tokens);
  },

  columns: (spec, tokens, depth) => {
    const children = Array.isArray(spec.children) ? spec.children : [];
    const body = children
      .map(
        (child) =>
          `<div class="ac-column" style="${style({ flex: '1 1 0', minWidth: 0 })}">${renderNode(child, tokens, depth + 1)}</div>`,
      )
      .join('');
    return container(
      textOf(spec.title) || undefined,
      `<div class="ac-columns" style="${style({ display: 'flex', gap: `${spacing(tokens, 1.5)}px`, alignItems: 'flex-start' })}">${body}</div>`,
      tokens,
    );
  },

  badge: (spec, tokens) => {
    const tone = toneOf(spec.tone);
    return `<span class="ac-badge" style="${style({
      display: 'inline-block',
      padding: `${spacing(tokens, 0.25)}px ${spacing(tokens, 1)}px`,
      borderRadius: `${tokens.radius.pill}px`,
      background: toneSurface(tokens, tone),
      color: toneColor(tokens, tone),
      fontSize: `${tokens.fontSize.xs}px`,
      fontWeight: 600,
    })}">${escapeHtml(textOf(spec.text))}</span>`;
  },
};

/** action 用实心按钮，语义色直接做底色 */
function actionBackground(tokens: ThemeTokens, tone: string | undefined): string {
  switch (tone) {
    case 'info':
      return tokens.color.info;
    case 'success':
      return tokens.color.success;
    case 'warning':
      return tokens.color.warning;
    case 'danger':
      return tokens.color.danger;
    case 'muted':
    case 'strong':
      return tokens.color.surfaceAlt;
    default:
      return tokens.color.accent;
  }
}

function renderNode(value: unknown, tokens: ThemeTokens, depth: number): string {
  if (depth > MAX_VIEW_DEPTH) return invalidPlaceholder(tokens, `嵌套超过 ${MAX_VIEW_DEPTH} 层`);
  if (!isRecord(value)) return invalidPlaceholder(tokens, '节点不是对象');
  const type = value.type;
  // 已知 / 未知由组件表判定——渲染器不维护第二份清单（SURF-001）
  if (!isComponentType(type)) {
    return unknownPlaceholder(tokens, typeof type === 'string' ? type : '');
  }
  const renderer = RENDERERS[type];
  if (!renderer) return unknownPlaceholder(tokens, type);
  return renderer(value as ViewSpec, tokens, depth);
}

/** 渲染组件片段（不带 HTML 文档外壳），供 ViewDocument 拼整页 */
export function renderFragment(spec: unknown, tokens: ThemeTokens = DEFAULT_TOKENS): string {
  return renderNode(spec, tokens, 0);
}

const BASE_CSS = `*{box-sizing:border-box}
body{margin:0;background:var(--ac-bg);color:var(--ac-text);font-family:var(--ac-font-family);font-size:var(--ac-font-md);line-height:1.55;-webkit-font-smoothing:antialiased}
.ac-root{max-width:880px;margin:0 auto;padding:calc(var(--ac-space) * 2)}
.ac-empty{color:var(--ac-text-muted);font-size:var(--ac-font-sm)}`;

/**
 * 渲染一份完整、自包含的 HTML 文档（SURF-005）。
 * 产物可直接写盘用浏览器打开：样式内联 + `:root` 令牌变量，无外部依赖。
 */
export function renderViewSpec(
  spec: unknown,
  options: { tokens?: ThemeTokens; title?: string } = {},
): string {
  const tokens = options.tokens ?? DEFAULT_TOKENS;
  const title = options.title ?? 'Agent Client · View Spec';
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${escapeHtml(title)}</title>`,
    '<style>',
    tokensToCss(tokens),
    BASE_CSS,
    '</style>',
    '</head>',
    `<body><main class="ac-root">${renderFragment(spec, tokens)}</main></body>`,
    '</html>',
    '',
  ].join('\n');
}
