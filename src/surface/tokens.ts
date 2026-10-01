/**
 * SPEC-006 §4 L0 主题令牌。
 *
 * 令牌是界面层的最低一层：渲染器只引用 `--ac-*` 自定义属性与内联样式，
 * 不依赖任何外部 CSS 文件。这样一份 View Spec 渲染出的 HTML 永远是自包含的
 * （`renderViewSpec` 的输出可以直接落盘、双击打开）。
 */

/** 语义色板。渲染器按 tone 取名，不直接写死颜色。 */
export interface ColorTokens {
  /** 页面底色 */
  bg: string;
  /** 卡片/容器底色 */
  surface: string;
  /** 次级底色（表头、轨道） */
  surfaceAlt: string;
  border: string;
  text: string;
  textMuted: string;
  accent: string;
  accentText: string;
  info: string;
  success: string;
  warning: string;
  danger: string;
}

/** 字号阶梯（px） */
export interface FontSizeTokens {
  xs: number;
  sm: number;
  md: number;
  lg: number;
  xl: number;
}

/** 圆角阶梯（px） */
export interface RadiusTokens {
  sm: number;
  md: number;
  lg: number;
  pill: number;
}

/** 密度：控制内边距与间隙的基础单位 */
export interface DensityTokens {
  /** 基础间距单位（px） */
  unit: number;
  /** 命名档位，只影响渲染时的乘数 */
  scale: 'compact' | 'normal' | 'comfortable';
}

export interface ThemeTokens {
  fontFamily: string;
  color: ColorTokens;
  fontSize: FontSizeTokens;
  radius: RadiusTokens;
  density: DensityTokens;
}

/** 默认主题（L0）。深浅色、品牌色属于宿主覆盖，不在本层。 */
export const DEFAULT_TOKENS: ThemeTokens = {
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  color: {
    bg: '#0f1115',
    surface: '#171a21',
    surfaceAlt: '#1f2430',
    border: '#2a3140',
    text: '#e6e9ef',
    textMuted: '#9aa4b8',
    accent: '#4c8dff',
    accentText: '#ffffff',
    info: '#4c8dff',
    success: '#3fb950',
    warning: '#d29922',
    danger: '#f85149',
  },
  fontSize: { xs: 11, sm: 12, md: 14, lg: 18, xl: 24 },
  radius: { sm: 4, md: 8, lg: 14, pill: 999 },
  density: { unit: 8, scale: 'normal' },
};

/** 密度档位 → 间距乘数。渲染器用它把 unit 换算成实际 px。 */
const DENSITY_MULTIPLIER: Record<DensityTokens['scale'], number> = {
  compact: 0.75,
  normal: 1,
  comfortable: 1.35,
};

/** 某一档密度下的基础间距（px） */
export function densityUnit(tokens: ThemeTokens): number {
  const multiplier = DENSITY_MULTIPLIER[tokens.density.scale] ?? 1;
  return round(tokens.density.unit * multiplier);
}

/** 取 `token * factor` 的间距，最多保留两位小数 */
export function spacing(tokens: ThemeTokens, factor: number): number {
  return round(densityUnit(tokens) * factor);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * CSS 值净化：令牌是宿主注入的字符串，不能让它越出声明块拼出额外规则。
 * 剔除 `; { } < >` 与反斜杠转义序列，保留 `#`、`(`、`)`、`,`、`-`、`.`、空格等合法值字符。
 */
function cssValue(value: string | number): string {
  const raw = typeof value === 'number' ? String(value) : value;
  return raw.replace(/[;{}<>\\]/g, '').replace(/\s+/g, ' ').trim();
}

function px(value: number): string {
  return `${round(value)}px`;
}

/**
 * 把令牌序列化成 `:root { --ac-*: ... }`。
 * 变量名与值都经过净化，输出永远是单个声明块。
 */
export function tokensToCss(tokens: ThemeTokens): string {
  const lines: string[] = [
    `  --ac-font-family: ${cssValue(tokens.fontFamily)};`,
    `  --ac-bg: ${cssValue(tokens.color.bg)};`,
    `  --ac-surface: ${cssValue(tokens.color.surface)};`,
    `  --ac-surface-alt: ${cssValue(tokens.color.surfaceAlt)};`,
    `  --ac-border: ${cssValue(tokens.color.border)};`,
    `  --ac-text: ${cssValue(tokens.color.text)};`,
    `  --ac-text-muted: ${cssValue(tokens.color.textMuted)};`,
    `  --ac-accent: ${cssValue(tokens.color.accent)};`,
    `  --ac-accent-text: ${cssValue(tokens.color.accentText)};`,
    `  --ac-info: ${cssValue(tokens.color.info)};`,
    `  --ac-success: ${cssValue(tokens.color.success)};`,
    `  --ac-warning: ${cssValue(tokens.color.warning)};`,
    `  --ac-danger: ${cssValue(tokens.color.danger)};`,
    `  --ac-font-xs: ${px(tokens.fontSize.xs)};`,
    `  --ac-font-sm: ${px(tokens.fontSize.sm)};`,
    `  --ac-font-md: ${px(tokens.fontSize.md)};`,
    `  --ac-font-lg: ${px(tokens.fontSize.lg)};`,
    `  --ac-font-xl: ${px(tokens.fontSize.xl)};`,
    `  --ac-radius-sm: ${px(tokens.radius.sm)};`,
    `  --ac-radius-md: ${px(tokens.radius.md)};`,
    `  --ac-radius-lg: ${px(tokens.radius.lg)};`,
    `  --ac-radius-pill: ${px(tokens.radius.pill)};`,
    `  --ac-density: ${cssValue(tokens.density.scale)};`,
    `  --ac-space: ${px(densityUnit(tokens))};`,
  ];
  return `:root {\n${lines.join('\n')}\n}`;
}

/** 渲染器用到的语义色：tone → CSS 颜色 */
export function toneColor(tokens: ThemeTokens, tone: string | undefined): string {
  switch (tone) {
    case 'muted':
      return tokens.color.textMuted;
    case 'strong':
      return tokens.color.text;
    case 'info':
      return tokens.color.info;
    case 'success':
      return tokens.color.success;
    case 'warning':
      return tokens.color.warning;
    case 'danger':
      return tokens.color.danger;
    default:
      return tokens.color.text;
  }
}

/** tone → 半透明底色（徽标、进度轨道用） */
export function toneSurface(tokens: ThemeTokens, tone: string | undefined): string {
  switch (tone) {
    case 'muted':
    case 'strong':
    case 'default':
    case undefined:
      return tokens.color.surfaceAlt;
    default:
      return `${toneColor(tokens, tone)}22`;
  }
}
