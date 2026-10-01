# 规格 ⇄ 测试 追溯矩阵

> 由 `node scripts/trace.mjs` 自动生成，**请勿手工修改**。

| 验收标准 | 规格文件 | 说明 | 覆盖测试 |
| --- | --- | --- | --- |
| **ARCH-001** | specs/000-architecture.md | 四层目录 `src/surface`、`src/protocol`、`src/runtime`、`src/kernel` 必须存在且各自可被独立导入。 | `test/architecture.test.ts` · 四层目录齐备，且每层都能被独立导入 |
| **ARCH-002** | specs/000-architecture.md | 依赖方向：`src/protocol` 不 import 任何其它层；`src/surface` 不 import kernel/runtime/loop；`src/loop` 不 import kernel。 | `test/architecture.test.ts` · 依赖方向：协议层最底层，界面层拿不到系统权限，Loop 不能反向控制内核 |
| **ARCH-003** | specs/000-architecture.md | 架构中的「一个 Agent 一个子进程」必须可被观测：Kernel 拉起的 Agent 有独立 pid，且 pid 与宿主不同。 | `test/kernel.test.ts` · spawn 拉起独立子进程：pid 与宿主不同，能读到子进程发出的帧 |
| **ARCH-004** | specs/000-architecture.md | 跨层数据只能是 `src/protocol` 定义的帧类型：所有 `ui.patch` / `human.message` 等字面量必须来自帧规格表。 | `test/architecture.test.ts` · 跨层数据只能是协议帧：src 里出现的帧字面量必须都在帧表里 |
| **ARCH-005** | specs/000-architecture.md | 每条规格的验收标准都必须被至少一个测试引用（由 `scripts/trace.mjs` 强制）。 | `test/architecture.test.ts` · 规格追溯门禁必须通过：每条验收标准都有测试守着 |
| **E2E-001** | specs/007-e2e.md | 端到端成立：Kernel 拉起 Loop 子进程，`human.message` 进去后，宿主能收到 `ui.patch`，界面文档产生新版本，并能渲染出含该面板的 HTML。 | `test/e2e.test.ts` · 端到端：子进程跑完 Loop → ui.patch → 界面文档出新版本并渲染出 HTML |
| **E2E-002** | specs/007-e2e.md | 非法 View Spec 被 `SurfaceIngest` 拒绝：不进入界面文档（版本不前进）、留下 rejected 记录，且**界面依然可用**。 | `test/e2e.test.ts` · 非法 View Spec 被拒绝：版本不前进、有留痕、界面依然可用 |
| **E2E-003** | specs/007-e2e.md | 回滚：连续应用多次 patch 后可回到任意历史版本，渲染结果随之回退（架构里的「可回滚的改造权」）。 | `test/e2e.test.ts` · 回滚：多次改造后可回到任意版本，渲染结果随之回退 |
| **E2E-004** | specs/007-e2e.md | CLI 可独立跑通：`node src/cli.ts demo` 作为真实进程执行到底，退出码为 0，并落盘 `surface.html` 与 `surface.json`。 | `test/e2e.test.ts` · CLI demo 作为真实进程跑通并落盘产物 |
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
| **MAIL-001** | specs/005-taskboard-mailbox.md | `send` 写入字段完整的消息，收件 Agent 可用 `pending` 读到。 | `test/mailbox.test.ts` · send 写入字段完整的消息，收件 Agent 可用 pending 读到 |
| **MAIL-002** | specs/005-taskboard-mailbox.md | 重复 id 幂等：再次 `send` 不新增记录，`duplicate` 为 `true`，邮箱里只有一条。 | `test/mailbox.test.ts` · 重复 id 幂等：不新增记录，duplicate 为 true |
| **MAIL-003** | specs/005-taskboard-mailbox.md | `pending(agentId)` 只读不消费：重复调用结果一致，不写 `deliveredAt`。 | `test/mailbox.test.ts` · pending 只读不消费，且返回快照副本 |
| **MAIL-004** | specs/005-taskboard-mailbox.md | `drainAt(agentId, 'step_boundary')` 一次性取出并消费全部待投递消息，第二次返回空数组。 | `test/mailbox.test.ts` · drainAt 一次性取出并消费，第二次返回空数组 |
| **MAIL-005** | specs/005-taskboard-mailbox.md | `drainAt` 只投递指定 Agent 的消息，其他 Agent 的待投递消息不受影响；无消息返回空数组而非错误。 | `test/mailbox.test.ts` · drainAt 只投递指定 Agent，其他 Agent 不受影响 |
| **MAIL-006** | specs/005-taskboard-mailbox.md | 投递边界不是 `'step_boundary'` 返回 `BAD_BOUNDARY`，且不消费任何消息。 | `test/mailbox.test.ts` · 投递边界不是 step_boundary 报 BAD_BOUNDARY，且不消费 |
| **MAIL-007** | specs/005-taskboard-mailbox.md | 持久化：`send` 后重新打开同一路径，未投递消息仍在；`drainAt` 后重新打开，已消费消息不会被二次投递。 | `test/mailbox.test.ts` · 持久化：重启后未投递消息仍在，已消费不重复投递 |
| **MAIL-008** | specs/005-taskboard-mailbox.md | 投递给不存在/空闲 Agent 的消息不丢，等它下次 `drainAt` 取到；`senderKind` 解析发送者前缀，`toPeerFrame`/`fromPeerFrame` 与 `peer.message` 帧互转。 | `test/mailbox.test.ts` · 空闲/不存在 Agent 的消息不丢；发送者前缀与 peer.message 帧互转 |
| **PROTO-001** | specs/001-protocol.md | `encodeFrame` 输出单行 JSON 且以 `\n` 结尾；文本里的换行被转义，不产生裸换行。 | `test/protocol.test.ts` · encodeFrame 输出单行 JSON，以换行结尾，不产生裸换行 |
| **PROTO-002** | specs/001-protocol.md | `decodeFrame` 对非法输入返回 `{ok:false, code}`，**不抛异常**。 | `test/protocol.test.ts` · decodeFrame 对非法输入返回错误而不是抛异常 |
| **PROTO-003** | specs/001-protocol.md | 未知 `t` 报 `UNKNOWN_TYPE`；缺少必填字段报 `MISSING_FIELD` 并指明字段名。 | `test/protocol.test.ts` · 未知帧类型与缺必填字段分别报 UNKNOWN_TYPE / MISSING_FIELD |
| **PROTO-004** | specs/001-protocol.md | 未知字段报 `UNKNOWN_FIELD`；字段类型不符报 `BAD_FIELD_TYPE`。 | `test/protocol.test.ts` · 未知字段报 UNKNOWN_FIELD，类型不符报 BAD_FIELD_TYPE |
| **PROTO-005** | specs/001-protocol.md | 通道能正确处理半帧（分块到达）与多帧粘连。 | `test/protocol.test.ts` · 通道能处理半帧分块到达与多帧粘连 |
| **PROTO-006** | specs/001-protocol.md | 超长行触发 `LINE_TOO_LONG` 错误事件，通道在之后仍能正常收帧。 | `test/protocol.test.ts` · 超长行报 LINE_TOO_LONG，通道随后仍可正常收帧 |
| **PROTO-007** | specs/001-protocol.md | `frameJsonSchema()` 的输出必须与磁盘上 `specs/schemas/frame.schema.json` 完全一致（契约漂移门禁）。 | `test/protocol.test.ts` · 磁盘上的 frame.schema.json 与代码生成的 schema 完全一致（契约漂移门禁） |
| **PROTO-008** | specs/001-protocol.md | 每个帧类型都声明了方向，`directionOf()` 与帧表一致，`isInbound()` 可判定。 | `test/protocol.test.ts` · 每个帧类型都声明方向，directionOf / isInbound 与帧表一致 |
| **PROTO-009** | specs/001-protocol.md | 每个帧类型都必须能编码-解码往返（round trip）而不丢字段。 | `test/protocol.test.ts` · 每个帧类型都能编码-解码往返且不丢字段 |
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

## 统计

- 验收标准：**76** 条
- 已覆盖：**76** 条
- 未覆盖：**0** 条
- 悬空引用／未标注用例：**0** 处
