# SPEC-003 Agent Loop（Runtime 层）

状态：**已实现** · 对应架构第「一个 Agent，一个子进程」与五步状态机

Loop 是被 Kernel 托管的最小执行单元：**一个 Agent 一个进程，进程里跑一个 Loop**。

## 1. 五步状态机

每一轮迭代固定走五步，且每一步都发出 `loop.step` 帧，便于宿主与人类观测：

| 步 | 名称 | 做什么 |
| --- | --- | --- |
| 1 | `assemble` | 组装上下文：系统提示 + 种子输入 + 边界投递的消息 + 工具结果，并按预算裁剪 |
| 2 | `infer` | 调用模型端口，流式文本以 `agent.thinking` 外发 |
| 3 | `dispatch` | 执行工具调用，成对发出 `tool.call` / `tool.result` |
| 4 | `emit` | 把模型产出的界面意图经守卫后以 `ui.patch` 外发 |
| 5 | `checkpoint` | 写检查点事件、记账预算 |

循环直到四种终态之一：`completed` / `interrupted` / `budget_exhausted` / `error`。四种都必须产生一个可恢复的终态并写日志。

## 2. 端口（依赖倒置）

Loop 不 import 上层实现，只依赖接口，由宿主注入：

```ts
interface ModelPort { step(input: ModelInput): Promise<ModelOutput> }
interface UiGuard   { check(patch: UiPatch): { ok: true } | { ok: false; reason: string } }
interface LoopSink  { onEvent(event: LoggedEvent): void; onFrame(frame: Frame): void }
```

这样 Loop 既能被假模型在 CI 里离线驱动，也不会为了校验 View Spec 而反向依赖 Surface（违反 SPEC-000 §2 的依赖方向）。

## 3. 关键语义

- **边界投递（I2）**：给运行中 Agent 的消息**只在 step boundary 被消费**，绝不打断正在进行的 step。
- **人类夺权（I5）**：`interrupt` 在一个 step 内生效——本轮结束即停止，并发出 `loop.done{reason:'interrupted'}`。
- **预算**：模型轮次、工具调用次数、token 三个维度任一触顶即 `budget_exhausted`，不允许静默继续烧钱。
- **工具失败不致命**：未知工具、工具抛异常都只产生 `tool.result{ok:false}`，Loop 继续。
- **界面守卫**：`ui.patch` 必须先过 `UiGuard`，被拒绝的 patch 不外发，但必须如实记账。

## 验收标准

- **LOOP-001** 每一轮迭代按 `assemble → infer → dispatch → emit → checkpoint` 的顺序发出 5 个 `loop.step` 帧。
- **LOOP-002** 模型端口可插拔：用脚本化假模型即可跑完全流程，结果确定、可离线复现。
- **LOOP-003** 边界投递：循环开始后送来的 `human.message` / `peer.message` 只在下一个 step boundary 被消费，本轮 step 不被打断。
- **LOOP-004** 工具调用成对发出 `tool.call` / `tool.result`；未知工具与抛异常的工具都只得到 `ok:false`，Loop 不中断。
- **LOOP-005** `ui.patch` 必须经过 `UiGuard`；被拒绝的 patch 不外发，且被记入事件日志。
- **LOOP-006** 预算三维（轮次 / 工具调用数 / token）任一触顶即终止，终态 `budget_exhausted`。
- **LOOP-007** `interrupt` 后在最近一个 step boundary 停止，终态 `interrupted`，且已完成的 step 事件仍然完整。
- **LOOP-008** 模型声明完成时终态为 `completed`，并写入检查点事件（含快照水位）。
- **LOOP-009** 每个 step 都写入事件日志，且可用 `replay` 重建出每轮的五步序列。
- **LOOP-010** 上下文按预算裁剪：超出上限时保留系统提示与最近的条目，且裁剪过程本身不丢事件。
