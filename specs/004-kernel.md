# SPEC-004 内核：进程池与审批门（Kernel 层）

状态：**已实现** · 对应架构「一个 Agent，一个子进程」与安全底线

Kernel 是唯一握有系统权限的角色：它拉起子进程、转发帧、执行审批、记录审计。Agent 越靠近它越受限。

## 1. 进程池

- `AgentPool.spawn({agentId, entry?, script?, logDir?, stepDelayMs?})` → `AgentProcess`
- 一个 Agent 一个进程：`node <runtime>/agent-main.ts --agent <id>`，stdio 双向 NDJSON。
- 宿主 → 子进程：`handle.send(frame)`；子进程 → 宿主：`onFrame(handler)`。
- 子进程的每一帧都要回流进事件日志（审计），事件类型 `agent.frame`。
- 生命周期：`interrupt(reason)` 优雅停止，`kill(signal)` 强杀，`exited` 只在真正退出后 resolve 一次。

## 2. 审批门

L3 类动作（装依赖、改宿主、访问凭据）必须过审批门。

- **默认拒绝**：没有策略时一律 `deny`——安全默认值不能靠调用方记得配。
- 决策：`allow_once` / `allow_always` / `deny`；`allow_always` 记入本门的动作白名单，后续同动作自动放行。
- 每次请求都留痕（`history`），可被写入审计日志。

## 3. 子进程入口（agent-main）

- 从 stdin 读帧，向 stdout 写帧，stderr 只放诊断信息（**不得污染帧流**）。
- `human.message` / `peer.message` 一律**入队**，由 Loop 在 step boundary 取走（不在收帧时直接执行）。
- 运行中再次收到消息 → 排队，等下一个 boundary，不打断当前 step。
- `interrupt` → 当前 Run 在最近一个 boundary 结束，子进程保持存活等待下一条消息。
- 未识别的帧 → 记诊断，不崩溃。

## 验收标准

- **KERN-001** `spawn` 拉起独立子进程：`pid` 存在且与宿主 `process.pid` 不同，能读到子进程发出的帧。
- **KERN-002** 宿主 `send(human.message)` 后，子进程会跑完 Loop 并回传 `loop.done`。
- **KERN-003** 同一池中两个 Agent 拥有不同 pid（一 Agent 一进程）。
- **KERN-004** 发送非法帧（未知类型 / 缺字段）抛 `ProtocolError`，不会把脏帧写进管道。
- **KERN-005** `interrupt` 后子进程在最近一个 step boundary 结束当前 Run，回传 `loop.done{reason:'interrupted'}`，并**保持存活**。
- **KERN-006** `kill()` 立即终止子进程，`exited` 报告信号。
- **KERN-007** 子进程崩溃不影响宿主：`exited` 报告崩溃退出码，宿主继续可用。
- **KERN-008** 审批门默认拒绝；`allow_always` 后同动作自动放行；决策历史可查。
- **KERN-009** 子进程的每一帧都写进事件日志（`agent.frame` 事件）。
- **KERN-010** 进程退出后 `exited` 只 resolve 一次，`alive` 变为 false，池中可被清理。
- **KERN-011** 模型端口可切换：子进程在 `AGENT_MODEL=http` 时走 OpenAI 兼容 HTTP 端口，且能真实收到模型的文本回复（用本机假服务验证接线，不碰外网）。
