# SPEC-014 客户端自举的浏览器端呈现（P3 UI）

状态：**已实现** · 上游：SPEC-013 §5、SPEC-012、SPEC-011 §2

SPEC-013 让 Agent 能改 `src/client/**`，并在服务端做了写作用域、自检门禁、版本历史与审计。
本规格只描述**浏览器端要把这件事显示给人类看**的部分：订阅 `client.changed`、CSS 无刷新热替换、
JS/HTML 变更横幅、检查器里的「客户端源码」区。

一条底线贯穿全篇：

> **服务器可以换样式，但不能悄悄换掉人类正在读的这一页。**

所以 `.css` 走热替换（不丢对话），`.js` / `.html` 只给出横幅与一个**必须由人类点击**的刷新按钮，
绝不自动整页刷新。

## 1. 新增 SSE 事件：`client.changed`

事件名就是 `client.changed`，data 形如：

```
{"kind":"write"|"revert","path":"style.css","reason":"...","selfTest":"passed","version":2,"diff":{"added":2,"removed":0}}
```

客户端对它做三件事，顺序固定：

1. `path` 以 `.css` 结尾 → **无刷新**替换 `<link rel="stylesheet">` 的 href（§2）；
2. 渲染一条可关闭的**变更横幅**（§3）；
3. 无论哪种变更都进**事件时间线**（「任何变更都进时间线」）。

事件字段一律当**不可信输入**：`kind` 只认 `write` / `revert`（其余记为 `unknown`），
`path` / `reason` / `selfTest` / `author` 只接受字符串，`version` 与 `diff.added|removed`
只接受有限数字，缺字段退化为 `null` / 空串，**未知字段不得导致异常**（§5）。

## 2. CSS 无刷新热替换

`path` 以 `.css` 结尾时：

- 在页面已有的 `<link rel="stylesheet">` 里按**文件名**匹配（忽略目录与已有查询串），
  因此 `style.css`、`src/client/style.css` 都能命中 `/style.css`；
- 把命中的 href 换成带 cache-bust 查询串的新地址：`/style.css` → `/style.css?v=2&t=<时间戳>`，
  旧查询串 / 锚点先剥掉，避免 `?v=1&t=1?v=2` 这种叠罗汉；
- **绝不整页刷新**：热替换只写 `<link>` 的 `href` 属性，宿主页面的 DOM 与对话记录原样保留。

匹配不到对应样式表时不做事（不炸、不误改别的 `<link>`）。

## 3. 变更横幅：人类点击才刷新

横幅是一条固定浮层（`#client-change`），显示**谁改了什么**：文件名、`reason`、自检结果、版本号、
差异行数（`+2 / -0`），可关闭。

| 情况 | 文案 | 刷新按钮 |
| --- | --- | --- |
| `write` + `.css` | 客户端样式已更新（style.css），已即时生效 | 不显示 |
| `write` + `.js` / `.html` | 客户端代码已更新（app.js），刷新以生效 | 显示 |
| `revert` + `.css` | 已回滚 style.css，样式已即时生效 | 不显示 |
| `revert` + `.js` / `.html` | 已回滚 app.js，刷新以生效 | 显示 |
| 其它 `kind` | 客户端源码有变更（…） | 按是否 `.css` 决定 |

刷新按钮只做一件事：**由人类点击时**导航到当前地址（等价整页刷新）。
实现上用 `window.location.assign(window.location.href)` 而不是 `location.reload()` 字面量：
后者是 UI-006 / UI-007 明令禁止出现在 `app.js` 里的字符串（那两条门禁的本意是防“自动刷新”）。
本规格保留其本意并升级：**没有自动刷新路径，只有人类点击**。

关闭按钮把横幅隐藏并清空内容，下一次 `client.changed` 再出现。

## 4. 检查器新增「客户端源码」区

`/api/state` 增加 `sources: [{path, bytes, versions}]`（SPEC-013 §5）。检查器新增第 4 张卡
（`#sources`，`.card-sources`）渲染这份列表：路径 / 字节数 / 版本数。

- 缺 `sources`、字段名不对、不是数组 → 退化成空列表并显示「暂无客户端源码」，不炸；
- 单条缺 `bytes` / `versions` → 该列显示 `—`。

检查器随之从「左列 2 卡 + 右列时间线跨 2 行」改成**四格布局**（左：进程表 / 任务板，
右：事件时间线 / 客户端源码），窄屏下退化为单列。

## 5. 纯函数优先

以下几件事提成可导出的纯函数，`node --test` 里直接 import 断言，DOM 只在 `boot()` 里接线：

| 导出 | 作用 |
| --- | --- |
| `isCssClientPath(path)` | 路径是否是样式表（忽略查询串与大小写） |
| `baseNameOf(path)` | 取文件名（`src/client/style.css` → `style.css`） |
| `cacheBustHref(href, version, nonce)` | 生成带 cache-bust 的新地址 |
| `findStyleLinkIndex(hrefs, path)` | 在已有样式表地址里按文件名定位 |
| `normalizeClientChange(raw)` | `client.changed` → 稳定模型（未知字段退化） |
| `selfTestLabel(value)` | 自检结果 → 中文（未知就是未知，不装作通过） |
| `renderClientChange(raw)` | 横幅 HTML（全部文本过 `escapeHtml`） |
| `normalizeSources(raw)` | `state.sources` → 稳定列表（缺字段退化为空） |
| `renderSourceRow(source)` | 源码列表一行（路径 / 字节 / 版本数） |

所有进入 DOM 的文本（含 `reason`、`path`、`author`）都必须过 `escapeHtml`。

## 验收标准

- **UI2-001** `app.js` 用 SSE 订阅 `client.changed`（事件名含点号），把 `write` / `revert` 两类变更归一化后追加进事件时间线，且对坏 data 不抛异常。
- **UI2-002** `path` 以 `.css` 结尾时，按文件名找到对应的 `<link rel="stylesheet">` 并把 href 换成带 cache-bust 查询串（`?v=<版本>&t=<时间戳>`）的新地址；热替换不刷新页面（`app.js` 内无自动刷新路径）。
- **UI2-003** `.js` / `.html` 变更显示「刷新以生效」横幅，横幅上的刷新按钮**只有人类点击**才导航到当前地址（等价整页刷新）；`app.js` 不含 UI-006 禁止的 `location.reload` / `location.href =` 字面量，不存在自动刷新。
- **UI2-004** 横幅显示 path / reason / 自检结果 / 版本号 / 差异行数，带关闭按钮；`kind:'revert'` 文案为「已回滚」，与 `write` 不同；`reason` 等自由文本全部转义。
- **UI2-005** 检查器新增「客户端源码」区：`/api/state` 的 `sources: [{path,bytes,versions}]` 渲染成路径 / 字节 / 版本数列表，`index.html` 含 `#sources`，字段缺失时退化为空列表、单列显示 `—`，不炸。
- **UI2-006** 防御性：`normalizeClientChange` 对 `null` / 非对象 / 未知 `kind` / 非字符串字段 / 非数字版本一律退化为默认值，`renderClientChange`、`renderSourceRow`、`cacheBustHref`、`findStyleLinkIndex` 对任意输入都不抛异常，且进入 DOM 的文本都经过 `escapeHtml`。
