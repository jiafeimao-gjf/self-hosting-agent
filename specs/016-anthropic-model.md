# SPEC-016 Anthropic 协议适配器（/v1/messages）

状态：**已实现** · 上游：SPEC-015 §4「两个适配器都实现同一个 `ModelPort`，由 `AGENT_PROTOCOL` 选择」

SPEC-009 把 Loop 接到了 **OpenAI 兼容**的 `/chat/completions`。本规格补上第二种协议：
`src/loop/anthropic-model.ts` 把同一个 `ModelPort` 接到 Anthropic 的 `POST {baseUrl}/v1/messages`。

端口不变、失败要响、离线可测这三条原则与 SPEC-009 完全一致；差别只在**线格式**，而线格式的差异集中在三处：

1. **system 不在 messages 里**：它是请求体的顶层 `system` 字段。
2. **工具结果是内容块**：工具调用是 assistant 的 `tool_use` 块，结果必须作为紧接着的 user 消息里的 `tool_result` 块回填。
3. **角色必须交替**：user / assistant 相邻同角色要合并，连续多条工具结果必须收进**同一条** user 消息。

## 1. 端口契约

```ts
createAnthropicModel(options: AnthropicModelOptions): ModelPort
```

| 选项 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `baseUrl` | ✅ | — | 例如 `https://api.anthropic.com`，尾部斜杠会被归一化 |
| `apiKey` | ✅ | — | 以 `x-api-key: <apiKey>` 发送 |
| `model` | ✅ | — | 请求体里的 `model` |
| `maxTokens` | — | `4096` | Anthropic 的 `max_tokens` 是**必填**字段，因此这里必须有默认值 |
| `temperature` | — | 不发送 | 只有显式给出才写入请求体（`0` 也是有效值） |
| `timeoutMs` | — | `30000` | 单次 HTTP 交换（含读 body）的总超时 |
| `fetchImpl` | — | 全局 `fetch` | 注入点：测试、代理、自定义传输都靠它 |
| `maxRetries` | — | `2` | **重试次数**（总尝试次数 = `maxRetries + 1`） |
| `retryBaseDelayMs` | — | `250` | 退避基数，第 n 次重试等待 `base * 2^n` |
| `anthropicVersion` | — | `2023-06-01` | 映射为 `anthropic-version` 请求头 |

请求：`POST {baseUrl}/v1/messages`，头 `content-type: application/json`、`x-api-key`、`anthropic-version`，
体 `{ model, max_tokens, messages, system?, tools?, temperature? }`。

## 2. 上下文与工具的映射

`ContextItem[]` 被拆成两份：`system` 项全部提到顶层，其余进 `messages`。

| `ContextItem.role` | 去向 |
| --- | --- |
| `system` | 顶层 `system` 字段：多条按出现顺序用 `\n\n` 拼接；全为空串时**不发** `system` 字段。绝不进 `messages` |
| `human` | `{ role: 'user', content: [{ type: 'text', text }] }` |
| `peer` | 也是 `user`：`{ type: 'text', text: '[来自 <from>] <text>' }`，来源取自 `meta.from`，缺失时为 `peer` |
| `assistant` | `{ role: 'assistant', content: [{ type: 'text', text }] }` |
| `tool` | `{ role: 'user', content: [{ type: 'tool_result', tool_use_id: meta.id, content: text }] }` |

**相邻同角色合并**：构建 `messages` 时，若上一条消息角色与新块相同，就直接追加内容块而不是新开消息。
这是 Anthropic「user / assistant 必须交替」的要求，也正好让**连续多条工具结果落进同一条 user 消息的多个
`tool_result` 块**，而不是几条合法的 user 消息。

**`meta.id` 缺失的降级**：`tool_result.tool_use_id` 必须对应前一条 assistant 的 `tool_use.id`，伪造一个
不存在的 id 会被 Anthropic 直接判 400。因此缺失 `meta.id` 时**不伪造 id**，而是把该条降级为同一条 user
消息里的普通文本块，内容前缀 `[工具结果] `——内容不丢，消息结构仍然合法（与 SPEC-009 里「没有 id 就不带
`tool_call_id`」同源：宁可少一个字段，也不编一个假的）。这种情况视为上游编排漏了配对信息。

`ToolSpec[]` → `tools: [{ name, description, input_schema }]`。`ToolSpec` 目前没有参数 schema 字段，
`input_schema` 用空对象 schema `{ type: 'object', properties: {} }`；`description` 缺失时给空串。
`tools` 为空数组时**不带**该字段。

## 3. 响应解析与终止约定

`content` 必须是数组，否则视为不可信响应。逐块解析：

- `{ type: 'text', text }` → 收集；多个文本块按出现顺序用 `\n` 拼接。空串不计入。
- `{ type: 'tool_use', id, name, input }` → `toolCalls[]`。`input` **已经是对象**，不做 `JSON.parse`；
  缺失时视为 `{}`，存在但不是对象则抛 `bad_response`。`id` 缺失时补一个稳定的 `toolu_<index>`，
  避免 Loop 里 `tool.call` / `tool.result` 配对断链。
- 其它类型的块（例如 `thinking` / `redacted_thinking`）**跳过不报错**：协议会演进，未知块不该让整轮失败。

`usage.input_tokens + usage.output_tokens` → `usage.tokens`（两者至少有一个是数字时才带上；都没有则不产生
`usage` 字段）。

**终止约定**（决定 Loop 是否继续下一轮）：

| 响应形态 | `done` |
| --- | --- |
| 有 `toolCalls`（即有待办动作） | `false` |
| 没有待办动作，且 `text` 非空 | `true` |
| 没有待办动作，也没有文本 | `undefined`（交给 Loop 的预算护栏终止） |

## 4. 错误与重试

导出的错误类型（宿主可 `instanceof` 识别）：

- `AnthropicModelError`：字段 `kind: 'http' | 'network' | 'timeout' | 'bad_response'`、
  `status?: number`（非 2xx 时的 HTTP 状态码）、`bodySnippet?: string`（响应片段，截断到 500 字符）。
- `AnthropicModelTimeoutError extends AnthropicModelError`：额外字段 `timeoutMs`，`kind` 恒为 `'timeout'`。

重试策略：**只对 429、5xx、网络错误**重试，退避 `retryBaseDelayMs * 2^n`；其余 4xx 立即抛出。
`maxRetries` 用尽后抛出**最后一次**的错误（不包装成新错误，保留 `status` / `bodySnippet`）。
超时不在重试之列（同 SPEC-009 的理由）。

超时用 `AbortController` + `timeoutMs` 实现：定时器到点 `abort()`，`fetch` 的中止被翻译为
`AnthropicModelTimeoutError`，错误信息包含 `timeoutMs` 与实际 URL。

## 5. 与架构约束的一致性

- `src/loop/anthropic-model.ts` 只 `import type` 自 `./loop.ts`，不 import kernel / runtime / surface / protocol 的任何实现 → 不违反 SPEC-000 §2 与 ARCH-002。
- 零第三方依赖；网络走全局 `fetch`（Node ≥ 24 内置），测试用 `node:http` 本地假服务，全程离线。
- Node 24 类型擦除约束：无 `enum` / `namespace` / 构造函数参数属性；相对导入带 `.ts` 后缀；类型导入用 `import type`。

## 验收标准

- **ANTH-001** `createAnthropicModel` 返回可用的 `ModelPort`：请求发往 `{baseUrl}/v1/messages`（`baseUrl` 尾部斜杠被归一化），带 `x-api-key`、`anthropic-version`（默认 `2023-06-01`，可覆盖）与 JSON 内容类型；请求体含 `model`，且 `max_tokens` 缺省为 `4096`。
- **ANTH-002** `role: 'system'` 的上下文全部提到请求体顶层 `system` 字段（多条按顺序用 `\n\n` 拼接），且不出现在 `messages` 中；没有 system 项时不发送 `system` 字段。
- **ANTH-003** `human` 映射为 `{ role: 'user', content: [{ type: 'text', text }] }`，`assistant` 映射为 `{ role: 'assistant', content: [{ type: 'text', text }] }`。
- **ANTH-004** `peer` 映射为 `user` 的文本块，文本前缀 `[来自 <from>] `，来源取自 `meta.from`，缺失时为 `peer`；相邻 user 消息被合并为一条消息的多个文本块。
- **ANTH-005** `role: 'tool'` 映射为 `user` 消息的 `{ type: 'tool_result', tool_use_id: meta.id, content: text }` 块；`meta.id` 缺失时**不伪造 id**，降级为同一条 user 消息里的 `[工具结果] <text>` 文本块。
- **ANTH-006** 连续多条工具结果被合并进**同一条** user 消息的多个 `tool_result` 块（不产生连续多条 user 消息），满足 Anthropic 的 user/assistant 交替要求。
- **ANTH-007** `ToolSpec[]` 映射为 `tools[{ name, description, input_schema }]`，`input_schema` 为空对象 schema，`description` 缺失时给空串；工具为空时不发送 `tools` 字段。
- **ANTH-008** `maxTokens` 映射为 `max_tokens`（覆盖默认 `4096`），`temperature` 只有显式给出时才发送（`0` 也必须被发送）。
- **ANTH-009** 响应 `content` 数组的 `text` 块按顺序用 `\n` 拼接为 `text`，未知类型块被跳过，全空时 `text` 为 `undefined`；`tool_use` 块映射为 `toolCalls`，`input` 作为对象直接使用（不 `JSON.parse`），`id` 缺失时补 `toolu_<index>`。
- **ANTH-010** `usage.input_tokens + usage.output_tokens` → `usage.tokens`（无 usage 时不产生该字段）；终止约定：有待办动作 → `done: false`，纯文本 → `done: true`，两者皆无 → `done` 为 `undefined`。
- **ANTH-011** 响应不可信（响应体不是 JSON、缺少 `content` 数组、`tool_use` 缺少 `name`、`tool_use.input` 不是对象）时抛 `AnthropicModelError`（`kind: 'bad_response'`）；非 2xx 抛 `AnthropicModelError`（`kind: 'http'`）并携带 `status` 与截断后的响应片段 `bodySnippet`。
- **ANTH-012** 超过 `timeoutMs` 时用 `AbortController` 中止请求并抛 `AnthropicModelTimeoutError`（含 `timeoutMs`，不重试）；429、5xx 与网络错误按 `maxRetries` 以 `retryBaseDelayMs * 2^n` 退避重试，用尽后抛出最后一次错误；非 429 的 4xx 不重试。
- **ANTH-013** 助手消息带 `toolCalls` 时输出 `tool_use` 内容块（`input` 为对象），与文本块同处一条 assistant 消息，使后续 `tool_result` 的 `tool_use_id` 有对应项。
