# SPEC-009 真实模型端口（HTTP /chat/completions）

状态：**已实现** · 上游：SPEC-000 §4「P0 允许用确定性假模型端口替代真实 LLM」的 P1 补课

P0 用 `src/loop/fake-model.ts` 把协议与状态机做成了真的，模型是假的。本规格补上另一半：
`src/loop/http-model.ts` 把 Loop 的 `ModelPort` 接到任意 **OpenAI 兼容**的 `POST {baseUrl}/chat/completions` 上。

设计原则有三条，其余细节都由它们推导：

1. **端口不变**：真实适配器只实现 `ModelPort`，Loop 一行不改。模型是不是真的，对状态机不可见。
2. **失败要响**：模型返回的结构一旦不可信（非 2xx、非法 JSON、arguments 解析不了、UI 意图不合法），
   一律抛**导出类型**的错误，而不是降级成空参数去执行工具。让宿主能识别、能让 Loop 进入 `error` 终态。
3. **离线可测**：零第三方依赖，用 `node:http` 起本地假服务；`fetchImpl` 可注入，测试与代理都不碰真实网络。

## 1. 端口契约

```ts
createHttpModel(options: HttpModelOptions): ModelPort
```

| 选项 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `baseUrl` | ✅ | — | 例如 `https://api.example.com/v1`，尾部斜杠会被归一化 |
| `model` | ✅ | — | 请求体里的 `model` |
| `apiKey` | ✅ | — | 以 `Authorization: Bearer <apiKey>` 发送 |
| `temperature` | — | 不发送 | 只有显式给出才写入请求体（`0` 也是有效值） |
| `maxTokens` | — | 不发送 | 映射为请求体的 `max_tokens` |
| `timeoutMs` | — | `30000` | 单次 HTTP 交换（含读 body）的总超时 |
| `fetchImpl` | — | 全局 `fetch` | 注入点：测试、代理、自定义 TLS 都靠它 |
| `maxRetries` | — | `2` | **重试次数**（总尝试次数 = `maxRetries + 1`） |
| `retryBaseDelayMs` | — | `250` | 退避基数，第 n 次重试等待 `base * 2^n` |
| `uiToolName` | — | 不启用 | 命中该名字的工具调用转成 `uiPatches` |

请求：`POST {baseUrl}/chat/completions`，头 `content-type: application/json` 与
`authorization: Bearer <apiKey>`，体 `{ model, messages, tools?, temperature?, max_tokens? }`。

## 2. 上下文与工具的映射

| `ContextItem.role` | OpenAI `message` |
| --- | --- |
| `system` | `{ role: 'system', content: text }` |
| `human` | `{ role: 'user', content: text }` |
| `peer` | `{ role: 'user', content: '[来自 <from>] <text>' }`，来源取自 `meta.from`，缺失时为 `peer` |
| `assistant` | `{ role: 'assistant', content: text }` |
| `tool` | `{ role: 'tool', content: text, tool_call_id: meta.id }`，`meta.id` 缺失时不带该字段 |

`ToolSpec[]` → `tools: [{ type: 'function', function: { name, description, parameters } }]`。
`ToolSpec` 目前没有参数 schema 字段，因此 `parameters` 用空对象 schema
`{ type: 'object', properties: {} }`；`description` 缺失时给空串。`tools` 为空数组时**不带**该字段。

## 3. 响应解析与终止约定

- `choices[0].message.content` → `text`。**空串与缺失统一归一化为 `undefined`**（Loop 只在 `text !== undefined && text !== ''` 时才外发 `agent.thinking`，归一化让「没说话」与「说了空话」不产生两种行为）。
- `choices[0].message.tool_calls[]` → `toolCalls[]`；`function.arguments` 是 JSON 字符串，解析为对象；空串等价于 `{}`。
  `arguments` 不是合法 JSON、或解析结果不是对象 → 抛 `HttpModelError`（`kind: 'bad_arguments'`）。
  宁可整轮失败也不静默降级为 `{}`：拿空参数去执行删除/写文件这类副作用的工具，比报错危险得多。
- `usage.total_tokens` → `usage.tokens`（只有是数字时才带上）。
- `id` 缺失的工具调用补一个稳定的 `call_<index>`，避免 Loop 里 `tool.call` / `tool.result` 配对断链。

**终止约定**（决定 Loop 是否继续下一轮）：

| 响应形态 | `done` |
| --- | --- |
| 有工具调用（或转出了 `uiPatches`） | `false` |
| 没有待办动作，且 `text` 非空 | `true` |
| 没有待办动作，也没有文本 | `undefined`（交给 Loop 的预算护栏终止） |

## 4. UI 工具（`uiToolName`）

当模型调用的工具名等于 `uiToolName` 时，这一次调用被解释为一次界面意图而不是工具执行：
`arguments` 必须是 `{ scope: string, op: 'patch' | 'replace' | 'mount', spec: object }`，转成
`ModelOutput.uiPatches`，**不进入** `toolCalls`（Loop 因此不会去找同名工具执行）。
`scope` 缺失/非字符串、`op` 不在枚举内、`spec` 非对象 → 抛 `HttpModelError`（`kind: 'bad_ui_patch'`）。

注意：这里只做**形状**校验；`scope` 是否在白名单、组件是否已知，仍由 Loop 的 `UiGuard`（SPEC-003）裁决。两者分工不重叠。

## 5. 错误与重试

导出的错误类型（宿主可 `instanceof` 识别）：

- `HttpModelError`：字段 `kind: 'http' | 'network' | 'timeout' | 'bad_response' | 'bad_arguments' | 'bad_ui_patch'`、
  `status?: number`（非 2xx 时的 HTTP 状态码）、`bodySnippet?: string`（响应片段，截断到 500 字符，便于宿主展示与日志）。
- `HttpModelTimeoutError extends HttpModelError`：额外字段 `timeoutMs`，`kind` 恒为 `'timeout'`。

重试策略：**只对 429、5xx、网络错误**重试，退避 `retryBaseDelayMs * 2^n`；其余 4xx 立即抛出。
`maxRetries` 用尽后抛出**最后一次**的错误（不包装成新错误，保留 `status` / `bodySnippet`）。
超时不在重试之列——超时通常是请求本身太大或网络不可达，重试只会把预算烧在同一个坑里；
需要重试超时的宿主应显式调大预算或自行包裹端口。

超时用 `AbortController` + `timeoutMs` 实现：定时器到点 `abort()`，`fetch` 的中止被翻译为
`HttpModelTimeoutError`，错误信息包含 `timeoutMs` 与实际 URL。

## 6. 与架构约束的一致性

- `src/loop/http-model.ts` 只 `import type` 自 `./loop.ts`，不 import kernel / runtime / surface / protocol 的任何实现 → 不违反 SPEC-000 §2 的依赖方向与 ARCH-002。
- 零第三方依赖；网络实现走全局 `fetch`（Node ≥ 24 内置），测试用 `node:http` 本地假服务，全程离线。
- Node 24 类型擦除约束：无 `enum` / `namespace` / 构造函数参数属性；相对导入带 `.ts` 后缀；类型导入用 `import type`。

## 验收标准

- **MODEL-001** `createHttpModel` 返回可用的 `ModelPort`：请求发往 `{baseUrl}/chat/completions`，带 `Authorization: Bearer <apiKey>`、JSON 内容类型与 `model` 字段，默认使用全局 `fetch`。
- **MODEL-002** `ContextItem[]` 的角色映射：`system`/`human`/`assistant` 直译，`human` → `user`，`peer` → `user` 且前缀标注来源（取自 `meta.from`，缺失时用 `peer`）。
- **MODEL-003** `role: 'tool'` 的上下文映射为 `{ role: 'tool', content, tool_call_id }`，`tool_call_id` 取自 `meta.id`，缺失时不带该字段。
- **MODEL-004** `ToolSpec[]` 映射为 `tools[{ type: 'function', function: { name, description, parameters } }]`，`parameters` 为空对象 schema，`description` 缺失时给空串；工具为空时不发送 `tools` 字段。
- **MODEL-005** `temperature` 与 `maxTokens` 只有显式给出时才映射为 `temperature` / `max_tokens`（`0` 也必须被发送）。
- **MODEL-006** 正常响应：`choices[0].message.content` → `text`，`usage.total_tokens` → `usage.tokens`；无 `usage` 时不产生 `usage` 字段。
- **MODEL-007** 空字符串或缺失的 `content` 统一归一化为 `undefined`。
- **MODEL-008** `tool_calls[]` 映射为 `toolCalls[]`，`arguments` 的 JSON 字符串被解析为对象，空串等价于 `{}`。
- **MODEL-009** `arguments` 不是合法 JSON 或解析结果不是对象时，抛 `HttpModelError`（`kind: 'bad_arguments'`），不静默降级为空参数。
- **MODEL-010** 终止约定：有工具调用（含转出的 `uiPatches`）→ `done: false`；无待办动作且文本非空 → `done: true`；两者皆无 → `done` 为 `undefined`。
- **MODEL-011** `uiToolName` 命中的调用被转成 `ModelOutput.uiPatches`（`scope`/`op`/`spec` 原样），且不出现在 `toolCalls` 中。
- **MODEL-012** `uiToolName` 调用的 `arguments` 形状非法（`scope` 缺失或非字符串、`op` 不在 `patch|replace|mount` 内、`spec` 非对象）时抛 `HttpModelError`（`kind: 'bad_ui_patch'`）。
- **MODEL-013** 非 2xx 响应抛 `HttpModelError`，携带 `status` 与截断后的响应片段 `bodySnippet`。
- **MODEL-014** 超过 `timeoutMs` 时用 `AbortController` 中止请求，抛 `HttpModelTimeoutError`（信息含 `timeoutMs`，`status` 为空）。
- **MODEL-015** 429、5xx 与网络错误按 `maxRetries` 退避重试（默认 2 次、总尝试 3 次），用尽后抛出最后一次的错误。
- **MODEL-016** 非 429 的 4xx 不重试：只发一次请求即抛错。
- **MODEL-017** 响应结构不可信（响应体不是 JSON、缺少 `choices[0]`、工具调用缺少 `function.name`）时抛 `HttpModelError`（`kind: 'bad_response'`）。
- **MODEL-018** 助手消息带 `toolCalls` 时输出 `tool_calls`（`arguments` 为 JSON 串），使后续 `role:'tool'` 消息的 `tool_call_id` 有对应项——否则严格端点直接 400。
- **MODEL-019** 工具名出网合法：内网名可含点（`ui.render`），但发给端点前必须压成 `^[a-zA-Z0-9_-]{1,64}$`，回程再映射回内部名；两个内部名压成同一个线上名时必须当场报错，不许猜。
- **MODEL-020** 参数 schema 透传：`ToolSpec.parameters` 原样作为 `function.parameters` 发出，缺省才退回空对象 schema（空 schema 的后果是模型只能给个 `{}`）。
