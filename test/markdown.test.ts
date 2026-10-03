import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const markdown = (await import(new URL('../src/client/markdown.js', import.meta.url).href)) as {
  renderMarkdown(source: unknown): string;
  sanitizeUrl(url: unknown): string | null;
  escapeHtml(text: unknown): string;
  looksLikeMarkdown(text: unknown): boolean;
};

const appSource = fs.readFileSync(path.join(here, '..', 'src', 'client', 'app.js'), 'utf8');

// @spec MD-001
test('基础语法：标题 / 粗斜 / 行内代码 / 代码块 / 列表 / 引用 / 分隔线', () => {
  const html = markdown.renderMarkdown(
    [
      '# 标题一',
      '',
      '普通段落，**加粗**、*斜体*、`代码`、~~删除线~~。',
      '',
      '- 第一项',
      '- 第二项',
      '',
      '1. 有序一',
      '2. 有序二',
      '',
      '> 引用一句',
      '',
      '---',
      '',
      '```js',
      'const a = 1;',
      '```',
    ].join('\n'),
  );

  assert.match(html, /<h1 class="md-h1">标题一<\/h1>/);
  assert.match(html, /<strong>加粗<\/strong>/);
  assert.match(html, /<em>斜体<\/em>/);
  assert.match(html, /<code>代码<\/code>/);
  assert.match(html, /<del>删除线<\/del>/);
  assert.match(html, /<ul class="md-list"><li>第一项<\/li><li>第二项<\/li><\/ul>/);
  assert.match(html, /<ol class="md-list"><li>有序一<\/li><li>有序二<\/li><\/ol>/);
  assert.match(html, /<blockquote class="md-quote">引用一句<\/blockquote>/);
  assert.match(html, /<hr class="md-hr" \/>/);
  assert.match(html, /<pre class="md-code"><code class="language-js">const a = 1;<\/code><\/pre>/);

  // 纯函数：同一段渲染两次结果一致
  assert.equal(markdown.renderMarkdown('# x'), markdown.renderMarkdown('# x'));
  assert.equal(markdown.renderMarkdown(''), '');
  assert.equal(markdown.renderMarkdown(null), '');
});

// @spec MD-002
test('安全：源文本里的 HTML 一律转义，链接走协议白名单', () => {
  const html = markdown.renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>');
  assert.equal(html.includes('<script>'), false, '不许产出源文本里的 script');
  assert.equal(html.includes('<img'), false, '不许产出源文本里的标签');
  assert.match(html, /&lt;script&gt;/);

  // 代码块里同样转义，但内容原样保留（含标签与缩进）
  const code = markdown.renderMarkdown('```html\n<div class="a">  x</div>\n```');
  assert.equal(code.includes('<div'), false);
  assert.match(code, /&lt;div class=&quot;a&quot;&gt;  x&lt;\/div&gt;/);

  // 链接协议白名单
  assert.equal(markdown.sanitizeUrl('https://example.com'), 'https://example.com');
  assert.equal(markdown.sanitizeUrl('mailto:a@b.c'), 'mailto:a@b.c');
  assert.equal(markdown.sanitizeUrl('/relative'), '/relative');
  assert.equal(markdown.sanitizeUrl('#anchor'), '#anchor');
  assert.equal(markdown.sanitizeUrl('javascript:alert(1)'), null);
  assert.equal(markdown.sanitizeUrl('JavaScript:alert(1)'), null);
  assert.equal(markdown.sanitizeUrl('data:text/html;base64,PHNjcmlwdD4='), null);
  assert.equal(markdown.sanitizeUrl('vbscript:msgbox(1)'), null);

  const link = markdown.renderMarkdown('[点我](javascript:alert(1))');
  assert.equal(link.includes('javascript:'), false, '危险协议不许进 href');
  assert.equal(link.includes('<a'), false, '不安全就只留文字');
  assert.match(link, /点我/);

  const safe = markdown.renderMarkdown('[点我](https://example.com/x)');
  assert.match(safe, /<a href="https:\/\/example\.com\/x" target="_blank" rel="noopener noreferrer">点我<\/a>/);
});

// @spec MD-003
test('表格与行内代码里的标记不被二次解析', () => {
  const table = markdown.renderMarkdown(['| 项目 | 金额 |', '| --- | ---: |', '| 已用 | 62 万 |'].join('\n'));
  assert.match(table, /<table class="md-table">/);
  assert.match(table, /<th>项目<\/th><th>金额<\/th>/);
  assert.match(table, /<td>已用<\/td><td>62 万<\/td>/);

  // 行内代码里的星号是字面量
  const inline = markdown.renderMarkdown('用 `**不是加粗**` 表示字面量');
  assert.match(inline, /<code>\*\*不是加粗\*\*<\/code>/);
  assert.equal(inline.includes('<strong>'), false);

  // 代码块里的 Markdown 不被解析
  const fence = markdown.renderMarkdown('```\n# 这不是标题\n- 这不是列表\n```');
  assert.equal(fence.includes('<h1'), false);
  assert.equal(fence.includes('<li>'), false);
  assert.match(fence, /# 这不是标题/);
});

// @spec MD-004
test('人类与系统消息不渲染 Markdown，只有 Agent 输出才渲染', () => {
  // 归因很重要：谁的内容被当成标记解析，是一条需要明确划出来的边界
  assert.match(appSource, /const isAgentOutput = kind === 'agent' \|\| kind === 'thinking'/);
  assert.match(appSource, /isAgentOutput && looksLikeMarkdown\(raw\)/);
  assert.match(appSource, /renderMarkdown\(raw\)/);
  // 流式气泡与正式消息用同一个渲染器，避免写完的瞬间排版跳变
  assert.match(appSource, /looksLikeMarkdown\(raw\)/);
  assert.match(appSource, /import \{ looksLikeMarkdown, renderMarkdown \} from '\.\/markdown\.js'/);
});

// @spec MD-005
test('looksLikeMarkdown 只认真的标记，普通句子不误判', () => {
  assert.equal(markdown.looksLikeMarkdown('这是一句普通的话。'), false);
  assert.equal(markdown.looksLikeMarkdown('两点半再说'), false);
  assert.equal(markdown.looksLikeMarkdown(''), false);
  assert.equal(markdown.looksLikeMarkdown('**重点**'), true);
  assert.equal(markdown.looksLikeMarkdown('- 列表项'), true);
  assert.equal(markdown.looksLikeMarkdown('3. 第三点'), true);
  assert.equal(markdown.looksLikeMarkdown('> 引用'), true);
  assert.equal(markdown.looksLikeMarkdown('# 标题'), true);
  assert.equal(markdown.looksLikeMarkdown('看这个 `code`'), true);
  assert.equal(markdown.looksLikeMarkdown('[文字](https://a.b)'), true);
});

// @spec MD-006
test('流式渲染：未闭合的语法按字面显示，闭合后变成标记（同一个渲染器）', () => {
  // 流式时 `**` 只来了半个：应当原样显示，不能产出残缺的 <strong>
  const half = markdown.renderMarkdown('我说的**重点');
  assert.equal(half.includes('<strong>'), false);
  assert.match(half, /\*\*重点/);

  const closed = markdown.renderMarkdown('我说的**重点**');
  assert.match(closed, /<strong>重点<\/strong>/);

  // 未闭合的代码围栏：内容也要在（不能因为没闭合就丢东西）
  const fence = markdown.renderMarkdown('```js\nconst a = 1;');
  assert.match(fence, /const a = 1;/);
});
