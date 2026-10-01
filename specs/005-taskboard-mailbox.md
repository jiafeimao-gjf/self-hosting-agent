# SPEC-005 任务板与邮箱（Runtime 协作原语）

状态：**已实现** · 对应架构第「Runtime」层 · 只依赖 `src/protocol`（依赖方向铁律见 SPEC-000 §2）

多 Agent 之间不共享内存。协作只经由两个原语：

- **任务板（TaskBoard）**：谁做什么、做到哪、动哪些文件。用 compare-and-set 解决抢单，用依赖解决排序。
- **邮箱（Mailbox）**：话怎么传到。append-only 落盘，只在 step boundary 被消费（不变量 I2）。

两者都不持有进程句柄、不管调度：它们只提供状态与投递语义，调度权在 Kernel（I1 单写者）。

## 1. 任务板：数据模型

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 是 | 稳定 id，缺省按 `task_<n>` 生成 |
| `subject` | string | 是 | 一句话目标，非空（去空白后） |
| `description` | string | 是 | 细节，缺省 `""` |
| `status` | string | 是 | `pending` \| `in_progress` \| `completed` |
| `owner` | string \| null | 是 | 认领者；`pending` 时必为 `null` |
| `blockedBy` | string[] | 是 | 依赖的任务 id，缺省 `[]` |
| `writeScopes` | string[] | 是 | 声称要写的路径，缺省 `[]` |
| `revision` | integer ≥ 0 | 是 | CAS 版本号，创建时为 `0` |
| `createdAt` | string | 是 | ISO8601 创建时间 |
| `updatedAt` | string | 是 | ISO8601 最近变更时间 |

创建时 `status = pending`、`owner = null`、`revision = 0`、`createdAt = updatedAt`。

所有读取接口（`get`/`list`/`ready`/`conflicts`/事件里的任务）返回**快照副本**：调用方改不动内部状态。

## 2. 状态机与 CAS

```
pending ──claim──▶ in_progress ──complete──▶ completed
   ▲                    │                       │
   └────── release ─────┘                       │
   └────────────── reopen ──────────────────────┘
```

| 操作 | 前置 | 效果 |
| --- | --- | --- |
| `claim(id, owner, expectedRevision)` | `pending`、`owner === null`、无未完成依赖 | → `in_progress`，写入 `owner` |
| `release(id, owner, expectedRevision)` | `in_progress`、调用者是 `owner` | → `pending`，`owner = null` |
| `complete(id, owner, expectedRevision)` | `in_progress`、调用者是 `owner` | → `completed`，保留 `owner` |
| `reopen(id, expectedRevision)` | `completed` | → `pending`，`owner = null` |

- 每个变更操作都必须带 `expectedRevision`；`revision` 不匹配一律 `REVISION_CONFLICT`，并在错误里给出 `expected` / `actual`。**校验顺序：先存在性，再 CAS，再状态机。**
- 每次成功变更 `revision += 1`、`updatedAt` 前进。
- 失败的操作必须**原子**：任务字段、`revision`、审计日志、`onChange` 均不产生任何变化。
- 并发抢同一任务时，只有一个调用能通过 CAS，其余得到冲突或非法迁移错误。

## 3. 就绪与依赖

`ready()` 返回满足全部条件的任务，按创建顺序：

1. `status === 'pending'`；
2. `owner === null`；
3. `blockedBy` 中每个任务都已 `completed`。

`create` 时 `blockedBy` 引用不存在的任务 → `UNKNOWN_BLOCKER`，任务不落库。依赖不自动级联：上游完成后，下游只是变「就绪」，仍需显式 `claim`。

## 4. 写作用域：契约不是锁

- `conflicts(owner, scopes)` 返回**在途**（`in_progress`）且 `writeScopes` 与给定作用域重叠、且不属于 `owner` 的任务。
- 重叠判定是路径前缀语义：相等，或一方是另一方的路径前缀（按 `/` 分段）。`""` 与 `"."` 视为仓库根，与任何作用域重叠。
- **重叠只是警告**：`claim` 不会因为重叠而失败；警告随 `task.claimed` 事件（`conflicts` 字段）交给宿主记录，是否让路由 Agent/人类决定。

## 5. 事件与审计

`onChange(listener)` 订阅所有成功变更，返回退订函数；`events()` 返回只增不改的审计记录。事件结构：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `type` | string | `task.created` \| `task.claimed` \| `task.released` \| `task.completed` \| `task.reopened` |
| `task` | object | 变更后的任务快照 |
| `actor` | string \| null | 触发者；创建为 `null` |
| `at` | string | ISO8601 |
| `conflicts` | object[]? | 仅 `task.claimed`：写作用域重叠警告 |

失败的操作不派发事件、不进审计。

## 6. 任务板持久化

- `toJSON()` → `{ version: 1, tasks: Task[] }`；`TaskBoard.fromJSON(snapshot)` 反向重建（重建不进审计、不派发事件）。
- `save(path)` 写 JSONL（一行一任务）；`TaskBoard.load(path)` 读回，坏行报 `PERSIST_ERROR`。
- 重建后 id 生成器不得与既有 id 冲突。

## 7. 邮箱：消息模型

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 是 | 稳定 id，缺省按 `mail_<n>` 生成 |
| `from` | string | 是 | 发送者，形如 `teammate:frontend` 或裸 id |
| `to` | string | 是 | 收件 Agent id |
| `kind` | string | 是 | 消息类别（如 `peer.message`、`handoff`） |
| `body` | string | 是 | 正文，可为空串 |
| `taskId` | string | 否 | 关联任务 |
| `artifacts` | string[] | 否 | 附带产物路径 |
| `createdAt` | string | 是 | ISO8601 |
| `deliveredAt` | string | 否 | 被消费的时间；未投递时不存在 |

`pending(agentId)` 只读返回该 Agent 尚未投递的消息（按到达顺序），**不消费**、不写 `deliveredAt`。

## 8. 边界投递（I2）

`drainAt(agentId, 'step_boundary')` 在 step boundary 一次性取出并消费该 Agent 的全部待投递消息：

- 消费 = 写 `deliveredAt` + 追加一条投递记录，**先落盘再改内存**：落盘失败则消息保持未投递（不丢）。
- 同一批消息只会被投递一次；第二次 `drainAt` 返回空数组。
- 边界参数不是 `'step_boundary'` → `BAD_BOUNDARY`，且不消费任何消息。
- 收件 Agent 不存在、空闲或还没被拉起都不影响投递：消息留在邮箱里，等它下次 `drainAt`。

## 9. 邮箱持久化与幂等

- 构造函数接受文件路径（以 `.jsonl` 结尾）或目录（目录下写 `mailbox.jsonl`）；不传路径即纯内存模式。
- 存储是 **append-only JSONL**：`send` 追加 `{op:'send',message}`，`drainAt` 追加 `{op:'deliver',to,ids,at}`；启动时按行回放重建状态，坏行跳过（不阻塞其余消息恢复）。
- 重复 id 幂等：`send` 同一个 id 不新增记录，返回已存在的消息并标记 `duplicate: true`；消费记录也幂等，重复回放不会二次投递。

## 10. 发送方前缀与帧互转

- `senderKind(sender)` 解析 `角色:实例` 的前缀：`teammate:frontend` → `teammate`，裸 id → `agent`。
- 邮箱与 Bridge 层的 `peer.message` 帧互转：`toPeerFrame(message)` / `fromPeerFrame(frame, to)`，跨层数据只用 SPEC-001 的帧类型。

## 11. 错误码

任务板：

| 码 | 触发条件 |
| --- | --- |
| `NOT_FOUND` | 任务 id 不存在 |
| `DUPLICATE_ID` | 创建时 id 已存在 |
| `INVALID_INPUT` | 字段缺失/类型不符/`subject` 为空 |
| `UNKNOWN_BLOCKER` | `blockedBy` 引用不存在的任务 |
| `REVISION_CONFLICT` | `expectedRevision` 与当前 `revision` 不符 |
| `INVALID_TRANSITION` | 当前状态不允许该操作 |
| `BLOCKED` | 依赖未完成时 `claim` |
| `NOT_OWNER` | `release` / `complete` 的调用者不是 `owner` |
| `PERSIST_ERROR` | `save` / `load` 的 IO 或坏行 |

邮箱：

| 码 | 触发条件 |
| --- | --- |
| `INVALID_MESSAGE` | 字段缺失/类型不符/`from`、`to`、`kind` 为空 |
| `BAD_BOUNDARY` | 投递边界不是 `'step_boundary'` |
| `PERSIST_ERROR` | 追加写失败 |

所有操作返回 `{ok:true,...} | {ok:false,error}`，**永不抛异常**（与 SPEC-001 的 Result 风格一致）。

## 验收标准

- **TASK-001** `create` 生成稳定 id 与完整字段（`pending`、`owner=null`、`revision=0`、`createdAt=updatedAt`），并能被 `get`/`list` 读到；读取结果是快照副本。
- **TASK-002** 状态机只允许 `claim`/`release`/`complete`/`reopen` 的合法迁移，其余迁移返回 `INVALID_TRANSITION` 且任务不变。
- **TASK-003** CAS：`expectedRevision` 不符返回 `REVISION_CONFLICT`（含 `expected`/`actual`），任务字段与 `revision` 不变。
- **TASK-004** 并发抢同一任务只有一个成功，其余失败，任务最终 `in_progress` 且 `revision` 只加一次。
- **TASK-005** `ready()` 只包含 `pending`、无 owner、且所有 `blockedBy` 已 `completed` 的任务，并按创建顺序返回。
- **TASK-006** `blockedBy` 引用不存在的任务报 `UNKNOWN_BLOCKER`、重复 id 报 `DUPLICATE_ID`、空 `subject` 报 `INVALID_INPUT`，且都不落库。
- **TASK-007** `conflicts(owner, scopes)` 按路径前缀返回重叠的在途任务（排除自己的任务）；重叠不是锁，`claim` 仍成功并在事件里附带 `conflicts` 警告。
- **TASK-008** 每次成功变更 `revision += 1`、`updatedAt` 前进，并通过 `onChange` 派发对应类型的事件、写入 `events()` 审计。
- **TASK-009** `toJSON`/`fromJSON` 与 `save`/`load` 往返后任务、`revision`、依赖关系与 `ready()` 结果一致。
- **TASK-010** 失败操作不改变任何状态、不产生事件；`release` 清空 owner 且非 owner 报 `NOT_OWNER`，`reopen` 把 `completed` 拉回 `pending`。
- **MAIL-001** `send` 写入字段完整的消息，收件 Agent 可用 `pending` 读到。
- **MAIL-002** 重复 id 幂等：再次 `send` 不新增记录，`duplicate` 为 `true`，邮箱里只有一条。
- **MAIL-003** `pending(agentId)` 只读不消费：重复调用结果一致，不写 `deliveredAt`。
- **MAIL-004** `drainAt(agentId, 'step_boundary')` 一次性取出并消费全部待投递消息，第二次返回空数组。
- **MAIL-005** `drainAt` 只投递指定 Agent 的消息，其他 Agent 的待投递消息不受影响；无消息返回空数组而非错误。
- **MAIL-006** 投递边界不是 `'step_boundary'` 返回 `BAD_BOUNDARY`，且不消费任何消息。
- **MAIL-007** 持久化：`send` 后重新打开同一路径，未投递消息仍在；`drainAt` 后重新打开，已消费消息不会被二次投递。
- **MAIL-008** 投递给不存在/空闲 Agent 的消息不丢，等它下次 `drainAt` 取到；`senderKind` 解析发送者前缀，`toPeerFrame`/`fromPeerFrame` 与 `peer.message` 帧互转。
