/**
 * SPEC-024：Markdown 渲染。
 *
 * Agent 说的是 Markdown（`**加粗**`、列表、代码块、表格），之前一律当纯文本显示，
 * 于是人类看到的是满屏星号和反引号。
 *
 * 两条硬约束决定了这份实现：
 *
 * 1. **零第三方依赖**（整个项目的底线）→ 自己写，只支持真用得上的那部分语法；
 * 2. **Agent 的输出是不可信输入** → **先整段转义，再做标记**，永远不产出源文本里的 HTML。
 *    链接另做协议白名单：`javascript:` / `data:` 这类一律降级成纯文本。
 *
 * 流式输出也用同一个渲染器（SPEC-022）：未闭合的语法（`**` 只来了一个）按字面显示，
 * 这是流式 Markdown 的正常表现——写完就闭合了。
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** HTML 转义：整个渲染的第一步，也是唯一的安全边界 */
export function escapeHtml(text) {
  return String(text === null || text === undefined ? '' : text).replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

/** 只放行明确的协议；其余（含 javascript:/data:/vbscript:）降级成纯文本 */
export function sanitizeUrl(url) {
  const raw = String(url === null || url === undefined ? '' : url).trim();
  if (raw === '') return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    return /^(https?|mailto|tel):/i.test(raw) ? raw : null;
  }
  // 相对路径 / 锚点：允许（本项目里没有外部资源可加载，图片也不用管）
  return raw;
}

/** 行内标记：**粗**、*斜*、`代码`、~~删除线~~、[文字](链接)、裸链接 */
function inline(escaped) {
  let out = escaped;

  // 行内代码先挖出来放进占位符：里面的星号/下划线是**字面量**，不能被后面的规则二次解析
  const codes = [];
  out = out.replace(/`([^`]+)`/g, (_match, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  // 链接：[文字](地址)
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, url) => {
    const safe = sanitizeUrl(url);
    if (safe === null) return label; // 不安全就只留文字
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });

  // 裸链接：http(s)://…（结尾的标点不算地址的一部分）
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, (_match, lead, url) => {
    const safe = sanitizeUrl(url);
    if (safe === null) return `${lead}${url}`;
    return `${lead}<a href="${safe}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  });

  // 再把行内代码放回去
  out = out.replace(/\u0000(\d+)\u0000/g, (_match, index) => `<code>${codes[Number(index)]}</code>`);

  return out;
}

const FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const UL = /^\s*[-*+]\s+(.*)$/;
const OL = /^\s*\d+[.)]\s+(.*)$/;
const TABLE_ROW = /^\s*\|?(.+\|.+)\|?\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function splitRow(line) {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/**
 * Markdown → HTML。
 *
 * 只做「块 + 行内」两层，够用就好：标题、围栏代码、列表、引用、分隔线、表格、段落。
 */
export function renderMarkdown(source) {
  const text = String(source === null || source === undefined ? '' : source).replace(/\r\n?/g, '\n');
  if (text.trim() === '') return '';

  // 块级标记在**原文**上识别（`>`、`#` 这些一旦先转义就认不出来了），
  // 但每一段内容都先 escapeHtml 再进 inline —— 安全边界仍然是「先转义，再产出 HTML」。
  const lines = text.split('\n');
  const html = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // 空行跳过
    if (line.trim() === '') {
      i += 1;
      continue;
    }

    // 围栏代码块：内容原样保留（已转义）
    const fence = FENCE.exec(line);
    if (fence !== null) {
      const marker = fence[1];
      const lang = fence[2];
      const body = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^\\s*${marker}\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // 吃掉收尾围栏（没有就走到末尾）
      const cls = lang === '' ? '' : ` class="language-${lang}"`;
      html.push(`<pre class="md-code"><code${cls}>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    // 标题
    const heading = HEADING.exec(line);
    if (heading !== null) {
      const level = heading[1].length;
      html.push(`<h${level} class="md-h${level}">${inline(escapeHtml(heading[2].trim()))}</h${level}>`);
      i += 1;
      continue;
    }

    // 分隔线
    if (HR.test(line)) {
      html.push('<hr class="md-hr" />');
      i += 1;
      continue;
    }

    // 表格：当前行是 | a | b |，且下一行是分隔行
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      const headHtml = head.map((cell) => `<th>${inline(escapeHtml(cell))}</th>`).join('');
      const bodyHtml = rows
        .map((cells) => `<tr>${cells.map((cell) => `<td>${inline(escapeHtml(cell))}</td>`).join('')}</tr>`)
        .join('');
      html.push(`<table class="md-table"><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`);
      continue;
    }

    // 引用（连续多行合成一段）
    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        body.push(QUOTE.exec(lines[i])[1]);
        i += 1;
      }
      html.push(`<blockquote class="md-quote">${body.map((line_) => inline(escapeHtml(line_))).join('<br />')}</blockquote>`);
      continue;
    }

    // 列表（有序 / 无序各自成块）
    if (UL.test(line) || OL.test(line)) {
      const ordered = OL.test(line);
      const items = [];
      while (i < lines.length) {
        const match = (ordered ? OL : UL).exec(lines[i]);
        if (match === null) break;
        items.push(match[1]);
        i += 1;
      }
      const tag = ordered ? 'ol' : 'ul';
      const itemsHtml = items.map((item) => `<li>${inline(escapeHtml(item))}</li>`).join('');
      html.push(`<${tag} class="md-list">${itemsHtml}</${tag}>`);
      continue;
    }

    // 段落：一直吃到空行或下一个块级标记
    const paragraph = [];
    while (i < lines.length && lines[i].trim() !== '') {
      const current = lines[i];
      if (
        FENCE.test(current) ||
        HEADING.test(current) ||
        HR.test(current) ||
        QUOTE.test(current) ||
        UL.test(current) ||
        OL.test(current) ||
        (TABLE_ROW.test(current) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]))
      ) {
        break;
      }
      paragraph.push(current);
      i += 1;
    }
    if (paragraph.length > 0) {
      // 行尾两个空格 = 强制换行；否则同一段内按空格连接
      // 行尾两个空格 = 强制换行（这是 Markdown 的约定）
      const joined = paragraph
        .map((line_) => (line_.endsWith('  ') ? `${escapeHtml(line_.slice(0, -2))}<br />` : escapeHtml(line_)))
        .join('\n');
      html.push(`<p class="md-p">${inline(joined)}</p>`);
    }
  }

  return html.join('');
}

/** 这段文本里有没有 Markdown 标记（用来决定要不要走渲染，省掉纯文本的重复解析） */
export function looksLikeMarkdown(text) {
  const source = String(text === null || text === undefined ? '' : text);
  if (source.trim() === '') return false;
  return /(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```|~~~|\|)|(\*\*|__|`|\[[^\]]+\]\([^)]+\))/.test(source);
}
