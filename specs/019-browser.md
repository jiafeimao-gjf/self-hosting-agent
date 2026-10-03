# SPEC-019 内置浏览器模块

状态：**已实现**

## 它解决什么

界面面板只能渲染「View Spec → 我们自己的组件 → HTML」，模型想画点别的（图表、表单、一段现成的网页、带 JS 的小工具）就无路可走。更关键的是：**沙箱里的交互是死的**——人类在 Agent 画出来的界面里点了按钮，Agent 毫不知情。

内置浏览器模块补上这两件事：

1. **独立渲染 HTML 文件**：不经过 View Spec 管线——渲染的是**工作空间里真实存在的 .html 文件**；
2. **执行文档里的交互**：脚本真的跑，点击/提交/自定义事件经桥回传，能送到 Agent 手上让它反应。

「独立」是关键字：它是**另一个**沙箱（浏览器面板），与界面面板并存，互不覆盖。

## 一、整体链路

```
Agent ──workspace.write──▶ 工作空间里的 .html 文件      ← Agent 只能"写文件"
                                    │  人点「在浏览器打开」/ `/browse`
                                    ▼
                        BrowserHost 组合文档（注入桥 + 默认断网 CSP）
                                    ▼
              SSE `browser` {version,title,html,path} ──▶ 客户端浏览器面板（沙箱 iframe）
                        ▲                                    │
                        │                             人类点按钮 / AgentClient.emit
                        │                                    ▼
              POST /api/browser/event ◀──────────── postMessage（只认本 iframe 的 window）
                        │  校验 → 落事件日志 → 以 browser.event 帧送达 Lead
                        ▼
                  Agent 收到「人类在浏览器里点了 X」，据此回应
```

## 二、沙箱与安全（这是本规格最要紧的部分）

- iframe **只开 `allow-scripts`**。**绝不能**再开 `allow-same-origin`——两者同时开等于沙箱失效（文档可以把自己变成同源、进而摸到宿主 DOM）。
- 桥的入口只认结构化消息：`__ac === 1`、channel 匹配、kind 在白名单内、payload 可序列化且不超限。**非本 iframe window 发来的消息一律丢弃。**
- 校验分两道，别混：
  | 入口 | 校验什么 | 为什么 |
  | --- | --- | --- |
  | 窗口消息（`acceptBridge`） | 信封 + 本体 | 挡的是「别的窗口/iframe 冒充」，信封只在窗口边界有意义 |
  | HTTP 入口（`acceptEvent`） | 只校验本体 | 客户端按契约只发 `{kind,name,payload}`；这里没有窗口可冒充 |

  （这条是踩过坑才写下的：宿主最初在 HTTP 入口也要求信封，于是客户端**正确地**剥掉信封之后，
  整条回流链路断在宿主这一侧。）
- 默认**断网**：注入 `Content-Security-Policy: default-src 'none'`（放行内联样式与内联脚本，因为交互要跑）。要联网必须显式 `allowNetwork: true`。
- HTML 与事件都有字节上限，超限直接拒绝而不是截断（截断出来的 HTML 更危险）。

## 三、桥（注入到每个文档里）

宿主把 `BOOTSTRAP` 脚本注入文档，它对文档暴露一个最小 API：

| 能力 | 用法 |
| --- | --- |
| 声明式 | 元素上加 `data-ac-emit="导出"`（可选 `data-ac-payload='{"fmt":"csv"}'`），点击/提交即上报 |
| 命令式 | `AgentClient.emit(name, payload)` |
| 日志 | `AgentClient.log(...)`、`console.log` 自动转发 |
| 错误 | `window.onerror` / `unhandledrejection` 自动转发 |

回传消息统一形如 `{__ac:1, channel:'agent-client:browser', kind, ...}`。

## 验收标准

- **BROWSER-001** `BrowserHost.render({html})` 独立渲染任意 HTML：返回递增版本号与标题，**不影响** View Spec 界面文档。
- **BROWSER-002** 空 HTML、非字符串、超过字节上限（256KB）一律拒绝，错误码明确。
- **BROWSER-003** 组合文档：HTML 碎片被包成完整文档；已是完整文档则就地注入；桥脚本必须出现在组合结果里。
- **BROWSER-004** 默认断网：组合结果含 `default-src 'none'` 的 CSP；`allowNetwork: true` 时不注入该 CSP。
- **BROWSER-005** 桥入口校验：非对象 / `__ac` 缺失 / kind 不在白名单 / emit 缺 name / 超限，逐条拒绝并给出错误码。
- **BROWSER-006** 声明式交互：桥脚本监听 click 与 submit，读取 `data-ac-emit` 与 `data-ac-payload` 后上报。
- **BROWSER-007** 命令式交互与日志：桥暴露 `AgentClient.emit/log`，并转发 `console.log`、`window.onerror`、`unhandledrejection`。
- **BROWSER-008** 浏览器面板的入口是 `POST /api/browser/open {path}`：渲染工作空间里的 `.html`/`.htm`；
  非 HTML（`NOT_HTML`）、不存在（`NOT_FOUND`）、越界（`PATH_ESCAPE`）、空路径（`BAD_PATH`）都被拒；
  文档带上来源 `path` 与组合好的桥脚本；每打开一份就前进一个版本。
- **BROWSER-013** **Agent 手里没有"往界面塞 HTML"的工具**：`browser.render` 已从工具表与子进程自述里移除，
  浏览器面板的入口只剩"打开人指定的 HTML 文件"；渲染引擎、桥、沙箱能力一个都没少。
- **BROWSER-009** 人类交互送达 Agent：`POST /api/browser/event` 校验后写进事件日志（`browser.event`），并以 `browser.event` 帧投递给 Lead；非法事件返回 400 且不落日志。
- **BROWSER-010** 子进程收到 `browser.event` 帧后，把它作为一条**人类来源的消息**注入本轮上下文（Agent 能据此行动）。
- **BROWSER-011** 客户端浏览器面板独立于界面面板：沙箱属性只含 `allow-scripts`；消息必须来自该 iframe 的 window；面板显示文档标题与版本。
- **BROWSER-012** 端到端：脚本模型渲染 HTML → 人类点击 → 事件回传 → Agent 收到并回应下一轮。

- **BROWSER-014** 写进沙箱的文档必须**真的画出来**：`srcdoc` 赋值后 iframe 有时加载了却不重绘
  （属性对、`load` 也触发，画面一直空白），必须在**加载完成之后**让它消失一帧再回来把画面顶出来；
  且顶帧不能早于加载（导航没起来就藏起来会把这次导航撤掉）。

## 非目标（本阶段不做）

- 真实 URL 导航（地址栏、历史前进后退）——需要 allow-same-origin 之外的网络策略，单独立规格；
- 多标签页；
- 真实 URL 导航；
- 把浏览器 DOM 结构暴露给 Agent（只回传事件，不回传 DOM，避免上下文爆炸）。
