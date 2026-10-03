# SPEC-015 设置与模型配置

状态：**已实现**

在此之前，模型是启动参数决定的：想换模型得改环境变量、重启服务。这一阶段把它变成**人类在界面里能自己配的东西**，并且支持两种主流协议。

## 1. 数据模型

```ts
interface ModelSettings {
  protocol: 'openai' | 'anthropic';   // OpenAI 兼容 /chat/completions，或 Anthropic /v1/messages
  baseUrl: string;                    // 例：http://127.0.0.1:11434/v1 或 https://api.anthropic.com
  model: string;                      // 例：qwen3:4b / claude-sonnet-4-5
  apiKey: string;                     // 本机模型可留空
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}
```

**默认值**：`{protocol:'openai', baseUrl:'http://127.0.0.1:11434/v1', model:'qwen3:4b'}`——即本机 Ollama，开箱即用、离线、不要 Key。

## 2. 存储与安全

- 落在 `<runDir>/settings.json`，文件权限 **0600**（里面有 Key）
- **API Key 永不回传明文**：`GET /api/settings` 只给 `apiKeyMasked`（如 `sk-…a1b2`）与 `hasApiKey`
- `PUT` 时 `apiKey` 缺省或为空字符串 → **保留原有 Key**（否则界面上「改模型名」会顺手把 Key 抹掉）

## 3. HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/settings` | 返回当前设置（Key 打码）+ 生效中的来源标签 |
| PUT | `/api/settings` | 保存并**生效**：重启 Lead 子进程，广播 `settings` 事件 |
| POST | `/api/settings/test` | 用给定（或已存）配置发一次最小请求，返回 `{ok, latencyMs, reply}` 或 `{ok:false, error}` |

`PUT` 之后必须让新配置真的生效——把旧的 Agent 进程回收、按新环境重新拉起。**历史不能丢**：上下文本来就由事件日志投影而来，重启后仍然连续（这正是当初把上下文做成投影的回报）。

## 4. 协议适配

两个适配器都实现同一个 `ModelPort`，由 `AGENT_PROTOCOL` 选择：

| 协议 | 端点 | 鉴权 | 工具调用 |
| --- | --- | --- | --- |
| `openai` | `POST {baseUrl}/chat/completions` | `Authorization: Bearer` | `tools[].function` / `tool_calls` |
| `anthropic` | `POST {baseUrl}/v1/messages` | `x-api-key` + `anthropic-version` | `tools[].input_schema` / `tool_use` 内容块 |

## 验收标准

- **SET-001** 无配置时的默认值是本机 Ollama（openai 协议），且 `hasApiKey` 为 false 也能正常工作。
- **SET-002** 保存后可读回且落盘；文件权限为 0600。
- **SET-003** `GET /api/settings` 永不返回明文 Key：只返回打码串与 `hasApiKey`。
- **SET-004** `PUT` 时省略或传空 `apiKey` → 保留原有 Key；传新 Key → 覆盖。
- **SET-005** 保存设置会重启 Lead 进程；重启后历史上下文仍在（由事件日志投影，不因重启断裂）。
- **SET-006** `POST /api/settings/test`：配置可用则返回 `{ok:true, latencyMs}`；不可用则返回 `{ok:false, error}`（可读信息，服务不崩）。
- **SET-007** 协议选择贯通到子进程：`AGENT_PROTOCOL=anthropic` 时子进程走 Anthropic 适配器（可在假服务上验证）。
- **SET-008** 设置变更广播 `settings` 事件，`/api/state` 里的生效模型信息同步更新。
- **SET-009** 非法输入被拒绝：未知协议、空 `baseUrl`、空 `model` → 400 且不落盘。
- **SET-010** 打码规则可测：长度足够的 Key 显示头尾、过短的 Key 全遮。
- **SET-013** 模型配置**按对话隔离**，且设置页作用在**当前对话**上：`GET/PUT/POST /api/settings*` 都接受 `?conversation=<id>`；在 c1 里读到/改到的必须是 c1 的配置，绝不是 default 的（真机踩过：c1 用 Ollama，设置页却显示 deepseek）；切换对话时若设置页开着要跟着重读。
- **SET-014** 新建对话**继承**当前活跃对话的模型配置（协议 / 端点 / 模型 / Key / 超时），而不是回落到内置默认——否则用户每开一个对话都要重配一次模型与 Key。已有配置的对话不被覆盖。
- **SET-015** 多对话之前的全局 `<root>/settings.json` 在启动时**幂等迁移**进默认对话：目标已存在则不覆盖（用户后来配的优先），老文件保留不删（不带 Key 的东西宁可多留一份也不悄悄删）。
- **SET-016** 列出可用模型：`POST /api/models` 按候选配置（不写盘）拉取列表——OpenAI 兼容走 `{baseUrl}/models`、Anthropic 走 `{baseUrl}/v1/models` + `x-api-key`；返回 `{ok, models:[{id,label?}], count}`，条目有上限；超时 / 连不上 / 鉴权失败 / 响应格式不对都给出**可归因**的错误码，且**绝不回显 Key**。
- **SET-017** 客户端「列出模型」：一次点击即列出端点上的模型并渲染成可点选的候选（`datalist` 提供输入联想 + 候选按钮**点一下即切换**，走与保存完全相同的路径）；本地 Ollama 必须能列出本机模型并尽量带上体积/参数量；列表为空或失败都显示原因，且**不阻断手动输入模型名**。
