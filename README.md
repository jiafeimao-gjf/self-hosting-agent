# agent-client

> 客户端不是 Agent 的宿主，而是 Agent 的笔。

按《把界面交给 Agent：原生多 Agent 客户端架构设计》落地的工程实现。当前处于 **P2：可用客户端**。

## 当前状态

| 指标 | 值 |
| --- | --- |
| 验收标准 | **240** 条（`specs/*.md`，全部有稳定 ID） |
| 覆盖情况 | **240 / 240** 全部有测试守着（`npm run trace` 门禁通过） |
| 测试 | **255** 个，全绿（约 8s，零第三方依赖） |
| 类型检查 | `npm run typecheck` 全绿（tsc 5.9 `--strict --erasableSyntaxOnly`） |
| P0 已落地 | 帧协议、事件日志、五步 Agent Loop、子进程池与审批门、任务板、邮箱、View Spec 渲染、SurfaceIngest |
| P1 已落地 | 宿主工具桥（`tool.reply`）、`agent.spawn/send/wait` 与任务板工具、TeamRunner 多进程编排、OpenAI 兼容 HTTP 模型端口 |
| P2 已落地 | **可用客户端**：HTTP + SSE 服务、浏览器 Surface（对话 / 沙箱界面面板 / 检查器）、事件日志投影的多轮记忆、本机 Ollama 直连 |
| P3 已落地 | **客户端自举**：Agent 可改 `src/client/**` 自身源码，写入前跑项目自检、不过自动回滚，带版本历史 / 可读 diff / 一键回滚 / 审计，CSS 变更无刷新热替换 |
| P7 已落地 | **多对话 + `/` 命令 + 工作空间**：一个对话一个独立单元（独立子进程/文档/事件日志/工作空间），顶栏切换；`/help /clear /history /new /list /switch /files /cat /whoami`；Agent 用 `workspace.write/read/list` 真实落盘，「文件」页签按需动态加载 |
| P6 已落地 | **内置浏览器模块**：Agent 直接渲染任意 HTML 到**独立的第二个沙箱**（与界面面板并存），文档里的脚本真的跑；点击/提交/`AgentClient.emit` 经 postMessage 桥回流，作为人类动作送进 Agent 的上下文 |
| P5 已落地 | **诊断日志 + 真模型跑通**：logger（级别/JSONL/子进程 stderr 收口/崩溃兜底/访问日志/事件日志轮转）；工具名线上合法化与参数 schema 透传——这两条修完，真 DeepSeek 端点才真正画出界面 |
| P4 已落地 | **设置页 + 可自配模型**：浏览器里切换 OpenAI 兼容 / Anthropic 两种协议，填 Base URL / 模型 / Key / 温度 / 超时，四个预设、连接测试、保存即生效（Lead 重启且历史不丢）；Key 打码、永不回显 |
| 尚未落地 | Electron/Tauri 外壳、人类审批 UI（当前人类在场即自动放行但全程留痕）、更细粒度的热更新（HMR） |

## 多对话与工作空间

一个**对话**是一个独立单元：自己的目录、自己的 Lead 子进程、自己的界面/浏览器文档、自己的事件日志、**自己的工作空间**。
顶栏切换对话，切走不打断（Agent 在后台照跑），切回来一次同步到位。

```
.agent-client/<run>/conversations/<id>/
├── meta.json          标题 / 创建时间
├── events/            这个对话的事件日志（审计与回放）
├── agents/lead/       Lead 的日志（上下文就是它的投影）
├── history/           `/history` 导出的人类可读 Markdown
└── workspace/         Agent 用 workspace.write 落盘的文件（人类在「文件」页签看到）
```

`/` 开头是命令，服务端执行、不经模型：

| 命令 | 作用 |
| --- | --- |
| `/help` `/whoami` | 帮助 / 当前对话与模型 |
| `/clear` | 清空**显示与上下文**（写一条边界标记，宿主与 Agent 共用同一套投影语义）；磁盘日志一个字不删 |
| `/history` `/history list` | 导出成 Markdown / 列出历史文件 |
| `/new` `/list` `/switch` | 新建 / 列出 / 切换对话 |
| `/files` `/cat <路径>` | 列出 / 读取工作空间文件 |

**工作空间的全部难点是路径**：`path` 来自不可信输入，规则只有一条——解析后必须仍在工作空间之内。
`..` 一律拒绝（**不做归一化猜测**，哪怕它其实落在根内）、绝对路径与盘符拒绝、符号链接拒绝、
单文件 256KB / 总量 4MB / 500 个文件上限；所有校验都在**动磁盘之前**完成，被拒绝的写入不留半个文件。

「**动态加载**」是指：`GET /api/workspace` 只回元信息（路径/大小/时间），内容只在点击时走
`GET /api/workspace/file` 取——叶子节点按需拉，状态快照永远不随文件增长而膨胀。

## 内置浏览器：Agent 直接给一份 HTML

界面面板只能画「我们支持的组件」。图表、表单、可点击的小工具这类东西，得让 Agent 直接交一份 HTML。

顶栏右侧的「浏览器」页签就是它的独立沙箱（与界面面板并存，互不覆盖）。Agent 调 `browser.render` 把文档推过去，
文档里的脚本**真的执行**；人类在里面的操作会经桥回流，作为一条人类动作送进 Agent 的上下文：

```html
<button data-ac-emit="导出">导出</button>          <!-- 声明式：点了就上报 -->
<script>AgentClient.emit('计算营收', {输入: 21})</script>  <!-- 命令式：能带数据 -->
```

| 规矩 | 做法 |
| --- | --- |
| 沙箱 | 只开 `allow-scripts`。**绝不同时开 `allow-same-origin`**（两者同开会话等于沙箱失效） |
| 断网 | 默认注入 `default-src 'none'` 的 CSP；要加载外链得显式 `allowNetwork: true` |
| 入口 | 窗口消息校验信封（`__ac`/channel）+ 本体；HTTP 入口只校验本体——客户端按契约会剥掉信封 |
| 上限 | HTML 256KB、单条事件 8KB，超限直接拒绝（截断出来的 HTML 更危险） |

实测（真 DeepSeek 端点）：页面加载即 `emit` 回流 → Agent 收到；用**真实鼠标坐标**点沙箱里的按钮 →
前端计数器 0→1（文档自己的 JS 在跑），同时「点我」回流成第二条人类动作，Agent 据此回应。

## 排障：日志在哪、看什么

```bash
ls .agent-client/<run>/logs/app.log      # 结构化 JSONL：ts / level / scope / message / data
npm run serve -- --log-level debug --log-echo true   # 同时打到终端
```

与事件日志分工明确：`events/events.jsonl` 是**领域事实**（谁改了什么、界面 = f(事件日志)，用于回放审计），
`logs/app.log` 是**排障证据**（进程为什么崩、端点连没连上、帧为什么发不出去）。

补它之前，子进程 stderr 上的那些话（模型端口、夺权、发包失败）**收进了内存却没有任何订阅者**——
出问题时最该看的东西恰好被丢掉了。

## 设置页：模型自己配，两种协议

顶栏「设置」打开一个独立页：协议（OpenAI 兼容 / Anthropic）、Base URL、模型名、API Key、温度、最大输出、超时，外加四个预设（本机 Ollama / OpenAI 官方 / Anthropic 官方 / DeepSeek）。

| 协议 | 请求 | 鉴权 | 工具调用 |
| --- | --- | --- | --- |
| OpenAI 兼容 | `POST {baseUrl}/chat/completions` | `Authorization: Bearer` | `tools[].function` / `tool_calls` |
| Anthropic | `POST {baseUrl}/v1/messages` | `x-api-key` + `anthropic-version` | `tools[].input_schema` / `tool_use` 内容块 |

**保存即生效**：旧 Agent 进程被回收、按新配置重新拉起，而**对话历史不会断**——上下文本来就由事件日志投影而来（P2 那个设计决定的回报）。

两条安全规矩：API Key 落盘权限 `0600` 且**永不回传明文**（界面只显示 `sk-…a1b2`）；Key 输入框留空即「不修改」，不会因为改个模型名就把 Key 抹掉。

实测：填本机假服务后，连接测试分别命中 `/v1/chat/completions` 与 `/v1/messages`，两种协议都返回「连接成功 + 延迟 + 模型回复」。

## 自举：Agent 改自己的代码，但改坏不行

在页面里说一句「**换个配色**」，会发生这些事（都已实测）：

```
Lead ──tool.call: client.write{path:'style.css', reason:'人类要求换配色'}──▶ Kernel
                                                                          │ ① 写作用域校验：只允许 src/client/**
                                                                          │ ② 写入 → 跑项目自检（node --check + node --test test/client-ui.test.ts）
                                                                          │ ③ 通过 → 记版本 + 广播；失败 → 逐字节回滚
浏览器 ◀── SSE client.changed ── 换掉 <link> 的 href ──▶ 界面当场变色，不刷新
```

实测结果：横幅显示「客户端样式已更新（style.css），已即时生效 · 人类要求换配色 · v1 · 自检 通过 · +6 / −0」，发送按钮从紫色变成蓝色；点一下人类的「回滚」按钮，文件与原样逐字节一致、颜色变回紫色、时间线留下 `client.revert`。

**关键不是「Agent 能改代码」，而是「改坏留不下来」**：自检不过就回滚，且回滚是逐字节的。

## 打开就能用

```bash
npm run serve      # 自动探测本机 Ollama，探测不到就用内置演示模型
```

打开 <http://127.0.0.1:4311> —— 左边跟 Agent 说话，右边是**它自己画的界面**，改完立刻更新，不刷新页面。

| 区域 | 内容 |
| --- | --- |
| 左栏 · 对话 | 人类消息靠右，Agent 思考靠左，工具调用压缩成一行摘要 |
| 右上 · 界面面板 | Agent 发来的 View Spec 渲染结果，跑在 `<iframe sandbox srcdoc>` 里（渲染沙箱）；带版本号与一键回滚 |
| 右下 · 检查器 | Agent 进程表（含 pid）、任务板、事件时间线 |
| 顶栏 | 连接状态、界面版本、回滚、**中断（人类夺权）** |

真模型跑通的例子（本机 `qwen3:4b`，问「这个季度预算花得怎么样」）：模型自己决定调用 `ui.render`，于是面板上出现了「预算使用状况 / 已使用 620,000（62%）/ 使用进度 / 剩余 380,000」——**我们没写这个界面，是它画的**。

## 两个可跑的演示

```bash
npm run demo    # P0：单 Agent —— 子进程跑完五步 → ui.patch → 界面文档 v1 → HTML
npm run team    # P1：多 Agent —— Lead 建任务 → 拉起队友 → 队友领活干完 → 回报 → Lead 改界面
```

`npm run team` 的真实输出（两个独立进程、6 次宿主工具调用、任务板终态 completed）：

```
终态：completed（641ms）
子 Agent：teammate:ui
任务板：task_19 → completed @ teammate:ui
界面文档：v1，scopes=[surface.sidebar]
宿主工具调用：6 次
事件日志：81 条 {"agent.spawn":2,"agent.frame":65,"host.tool.call":6,"host.tool.result":6,"agent.exit":2}
```

## P1：宿主工具与编排（为什么这么设计）

Loop 是被 Kernel 托管的进程，它能调模型、跑本地工具，但有三件事**做不到也不该做**：拉起新进程、给别的 Agent 投递消息、把界面改动写进界面文档。

于是协议补一帧 `tool.reply`（入站）：Loop 发 `tool.call` 请宿主代办，宿主执行完回填。**被托管的进程不反向控制内核，只是提出请求。**

```
Lead 进程 ──tool.call: agent.spawn──▶ Kernel ──▶ 拉起 Teammate 进程
                                       │
Teammate ──loop.done──────────────────▶ Kernel ──自动回报父 Agent──▶ Lead 收到 peer.message
                                       │
Lead ──tool.call: ui.render──▶ Kernel ──▶ SurfaceIngest 校验 ──▶ 界面文档 v1
```

两条编排不变量：

- **子 Agent 完成由 Kernel 主动回报父 Agent**——不指望子 Agent 记得说话，`agent.wait` 因此不会挂死。
- **邮箱是唯一的投递记录**：先落盘再投递，目标不在世就等它上线，消息不丢。

## 三条公理

1. **界面是输出，不是外壳** —— UI 与文本、工具调用同级，都是 Agent 的表达通道。
2. **多 Agent 是内核能力，不是提示词技巧** —— Lead / Teammate / Subagent 是运行时一等公民。
3. **一个 Agent，一个子进程** —— 独立内存、独立预算、独立生命周期。

## 四层架构

| 层 | 目录 | 职责 |
| --- | --- | --- |
| Surface | `src/surface` | View Spec → 界面；组件注册表、未知类型降级、四级权限 |
| Bridge | `src/protocol` | 一行一帧的 NDJSON 协议、帧校验、通道 |
| Runtime | `src/runtime` `src/loop` `src/mailbox` `src/taskboard` | Agent Loop 五步状态机、邮箱、任务板、子进程入口 |
| Kernel | `src/kernel` `src/eventlog` | 进程池、审批门、事件日志与快照 |

> **数据自下而上流动，权限自上而下收敛。**

## SDD + TDD 混合驱动

这个仓库的规矩不是「先写代码再补测试」，也不是「写一堆没人看的文档」，而是两者互相咬合：

### SDD：规格先行

- `specs/*.md` 是**唯一事实源**。每份规格末尾都有 `## 验收标准`，每条带稳定 ID（如 `PROTO-003`）。
- 机器可校验的契约放在 `specs/schemas/*.schema.json`，由代码里的**声明式帧表**生成，并有测试断言「磁盘上的 schema == 代码生成的 schema」，防止规格与实现漂移。

### TDD：先红后绿

- 每个测试必须标注它验证的规格条目：`test('...', { }, ...)` 上方的 `@spec PROTO-003` 注释。
- 顺序固定：**写规格 → 写失败测试（红）→ 最小实现（绿）→ 重构**。
- 架构约束本身也是测试：`test/architecture.test.ts` 扫描 `src/**` 的 import，断言分层依赖方向（Surface 不许 import Kernel 实现、Protocol 不许依赖上层……）。

### 咬合点：可追溯性门禁

```bash
npm run check     # = npm run trace && npm test
```

`scripts/trace.mjs` 做双向校验，任一条不满足就**以非零码退出**：

| 违规 | 含义 |
| --- | --- |
| 规格条目没有测试 | 只在文档里存在的承诺，等于没有承诺 |
| 测试引用了不存在的规格 ID | 测试在验证幻觉 |
| schema 与代码不一致 | 契约漂移 |

## 快速开始

```bash
node -v            # 需要 >= 24（原生 TS + node:test，零运行时依赖）
npm run check      # 规格追溯门禁 + 全量测试
npm run typecheck  # 类型检查（无 tsc 时会明确提示「跳过」，不会假装通过）
npm run demo       # P0 端到端演示：Kernel 拉起源码里的 Agent Loop 子进程
npm run team       # P1 多 Agent 编排演示
```

`npm run demo` 会：

1. 由 Kernel 以子进程方式拉起一个 Agent Loop；
2. 通过 stdio 发送 `human.message` 帧；
3. Loop 走完五步状态机，回传 `agent.thinking` / `tool.call` / `ui.patch` 帧；
4. Surface 把 View Spec 渲染成 HTML 落盘 `examples/out/`。

## 目录

```
specs/          规格（SDD 事实源）+ schemas + traceability.md（自动生成）
src/protocol/   帧定义、校验、NDJSON 通道
src/eventlog/   追加写事件日志、快照、回放
src/loop/       Agent Loop 五步状态机、上下文组装、模型端口
src/runtime/    子进程入口（一个 Agent 一个进程）
src/kernel/     进程池、审批门
src/taskboard/  任务板 CAS 状态机
src/mailbox/    持久邮箱
src/surface/    View Spec 校验、渲染器、主题令牌
test/           node:test 测试，逐条标注 @spec ID
scripts/        trace.mjs（规格 ⇄ 测试 双向门禁）
```

## 边界

P0 只做**可测的内核垂直切片**：真实模型端口、Electron/Tauri 宿主、iframe 沙箱、热更新属于 P1–P3。当前模型端口是确定性的假实现，因此整套协作流程可以在 CI 里完全离线复现。
