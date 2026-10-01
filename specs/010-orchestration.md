# SPEC-010 宿主工具与多 Agent 编排（P1）

状态：**已实现**

P0 证明了「一个 Agent 一个进程」。P1 要证明的是**多个进程能真的协作**——而这需要一个新东西：**宿主工具桥**。

## 1. 为什么要宿主工具

Loop 是被 Kernel 托管的进程。它能读上下文、调模型、跑本地工具，但有三件事它**做不到也不该做**：

- 拉起一个新进程（那是 Kernel 的进程池）
- 给别的 Agent 投递消息（那要落盘到邮箱，才不丢）
- 把界面改动写进界面文档（那要过 Surface 的校验闸门）

于是协议里补一帧：Loop 发 `tool.call`（out）请宿主代办，宿主执行完用 `tool.reply`（in）回填。**被托管的进程不反向控制内核，只是提出请求。**

## 2. 宿主工具清单

| 工具 | 谁用 | 作用 | 需要审批 |
| --- | --- | --- | --- |
| `agent.spawn` | Lead | 拉起一个 Teammate 子进程，并把 brief 投递过去 | 是（默认拒绝） |
| `agent.send` | 任意 | 经邮箱落盘后投递给目标 Agent | 否 |
| `agent.wait` | Lead | 等到列出的 Agent 都回报（或超时/进程死亡） | 否 |
| `ui.render` | 任意 | 经 SurfaceIngest 校验后落到界面文档 | 否 |
| `task.create` | Lead | 建任务（可指定 id / 依赖 / 写作用域） | 否 |
| `task.claim` | Teammate | CAS 认领任务 | 否 |
| `task.complete` | Teammate | CAS 完成任务 | 否 |

## 3. 编排语义

- **父子关系**：`agent.spawn` 记下 parent。子 Agent 的 `loop.done` 由 **Kernel** 观察到，并自动向父 Agent 投递一条 `report`（子 Agent 不需要自己记得汇报，因此 `agent.wait` 不会因为子 Agent「忘了说话」而挂死）。
- **邮箱是唯一的投递记录**：所有跨 Agent 消息先落盘再投递；目标不在世时消息留在邮箱，等它下次上线。
- **任务板是唯一的状态机**：谁在做什么由 CAS 决定，抢单失败要如实报错，不静默覆盖。
- **中断要收敛**：人类中断 Lead 时，它派出去的子进程必须被回收——不能留下孤儿进程继续烧钱。

## 验收标准

- **HOST-001** `agent.spawn` 拉起独立子进程：返回的 pid 与调用者不同，且 brief 已投递给它。
- **HOST-002** `agent.spawn` 过审批门：未获放行时返回 `ok:false`，不拉起任何进程。
- **HOST-003** `agent.send` 先落盘再投递；目标不在世时消息留在邮箱，之后上线能取到。
- **HOST-004** `agent.wait` 等到每个目标 Agent 都回报才返回成功；有人没回报则超时返回 `ok:false` 并指出是谁。
- **HOST-005** `ui.render` 经 Surface 校验后落进界面文档并返回版本号；非法 spec 返回 `ok:false` 且文档版本不变。
- **HOST-006** 任务板工具保持 CAS 语义：用过期 revision 认领报 `REVISION_CONFLICT`，任务状态不被覆盖。
- **HOST-007** 每次宿主工具调用都写事件日志（`host.tool.call` / `host.tool.result`），可回放审计。
- **ORCH-001** Lead 通过 `agent.spawn` 拉起 Teammate，两者 pid 不同，且事件日志里能还原出这次派发。
- **ORCH-002** 跨进程协作闭环：Teammate 领取并完成任务 → 回报 Lead → Lead 收到后继续（上下文里能看到回报）。
- **ORCH-003** 子 Agent 完成时由 Kernel 自动向父 Agent 回报，`agent.wait` 因此能确定性地返回。
- **ORCH-004** 一次完整编排结束后：界面文档产生新版本、任务板终态 `completed`、邮箱里留下 brief 与 report 两类消息、事件日志可回放出完整时间线。
- **ORCH-005** 人类中断 Lead 时，它派出去的子进程全部被回收（不留下孤儿进程）。
