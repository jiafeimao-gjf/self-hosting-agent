# 规格 ⇄ 测试 追溯矩阵

> 由 `node scripts/trace.mjs` 自动生成，**请勿手工修改**。

| 验收标准 | 规格文件 | 说明 | 覆盖测试 |
| --- | --- | --- | --- |
| **ANTH-001** | specs/016-anthropic-model.md | `createAnthropicModel` 返回可用的 `ModelPort`：请求发往 `{baseUrl}/v1/messages`（`baseUrl` 尾部斜杠被归一化），带 `x-api-key`、`anthropic-version`（默认 `2023-06-01`，可覆盖）与 JSON 内容类型；请求体含 `model`，且 `max_tokens` 缺省为 `4096`。 | `test/anthropic-model.test.ts` · createAnthropicModel 把请求发到 {baseUrl}/v1/messages，带 x-api-key / anthropic-version，max_tokens 缺省为 4096 |
| **ANTH-002** | specs/016-anthropic-model.md | `role: 'system'` 的上下文全部提到请求体顶层 `system` 字段（多条按顺序用 `\n\n` 拼接），且不出现在 `messages` 中；没有 system 项时不发送 `system` 字段。 | `test/anthropic-model.test.ts` · system 上下文合并进请求体顶层 system 字段，且不出现在 messages 里 |
| **ANTH-003** | specs/016-anthropic-model.md | `human` 映射为 `{ role: 'user', content: [{ type: 'text', text }] }`，`assistant` 映射为 `{ role: 'assistant', content: [{ type: 'text', text }] }`。 | `test/anthropic-model.test.ts` · human/assistant 上下文映射为 text 内容块消息 |
| **ANTH-004** | specs/016-anthropic-model.md | `peer` 映射为 `user` 的文本块，文本前缀 `[来自 <from>] `，来源取自 `meta.from`，缺失时为 `peer`；相邻 user 消息被合并为一条消息的多个文本块。 | `test/anthropic-model.test.ts` · peer 转 user 并前缀标注来源（缺失时用 peer），相邻 user 消息合并为一条 |
| **ANTH-005** | specs/016-anthropic-model.md | `role: 'tool'` 映射为 `user` 消息的 `{ type: 'tool_result', tool_use_id: meta.id, content: text }` 块；`meta.id` 缺失时**不伪造 id**，降级为同一条 user 消息里的 `[工具结果] <text>` 文本块。 | `test/anthropic-model.test.ts` · tool 上下文映射为 user 消息的 tool_result 块；meta.id 缺失时不伪造 id 而降级为文本块 |
| **ANTH-006** | specs/016-anthropic-model.md | 连续多条工具结果被合并进**同一条** user 消息的多个 `tool_result` 块（不产生连续多条 user 消息），满足 Anthropic 的 user/assistant 交替要求。 | `test/anthropic-model.test.ts` · 连续多条工具结果合并进同一条 user 消息的多个 tool_result 块 |
| **ANTH-007** | specs/016-anthropic-model.md | `ToolSpec[]` 映射为 `tools[{ name, description, input_schema }]`，`input_schema` 为空对象 schema，`description` 缺失时给空串；工具为空时不发送 `tools` 字段。 | `test/anthropic-model.test.ts` · ToolSpec 映射为 tools[{name, description, input_schema}]，无工具时不发 tools 字段 |
| **ANTH-008** | specs/016-anthropic-model.md | `maxTokens` 映射为 `max_tokens`（覆盖默认 `4096`），`temperature` 只有显式给出时才发送（`0` 也必须被发送）。 | `test/anthropic-model.test.ts` · maxTokens 映射为 max_tokens，temperature 只有显式给出才发送（0 也是有效值） |
| **ANTH-009** | specs/016-anthropic-model.md | 响应 `content` 数组的 `text` 块按顺序用 `\n` 拼接为 `text`，未知类型块被跳过，全空时 `text` 为 `undefined`；`tool_use` 块映射为 `toolCalls`，`input` 作为对象直接使用（不 `JSON.parse`），`id` 缺失时补 `toolu_<index>`。 | `test/anthropic-model.test.ts` · 解析 content 的 text 块（按 \\n 拼接、跳过未知块）与 tool_use 块（input 已是对象，不 JSON.parse） |
| **ANTH-010** | specs/016-anthropic-model.md | `usage.input_tokens + usage.output_tokens` → `usage.tokens`（无 usage 时不产生该字段）；终止约定：有待办动作 → `done: false`，纯文本 → `done: true`，两者皆无 → `done` 为 `undefined`。 | `test/anthropic-model.test.ts` · usage 的 input_tokens + output_tokens 合成 tokens；终止约定按待办动作与文本判定 |
| **ANTH-011** | specs/016-anthropic-model.md | 响应不可信（响应体不是 JSON、缺少 `content` 数组、`tool_use` 缺少 `name`、`tool_use.input` 不是对象）时抛 `AnthropicModelError`（`kind: 'bad_response'`）；非 2xx 抛 `AnthropicModelError`（`kind: 'http'`）并携带 `status` 与截断后的响应片段 `bodySnippet`。 | `test/anthropic-model.test.ts` · 响应不可信抛 bad_response；非 2xx 抛带 status 与响应片段的 http 错误 |
| **ANTH-012** | specs/016-anthropic-model.md | 超过 `timeoutMs` 时用 `AbortController` 中止请求并抛 `AnthropicModelTimeoutError`（含 `timeoutMs`，不重试）；429、5xx 与网络错误按 `maxRetries` 以 `retryBaseDelayMs * 2^n` 退避重试，用尽后抛出最后一次错误；非 429 的 4xx 不重试。 | `test/anthropic-model.test.ts` · 超时用 AbortController 中止且不重试；429/5xx/网络错误退避重试；非 429 的 4xx 不重试 |
| **ANTH-013** | specs/016-anthropic-model.md | 助手消息带 `toolCalls` 时输出 `tool_use` 内容块（`input` 为对象），与文本块同处一条 assistant 消息，使后续 `tool_result` 的 `tool_use_id` 有对应项。 | `test/anthropic-model.test.ts` · 助手消息带 toolCalls 时输出 tool_use 块，tool_result 与之配对 |
| **ANTH-014** | specs/016-anthropic-model.md | 工具名出网合法：与 OpenAI 侧同样只接受 `[a-zA-Z0-9_-]`，出网改名、回程还原。 | `test/anthropic-model.test.ts` · 工具名出网必须合法：Anthropic 同样只接受 [a-zA-Z0-9_-] |
| **ARCH-001** | specs/000-architecture.md | 四层目录 `src/surface`、`src/protocol`、`src/runtime`、`src/kernel` 必须存在且各自可被独立导入。 | `test/architecture.test.ts` · 四层目录齐备，且每层都能被独立导入 |
| **ARCH-002** | specs/000-architecture.md | 依赖方向：`src/protocol` 不 import 任何其它层；`src/surface` 不 import kernel/runtime/loop；`src/loop` 不 import kernel。 | `test/architecture.test.ts` · 依赖方向：协议层最底层，界面层拿不到系统权限，Loop 不能反向控制内核 |
| **ARCH-003** | specs/000-architecture.md | 架构中的「一个 Agent 一个子进程」必须可被观测：Kernel 拉起的 Agent 有独立 pid，且 pid 与宿主不同。 | `test/kernel.test.ts` · spawn 拉起独立子进程：pid 与宿主不同，能读到子进程发出的帧 |
| **ARCH-004** | specs/000-architecture.md | 跨层数据只能是 `src/protocol` 定义的帧类型：所有 `ui.patch` / `human.message` 等字面量必须来自帧规格表。 | `test/architecture.test.ts` · 跨层数据只能是协议帧：src 里出现的帧字面量必须都在帧表里 |
| **ARCH-005** | specs/000-architecture.md | 每条规格的验收标准都必须被至少一个测试引用（由 `scripts/trace.mjs` 强制）。 | `test/architecture.test.ts` · 规格追溯门禁必须通过：每条验收标准都有测试守着 |
| **BROWSER-001** | specs/019-browser.md | `BrowserHost.render({html})` 独立渲染任意 HTML：返回递增版本号与标题，**不影响** View Spec 界面文档。 | `test/browser.test.ts` · render 独立渲染任意 HTML：版本号自成一路，不影响 View Spec 界面文档 |
| **BROWSER-002** | specs/019-browser.md | 空 HTML、非字符串、超过字节上限（256KB）一律拒绝，错误码明确。 | `test/browser.test.ts` · 空 HTML / 非字符串 / 超过字节上限一律拒绝，错误码明确 |
| **BROWSER-003** | specs/019-browser.md | 组合文档：HTML 碎片被包成完整文档；已是完整文档则就地注入；桥脚本必须出现在组合结果里。 | `test/browser.test.ts` · 组合文档：碎片补成完整文档、完整文档就地注入，两种情况都带桥 |
| **BROWSER-004** | specs/019-browser.md | 默认断网：组合结果含 `default-src 'none'` 的 CSP；`allowNetwork: true` 时不注入该 CSP。 | `test/browser.test.ts` · 默认断网（CSP），显式 allowNetwork 才放开 |
| **BROWSER-005** | specs/019-browser.md | 桥入口校验：非对象 / `__ac` 缺失 / kind 不在白名单 / emit 缺 name / 超限，逐条拒绝并给出错误码。 | `test/browser.test.ts` · 事件入口硬校验：kind 白名单 / name / 超限，逐条拒绝<br>`test/browser.test.ts` · 窗口消息形态多一层信封校验：缺 __ac / channel 不对一律拒绝 |
| **BROWSER-006** | specs/019-browser.md | 声明式交互：桥脚本监听 click 与 submit，读取 `data-ac-emit` 与 `data-ac-payload` 后上报。 | `test/browser.test.ts` · 声明式交互：桥监听 click 与 submit，读取 data-ac-emit / data-ac-payload<br>`test/client-browser-ui.test.ts` · 声明式交互：桥上报的 emit（data-ac-emit / data-ac-payload）原样转成 POST /api/browser/event |
| **BROWSER-007** | specs/019-browser.md | 命令式交互与日志：桥暴露 `AgentClient.emit/log`，并转发 `console.log`、`window.onerror`、`unhandledrejection`。 | `test/browser.test.ts` · 命令式交互与日志：AgentClient.emit/log 与 console/error 转发<br>`test/client-browser-ui.test.ts` · 命令式与日志转发：emit / log / error 三类消息都转成 POST，进 DOM 的文本全部转义<br>`test/client-browser-ui.test.ts` · 面板控制器接上假 DOM：只有本 iframe 的消息才变成 POST，来源不对完全静默 |
| **BROWSER-008** | specs/019-browser.md | 浏览器面板的入口是 `POST /api/browser/open {path}`：渲染工作空间里的 `.html`/`.htm`； | `test/browser.test.ts` · 浏览器面板的入口是「打开 HTML 文件」：非 HTML / 不存在 / 越界都被拒 |
| **BROWSER-009** | specs/019-browser.md | 人类交互送达 Agent：`POST /api/browser/event` 校验后写进事件日志（`browser.event`），并以 `browser.event` 帧投递给 Lead；非法事件返回 400 且不落日志。 | `test/browser.test.ts` · 人类交互回流：合法事件落日志并投给 Lead，非法事件 400 且不落日志 |
| **BROWSER-010** | specs/019-browser.md | 子进程收到 `browser.event` 帧后，把它作为一条**人类来源的消息**注入本轮上下文（Agent 能据此行动）。 | `test/browser.test.ts` · 子进程收到 browser.event 帧后，把它作为人类来源的消息注入本轮上下文 |
| **BROWSER-011** | specs/019-browser.md | 客户端浏览器面板独立于界面面板：沙箱属性只含 `allow-scripts`；消息必须来自该 iframe 的 window；面板显示文档标题与版本。 | `test/client-browser-ui.test.ts` · 浏览器面板是独立的第二个沙箱：只开 allow-scripts，与界面面板并存，已有 id 不变<br>`test/client-browser-ui.test.ts` · 桥消息只认本 iframe 的 window + __ac 标记 + 通道 + kind 白名单，其余一律丢弃<br>`test/client-browser-ui.test.ts` · 面板显示文档标题与版本；没有文档时是空态，坏输入不报错<br>`test/client-browser-ui.test.ts` · 首帧与空态：没画上就要再画，没有文档就清空沙箱而不是沿用旧内容<br>`test/client-browser-ui.test.ts` · 面板控制器接上假 DOM：只有本 iframe 的消息才变成 POST，来源不对完全静默 |
| **BROWSER-012** | specs/019-browser.md | 端到端：脚本模型渲染 HTML → 人类点击 → 事件回传 → Agent 收到并回应下一轮。 | `test/browser.test.ts` · 端到端：Agent 写 HTML 文件 → 人打开渲染 → 点击回流给 Agent |
| **BROWSER-013** | specs/019-browser.md | **Agent 手里没有"往界面塞 HTML"的工具**：`browser.render` 已从工具表与子进程自述里移除， | `test/browser.test.ts` · Agent 不再有「往界面塞 HTML」的工具：browser.render 已移除 |
| **BROWSER-014** | specs/019-browser.md | 写进沙箱的文档必须**真的画出来**：`srcdoc` 赋值后 iframe 有时加载了却不重绘 | `test/client-browser-ui.test.ts` · 写进沙箱的文档必须真的画出来：加载完成后强制重绘一帧 |
| **CLI-001** | specs/011-client.md | `GET /api/state` 返回界面文档、进程表、任务板、消息与事件尾部，字段齐全且可 JSON 解析。 | `test/server.test.ts` · GET /api/state 返回界面文档、进程表、任务板、消息与事件尾部 |
| **CLI-002** | specs/011-client.md | `GET /api/stream` 建立 SSE 连接后，先收到一次 `state` 快照。 | `test/server.test.ts` · SSE 建立连接后先收到一次 state 快照 |
| **CLI-003** | specs/011-client.md | `POST /api/message` 把人类输入交给 Lead，Agent 的帧通过 SSE 以 `frame` 事件实时推给客户端。 | `test/server.test.ts` · POST /api/message 把人类输入交给 Lead，帧通过 SSE 实时推流 |
| **CLI-004** | specs/011-client.md | Agent 发出 `ui.patch` 后，客户端收到 `document` 事件，且其中的 HTML 含该组件、版本号前进（**不刷新页面**）。 | `test/server.test.ts` · Agent 改界面后客户端收到 document 事件，版本前进且 HTML 含该组件 |
| **CLI-005** | specs/011-client.md | `POST /api/interrupt` 让正在跑的一轮在最近边界停下，SSE 收到 `done{reason:'interrupted'}`。 | `test/server.test.ts` · POST /api/interrupt 让在跑的一轮在边界停下，SSE 收到 done{interrupted} |
| **CLI-006** | specs/011-client.md | `POST /api/rollback` 把界面文档退回指定版本，并广播新的 `document` 事件。 | `test/server.test.ts` · POST /api/rollback 把界面退回指定版本并广播新的 document 事件 |
| **CLI-007** | specs/011-client.md | 静态资源只允许 `src/client/` 内的文件：路径穿越（`../`）被拒绝。 | `test/server.test.ts` · 静态资源只允许 src/client 目录内：路径穿越被拒绝 |
| **CLI-008** | specs/011-client.md | 多轮记忆：第二轮请求的上下文包含第一轮的人类消息与 Agent 回复（由事件日志投影）。 | `test/server.test.ts` · 多轮记忆：第二轮上下文包含第一轮的人类消息与 Agent 回复（事件日志投影） |
| **CLI-009** | specs/011-client.md | 模型不可用时（HTTP 端口报错）客户端收到可读的错误帧，服务本身不崩。 | `test/server.test.ts` · 模型不可用时客户端收到可读的错误帧，服务本身不崩 |
| **CLI-010** | specs/011-client.md | 服务端可以只监听 127.0.0.1（默认），不对外暴露。 | `test/server.test.ts` · 默认只监听 127.0.0.1，不对外暴露 |
| **CLI-011** | specs/011-client.md | `POST /api/client/revert` 让人类**不必经过 Agent** 就能把被改过的客户端源码回滚（架构底线：人类永远能一键回滚）。 | `test/server.test.ts` · POST /api/client/revert 让人类不经过 Agent 就能回滚客户端源码 |
| **CLI-012** | specs/011-client.md | `/api/state` 的 `messages` 是**完整对话投影**（人类消息 + Agent 说过的话，按时间归并）。前端会据此整体重建对话流，只投影邮件类消息会把 Agent 的回复冲掉。 | `test/server.test.ts` · 对话投影同时包含人类消息与 Agent 说过的话（只投影邮件会冲掉回复） |
| **CLI-013** | specs/011-client.md | 清空边界必须**分别**作用于两份日志：宿主日志与子进程日志的 `seq` 是**独立号段**，拿宿主的边界去过滤子进程的 `agent.thinking` 会把回复整条吃掉（真 bug：流式输出结束后整条消息消失）。 | `test/conversations.test.ts` · 清空边界必须分别作用于两份日志：宿主 seq 涨得快也不能吃掉子进程的回复 |
| **CMD-001** | specs/020-conversations.md | `/help` 列出全部命令，且每条命令都真的存在（表中没有幽灵命令）。 | `test/client-conversations-ui.test.ts` · /help 走命令通道，output 渲染成与人类 / Agent 消息不同款的系统消息<br>`test/conversations.test.ts` · /help 列出全部命令，且表里没有幽灵命令 |
| **CMD-002** | specs/020-conversations.md | `/clear` 清空可见对话与上下文，但**不删磁盘上的历史**；清空后投影只剩清空之后的内容，Agent 下一轮也看不到清空前的对话。 | `test/conversations.test.ts` · /clear 清空显示与上下文，但磁盘上的历史一个字都不删 |
| **CMD-003** | specs/020-conversations.md | `/history` 导出 Markdown 到 `history/` 目录，返回真实存在的路径与行数；`/history list` 能列出来。 | `test/conversations.test.ts` · /history 真的落盘，/history list 能列出来 |
| **CMD-004** | specs/020-conversations.md | `/new` 新建并切换，`/list` 列出，`/switch <id>` 切换；切换通过 `action` 告知客户端。 | `test/client-conversations-ui.test.ts` · 命令 action：switch / created 切到目标对话，cleared 只重画当前对话<br>`test/conversations.test.ts` · /new 新建并切换、/list 列出、/switch 切换，并通过 action 告知客户端 |
| **CMD-005** | specs/020-conversations.md | 未知命令返回明确错误，且**不会**被当成消息送给模型（不产生 `mail.message`，不惊动 Agent）。 | `test/client-conversations-ui.test.ts` · 未知命令绝不发给模型：任何 / 前缀都走 /api/command，失败结果也渲染成可见系统消息<br>`test/conversations.test.ts` · 未知命令明确报错，且绝不被当成消息送给模型 |
| **CMD-006** | specs/020-conversations.md | 命令不依赖模型：整个过程不发生模型调用（用假模型/脚本模型也能跑通）。 | `test/conversations.test.ts` · 命令完全不依赖模型：脚本模型下也能跑通全部命令 |
| **CMD-007** | specs/020-conversations.md | 命令对空参数/多余参数的处理明确：`/switch` 缺参数报错，`/new a b c` 以剩余文本为标题。 | `test/conversations.test.ts` · 参数处理明确：/switch 缺参数报错，/new 以剩余文本为标题<br>`test/conversations.test.ts` · parseCommand 只认行首斜杠，其余当普通消息 |
| **CONV-001** | specs/020-conversations.md | `ConversationRegistry` 按 id 惰性创建会话：同一 id 两次拿到同一实例，不同 id 互不相同，且各自 `dir` 在 `<root>/conversations/<id>` 下。 | `test/conversations.test.ts` · 注册表按 id 惰性开门：同 id 同实例，不同 id 不同实例，目录在 conversations/<id> 下 |
| **CONV-002** | specs/020-conversations.md | 新建对话返回合法 id 与标题；省略标题时给默认标题；id 冲突时自动避让而不是覆盖已有对话。 | `test/conversations.test.ts` · 新建对话：合法 id、默认标题、冲突自动避让 |
| **CONV-003** | specs/020-conversations.md | 非法 id（超长、大写、`..`、路径分隔符）一律拒绝，不接受客户端指定任意目录。 | `test/conversations.test.ts` · 非法 id 一律拒绝：超长、大写、.. 、路径分隔符 |
| **CONV-004** | specs/020-conversations.md | `GET /api/conversations` 列出全部对话并标出 active；`POST` 新建后 active 指向新对话；`DELETE` 删除后不再出现，且默认对话不可删。 | `test/client-conversations-ui.test.ts` · 对话切换器：列出全部对话并标出 active，新建 / 删除都走冻结契约<br>`test/conversations.test.ts` · 对话列表 / 新建 / 删除：active 跟着走，默认对话不可删 |
| **CONV-005** | specs/020-conversations.md | 不传 `conversation` 时所有既有路由都作用在 `default` 上（向后兼容）。 | `test/conversations.test.ts` · 不传 conversation 时所有路由作用在 default 上（向后兼容） |
| **CONV-006** | specs/020-conversations.md | 每个对话的事件流互不串扰：给 A 发消息只会在 A 的流上看到事件。 | `test/client-conversations-ui.test.ts` · 每个对话一条独立 SSE：切换时关旧流、按新 id 重开，事件不串扰<br>`test/conversations.test.ts` · 对话之间的事件流互不串扰 |
| **CONV-007** | specs/020-conversations.md | 切换对话不丢状态：A 渲染过界面文档后切到 B 再切回 A，A 的文档版本与内容原样还在。 | `test/client-conversations-ui.test.ts` · 切走再切回：本地绘制缓存作废并重新拉取该对话的 state，界面文档原样重画<br>`test/conversations.test.ts` · 切换对话不丢状态：A 的界面文档切走再切回来原样还在 |
| **CONV-008** | specs/020-conversations.md | 删除对话会回收它的 Agent 子进程（不留孤儿）。 | `test/conversations.test.ts` · 删除对话会回收它的 Agent 子进程，不留孤儿 |
| **CONV-009** | specs/020-conversations.md | 前后端版本漂移要可诊断：新客户端打在缺这些接口的旧服务端上会拿到 404/405，此时必须明确提示「服务端是旧版本，重启后再试」，而不是甩一个 `METHOD_NOT_ALLOWED`；对话/文件/命令三条路径口径一致。 | `test/client-conversations-ui.test.ts` · 版本漂移要可诊断：旧服务端 404/405 明确提示重启，而不是吐 METHOD_NOT_ALLOWED |
| **DIAG-001** | specs/018-diagnostics.md | 记录器按级别过滤：低于阈值的记录既不落盘也不进 sink；每条含 `ts/level/scope/message`，可带结构化 `data`。 | `test/logging.test.ts` · 记录器按级别过滤，每条含 ts/level/scope/message 且可带结构化 data |
| **DIAG-002** | specs/018-diagnostics.md | 记日志失败不影响主流程：目录不可写时自动退化为内存日志，调用方不抛异常。 | `test/logging.test.ts` · 记日志失败不影响主流程：目录建不出来就退化为内存日志，调用方不抛异常 |
| **DIAG-003** | specs/018-diagnostics.md | 子进程 stderr 被消费：内容逐行写入诊断日志，且带 `agent:<id>` 标签（补之前它没有任何订阅者）。 | `test/logging.test.ts` · 子进程 stderr 被消费：逐行写进诊断日志并带 agent 标签 |
| **DIAG-004** | specs/018-diagnostics.md | stderr 缓冲有上限：只保留尾部，长会话不会无限增长。 | `test/logging.test.ts` · stderr 缓冲有上限：只留尾部，长会话不会无限增长 |
| **DIAG-005** | specs/018-diagnostics.md | HTTP 访问日志：每条请求记录 method / path / status / 耗时；5xx 为 error 级。 | `test/logging.test.ts` · HTTP 访问日志：记录 method/path/status/耗时，4xx 记 warn |
| **DIAG-006** | specs/018-diagnostics.md | 崩溃兜底：父进程与子进程都注册 `uncaughtException` / `unhandledRejection`，前者记 error 级日志。 | `test/logging.test.ts` · 崩溃兜底：父子进程都注册了 uncaughtException / unhandledRejection |
| **DIAG-007** | specs/018-diagnostics.md | 启动时上报事件日志的损坏行（`issues()` 不再只有测试在调）。 | `test/logging.test.ts` · 启动时上报事件日志的损坏行，不再静默跳过 |
| **DIAG-008** | specs/018-diagnostics.md | 事件日志可按 `maxBytes` 轮转：超过上限把当前文件滚到 `<file>.1`，磁盘不会无限增长（默认关闭，显式开启）。 | `test/logging.test.ts` · 事件日志可按 maxBytes 轮转：滚到 .1，磁盘不会无限增长 |
| **E2E-001** | specs/007-e2e.md | 端到端成立：Kernel 拉起 Loop 子进程，`human.message` 进去后，宿主能收到 `ui.patch`，界面文档产生新版本，并能渲染出含该面板的 HTML。 | `test/e2e.test.ts` · 端到端：子进程跑完 Loop → ui.patch → 界面文档出新版本并渲染出 HTML |
| **E2E-002** | specs/007-e2e.md | 非法 View Spec 被 `SurfaceIngest` 拒绝：不进入界面文档（版本不前进）、留下 rejected 记录，且**界面依然可用**。 | `test/e2e.test.ts` · 非法 View Spec 被拒绝：版本不前进、有留痕、界面依然可用 |
| **E2E-003** | specs/007-e2e.md | 回滚：连续应用多次 patch 后可回到任意历史版本，渲染结果随之回退（架构里的「可回滚的改造权」）。 | `test/e2e.test.ts` · 回滚：多次改造后可回到任意版本，渲染结果随之回退 |
| **E2E-004** | specs/007-e2e.md | CLI 可独立跑通：`node src/cli.ts demo` 作为真实进程执行到底，退出码为 0，并落盘 `surface.html` 与 `surface.json`。 | `test/e2e.test.ts` · CLI demo 作为真实进程跑通并落盘产物 |
| **E2E-005** | specs/007-e2e.md | 局部补丁：`op='patch'` 的局部字段补丁能穿过入口闸门落到界面文档（深合并、其余字段保留）；合并后非法的补丁整笔作废、版本不前进。三种粒度在端到端链路上都成立。 | `test/e2e.test.ts` · 局部补丁：op=patch 能穿过入口闸门做深合并；合并后非法则整笔作废 |
| **E2E-006** | specs/007-e2e.md | P1 编排链路可一键复现：`node src/cli.ts team` 作为真实进程跑通「Lead 建任务 → 拉起队友 → 队友领活干完 → 回报 → Lead 改界面」，退出码 0，并落盘编排产物 HTML。 | `test/e2e.test.ts` · CLI team 命令跑通一次真实的多进程编排并落盘产物 |
| **E2E-007** | specs/007-e2e.md | 多轮工具调用不被严格端点拒绝：用一个「看到孤儿工具结果就 400」的假服务驱动真实子进程，断言两轮工具往返能跑完且零违规（本机宽容的模型掩盖过这个问题）。 | `test/e2e.test.ts` · 多轮工具调用不被严格端点拒绝：工具结果必须能对应上助手声明的工具调用 |
| **HOST-001** | specs/010-orchestration.md | `agent.spawn` 拉起独立子进程：返回的 pid 与调用者不同，且 brief 已投递给它。 | `test/orchestration.test.ts` · agent.spawn 拉起独立子进程，并把 brief 投递给它 |
| **HOST-002** | specs/010-orchestration.md | `agent.spawn` 过审批门：未获放行时返回 `ok:false`，不拉起任何进程。 | `test/orchestration.test.ts` · agent.spawn 过审批门：默认拒绝时不拉起任何进程 |
| **HOST-003** | specs/010-orchestration.md | `agent.send` 先落盘再投递；目标不在世时消息留在邮箱，之后上线能取到。 | `test/orchestration.test.ts` · agent.send 先落盘再投递；目标不在世时消息留在邮箱 |
| **HOST-004** | specs/010-orchestration.md | `agent.wait` 等到每个目标 Agent 都回报才返回成功；有人没回报则超时返回 `ok:false` 并指出是谁。 | `test/orchestration.test.ts` · agent.wait 等到不了回报就如实失败，并指出是谁没回 |
| **HOST-005** | specs/010-orchestration.md | `ui.render` 经 Surface 校验后落进界面文档并返回版本号；非法 spec 返回 `ok:false` 且文档版本不变。 | `test/orchestration.test.ts` · ui.render 经表面校验落进界面文档；非法 spec 版本不变 |
| **HOST-006** | specs/010-orchestration.md | 任务板工具保持 CAS 语义：用过期 revision 认领报 `REVISION_CONFLICT`，任务状态不被覆盖。 | `test/orchestration.test.ts` · 任务板工具保持 CAS 语义：过期 revision 认领失败且不覆盖状态 |
| **HOST-007** | specs/010-orchestration.md | 每次宿主工具调用都写事件日志（`host.tool.call` / `host.tool.result`），可回放审计。 | `test/orchestration.test.ts` · 每次宿主工具调用都写事件日志，可回放审计 |
| **KERN-001** | specs/004-kernel.md | `spawn` 拉起独立子进程：`pid` 存在且与宿主 `process.pid` 不同，能读到子进程发出的帧。 | `test/kernel.test.ts` · spawn 拉起独立子进程：pid 与宿主不同，能读到子进程发出的帧 |
| **KERN-002** | specs/004-kernel.md | 宿主 `send(human.message)` 后，子进程会跑完 Loop 并回传 `loop.done`。 | `test/kernel.test.ts` · 宿主 send(human.message) 后子进程跑完 Loop 并回传 loop.done |
| **KERN-003** | specs/004-kernel.md | 同一池中两个 Agent 拥有不同 pid（一 Agent 一进程）。 | `test/kernel.test.ts` · 一个 Agent 一个进程：两个 Agent 的 pid 不同 |
| **KERN-004** | specs/004-kernel.md | 发送非法帧（未知类型 / 缺字段）抛 `ProtocolError`，不会把脏帧写进管道。 | `test/kernel.test.ts` · 发送非法帧被拦截并抛 ProtocolError，脏帧不进管道 |
| **KERN-005** | specs/004-kernel.md | `interrupt` 后子进程在最近一个 step boundary 结束当前 Run，回传 `loop.done{reason:'interrupted'}`，并**保持存活**。 | `test/kernel.test.ts` · interrupt 后子进程在最近一个 boundary 收尾，并保持存活 |
| **KERN-006** | specs/004-kernel.md | `kill()` 立即终止子进程，`exited` 报告信号。 | `test/kernel.test.ts` · kill 立即终止子进程，exited 报告信号 |
| **KERN-007** | specs/004-kernel.md | 子进程崩溃不影响宿主：`exited` 报告崩溃退出码，宿主继续可用。 | `test/kernel.test.ts` · 子进程崩溃不影响宿主，exited 报告退出码 |
| **KERN-008** | specs/004-kernel.md | 审批门默认拒绝；`allow_always` 后同动作自动放行；决策历史可查。 | `test/kernel.test.ts` · 审批门默认拒绝；allow_always 之后同动作自动放行；历史可查 |
| **KERN-009** | specs/004-kernel.md | 子进程的每一帧都写进事件日志（`agent.frame` 事件）。 | `test/kernel.test.ts` · 子进程的每一帧都写进事件日志（审计） |
| **KERN-010** | specs/004-kernel.md | 进程退出后 `exited` 只 resolve 一次，`alive` 变为 false，池中可被清理。 | `test/kernel.test.ts` · 进程退出后 exited 只 resolve 一次，alive 为 false，池中被清理 |
| **KERN-011** | specs/004-kernel.md | 模型端口可切换：子进程在 `AGENT_MODEL=http` 时走 OpenAI 兼容 HTTP 端口，且能真实收到模型的文本回复（用本机假服务验证接线，不碰外网）。 | `test/kernel.test.ts` · 模型端口可切换：AGENT_MODEL=http 时子进程走真 HTTP 端口（本机假服务） |
| **LOG-001** | specs/002-event-log.md | `append` 返回的事件带自增 `seq`（从 1 开始）与合法 `ts`，且**立即落盘**：新建实例重新读取能看到同样的事件。 | `test/eventlog.test.ts` · append 返回自增 seq 与合法 ts，且立即落盘（新实例可读回） |
| **LOG-002** | specs/002-event-log.md | 交错调用（await 之间穿插其它 append）不产生重复或跳号的 `seq`。 | `test/eventlog.test.ts` · 交错 append 不产生重复或跳号的 seq |
| **LOG-003** | specs/002-event-log.md | `read()` 按 `seq` 升序返回全部事件；`readFrom(seq)` 返回 `seq ≥ 给定值` 的子集。 | `test/eventlog.test.ts` · read 升序返回全部事件，readFrom 返回水位之后的子集 |
| **LOG-004** | specs/002-event-log.md | `snapshot(state)` 落盘且带水位 `seq`；`latestSnapshot()` 返回最近一次的状态与水位的对象。 | `test/eventlog.test.ts` · snapshot 落盘并带水位，latestSnapshot 取最近一次 |
| **LOG-005** | specs/002-event-log.md | `replay(reducer, initial)` 能从空态或从快照水位起跳，折叠出确定的状态。 | `test/eventlog.test.ts` · replay 能从空态或从快照水位起跳折叠出状态 |
| **LOG-006** | specs/002-event-log.md | 损坏行不影响其余事件：`read()` 跳过非法 JSON 行，并通过 `issues()` 上报行号与原因。 | `test/eventlog.test.ts` · 损坏行被跳过并上报，其余事件仍可读 |
| **LOG-007** | specs/002-event-log.md | `ts` 单调不减；`type` 为空字符串或缺失时 `append` 必须拒绝（返回错误而不是写入脏事件）。 | `test/eventlog.test.ts` · 非法事件被拒绝：空 type 不写入，ts 单调不减 |
| **LOG-008** | specs/002-event-log.md | 事件日志是唯一真相：同一份日志两次 replay 必须得到**深度相等**的状态；且从快照 + 后续事件回放，与从零回放结果一致。 | `test/eventlog.test.ts` · 同一份日志两次 replay 深度相等；快照起跳与从零回放一致 |
| **LOOP-001** | specs/003-agent-loop.md | 每一轮迭代按 `assemble → infer → dispatch → emit → checkpoint` 的顺序发出 5 个 `loop.step` 帧。 | `test/loop.test.ts` · 每轮迭代按 assemble → infer → dispatch → emit → checkpoint 发 5 个 loop.step 帧 |
| **LOOP-002** | specs/003-agent-loop.md | 模型端口可插拔：用脚本化假模型即可跑完全流程，结果确定、可离线复现。 | `test/loop.test.ts` · 模型端口可插拔：脚本化假模型驱动全流程，结果确定可复现 |
| **LOOP-003** | specs/003-agent-loop.md | 边界投递：循环开始后送来的 `human.message` / `peer.message` 只在下一个 step boundary 被消费，本轮 step 不被打断。 | `test/loop.test.ts` · 边界投递：运行中送来的消息只在下一个 step boundary 被消费 |
| **LOOP-004** | specs/003-agent-loop.md | 工具调用成对发出 `tool.call` / `tool.result`；未知工具与抛异常的工具都只得到 `ok:false`，Loop 不中断。 | `test/loop.test.ts` · 工具调用成对发帧；未知工具与抛异常的工具都只得到 ok:false |
| **LOOP-005** | specs/003-agent-loop.md | `ui.patch` 必须经过 `UiGuard`；被拒绝的 patch 不外发，且被记入事件日志。 | `test/loop.test.ts` · ui.patch 必须过 UiGuard；被拒绝的 patch 不外发但记账 |
| **LOOP-006** | specs/003-agent-loop.md | 预算三维（轮次 / 工具调用数 / token）任一触顶即终止，终态 `budget_exhausted`。 | `test/loop.test.ts` · 预算三维任一触顶即终止，终态 budget_exhausted |
| **LOOP-007** | specs/003-agent-loop.md | `interrupt` 后在最近一个 step boundary 停止，终态 `interrupted`，且已完成的 step 事件仍然完整。 | `test/loop.test.ts` · interrupt 后在最近的 step boundary 停止，已完成的 step 事件完整 |
| **LOOP-008** | specs/003-agent-loop.md | 模型声明完成时终态为 `completed`，并写入检查点事件（含快照水位）。 | `test/loop.test.ts` · 模型声明完成 → 终态 completed 并写检查点事件 |
| **LOOP-009** | specs/003-agent-loop.md | 每个 step 都写入事件日志，且可用 `replay` 重建出每轮的五步序列。 | `test/loop.test.ts` · 每个 step 都写日志，可用 replay 重建每轮五步序列 |
| **LOOP-010** | specs/003-agent-loop.md | 上下文按预算裁剪：超出上限时保留系统提示与最近的条目，且裁剪过程本身不丢事件。 | `test/loop.test.ts` · 上下文按预算裁剪：保留系统提示与最近条目 |
| **LOOP-011** | specs/003-agent-loop.md | 工具分流：`execute:'host'` 的工具由宿主执行（Loop 只发 `tool.call` 并等待回填），`execute:'loop'` 的工具在进程内执行，两者可在同一轮混用。 | `test/loop.test.ts` · 工具分流：宿主工具请宿主代办，进程内工具自己跑，同一轮可混用 |
| **LOOP-012** | specs/003-agent-loop.md | 宿主回填：收到 `tool.reply` 后必须成对发出 `tool.result`，`result` / `error` 原样透传，并写入事件日志。 | `test/loop.test.ts` · 宿主回填：tool.result 成对发出、原样透传，并写入事件日志 |
| **LOOP-013** | specs/003-agent-loop.md | 宿主工具失败不致命：超时、被中断、回填 `ok:false` 都只产生 `tool.result{ok:false}`，Loop 继续到下一轮。 | `test/loop.test.ts` · 宿主工具失败不致命：超时/中断/回填失败都只变成 ok:false，Loop 继续 |
| **LOOP-014** | specs/003-agent-loop.md | 没有接到宿主桥时调用宿主工具 → `tool.result{ok:false}` 且错误信息含 `NO_HOST_BRIDGE`，Loop 不崩。 | `test/loop.test.ts` · 没有宿主桥时调用宿主工具 → NO_HOST_BRIDGE，Loop 不崩 |
| **LOOP-015** | specs/003-agent-loop.md | `seedContext` 提供的历史上下文会进入模型输入（顺序：system → 历史 → 本轮 seed），且本轮消息不会重复注入。 | `test/loop.test.ts` · seedContext 把历史上下文喂进模型输入，且不重复本轮消息 |
| **LOOP-016** | specs/003-agent-loop.md | 助手消息必须携带它发起的工具调用（`ContextItem.toolCalls`），且工具结果排在其后。少了这一条，工具结果在严格端点上就是孤儿：OpenAI 要求 `role:'tool'` 紧跟带 `tool_calls` 的助手消息，Anthropic 要求 `tool_result` 对应前一条的 `tool_use`。 | `test/loop.test.ts` · 助手消息必须携带工具调用：下一步的工具结果才有归属 |
| **MAIL-001** | specs/005-taskboard-mailbox.md | `send` 写入字段完整的消息，收件 Agent 可用 `pending` 读到。 | `test/mailbox.test.ts` · send 写入字段完整的消息，收件 Agent 可用 pending 读到 |
| **MAIL-002** | specs/005-taskboard-mailbox.md | 重复 id 幂等：再次 `send` 不新增记录，`duplicate` 为 `true`，邮箱里只有一条。 | `test/mailbox.test.ts` · 重复 id 幂等：不新增记录，duplicate 为 true |
| **MAIL-003** | specs/005-taskboard-mailbox.md | `pending(agentId)` 只读不消费：重复调用结果一致，不写 `deliveredAt`。 | `test/mailbox.test.ts` · pending 只读不消费，且返回快照副本 |
| **MAIL-004** | specs/005-taskboard-mailbox.md | `drainAt(agentId, 'step_boundary')` 一次性取出并消费全部待投递消息，第二次返回空数组。 | `test/mailbox.test.ts` · drainAt 一次性取出并消费，第二次返回空数组 |
| **MAIL-005** | specs/005-taskboard-mailbox.md | `drainAt` 只投递指定 Agent 的消息，其他 Agent 的待投递消息不受影响；无消息返回空数组而非错误。 | `test/mailbox.test.ts` · drainAt 只投递指定 Agent，其他 Agent 不受影响 |
| **MAIL-006** | specs/005-taskboard-mailbox.md | 投递边界不是 `'step_boundary'` 返回 `BAD_BOUNDARY`，且不消费任何消息。 | `test/mailbox.test.ts` · 投递边界不是 step_boundary 报 BAD_BOUNDARY，且不消费 |
| **MAIL-007** | specs/005-taskboard-mailbox.md | 持久化：`send` 后重新打开同一路径，未投递消息仍在；`drainAt` 后重新打开，已消费消息不会被二次投递。 | `test/mailbox.test.ts` · 持久化：重启后未投递消息仍在，已消费不重复投递 |
| **MAIL-008** | specs/005-taskboard-mailbox.md | 投递给不存在/空闲 Agent 的消息不丢，等它下次 `drainAt` 取到；`senderKind` 解析发送者前缀，`toPeerFrame`/`fromPeerFrame` 与 `peer.message` 帧互转。 | `test/mailbox.test.ts` · 空闲/不存在 Agent 的消息不丢；发送者前缀与 peer.message 帧互转 |
| **MD-001** | specs/024-markdown.md | 基础语法：标题 / 粗体 / 斜体 / 删除线 / 行内代码 / 围栏代码块 / 无序与有序列表 / 引用 / 分隔线都能正确产出；渲染是纯函数（同输入同输出），空输入产出空串。 | `test/markdown.test.ts` · 基础语法：标题 / 粗斜 / 行内代码 / 代码块 / 列表 / 引用 / 分隔线 |
| **MD-002** | specs/024-markdown.md | 安全：源文本里的 HTML **一律转义**（不产出 `script`/`img` 等标签），代码块内容同样转义但原样保留；链接走协议白名单，`javascript:` / `data:` / `vbscript:` 被拒并降级成纯文本；安全链接带 `target="_blank" rel="noopener noreferrer"`。 | `test/markdown.test.ts` · 安全：源文本里的 HTML 一律转义，链接走协议白名单 |
| **MD-003** | specs/024-markdown.md | 行内代码与代码块里的 Markdown **不被二次解析**（`` `**不是加粗**` `` 保持字面量；围栏里的 `#` 不是标题）。 | `test/markdown.test.ts` · 表格与行内代码里的标记不被二次解析 |
| **MD-004** | specs/024-markdown.md | 归因：只有 Agent 输出（`agent` / `thinking`）走 Markdown；人类与系统消息保持纯文本；流式气泡与正式消息共用同一个渲染器。 | `test/markdown.test.ts` · 人类与系统消息不渲染 Markdown，只有 Agent 输出才渲染 |
| **MD-005** | specs/024-markdown.md | `looksLikeMarkdown()` 只认真的标记，普通句子（含「两点半再说」这类数字开头）不误判。 | `test/markdown.test.ts` · looksLikeMarkdown 只认真的标记，普通句子不误判 |
| **MD-006** | specs/024-markdown.md | 流式渲染：未闭合的 `**` 按字面显示（不产出残缺的 `<strong>`），闭合后才变成标记；未闭合的围栏也要保留内容。 | `test/markdown.test.ts` · 流式渲染：未闭合的语法按字面显示，闭合后变成标记（同一个渲染器） |
| **MODEL-001** | specs/009-http-model.md | `createHttpModel` 返回可用的 `ModelPort`：请求发往 `{baseUrl}/chat/completions`，带 `Authorization: Bearer <apiKey>`、JSON 内容类型与 `model` 字段，默认使用全局 `fetch`。 | `test/http-model.test.ts` · createHttpModel 用全局 fetch 把请求发到 {baseUrl}/chat/completions，带鉴权头与 model |
| **MODEL-002** | specs/009-http-model.md | `ContextItem[]` 的角色映射：`system`/`human`/`assistant` 直译，`human` → `user`，`peer` → `user` 且前缀标注来源（取自 `meta.from`，缺失时用 `peer`）。 | `test/http-model.test.ts` · 上下文角色映射：system/human/assistant 直译，peer 转 user 并前缀标注来源 |
| **MODEL-003** | specs/009-http-model.md | `role: 'tool'` 的上下文映射为 `{ role: 'tool', content, tool_call_id }`，`tool_call_id` 取自 `meta.id`，缺失时不带该字段。 | `test/http-model.test.ts` · role:tool 的上下文映射为 tool 消息并带上 meta.id 作为 tool_call_id |
| **MODEL-004** | specs/009-http-model.md | `ToolSpec[]` 映射为 `tools[{ type: 'function', function: { name, description, parameters } }]`，`parameters` 为空对象 schema，`description` 缺失时给空串；工具为空时不发送 `tools` 字段。 | `test/http-model.test.ts` · ToolSpec 映射为 function 工具，parameters 用空对象 schema；无工具时不发 tools |
| **MODEL-005** | specs/009-http-model.md | `temperature` 与 `maxTokens` 只有显式给出时才映射为 `temperature` / `max_tokens`（`0` 也必须被发送）。 | `test/http-model.test.ts` · temperature 与 maxTokens 只有显式给出才发送，0 也是有效值 |
| **MODEL-006** | specs/009-http-model.md | 正常响应：`choices[0].message.content` → `text`，`usage.total_tokens` → `usage.tokens`；无 `usage` 时不产生 `usage` 字段。 | `test/http-model.test.ts` · 解析 content 与 usage.total_tokens；无 usage 时不产生 usage 字段 |
| **MODEL-007** | specs/009-http-model.md | 空字符串或缺失的 `content` 统一归一化为 `undefined`。 | `test/http-model.test.ts` · 空字符串或缺失的 content 统一归一化为 undefined |
| **MODEL-008** | specs/009-http-model.md | `tool_calls[]` 映射为 `toolCalls[]`，`arguments` 的 JSON 字符串被解析为对象，空串等价于 `{}`。 | `test/http-model.test.ts` · tool_calls 映射为 toolCalls，arguments 的 JSON 字符串被解析，空串等价于空对象 |
| **MODEL-009** | specs/009-http-model.md | `arguments` 不是合法 JSON 或解析结果不是对象时，抛 `HttpModelError`（`kind: 'bad_arguments'`），不静默降级为空参数。 | `test/http-model.test.ts` · arguments 不是合法 JSON 或不是对象时抛 bad_arguments，绝不降级为空参数 |
| **MODEL-010** | specs/009-http-model.md | 终止约定：有工具调用（含转出的 `uiPatches`）→ `done: false`；无待办动作且文本非空 → `done: true`；两者皆无 → `done` 为 `undefined`。 | `test/http-model.test.ts` · 终止约定：有待办动作 done:false，纯文本 done:true，两者皆无 done 为 undefined |
| **MODEL-011** | specs/009-http-model.md | `uiToolName` 命中的调用被转成 `ModelOutput.uiPatches`（`scope`/`op`/`spec` 原样），且不出现在 `toolCalls` 中。 | `test/http-model.test.ts` · uiToolName 命中的调用转成 uiPatches，且不进入 toolCalls |
| **MODEL-012** | specs/009-http-model.md | `uiToolName` 调用的 `arguments` 形状非法（`scope` 缺失或非字符串、`op` 不在 `patch\|replace\|mount` 内、`spec` 非对象）时抛 `HttpModelError`（`kind: 'bad_ui_patch'`）。 | `test/http-model.test.ts` · uiToolName 调用的 arguments 形状非法时抛 bad_ui_patch |
| **MODEL-013** | specs/009-http-model.md | 非 2xx 响应抛 `HttpModelError`，携带 `status` 与截断后的响应片段 `bodySnippet`。 | `test/http-model.test.ts` · 非 2xx 抛 HttpModelError，带 status 与截断后的响应片段 |
| **MODEL-014** | specs/009-http-model.md | 超过 `timeoutMs` 时用 `AbortController` 中止请求，抛 `HttpModelTimeoutError`（信息含 `timeoutMs`，`status` 为空）。 | `test/http-model.test.ts` · 超过 timeoutMs 时中止请求并抛 HttpModelTimeoutError，信息含 timeoutMs |
| **MODEL-015** | specs/009-http-model.md | 429、5xx 与网络错误按 `maxRetries` 退避重试（默认 2 次、总尝试 3 次），用尽后抛出最后一次的错误。 | `test/http-model.test.ts` · 429/5xx/网络错误按 maxRetries 退避重试，用尽后抛最后一次错误 |
| **MODEL-016** | specs/009-http-model.md | 非 429 的 4xx 不重试：只发一次请求即抛错。 | `test/http-model.test.ts` · 非 429 的 4xx 不重试，只发一次请求就抛错 |
| **MODEL-017** | specs/009-http-model.md | 响应结构不可信（响应体不是 JSON、缺少 `choices[0]`、工具调用缺少 `function.name`）时抛 `HttpModelError`（`kind: 'bad_response'`）。 | `test/http-model.test.ts` · 响应结构不可信（非 JSON / 缺 choices / 工具调用缺 name）抛 bad_response |
| **MODEL-018** | specs/009-http-model.md | 助手消息带 `toolCalls` 时输出 `tool_calls`（`arguments` 为 JSON 串），使后续 `role:'tool'` 消息的 `tool_call_id` 有对应项——否则严格端点直接 400。 | `test/http-model.test.ts` · 助手消息带 toolCalls 时输出 tool_calls，后面的工具结果才对得上 id |
| **MODEL-019** | specs/009-http-model.md | 工具名出网合法：内网名可含点（`ui.render`），但发给端点前必须压成 `^[a-zA-Z0-9_-]{1,64}$`，回程再映射回内部名；两个内部名压成同一个线上名时必须当场报错，不许猜。 | `test/http-model.test.ts` · 工具名出网必须合法：带点的内部名压成下划线，回程再改回来<br>`test/http-model.test.ts` · 线上名冲突必须当场报错，不许猜 |
| **MODEL-020** | specs/009-http-model.md | 参数 schema 透传：`ToolSpec.parameters` 原样作为 `function.parameters` 发出，缺省才退回空对象 schema（空 schema 的后果是模型只能给个 `{}`）。 | `test/http-model.test.ts` · 参数 schema 原样透传；没给才退回空 schema |
| **ORCH-001** | specs/010-orchestration.md | Lead 通过 `agent.spawn` 拉起 Teammate，两者 pid 不同，且事件日志里能还原出这次派发。 | `test/orchestration.test.ts` · Lead 通过 agent.spawn 拉起 Teammate：两者 pid 不同，日志可还原派发 |
| **ORCH-002** | specs/010-orchestration.md | 跨进程协作闭环：Teammate 领取并完成任务 → 回报 Lead → Lead 收到后继续（上下文里能看到回报）。 | `test/orchestration.test.ts` · 跨进程协作闭环：Teammate 领任务并完成，Lead 收到回报后继续 |
| **ORCH-003** | specs/010-orchestration.md | 子 Agent 完成时由 Kernel 自动向父 Agent 回报，`agent.wait` 因此能确定性地返回。 | `test/orchestration.test.ts` · 子 Agent 完成时由 Kernel 自动回报父 Agent，agent.wait 因此能确定性返回 |
| **ORCH-004** | specs/010-orchestration.md | 一次完整编排结束后：界面文档产生新版本、任务板终态 `completed`、邮箱里留下 brief 与 report 两类消息、事件日志可回放出完整时间线。 | `test/orchestration.test.ts` · 一次完整编排：界面出新版本、任务完成、邮箱留痕、日志可回放时间线 |
| **ORCH-005** | specs/010-orchestration.md | 人类中断 Lead 时，它派出去的子进程全部被回收（不留下孤儿进程）。 | `test/orchestration.test.ts` · 人类中断 Lead：终态 interrupted，且它派出去的子进程被回收 |
| **PROTO-001** | specs/001-protocol.md | `encodeFrame` 输出单行 JSON 且以 `\n` 结尾；文本里的换行被转义，不产生裸换行。 | `test/protocol.test.ts` · encodeFrame 输出单行 JSON，以换行结尾，不产生裸换行 |
| **PROTO-002** | specs/001-protocol.md | `decodeFrame` 对非法输入返回 `{ok:false, code}`，**不抛异常**。 | `test/protocol.test.ts` · decodeFrame 对非法输入返回错误而不是抛异常 |
| **PROTO-003** | specs/001-protocol.md | 未知 `t` 报 `UNKNOWN_TYPE`；缺少必填字段报 `MISSING_FIELD` 并指明字段名。 | `test/protocol.test.ts` · 未知帧类型与缺必填字段分别报 UNKNOWN_TYPE / MISSING_FIELD |
| **PROTO-004** | specs/001-protocol.md | 未知字段报 `UNKNOWN_FIELD`；字段类型不符报 `BAD_FIELD_TYPE`。 | `test/protocol.test.ts` · 未知字段报 UNKNOWN_FIELD，类型不符报 BAD_FIELD_TYPE |
| **PROTO-005** | specs/001-protocol.md | 通道能正确处理半帧（分块到达）与多帧粘连。 | `test/protocol.test.ts` · 通道能处理半帧分块到达与多帧粘连 |
| **PROTO-006** | specs/001-protocol.md | 超长行触发 `LINE_TOO_LONG` 错误事件，通道在之后仍能正常收帧。 | `test/protocol.test.ts` · 超长行报 LINE_TOO_LONG，通道随后仍可正常收帧 |
| **PROTO-007** | specs/001-protocol.md | `frameJsonSchema()` 的输出必须与磁盘上 `specs/schemas/frame.schema.json` 完全一致（契约漂移门禁）。 | `test/protocol.test.ts` · 磁盘上的 frame.schema.json 与代码生成的 schema 完全一致（契约漂移门禁） |
| **PROTO-008** | specs/001-protocol.md | 每个帧类型都声明了方向，`directionOf()` 与帧表一致，`isInbound()` 可判定。 | `test/protocol.test.ts` · 每个帧类型都声明方向，directionOf / isInbound 与帧表一致 |
| **PROTO-009** | specs/001-protocol.md | 每个帧类型都必须能编码-解码往返（round trip）而不丢字段。 | `test/protocol.test.ts` · 每个帧类型都能编码-解码往返且不丢字段 |
| **PROTO-010** | specs/001-protocol.md | `tool.reply` 是宿主回填宿主工具结果的**唯一**入站帧（方向 in），必填 `id` 与 `ok`；缺 `ok` 报 `MISSING_FIELD`。 | `test/protocol.test.ts` · tool.reply 是宿主回填宿主工具结果的唯一入站帧 |
| **SELF-001** | specs/013-self-hosting.md | 写作用域：`src/client/**` 内允许；`../`、绝对路径、其它目录一律拒绝且不落盘。 | `test/self-hosting.test.ts` · 写作用域：src/client 之外一律拒绝，且不落盘 |
| **SELF-002** | specs/013-self-hosting.md | `read` 同样受作用域与大小上限约束；不存在的文件返回明确错误。 | `test/self-hosting.test.ts` · read 同样受作用域与存在性约束 |
| **SELF-003** | specs/013-self-hosting.md | `list` 返回可改文件、字节数与版本数。 | `test/self-hosting.test.ts` · list 返回可改文件、字节数与版本数 |
| **SELF-004** | specs/013-self-hosting.md | 写入成功后文件内容更新、版本号 +1、历史留快照。 | `test/self-hosting.test.ts` · 写入成功：内容更新、版本 +1、历史留快照 |
| **SELF-005** | specs/013-self-hosting.md | 版本历史可读，能给出人可读 diff（新增/删除行数与被改的行）。 | `test/self-hosting.test.ts` · diff 给出人可读差异（增删行与内容） |
| **SELF-006** | specs/013-self-hosting.md | 自检通过才落盘：自检失败时文件内容**与写入前逐字节一致**（自动回滚）。 | `test/self-hosting.test.ts` · 自检不通过 → 逐字节回滚，且不进历史 |
| **SELF-007** | specs/013-self-hosting.md | 语法错误（`node --check` 失败）同样触发回滚，且错误信息可读。 | `test/self-hosting.test.ts` · 语法错误被真的语法自检拦下并回滚（用生产实现，不是假 selfTest） |
| **SELF-008** | specs/013-self-hosting.md | `client.write` 过审批门：默认拒绝时不写文件、不进历史。 | `test/self-hosting.test.ts` · client.write 过审批门：默认拒绝时不写文件 |
| **SELF-009** | specs/013-self-hosting.md | 审计：每次写入 / 回滚都写事件日志（含 path、reason、自检结果）。 | `test/self-hosting.test.ts` · 审计：成功写入写 client.write，失败写入写 client.write.rejected |
| **SELF-010** | specs/013-self-hosting.md | 回滚：`revert` 把文件恢复为上一版内容，并广播 `client.changed{kind:'revert'}`。 | `test/self-hosting.test.ts` · revert 回到上一版，并留下回滚记录 |
| **SELF-011** | specs/013-self-hosting.md | 广播：写入成功与回滚都产生 `client.changed`；`/api/state` 的 `sources` 同步更新。 | `test/self-hosting.test.ts` · 广播：写入触发 client.changed，且 state.sources 同步更新 |
| **SELF-012** | specs/013-self-hosting.md | 无变化写入是幂等的：内容与当前一致时不产生新版本。 | `test/self-hosting.test.ts` · 无变化写入是幂等的：不产生新版本 |
| **SELF-013** | specs/013-self-hosting.md | `append` 模式：在文件末尾追加内容（不必先读全文），且同样走自检门禁。 | `test/self-hosting.test.ts` · append 模式在末尾追加，且同样走自检门禁 |
| **SET-001** | specs/015-model-settings.md | 无配置时的默认值是本机 Ollama（openai 协议），且 `hasApiKey` 为 false 也能正常工作。 | `test/settings.test.ts` · 无配置时的默认值是本机 Ollama（openai 协议），且未设 Key 也能用 |
| **SET-002** | specs/015-model-settings.md | 保存后可读回且落盘；文件权限为 0600。 | `test/settings.test.ts` · 保存后可读回并落盘，文件权限 0600 |
| **SET-003** | specs/015-model-settings.md | `GET /api/settings` 永不返回明文 Key：只返回打码串与 `hasApiKey`。 | `test/settings.test.ts` · 永不回传明文 Key：GET /api/settings 只给打码串 |
| **SET-004** | specs/015-model-settings.md | `PUT` 时省略或传空 `apiKey` → 保留原有 Key；传新 Key → 覆盖。 | `test/settings.test.ts` · PUT 省略或传空 apiKey → 保留原 Key；传新 Key → 覆盖 |
| **SET-005** | specs/015-model-settings.md | 保存设置会重启 Lead 进程；重启后历史上下文仍在（由事件日志投影，不因重启断裂）。 | `test/settings.test.ts` · 保存设置会重启 Lead，历史上下文仍在（事件日志投影） |
| **SET-006** | specs/015-model-settings.md | `POST /api/settings/test`：配置可用则返回 `{ok:true, latencyMs}`；不可用则返回 `{ok:false, error}`（可读信息，服务不崩）。 | `test/settings.test.ts` · 连接测试：通就返回延迟与回复，不通就返回可读错误 |
| **SET-007** | specs/015-model-settings.md | 协议选择贯通到子进程：`AGENT_PROTOCOL=anthropic` 时子进程走 Anthropic 适配器（可在假服务上验证）。 | `test/settings.test.ts` · 协议贯通到子进程：AGENT_PROTOCOL=anthropic 时走 /v1/messages |
| **SET-008** | specs/015-model-settings.md | 设置变更广播 `settings` 事件，`/api/state` 里的生效模型信息同步更新。 | `test/settings.test.ts` · 设置变更广播 settings 事件，state.model 同步更新 |
| **SET-009** | specs/015-model-settings.md | 非法输入被拒绝：未知协议、空 `baseUrl`、空 `model` → 400 且不落盘。 | `test/settings.test.ts` · 非法输入被拒绝且不落盘 |
| **SET-010** | specs/015-model-settings.md | 打码规则可测：长度足够的 Key 显示头尾、过短的 Key 全遮。 | `test/settings.test.ts` · 打码规则：足够长显示头尾，短的一律遮住 |
| **SET-013** | specs/015-model-settings.md | 模型配置**按对话隔离**，且设置页作用在**当前对话**上：`GET/PUT/POST /api/settings*` 都接受 `?conversation=<id>`；在 c1 里读到/改到的必须是 c1 的配置，绝不是 default 的（真机踩过：c1 用 Ollama，设置页却显示 deepseek）；切换对话时若设置页开着要跟着重读。 | `test/settings.test.ts` · 模型配置按对话隔离：设置接口跟着 ?conversation= 走 |
| **SET-014** | specs/015-model-settings.md | 新建对话**继承**当前活跃对话的模型配置（协议 / 端点 / 模型 / Key / 超时），而不是回落到内置默认——否则用户每开一个对话都要重配一次模型与 Key。已有配置的对话不被覆盖。 | `test/settings.test.ts` · 新建对话跟随全局默认：全局不存在时由当前活跃对话建立，而不是回落到内置默认 |
| **SET-015** | specs/015-model-settings.md | 多对话之前的全局 `<root>/settings.json` 在启动时**幂等迁移**进默认对话：目标已存在则不覆盖（用户后来配的优先），老文件保留不删（不带 Key 的东西宁可多留一份也不悄悄删）。 | `test/settings.test.ts` · 旧位置 <root>/settings.json 幂等迁移进默认对话，老文件保留 |
| **SET-016** | specs/015-model-settings.md | 列出可用模型：`POST /api/models` 按候选配置（不写盘）拉取列表——OpenAI 兼容走 `{baseUrl}/models`、Anthropic 走 `{baseUrl}/v1/models` + `x-api-key`；返回 `{ok, models:[{id,label?}], count}`，条目有上限；超时 / 连不上 / 鉴权失败 / 响应格式不对都给出**可归因**的错误码，且**绝不回显 Key**。 | `test/settings.test.ts` · 列模型：两家协议各走各的端点，错误可归因且绝不回显 Key<br>`test/settings.test.ts` · 列模型的 HTTP 接口：候选配置不写盘，非法配置 400 |
| **SET-017** | specs/015-model-settings.md | 客户端「列出模型」：一次点击即列出端点上的模型并渲染成可点选的候选（`datalist` 提供输入联想 + 候选按钮**点一下即切换**，走与保存完全相同的路径）；本地 Ollama 必须能列出本机模型并尽量带上体积/参数量；列表为空或失败都显示原因，且**不阻断手动输入模型名**。 | `test/client-settings-ui.test.ts` · 列模型：不要求先填模型名，候选可点选、全部转义、失败也不阻断手动输入 |
| **SET-018** | specs/026-model-switch.md | 配置解析顺序：对话有覆盖 → 用覆盖；没有 → 用全局；全局也没有 → 用内置默认。三条路径都要有测试。 | `test/model-switch.test.ts` · 配置解析顺序：对话覆盖 > 全局 > 内置默认 |
| **SET-019** | specs/026-model-switch.md | 新对话跟随全局：新建的对话不写自己的配置文件，因此生效的是全局默认；**全局不存在**时用当前活跃对话的配置建立全局（建立后新对话跟随它，且重复调用不再改写）。 | `test/model-switch.test.ts` · 新对话跟随全局；全局不存在时用当前活跃对话建立（幂等） |
| **SET-020** | specs/026-model-switch.md | 全局配置可读写：`GET/PUT /api/settings?scope=global`；改全局**不影响已有覆盖的对话**，也不影响它们的运行中配置。 | `test/model-switch.test.ts` · 改全局：影响没有覆盖的对话，不影响已有覆盖的对话<br>`test/model-switch.test.ts` · 设为全局默认：Key 不经浏览器，由服务端内部复制 |
| **SET-021** | specs/026-model-switch.md | 本轮进行中拒绝设置变更：`busy` 时 `PUT /api/settings` 返回可读的拒绝原因，**不重启** Agent、不落盘；回合结束后同一请求成功。 | `test/model-switch.test.ts` · 本轮进行中拒绝设置变更：不落盘、不重启，回合结束后成功 |
| **SET-022** | specs/026-model-switch.md | 输入框旁的模型切换器：选项来自模型清单且**当前模型一定在列表里**（端点没返回它也不能丢）；`busy` 时禁用并给出原因；切换只作用于当前对话（`?conversation=` 带对）。 | `test/model-switch.test.ts` · 输入框旁的切换器：当前模型一定在列表里，busy 时禁用并说明原因 |
| **SET-023** | specs/026-model-switch.md | 切换真的生效：设置变更后 Agent 以新模型重启（`restarted: true`），且历史对话不丢。 | `test/model-switch.test.ts` · 切换真的生效：Agent 按新模型重启，历史不丢 |
| **SHELL-001** | specs/023-shell.md | 默认不注册：不传 `--allow-shell` 时 `shell.run` 不在工具表里（模型看不到），传了才在。 | `test/shell.test.ts` · 默认不注册 shell：不启用就看不到这个工具，启用才在<br>`test/shell.test.ts` · 子进程只声明宿主真正注册的工具（没启用就不声明 shell.run） |
| **SHELL-002** | specs/023-shell.md | 每次调用都过审批门：策略说 `deny` 时**不执行任何命令**，并返回明确的拒绝错误。 | `test/shell.test.ts` · 审批说拒绝就一行命令都不执行<br>`test/shell.test.ts` · 端到端：子进程调 shell.run → 人类批准 → 命令真的执行 → 结果回给 Agent |
| **SHELL-003** | specs/023-shell.md | 执行结果形状稳定：`{code, stdout, stderr, durationMs, timedOut, truncated}`；退出码原样透传（非 0 不是异常）。 | `test/shell.test.ts` · 执行结果形状稳定：退出码原样透传，非 0 不算异常 |
| **SHELL-004** | specs/023-shell.md | 超时会杀掉**整棵进程树**（含后台子进程），返回 `timedOut: true`，且不挂住调用方。 | `test/shell.test.ts` · 超时后进程组里的后台进程确实死了 |
| **SHELL-005** | specs/023-shell.md | 输出有上限：超大 stdout 被截断并标记 `truncated`，字节数如实报告。 | `test/shell.test.ts` · 输出有上限：超大输出被截断并标记，字节数如实 |
| **SHELL-006** | specs/023-shell.md | 环境变量白名单：`AGENT_API_KEY` 等 `AGENT_*` 变量不出现在子进程环境里（用 `env` 验证）。 | `test/shell.test.ts` · 环境变量白名单：AGENT_* 与密钥绝不进 shell |
| **SHELL-007** | specs/023-shell.md | cwd 落在该对话的工作空间；工作空间不存在时自动创建。 | `test/shell.test.ts` · cwd 落在该对话的工作空间，不存在时自动创建 |
| **SHELL-008** | specs/023-shell.md | 每次调用（含被拒绝的）都写事件日志，含命令与结果摘要。 | `test/shell.test.ts` · 每次调用（含被拒绝的）都写事件日志 |
| **SHELL-009** | specs/023-shell.md | 审批交互：宿主发出 `approval` 事件、人类 `POST /api/approval` 后放行； | `test/shell.test.ts` · 审批交互：发出 approval 事件，人类回复后放行；重复回复只认第一次 |
| **SHELL-010** | specs/023-shell.md | **没人在就是拒绝**：无客户端连接时审批请求立刻 `deny`，不挂住；等人超时也按拒绝处理。 | `test/shell.test.ts` · 没人在就是拒绝：无客户端连接时审批立刻 deny，不挂住<br>`test/shell.test.ts` · 等人超时按拒绝处理<br>`test/shell.test.ts` · 默认审批超时足够长：人不可能守着屏幕等（真机上吃过 120s 的亏） |
| **SHELL-011** | specs/023-shell.md | 客户端审批对话框：显示完整命令、三个按钮、**必须人工点击**，不允许自动同意； | `test/client-approval-ui.test.ts` · 审批归一化：detail 是完整命令原文一字不改；没有 id 就是没有待批<br>`test/client-approval-ui.test.ts` · 展示模型：显示风险等级与发起者，命令原文逐字保留（含注入串）<br>`test/client-approval-ui.test.ts` · 对话框：弹出后显示完整命令（只走 textContent），初始焦点在「拒绝」<br>`test/client-approval-ui.test.ts` · 幂等与状态同步：同一 id 不叠窗；没有待批就隐藏；老服务端缺字段不清掉待批<br>`test/client-approval-ui.test.ts` · 三个按钮：点击才发 POST /api/approval，请求体是 {id, decision}，成功后关窗<br>`test/client-approval-ui.test.ts` · 回复失败（400 / 网络）显示原因并保持对话框打开，人可以原样重试<br>`test/client-approval-ui.test.ts` · 必须人工点击才能决定：没有定时器 / 键盘快捷键 / 默认允许，且 DOM 不为同意留后门<br>`test/client-approval-ui.test.ts` · DOM / 样式 / app.js 接线：完整命令可换行看全，回复带当前对话，既有 id 不动 |
| **STREAM-001** | specs/022-streaming.md | SSE 解析器：跨 chunk 切断、CRLF、多行 `data`、注释心跳、`[DONE]`、`flush()` 吐出最后一条；增量节流按时间合流且收尾必发。 | `test/stream.test.ts` · SSE 解析：跨 chunk 切断、CRLF、多行 data、注释心跳、[DONE]<br>`test/stream.test.ts` · 增量节流：按时间合流，收尾那一条一定发出去 |
| **STREAM-002** | specs/022-streaming.md | 两家适配器都能流式解析：OpenAI 的 `delta.content` + 分批 `tool_calls`、Anthropic 的 `text_delta` + `input_json_delta` + `content_block_start`；请求体带 `stream: true`；**拼回来之后与非流式解析结果完全一致**。 | `test/stream.test.ts` · OpenAI 流式：文本增量 + 分批 tool_calls 拼接，结果与非流式完全一致<br>`test/stream.test.ts` · Anthropic 流式：text_delta 与 input_json_delta 拼回同一条 message |
| **STREAM-003** | specs/022-streaming.md | 流式失败降级为非流式（并留下可查原因），而不是把整轮变成错误；超时不降级重试。 | `test/stream.test.ts` · 流式失败要降级为非流式，而不是把整轮搞死 |
| **STREAM-004** | specs/022-streaming.md | Loop 把增量作为 `agent.delta` 帧外发（内容是累积全文），最终 `agent.thinking` 文本完整；**池子不把 `agent.delta` 写进事件日志**，其余帧照旧全记。 | `test/stream.test.ts` · Loop 把增量作为 agent.delta 帧外发，且最终文本仍然完整<br>`test/stream.test.ts` · 池子把 agent.delta 只转发、不落日志，其余帧照旧全记 |
| **STREAM-005** | specs/022-streaming.md | 客户端：流式气泡**原地更新**（不 append）、文本一律 `textContent`/转义写入、最终消息到达时收掉气泡不重复、整体重建对话流时清掉气泡引用。 | `test/client-ui.test.ts` · 流式输出：原地更新气泡、纯文本写入、最终消息到达时替换（不重复） |
| **STREAM-006** | specs/022-streaming.md | 确定性演示模型（`--model demo`）也走流式，因此整条流式链路可以在没有网络的情况下被确定性测试。 | `test/stream.test.ts` · 确定性演示模型也走流式：没有网络也能测整条链路 |
| **SURF-001** | specs/006-surface.md | 组件表 `COMPONENT_SPECS` 是唯一真相来源：校验器、渲染器与 JSON Schema 均由它派生，新增组件只需改这一处。 | `test/surface.test.ts` · 组件表是唯一真相来源：校验 / 渲染 / schema 三处同步 |
| **SURF-002** | specs/006-surface.md | `validateViewSpec` 接受全部已声明组件的合法 spec 并返回 `{ok:true}`，对任意输入（含 `null`、数组、标量、循环引用）永不抛异常。 | `test/surface.test.ts` · validateViewSpec 接受合法 spec，且对任意输入永不抛异常 |
| **SURF-003** | specs/006-surface.md | 未知组件类型报 `UNKNOWN_COMPONENT`，与结构错误（`MISSING_FIELD` / `BAD_FIELD_TYPE` / `UNKNOWN_FIELD`）在错误码上可区分，且错误带 `path`。 | `test/surface.test.ts` · 未知组件类型与结构错误在错误码上可区分，且都带 path |
| **SURF-004** | specs/006-surface.md | `progress.value` 必须是 0~1 的有限数，越界报 `OUT_OF_RANGE`，边界值 0 与 1 合法。 | `test/surface.test.ts` · progress.value 必须是 0~1 的有限数，越界报 OUT_OF_RANGE |
| **SURF-005** | specs/006-surface.md | `renderViewSpec` 返回可直接打开的自包含 HTML：含文档外壳、内联样式与 `:root` 令牌变量，progress 的宽度与百分比与 `value` 一致。 | `test/surface.test.ts` · renderViewSpec 输出自包含 HTML，progress 宽度与百分比跟随 value |
| **SURF-006** | specs/006-surface.md | 所有进入 HTML 的文本与属性值都被转义，注入 `<script>` 只以文本形式出现。 | `test/surface.test.ts` · 所有进入 HTML 的文本与属性值都被转义 |
| **SURF-007** | specs/006-surface.md | 未知组件类型渲染为占位块（带 `data-unknown-component`），不抛异常、不白屏，同级已知组件照常渲染。 | `test/surface.test.ts` · 未知组件降级为占位块，不抛异常、不白屏，兄弟组件照常渲染 |
| **SURF-008** | specs/006-surface.md | `DEFAULT_TOKENS` 覆盖颜色/字号/圆角/密度，`tokensToCss` 生成 `--ac-*` 自定义属性。 | `test/surface.test.ts` · 令牌覆盖颜色/字号/圆角/密度，tokensToCss 生成 --ac-* 变量 |
| **SURF-009** | specs/006-surface.md | `schemaOf()` 由组件表派生，与磁盘 `specs/schemas/view-spec.schema.json` 逐字节一致（契约漂移门禁）。 | `test/surface.test.ts` · 磁盘上的 view-spec.schema.json 与代码生成的 schema 完全一致（契约漂移门禁） |
| **SURF-010** | specs/006-surface.md | `ViewDocument.applyPatch` 按 scope 维护区块，支持 `mount` / `replace` / `patch` 三种粒度；非法变更返回错误码且不改变文档。 | `test/surface.test.ts` · applyPatch 支持 mount / replace / patch 三种粒度，非法变更不改文档 |
| **SURF-011** | specs/006-surface.md | 版本号单调递增：每次成功变更 +1、失败不变；`rollback(version)` 回到任意历史版本的界面内容并产生新的递增版本。 | `test/surface.test.ts` · 版本号单调递增，rollback 回到历史内容并产生新的递增版本 |
| **SURF-012** | specs/006-surface.md | `ViewDocument.render()` 输出整页 HTML，包含全部 scope 区块并保持转义。 | `test/surface.test.ts` · render 输出整页 HTML，包含全部 scope 区块并保持转义 |
| **SURF-013** | specs/006-surface.md | 第四种粒度 `upsert`：scope 不存在则挂载、已存在则整块替换，**不做存在性检查**。真模型第一次渲染时无从知道 scope 是否存在，这是它该用的默认粒度（否则它必然浪费一轮去猜）。 | `test/surface.test.ts` · upsert 粒度：不存在则挂载、已存在则整块替换，不做存在性检查 |
| **SURF-014** | specs/025-surface-history.md | 界面改动落成事件：`ui.patch` 成功 → 写一条 `ui.patch` 事件（含 version / op / scope / spec）；被拒绝的改动**不写**事件。 | `test/surface-history.test.ts` · 界面改动落成事件；被拒绝的改动不写事件 |
| **SURF-015** | specs/025-surface-history.md | 启动回放：新建会话时按事件日志回放 `ui.patch` 与 `surface.rollback`，文档版本与各 scope 内容恢复到重启前；回放**不产生新事件**（幂等：重启两次，日志长度不变）。 | `test/surface-history.test.ts` · 重启不丢：按事件日志回放，界面与版本号原样回来（且回放不产生新事件） |
| **SURF-016** | specs/025-surface-history.md | 回滚落成事件：`surface.rollback` 写入事件日志；回滚后重启，文档停在**回滚后**的版本。 | `test/surface-history.test.ts` · 回滚也是一次变更：回滚后重启，文档停在回滚后的版本 |
| **SURF-017** | specs/025-surface-history.md | 版本清单接口：`GET /api/surface/versions` 返回从新到旧的清单（version / ts / scopes / note）与当前版本；时间戳取自事件日志，取不到就空串（不编造）。 | `test/surface-history.test.ts` · 版本清单接口：从新到旧、带时间与区块数，时间取不到不编造 |
| **SURF-018** | specs/025-surface-history.md | 客户端版本列表：下拉里每一版显示 `vN · 时间 · 区块数`，当前版本标注「（当前）」；点「回到这一版」调用 `/api/rollback` 并在成功后刷新清单；回滚失败要有可见错误、不静默。 | `test/surface-history.test.ts` · 客户端版本列表：vN · 时间 · 区块数，当前标注、坏输入不炸 |
| **SURF-019** | specs/025-surface-history.md | 重启后的第一帧必须**真的画出来**：页面加载时 iframe 的首次 `load` 可能早于挂监听，此时必须由启动兜底**主动认定 iframe 已就绪**（而不是只补画"待画内容"）——否则后续送来的界面永远卡在待画队列里，面板一片空白且 `srcdoc` 为空；写入之后还要在**加载完成之后**强制重绘一帧（先于加载地隐藏会把这次导航撤掉）。界面面板与浏览器面板同此。真 bug：重启后界面面板空白。 | `test/surface-history.test.ts` · 重启后的第一帧必须真的画出来：兜底要主动认定 iframe 就绪，重绘要在加载之后 |
| **TASK-001** | specs/005-taskboard-mailbox.md | `create` 生成稳定 id 与完整字段（`pending`、`owner=null`、`revision=0`、`createdAt=updatedAt`），并能被 `get`/`list` 读到；读取结果是快照副本。 | `test/taskboard.test.ts` · create 生成稳定 id 与完整字段，get/list 返回快照副本 |
| **TASK-002** | specs/005-taskboard-mailbox.md | 状态机只允许 `claim`/`release`/`complete`/`reopen` 的合法迁移，其余迁移返回 `INVALID_TRANSITION` 且任务不变。 | `test/taskboard.test.ts` · 状态机拒绝非法迁移，任务保持不变 |
| **TASK-003** | specs/005-taskboard-mailbox.md | CAS：`expectedRevision` 不符返回 `REVISION_CONFLICT`（含 `expected`/`actual`），任务字段与 `revision` 不变。 | `test/taskboard.test.ts` · CAS：expectedRevision 不符报 REVISION_CONFLICT，任务不变 |
| **TASK-004** | specs/005-taskboard-mailbox.md | 并发抢同一任务只有一个成功，其余失败，任务最终 `in_progress` 且 `revision` 只加一次。 | `test/taskboard.test.ts` · 并发抢同一任务只有一个成功 |
| **TASK-005** | specs/005-taskboard-mailbox.md | `ready()` 只包含 `pending`、无 owner、且所有 `blockedBy` 已 `completed` 的任务，并按创建顺序返回。 | `test/taskboard.test.ts` · ready 只含无依赖阻塞的 pending 任务，并按创建顺序返回 |
| **TASK-006** | specs/005-taskboard-mailbox.md | `blockedBy` 引用不存在的任务报 `UNKNOWN_BLOCKER`、重复 id 报 `DUPLICATE_ID`、空 `subject` 报 `INVALID_INPUT`，且都不落库。 | `test/taskboard.test.ts` · 创建校验：未知依赖 / 重复 id / 空 subject 都不落库 |
| **TASK-007** | specs/005-taskboard-mailbox.md | `conflicts(owner, scopes)` 按路径前缀返回重叠的在途任务（排除自己的任务）；重叠不是锁，`claim` 仍成功并在事件里附带 `conflicts` 警告。 | `test/taskboard.test.ts` · 写作用域按路径前缀判定重叠，冲突只是警告不是锁 |
| **TASK-008** | specs/005-taskboard-mailbox.md | 每次成功变更 `revision += 1`、`updatedAt` 前进，并通过 `onChange` 派发对应类型的事件、写入 `events()` 审计。 | `test/taskboard.test.ts` · 每次成功变更 revision+1、updatedAt 前进，并派发事件与审计 |
| **TASK-009** | specs/005-taskboard-mailbox.md | `toJSON`/`fromJSON` 与 `save`/`load` 往返后任务、`revision`、依赖关系与 `ready()` 结果一致。 | `test/taskboard.test.ts` · toJSON/fromJSON 与 save/load 往返后状态一致 |
| **TASK-010** | specs/005-taskboard-mailbox.md | 失败操作不改变任何状态、不产生事件；`release` 清空 owner 且非 owner 报 `NOT_OWNER`，`reopen` 把 `completed` 拉回 `pending`。 | `test/taskboard.test.ts` · 失败操作无变更无事件；release 清 owner，reopen 回到 pending |
| **UI-001** | specs/012-client-ui.md | `src/client/renderer.js` 是纯 ESM 纯函数模块：导出 `renderViewSpec` / `renderFragment` / `escapeHtml` / `COMPONENT_TYPES`，可在 Node 中直接 import，全程不触碰 DOM。 | `test/client-ui.test.ts` · renderer.js 是纯 ESM 纯函数模块：四个导出齐全且不触碰 DOM |
| **UI-002** | specs/012-client-ui.md | `COMPONENT_TYPES` 与 `src/surface/viewspec.ts` 的 `Object.keys(COMPONENT_SPECS)` 完全一致（顺序与元素），且 8 种组件都有渲染实现、不会落进未知占位块。 | `test/client-ui.test.ts` · 组件词汇表与 src/surface/viewspec.ts 的 COMPONENT_SPECS 完全一致，8 种组件都有实现 |
| **UI-003** | specs/012-client-ui.md | `renderViewSpec` 输出自包含 HTML 文档（内联 `--ac-*` 令牌、无外部依赖），`renderFragment` 输出不带外壳的片段，且所有文本与属性值（含 `data-emit`）都被转义。 | `test/client-ui.test.ts` · renderViewSpec 输出自包含 HTML，renderFragment 输出片段，文本与属性全部转义 |
| **UI-004** | specs/012-client-ui.md | 未知组件降级为 `data-unknown-component` 占位块、非法节点与超深嵌套降级为 `data-invalid-spec`，对任意输入都不抛异常、不白屏，兄弟组件照常渲染。 | `test/client-ui.test.ts` · 未知组件与非法节点降级为占位块：不抛异常、不白屏、兄弟组件照常渲染 |
| **UI-005** | specs/012-client-ui.md | `index.html` + `style.css` 构成离线深色单页：不引任何远程资源，含顶部栏 / 对话栏 / 界面面板 / 检查器四区与全部必需元素 id，使用 `#05060a` 背景、`#22d3ee` 与 `#a78bfa` 强调色与 `PingFang SC` 字体栈。 | `test/client-ui.test.ts` · index.html + style.css 是离线深色单页，四区与必需元素齐全 |
| **UI-006** | specs/012-client-ui.md | 界面面板用 `<iframe sandbox="allow-scripts" srcdoc>` 承载服务端 HTML；`document` 事件只更新 `srcdoc` 与版本号，宿主页面不刷新（无 `location.reload` / `document.write`）。 | `test/client-ui.test.ts` · 界面面板是 sandbox iframe srcdoc，document 事件只更新 srcdoc 而不刷新页面 |
| **UI-007** | specs/012-client-ui.md | `app.js` 用 `EventSource('/api/stream')` 订阅并处理 `state` / `frame` / `document` / `done` 四类事件，通过 `POST` 调用 `/api/message`、`/api/interrupt`、`/api/rollback`；在 Node 中 import 无副作用，`normalizeState` 对缺字段的坏输入退化为空。 | `test/client-ui.test.ts` · app.js 订阅 /api/stream 处理四类事件，并用 POST 调 message / interrupt / rollback |
| **UI-008** | specs/012-client-ui.md | 对话流把人类消息靠右、`agent.thinking` 靠左，工具调用渲染成「谁 · 调了什么 · ok/失败」的摘要行，时间线按事件类型上色，且所有进入 DOM 的文本都经过 `escapeHtml`。 | `test/client-ui.test.ts` · 对话流：人类靠右、thinking 靠左、工具调用是可读摘要行，所有文本都转义 |
| **UI-009** | specs/012-client-ui.md | 首帧不会被吞：iframe 尚未完成初始加载时收到的 html 先记为待画、`load` 之后补画；`document` 事件强制重画；判定「要不要画」看的是**画没画上**而不是「内容变没变」。（真实故障：首帧赋值被 iframe 尚未完成的初始加载覆盖，缓存又认定「这份 html 画过了」，于是面板永久空白。） | `test/client-ui.test.ts` · 首帧不会被吞：没画上就必须再画，document 事件强制重画 |
| **UI-010** | specs/012-client-ui.md | 忙碌指示：Agent 干活期间对话区有可见反馈（脉动点 + 「已等 N 秒」），`done` 时立即收掉。真模型一轮可能几十秒，没有它人类会以为卡死。 | `test/client-ui.test.ts` · 忙碌指示：Agent 干活时有可见反馈并显示已等待秒数，收工时收掉 |
| **UI-011** | specs/012-client-ui.md | 检查器可最小化：标题栏上的按钮收起/展开（`aria-expanded` / `aria-controls` 同步），收起时只留标题栏、腾出的高度给上半区，不做整页刷新；选择记在 localStorage，刷新后保持。 | `test/client-ui.test.ts` · 检查器可最小化：只切属性、不刷页面，状态记在 localStorage |
| **UI2-001** | specs/014-client-selfhost-ui.md | `app.js` 用 SSE 订阅 `client.changed`（事件名含点号），把 `write` / `revert` 两类变更归一化后追加进事件时间线，且对坏 data 不抛异常。 | `test/client-selfhost-ui.test.ts` · 订阅 client.changed：写 / 回滚都归一化，并进事件时间线 |
| **UI2-002** | specs/014-client-selfhost-ui.md | `path` 以 `.css` 结尾时，按文件名找到对应的 `<link rel="stylesheet">` 并把 href 换成带 cache-bust 查询串（`?v=<版本>&t=<时间戳>`）的新地址；热替换不刷新页面（`app.js` 内无自动刷新路径）。 | `test/client-selfhost-ui.test.ts` · CSS 变更走无刷新热替换：按文件名定位 <link> 并加 cache-bust 查询串 |
| **UI2-003** | specs/014-client-selfhost-ui.md | `.js` / `.html` 变更显示「刷新以生效」横幅，横幅上的刷新按钮**只有人类点击**才导航到当前地址（等价整页刷新）；`app.js` 不含 UI-006 禁止的 `location.reload` / `location.href =` 字面量，不存在自动刷新。 | `test/client-selfhost-ui.test.ts` · JS / HTML 变更显示横幅，刷新按钮只由人类点击触发，绝不自动刷新 |
| **UI2-004** | specs/014-client-selfhost-ui.md | 横幅显示 path / reason / 自检结果 / 版本号 / 差异行数，带关闭按钮；`kind:'revert'` 文案为「已回滚」，与 `write` 不同；`reason` 等自由文本全部转义。 | `test/client-selfhost-ui.test.ts` · 横幅显示 path / reason / 自检 / 版本 / 差异，可关闭，revert 文案不同且文本转义 |
| **UI2-005** | specs/014-client-selfhost-ui.md | 检查器新增「客户端源码」区：`/api/state` 的 `sources: [{path,bytes,versions}]` 渲染成路径 / 字节 / 版本数列表，`index.html` 含 `#sources`，字段缺失时退化为空列表、单列显示 `—`，不炸。 | `test/client-selfhost-ui.test.ts` · 检查器「客户端源码」区渲染 path / bytes / versions，缺字段退化为空列表 |
| **UI2-006** | specs/014-client-selfhost-ui.md | 防御性：`normalizeClientChange` 对 `null` / 非对象 / 未知 `kind` / 非字符串字段 / 非数字版本一律退化为默认值，`renderClientChange`、`renderSourceRow`、`cacheBustHref`、`findStyleLinkIndex` 对任意输入都不抛异常，且进入 DOM 的文本都经过 `escapeHtml`。 | `test/client-selfhost-ui.test.ts` · 防御性：坏输入不抛异常、未知字段退化，进入 DOM 的文本全部转义 |
| **UI3-001** | specs/017-settings-ui.md | 顶栏「设置」入口打开独立的设置页并覆盖主区域，返回按钮回到对话且不刷新页面。 | `test/client-settings-ui.test.ts` · 顶栏「设置」入口打开覆盖主区域的独立设置页，返回按钮回到对话且不刷新页面 |
| **UI3-002** | specs/017-settings-ui.md | 顶栏与设置页显著位置显示当前生效的模型（`模型名 · 来源`），缺字段退化为默认值。 | `test/client-settings-ui.test.ts` · 当前生效模型显示为「模型 · 来源」，顶栏与设置页同步，缺字段退化为默认值 |
| **UI3-003** | specs/017-settings-ui.md | 表单字段齐全：协议二选一、Base URL、模型名、`type="password"` 的 API Key、温度 / 最大输出 token / 超时；协议说明写清两种端点差异。 | `test/client-settings-ui.test.ts` · 表单字段齐全（协议二选一 / Base URL / 模型名 / password 的 Key / 三个可选数字）且说明端点差异 |
| **UI3-004** | specs/017-settings-ui.md | 服务端设置 → 表单值：已存 Key 时输入框留空、placeholder 显示打码值并提示「留空表示不修改」；归一化永不读取明文 Key。 | `test/client-settings-ui.test.ts` · 服务端设置 → 表单值：Key 留空 + placeholder 显示打码值 + 「留空表示不修改」；永不读明文 |
| **UI3-005** | specs/017-settings-ui.md | 四个预设按钮（本机 Ollama / OpenAI 官方 / Anthropic 官方 / DeepSeek）点一下填好协议 + Base URL + 模型名，且不动已输入的 Key。 | `test/client-settings-ui.test.ts` · 四个预设按钮一键填好协议 + Base URL + 模型名，且不动人类已输入的 Key |
| **UI3-006** | specs/017-settings-ui.md | 本地校验拦住非法输入（空 Base URL / 空模型名 / 未知协议 / 坏数字）且不发请求；合法则 `PUT /api/settings`，成功后回到对话并提示。 | `test/client-settings-ui.test.ts` · 本地校验拦住非法输入且不发请求；合法则 PUT /api/settings，成功后回到对话并提示 |
| **UI3-007** | specs/017-settings-ui.md | 测试连接调 `POST /api/settings/test`：成功显示延迟 ms 与模型回复片段，失败显示可读错误，缺字段退化不炸。 | `test/client-settings-ui.test.ts` · 测试连接调 POST /api/settings/test：成功显示延迟与回复片段，失败显示可读错误 |
| **UI3-008** | specs/017-settings-ui.md | 防御与安全：Key 不进 localStorage / 日志 / URL 且永不回显明文，进入 DOM 的文本全部转义，任意坏输入不抛异常。 | `test/client-settings-ui.test.ts` · 防御与安全：Key 不进浏览器存储 / 日志 / URL，文本全部转义，坏输入不抛异常 |
| **WS-001** | specs/021-workspace.md | 工作空间根目录在 `<dir>/conversations/<id>/workspace` 下，首次写入时自动创建。 | `test/workspace.test.ts` · 工作空间落在 <dir>/conversations/<id>/workspace 下，首次写入时自动创建 |
| **WS-002** | specs/021-workspace.md | `workspace.write` 写入成功返回字节数；`append: true` 追加而不是覆盖。 | `test/workspace.test.ts` · write 返回字节数；append 是追加而不是覆盖<br>`test/workspace.test.ts` · 宿主工具 workspace.write/read/list 走的是同一套校验 |
| **WS-003** | specs/021-workspace.md | 路径穿越一律拒绝：`../x`、`a/../../x`、绝对路径、`..` 单独一段都不能写出根目录之外。 | `test/workspace.test.ts` · 路径穿越一律拒绝：.. / 绝对路径 / 盘符 / 深挖 |
| **WS-004** | specs/021-workspace.md | 拒绝时无副作用：被拒的写入不留文件、不改已有文件。 | `test/workspace.test.ts` · 被拒绝的写入不留任何副作用 |
| **WS-005** | specs/021-workspace.md | 单文件与总量有上限，超限返回 `WORKSPACE_FULL` 且不写半个文件。 | `test/workspace.test.ts` · 单文件与总量超限都拒绝，且不写半个文件 |
| **WS-006** | specs/021-workspace.md | `workspace.read` 读到不存在的文件返回明确错误码；超大文件读取时截断并标记。 | `test/workspace.test.ts` · read：不存在的文件报 NOT_FOUND；超大文件截断并标记 |
| **WS-007** | specs/021-workspace.md | `workspace.list` 只列元信息（路径/字节/时间），**不返回文件内容**。 | `test/workspace.test.ts` · list 只给元信息，不返回文件内容 |
| **WS-008** | specs/021-workspace.md | `GET /api/workspace/file` 按需加载：内容参与本次响应，但**不出现在** `/api/state` 快照里。 | `test/workspace.test.ts` · HTTP：列表只给元信息，内容按需加载；/api/state 里不含文件内容 |
| **WS-009** | specs/021-workspace.md | 越界或非法路径的 HTTP 请求返回 400 且不泄漏根目录之外的任何信息。 | `test/workspace.test.ts` · HTTP 越界路径返回 400，且不泄漏根目录之外的信息 |
| **WS-010** | specs/021-workspace.md | 客户端「文件」页签：列出文件、点击动态加载、空态与错误态都不白屏、内容以纯文本渲染。 | `test/client-conversations-ui.test.ts` · 文件页签：列表只给元信息，点击才动态加载内容，纯文本渲染且空态 / 错误态 / 截断态可见 |
| **WS-011** | specs/021-workspace.md | 工作空间隔离：对话 A 写的文件在对话 B 的文件列表里看不到。 | `test/workspace.test.ts` · 工作空间按对话隔离：A 写的文件在 B 里看不到 |
| **WS-012** | specs/021-workspace.md | **按对话隔离的接口必须带对话参数**：文件列表、文件内容、浏览器打开三处一律带 `?conversation=<id>`， | `test/client-conversations-ui.test.ts` · 按对话隔离的接口必须带对话参数，且三处用的是同一个 id |

## 统计

- 验收标准：**285** 条
- 已覆盖：**285** 条
- 未覆盖：**0** 条
- 悬空引用／未标注用例：**0** 处
