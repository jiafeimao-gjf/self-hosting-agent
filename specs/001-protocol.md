# SPEC-001 帧协议（Bridge 层）

状态：**已实现** · 对应架构第「Bridge」层

宿主与 Agent Loop 之间不开放端口、不走网络，只通过 stdio 传 NDJSON：**一行一帧，双向同构**。

## 1. 信封

每帧的公共字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `t` | string | 是 | 帧类型，必须来自下面的帧表 |
| `agent` | string | 否 | 发送者 id（如 `lead`、`teammate:frontend`） |
| `seq` | integer ≥ 0 | 否 | 同一发送者内单调递增 |
| `ts` | string | 否 | ISO8601 时间戳 |

除上述字段与本帧声明的字段外，**不允许出现未知字段**（协议宁可报错，也不静默忽略）。

## 2. 帧表

方向 `in` = 宿主 → Loop，`out` = Loop → 宿主。

| `t` | 方向 | 必填 | 可选 |
| --- | --- | --- | --- |
| `human.message` | in | `text` | `at` |
| `peer.message` | in | `from`, `body` | `taskId`, `artifacts` |
| `ui.event` | in | `target`, `event` | `payload` |
| `approval.reply` | in | `id`, `decision` | `reason` |
| `interrupt` | in | `reason` | — |
| `agent.thinking` | out | `text` | — |
| `tool.call` | out | `id`, `name` | `args` |
| `tool.result` | out | `id`, `ok` | `result`, `error` |
| `ui.patch` | out | `scope`, `op`, `spec` | — |
| `approval.ask` | out | `id`, `action`, `risk` | — |
| `loop.step` | out | `step`, `name` | — |
| `loop.state` | out | `state` | `detail` |
| `loop.done` | out | `reason` | — |
| `loop.error` | out | `message` | `stack` |

`ui.patch.spec` 的结构由 SPEC-006 的 View Spec 契约约束，帧表只校验它是对象。

## 3. 错误码

| 码 | 触发条件 |
| --- | --- |
| `BAD_JSON` | 该行不是合法 JSON |
| `NOT_OBJECT` | 解析结果不是对象（数组/标量/null） |
| `UNKNOWN_TYPE` | `t` 缺失或不在帧表中 |
| `MISSING_FIELD` | 缺少必填字段 |
| `BAD_FIELD_TYPE` | 字段类型不符 |
| `UNKNOWN_FIELD` | 出现未声明字段 |

## 4. 通道语义

- 一行一帧：`encodeFrame` 结果内不得包含裸换行；`\n` 是唯一分隔符。
- 粘包/拆包：一次 `data` 可以包含半帧，也可以包含多帧；通道必须自行缓冲。
- 超长行：单行超过上限（默认 1 MiB）时抛一个 `LINE_TOO_LONG` 错误事件，通道必须**存活**且不再把该行当成帧。
- 关闭：`close()` 之后 `send` 抛错，输入流 end 时通道发出 `close` 事件。

## 验收标准

- **PROTO-001** `encodeFrame` 输出单行 JSON 且以 `\n` 结尾；文本里的换行被转义，不产生裸换行。
- **PROTO-002** `decodeFrame` 对非法输入返回 `{ok:false, code}`，**不抛异常**。
- **PROTO-003** 未知 `t` 报 `UNKNOWN_TYPE`；缺少必填字段报 `MISSING_FIELD` 并指明字段名。
- **PROTO-004** 未知字段报 `UNKNOWN_FIELD`；字段类型不符报 `BAD_FIELD_TYPE`。
- **PROTO-005** 通道能正确处理半帧（分块到达）与多帧粘连。
- **PROTO-006** 超长行触发 `LINE_TOO_LONG` 错误事件，通道在之后仍能正常收帧。
- **PROTO-007** `frameJsonSchema()` 的输出必须与磁盘上 `specs/schemas/frame.schema.json` 完全一致（契约漂移门禁）。
- **PROTO-008** 每个帧类型都声明了方向，`directionOf()` 与帧表一致，`isInbound()` 可判定。
- **PROTO-009** 每个帧类型都必须能编码-解码往返（round trip）而不丢字段。
