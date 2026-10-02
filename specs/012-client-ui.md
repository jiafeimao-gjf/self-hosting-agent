# SPEC-012 浏览器端界面（Surface UI）

状态：**已实现** · 上游：SPEC-011 §2–§3、SPEC-006

Kernel 侧已经有帧协议、事件日志、View Spec 渲染器与进程池；本规格只描述**人类真正打开的那个页面**：
一个离线可用的单页 Surface，跟 Agent 对话，并**亲眼看着 Agent 改自己的界面**。

## 1. 渲染器：`src/client/renderer.js`

浏览器拿不到服务端的 TS 模块，因此客户端保留一份**等价的纯 JS 渲染器**。它是**纯函数模块**：
输入 View Spec，输出 HTML 字符串，**不触碰任何 DOM**（所以 `node --test` 里能直接 import 断言）。

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `renderViewSpec` | `(spec, {title?}) → string` | 自包含 HTML 文档（沙箱 `srcdoc` / 落盘可开） |
| `renderFragment` | `(spec) → string` | 不带文档外壳的片段 |
| `escapeHtml` | `(value) → string` | 转义 `& < > " '`，所有文本与属性值都得过它 |
| `COMPONENT_TYPES` | `string[]` | 组件词汇表，镜像 `COMPONENT_SPECS` |

规则与服务端 `src/surface/renderer.ts` 同源：

1. **转义**：所有进入 HTML 的文本与属性值必须转义，包括 `data-emit` 这类属性；
2. **降级而非白屏**：未知组件（`data-unknown-component`）、非法节点（`data-invalid-spec`）、
   嵌套超过 32 层（`MAX_VIEW_DEPTH`）统统降级成占位块，不抛异常、不中断兄弟组件；
3. **自包含**：样式内联 + `:root` 令牌变量（`--ac-*`），不依赖外部 CSS 或字体。

组件词汇表是**唯一真相来源** `COMPONENT_SPECS` 的镜像：服务端加一个组件，客户端必须跟上，
否则漂移门禁（UI-002）失败。

## 2. 页面：`index.html` + `style.css`

单页、**离线可用**：只引用本服务 `src/client/` 内的 `/style.css`、`/app.js`、`/renderer.js`，
不引 CDN、不引远程字体、无 `@import`。

| 区域 | 元素 | 内容 |
| --- | --- | --- |
| 顶部栏 | `.topbar` | 标题、连接状态（`connecting` / `open` / `reconnecting` / `closed`）、界面版本号、回滚、中断 |
| 左栏 · 对话 | `#messages` `#composer` | 人类输入框（回车发送、Shift+回车换行）+ 消息流 |
| 右栏上 · 界面面板 | `#surface` | `<iframe sandbox="allow-scripts" srcdoc>`，版本号 `#surface-version` |
| 右栏下 · 检查器 | `#agents` `#tasks` `#timeline` | Agent 进程表（id/pid/存活）、任务板、事件时间线（按类型上色） |

视觉：深色科技风 —— 背景 `#05060a`，强调色青 `#22d3ee` 与紫 `#a78bfa`，
中文字体栈以 `PingFang SC` 打头；只使用本地字体与纯 CSS。

## 3. 渲染沙箱

Agent 给的 HTML **只进沙箱**：`<iframe sandbox="allow-scripts" srcdoc="...">`，不给 `allow-same-origin`，
因此界面代码跑在不透明源里，拿不到宿主页面的 DOM / 存储。

收到 SSE `document` 事件时**只更新 `srcdoc`**（并同步版本号），**绝不刷新宿主页面**：
没有 `location.reload()`、没有 `document.write()`。

## 4. 数据流：`app.js`

| 通道 | 用途 |
| --- | --- |
| `EventSource('/api/stream')` | 订阅 SSE，处理 `state` / `frame` / `document` / `done` 四类事件 |
| `POST /api/message` | `{text}` 人类输入交给 Lead |
| `POST /api/interrupt` | `{reason?}` 人类夺权 |
| `POST /api/rollback` | `{version}` 界面回滚到指定版本 |

事件与界面动作：

| 事件 | 界面动作 |
| --- | --- |
| `state` | 归一化快照：界面文档、进程表、任务板、消息、事件尾部全量刷新 |
| `frame` | `agent.thinking` → 左侧思考气泡；`tool.call` / `tool.result` → 摘要行；`loop.error` → 错误气泡；其余进时间线 |
| `document` | 只更新 `srcdoc` 与版本号 |
| `done` | 追加一条「本轮结束 / 已中断」提示 |

对话渲染规则：

- 人类消息靠右（`.msg-human`），Agent 与 `agent.thinking` 靠左（`.msg-agent` / `.msg-thinking`）；
- 工具调用是一条可读摘要行：**谁 · 调了什么 · ok / 失败 / 调用中**，失败时附错误文本；
- 时间线按事件类型上色：`ui.*` → 青（info）、`tool.*`/`host.tool.*` → 琥珀（warning）、
  `message.*` → 紫（strong）、含 `error`/`exit` → 红（danger）、`loop.*` → 灰（muted）；
- 进入 DOM 的所有文本都经过 `escapeHtml`。

`/api/state` 的字段名尚未在契约里冻结到字段级，`normalizeState()` 对常见别名
（`document|doc|ui`、`agents|processes|agentTable`、`tasks|taskboard|board`、`messages|conversation`、
`events|timeline|eventTail`）做防御性读取，缺字段退化成空列表 —— 服务端换个字段名不该让界面白屏。

## 验收标准

- **UI-001** `src/client/renderer.js` 是纯 ESM 纯函数模块：导出 `renderViewSpec` / `renderFragment` / `escapeHtml` / `COMPONENT_TYPES`，可在 Node 中直接 import，全程不触碰 DOM。
- **UI-002** `COMPONENT_TYPES` 与 `src/surface/viewspec.ts` 的 `Object.keys(COMPONENT_SPECS)` 完全一致（顺序与元素），且 8 种组件都有渲染实现、不会落进未知占位块。
- **UI-003** `renderViewSpec` 输出自包含 HTML 文档（内联 `--ac-*` 令牌、无外部依赖），`renderFragment` 输出不带外壳的片段，且所有文本与属性值（含 `data-emit`）都被转义。
- **UI-004** 未知组件降级为 `data-unknown-component` 占位块、非法节点与超深嵌套降级为 `data-invalid-spec`，对任意输入都不抛异常、不白屏，兄弟组件照常渲染。
- **UI-005** `index.html` + `style.css` 构成离线深色单页：不引任何远程资源，含顶部栏 / 对话栏 / 界面面板 / 检查器四区与全部必需元素 id，使用 `#05060a` 背景、`#22d3ee` 与 `#a78bfa` 强调色与 `PingFang SC` 字体栈。
- **UI-006** 界面面板用 `<iframe sandbox="allow-scripts" srcdoc>` 承载服务端 HTML；`document` 事件只更新 `srcdoc` 与版本号，宿主页面不刷新（无 `location.reload` / `document.write`）。
- **UI-007** `app.js` 用 `EventSource('/api/stream')` 订阅并处理 `state` / `frame` / `document` / `done` 四类事件，通过 `POST` 调用 `/api/message`、`/api/interrupt`、`/api/rollback`；在 Node 中 import 无副作用，`normalizeState` 对缺字段的坏输入退化为空。
- **UI-008** 对话流把人类消息靠右、`agent.thinking` 靠左，工具调用渲染成「谁 · 调了什么 · ok/失败」的摘要行，时间线按事件类型上色，且所有进入 DOM 的文本都经过 `escapeHtml`。
- **UI-011** 检查器可最小化：标题栏上的按钮收起/展开（`aria-expanded` / `aria-controls` 同步），收起时只留标题栏、腾出的高度给上半区，不做整页刷新；选择记在 localStorage，刷新后保持。
- **UI-010** 忙碌指示：Agent 干活期间对话区有可见反馈（脉动点 + 「已等 N 秒」），`done` 时立即收掉。真模型一轮可能几十秒，没有它人类会以为卡死。
- **UI-009** 首帧不会被吞：iframe 尚未完成初始加载时收到的 html 先记为待画、`load` 之后补画；`document` 事件强制重画；判定「要不要画」看的是**画没画上**而不是「内容变没变」。（真实故障：首帧赋值被 iframe 尚未完成的初始加载覆盖，缓存又认定「这份 html 画过了」，于是面板永久空白。）
