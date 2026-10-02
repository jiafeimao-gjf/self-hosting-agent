/**
 * SPEC-019 内置浏览器的「桥」与文档组合。
 *
 * 沙箱里的文档默认是死的：人类点了按钮，宿主一无所知。这份注入脚本把三件事接回宿主：
 *   1. 声明式交互 —— 元素上写 `data-ac-emit="导出"`，点击/提交就上报；
 *   2. 命令式交互 —— 文档里的脚本调 `AgentClient.emit(name, payload)`；
 *   3. 日志与错误 —— console.log / window.onerror / unhandledrejection 转发。
 *
 * 回传统一形如 `{__ac:1, channel:'agent-client:browser', kind, ...}`，
 * 宿主只认这个形状（见 src/browser/document.ts 的 accept）。
 *
 * 注意：脚本会被**注入进不可信文档**，所以它必须自足、不依赖任何外部资源，
 * 且用 try/catch 包住每一次 postMessage（文档里可能有同名的全局变量捣乱）。
 */

export const BRIDGE_CHANNEL = 'agent-client:browser';

/** 桥的标记字段：宿主与客户端都靠它过滤 window message */
export const BRIDGE_MARK = '__ac';

/** 注入脚本本体：普通 ES5 风格的 JS 字符串（不要用反引号，它要被嵌进模板里） */
export const BOOTSTRAP_SCRIPT = [
  '(function () {',
  "  var CHANNEL = 'agent-client:browser';",
  '  var MARK = 1;',
  '  function send(message) {',
  '    try {',
  '      var out = { __ac: MARK, channel: CHANNEL };',
  '      for (var key in message) {',
  '        if (Object.prototype.hasOwnProperty.call(message, key)) out[key] = message[key];',
  '      }',
  "      parent.postMessage(out, '*');",
  '    } catch (error) {',
  '      /* 文档里的异常不该把页面搞挂 */',
  '    }',
  '  }',
  '  function textOf(value) {',
  '    try {',
  "      if (typeof value === 'string') return value;",
  '      return JSON.stringify(value);',
  '    } catch (error) {',
  "      return String(value);",
  '    }',
  '  }',
  '  function parsePayload(raw) {',
  "    if (typeof raw !== 'string' || raw === '') return {};",
  '    try {',
  '      var parsed = JSON.parse(raw);',
  "      return parsed !== null && typeof parsed === 'object' ? parsed : { value: parsed };",
  '    } catch (error) {',
  '      return { raw: raw };',
  '    }',
  '  }',
  '  function fieldsOf(element) {',
  '    var fields = {};',
  '    try {',
  "      var named = element.querySelectorAll('[name]');",
  '      for (var i = 0; i < named.length; i += 1) {',
  '        var field = named[i];',
  '        fields[field.name] = field.value === undefined ? null : field.value;',
  '      }',
  '    } catch (error) {',
  '      /* ignore */',
  '    }',
  '    return fields;',
  '  }',
  '  function normalize(value) {',
  "    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value;",
  '    return { value: value === undefined ? null : value };',
  '  }',
  '  function nearest(node, attribute) {',
  '    var current = node;',
  '    while (current && current !== document) {',
  "      if (current.getAttribute && current.getAttribute('data-ac-emit') !== null && attribute === 'emit') return current;",
  "      if (current.getAttribute && current.getAttribute(attribute) !== null) return current;",
  '      current = current.parentNode;',
  '    }',
  '    return null;',
  '  }',
  '  function report(element, extra) {',
  "    var name = element.getAttribute('data-ac-emit');",
  "    var payload = parsePayload(element.getAttribute('data-ac-payload'));",
  '    var merged = {};',
  '    for (var key in payload) {',
  '      if (Object.prototype.hasOwnProperty.call(payload, key)) merged[key] = payload[key];',
  '    }',
  '    if (extra) {',
  '      for (var extraKey in extra) {',
  '        if (Object.prototype.hasOwnProperty.call(extra, extraKey)) merged[extraKey] = extra[extraKey];',
  '      }',
  '    }',
  "    send({ kind: 'emit', name: String(name), payload: merged });",
  '  }',
  '  document.addEventListener(',
  "    'click',",
  '    function (event) {',
  "      var element = nearest(event.target, 'emit');",
  '      if (element) report(element, null);',
  '    },',
  '    true,',
  '  );',
  '  document.addEventListener(',
  "    'submit',",
  '    function (event) {',
  "      var element = nearest(event.target, 'emit');",
  '      if (!element) return;',
  '      try {',
  '        event.preventDefault();',
  '      } catch (error) {',
  '        /* ignore */',
  '      }',
  "      report(element, { fields: fieldsOf(element) });",
  '    },',
  '    true,',
  '  );',
  '  var originalLog = typeof console !== "undefined" && console.log ? console.log : null;',
  "  ['log', 'info', 'warn', 'error'].forEach(function (level) {",
  '    if (typeof console === "undefined") return;',
  "    var original = console[level];",
  '    console[level] = function () {',
  '      var parts = [];',
  '      for (var i = 0; i < arguments.length; i += 1) parts.push(textOf(arguments[i]));',
  "      send({ kind: 'log', level: level, text: parts.join(' ') });",
  '      if (typeof original === "function") original.apply(console, arguments);',
  '    };',
  '  });',
  '  window.addEventListener("error", function (event) {',
  "    send({ kind: 'error', text: textOf(event && event.message ? event.message : 'unknown error') });",
  '  });',
  '  window.addEventListener("unhandledrejection", function (event) {',
  "    send({ kind: 'error', text: 'unhandledrejection: ' + textOf(event && event.reason) });",
  '  });',
  '  window.AgentClient = {',
  '    emit: function (name, payload) {',
  "      send({ kind: 'emit', name: String(name), payload: normalize(payload) });",
  '    },',
  '    log: function () {',
  '      var parts = [];',
  '      for (var i = 0; i < arguments.length; i += 1) parts.push(textOf(arguments[i]));',
  "      send({ kind: 'log', level: 'log', text: parts.join(' ') });",
  '    },',
  '  };',
  '  function announce() {',
  "    send({ kind: 'ready', title: document.title || '' });",
  '  }',
  "  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', announce);",
  '  else announce();',
  '  void originalLog;',
  '})();',
].join('\n');

/** 默认断网：只放行内联脚本与内联样式（交互要跑），其余一律不许出网 */
export const OFFLINE_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:";

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isFullDocument(html: string): boolean {
  return /<html[\s>]/i.test(html) || /<!doctype\s+html/i.test(html);
}

/**
 * 把一份 HTML 组合成可直接塞进 `srcdoc` 的完整文档。
 *
 * - 碎片 → 补成完整文档（否则浏览器会用怪异模式解析，样式全乱）；
 * - 完整文档 → 就地注入（尊重作者写的 head/body 结构）；
 * - 两种情况都注入 CSP（除非 allowNetwork）与桥脚本。
 */
export function composeDocument(input: { html: string; title?: string; allowNetwork?: boolean }): string {
  const allowNetwork = input.allowNetwork === true;
  const title = input.title ?? '内置浏览器';
  const cspMeta = allowNetwork ? '' : `<meta http-equiv="Content-Security-Policy" content="${OFFLINE_CSP}">`;
  const bridge = `<script data-agent-client-bridge="1">\n${BOOTSTRAP_SCRIPT}\n</script>`;

  if (!isFullDocument(input.html)) {
    return [
      '<!doctype html>',
      '<html lang="zh-CN">',
      '<head>',
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      cspMeta,
      `<title>${escapeHtml(title)}</title>`,
      '</head>',
      '<body>',
      input.html,
      bridge,
      '</body>',
      '</html>',
    ]
      .filter((part) => part !== '')
      .join('\n');
  }

  let html = input.html;
  // CSP 尽量放进 head 最前面：晚了就可能已经放行过一次请求
  if (cspMeta !== '') {
    if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (match) => `${match}\n${cspMeta}`);
    else if (/<html[^>]*>/i.test(html)) html = html.replace(/<html[^>]*>/i, (match) => `${match}\n<head>${cspMeta}</head>`);
    else html = `${cspMeta}\n${html}`;
  }

  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${bridge}\n</body>`);
  if (/<\/html>/i.test(html)) return html.replace(/<\/html>/i, `${bridge}\n</html>`);
  return `${html}\n${bridge}`;
}
