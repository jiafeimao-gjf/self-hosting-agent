# SPEC-017 浏览器端设置页

状态：**已实现**

SPEC-015 把「模型怎么配」变成了服务端能力：设置落盘、接口齐全、Key 打码回传。但能力躺在
`/api/settings` 后面，人类还得手写 JSON 才能换模型——那不算「在界面里自己配」。

这一阶段补上浏览器端的最后一段：**一个覆盖主区域的独立设置页**，选协议、填 Base URL 与模型名、
点一下预设、测一次连接、保存生效。服务端契约由 SPEC-015 §2/§3 冻结，本页只做对接方，
**绝不假设服务端一定在**：接口缺失或字段缺失时退化为默认值，不许白屏。

## 1. 位置与形态

- 顶栏右侧新增「设置」入口（`#settings-open`）；点开后 `#settings` 覆盖主区域（对话 / 界面面板 / 检查器暂不可见），
  页面自带「← 返回对话」（`#settings-back`），返回后原对话记录与沙箱内容原样保留（不刷新页面）。
- 顶栏（`#current-model`）与设置页头部（`#settings-model`）都显示**当前生效的模型**，形如
  `qwen3:4b · 本机 Ollama`（模型名 · 来源标签）。
- 设置页是**纯 DOM 追加**：不引入任何第三方依赖、CDN、远程字体；样式仍只有 `/style.css`。

## 2. 表单

| 字段 | 控件 | 说明 |
| --- | --- | --- |
| 协议 | `input[type=radio][name=protocol]` | `openai` / `anthropic` 二选一，切换时更新端点差异说明 |
| Base URL | `#set-base-url` | 如本机 Ollama 的 `/v1`、或 Anthropic 官方根地址 |
| 模型名 | `#set-model` | 如 `qwen3:4b` / `claude-sonnet-4-5` |
| API Key | `#set-api-key`，`type="password"` | 已存过 Key 时**输入框留空**，placeholder 显示服务端打码值，并提示「留空表示不修改」 |
| 温度 | `#set-temperature`，可选 | 留空 = 用服务端默认；范围 0–2 |
| 最大输出 token | `#set-max-tokens`，可选 | 留空 = 用服务端默认；正整数 |
| 超时(ms) | `#set-timeout`，可选 | 留空 = 用服务端默认；正整数 |

协议说明必须写清差异：`openai` 打 `POST {baseUrl}/chat/completions`，用 `Authorization: Bearer`；
`anthropic` 打 `POST {baseUrl}/v1/messages`，用 `x-api-key` + `anthropic-version`。

预设快捷按钮（`#presets`，`data-preset`）：**本机 Ollama / OpenAI 官方 / Anthropic 官方 / DeepSeek**，
点一下自动填好协议 + Base URL + 模型名，**不清空**人类已输入的 Key 与可选数字。

## 3. 交互

- **测试连接**（`#settings-test`）：`POST /api/settings/test`，请求体是当前表单（服务端可据此用「已存 Key」）；
  成功显示 `延迟 {latencyMs} ms` 与模型回复片段，失败显示可读错误。
- **保存**（`#settings-save`）：先做本地校验，非法输入就地报错、**不发请求**；合法则 `PUT /api/settings`，
  成功后回到对话页并在对话里提示已保存，失败则在设置页内显示可读错误、停留在设置页。
- 服务端广播 `settings` 事件 / `/api/state` 携带生效模型时，顶栏模型 chip 同步更新。

## 4. 安全与防御

- **API Key 永不回显**：`GET /api/settings` 的打码值只用作 placeholder；表单的 Key 输入框恒为空；
  归一化函数**不读** `apiKey` 字段（服务端就算误传明文也不会进 DOM）。
- Key 只经表单 `PUT`/`POST` 的**请求体**送出：不进 `localStorage` / `sessionStorage` / cookie / URL / 日志。
- 所有进入 DOM 的文本（模型名、标签、回复片段、错误信息、表单错误）一律经 `escapeHtml` 转义；
  按钮 / 字段的 `data-*` 属性值同样转义。
- 任何 API 响应缺字段、类型不对、为空，都必须退化成可读文本或默认值，**不抛异常、不白屏**。

## 5. 纯逻辑与测试边界

`src/client/settings.js` 上半部分是纯函数（设置归一化、预设、表单校验、表单 ⇄ 设置互转、结果渲染），
Node 里 import 无副作用、可直接断言；`createSettingsPage()` 才做 DOM 连线，由 `app.js` 在浏览器里实例化。
沿用既有 UI-006 / UI2-006 的做法：纯逻辑直接 import，DOM 接线读源码结构断言。

## 验收标准

- **UI3-001** 顶栏「设置」入口打开独立的设置页并覆盖主区域，返回按钮回到对话且不刷新页面。
- **UI3-002** 顶栏与设置页显著位置显示当前生效的模型（`模型名 · 来源`），缺字段退化为默认值。
- **UI3-003** 表单字段齐全：协议二选一、Base URL、模型名、`type="password"` 的 API Key、温度 / 最大输出 token / 超时；协议说明写清两种端点差异。
- **UI3-004** 服务端设置 → 表单值：已存 Key 时输入框留空、placeholder 显示打码值并提示「留空表示不修改」；归一化永不读取明文 Key。
- **UI3-005** 四个预设按钮（本机 Ollama / OpenAI 官方 / Anthropic 官方 / DeepSeek）点一下填好协议 + Base URL + 模型名，且不动已输入的 Key。
- **UI3-006** 本地校验拦住非法输入（空 Base URL / 空模型名 / 未知协议 / 坏数字）且不发请求；合法则 `PUT /api/settings`，成功后回到对话并提示。
- **UI3-007** 测试连接调 `POST /api/settings/test`：成功显示延迟 ms 与模型回复片段，失败显示可读错误，缺字段退化不炸。
- **UI3-008** 防御与安全：Key 不进 localStorage / 日志 / URL 且永不回显明文，进入 DOM 的文本全部转义，任意坏输入不抛异常。
