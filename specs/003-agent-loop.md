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
interface ModelPort     { step(input: ModelInput): Promise<ModelOutput> }
interface UiGuard       { check(patch: UiPatch): { ok: true } | { ok: false; reason: string } }
interface LoopSink      { onFrame(frame: Frame): void }
interface HostBridgePort {
  /** 请宿主代办一个宿主工具调用，并等它回填（tool.reply 帧） */
  awaitToolReply(callId: string, options: { timeoutMs: number }): Promise<{ ok: boolean; result?: string; error?: string }>
}
```

**工具分两类。** `execute: 'loop'`（默认）在 Loop 进程内跑；`execute: 'host'` 是**宿主工具**——「拉起一个进程」「派发任务」这类事只有 Kernel 干得了，Loop 只能发 `tool.call` 请宿主代办，再由宿主用 `tool.reply`（入站帧）回填。这是依赖倒置的必然结果：被托管的进程不能反向控制内核。

宿主工具的失败（超时、被中断、回填 ok:false）**一律只产生 `tool.result{ok:false}`，不中断 Loop**——Agent 应该有机会换条路走，而不是被一次工具失败打死。

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
- **LOOP-011** 工具分流：`execute:'host'` 的工具由宿主执行（Loop 只发 `tool.call` 并等待回填），`execute:'loop'` 的工具在进程内执行，两者可在同一轮混用。
- **LOOP-012** 宿主回填：收到 `tool.reply` 后必须成对发出 `tool.result`，`result` / `error` 原样透传，并写入事件日志。
- **LOOP-013** 宿主工具失败不致命：超时、被中断、回填 `ok:false` 都只产生 `tool.result{ok:false}`，Loop 继续到下一轮。
- **LOOP-014** 没有接到宿主桥时调用宿主工具 → `tool.result{ok:false}` 且错误信息含 `NO_HOST_BRIDGE`，Loop 不崩。
- **LOOP-015** `seedContext` 提供的历史上下文会进入模型输入（顺序：system → 历史 → 本轮 seed），且本轮消息不会重复注入。
- **LOOP-016** 助手消息必须携带它发起的工具调用（`ContextItem.toolCalls`），且工具结果排在其后。少了这一条，工具结果在严格端点上就是孤儿：OpenAI 要求 `role:'tool'` 紧跟带 `tool_calls` 的助手消息，Anthropic 要求 `tool_result` 对应前一条的 `tool_use`。
