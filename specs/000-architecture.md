# SPEC-000 架构总纲

状态：**已实现（P0 范围）** · 上游来源：《把界面交给 Agent：原生多 Agent 客户端架构设计》

本文件是仓库的最高约束。任何实现如果与本文件的公理冲突，以本文件为准；本文件的每条验收标准都必须有对应测试，否则 `npm run trace` 失败。

## 1. 三条公理

1. **界面是输出，不是外壳。** UI 与文本、工具调用同级，都是 Agent 的输出通道。
2. **多 Agent 是内核能力，不是提示词技巧。** 角色必须是运行时一等公民。
3. **一个 Agent，一个子进程。** 独立内存、独立预算、独立生命周期。

推论：客户端不预设「什么功能配什么界面」，它只提供两样东西——**渲染能力**与**安全边界**。

## 2. 四层与依赖方向

```
Surface   src/surface        把 View Spec 渲染成界面
   ▲ 依赖（只能向下）
Bridge    src/protocol       一行一帧的帧协议与通道
   ▲
Runtime   src/runtime        子进程入口
          src/loop           Agent Loop 五步状态机
          src/mailbox        邮箱
          src/taskboard      任务板
   ▲
Kernel    src/kernel         进程池、审批门
          src/eventlog       事件日志与快照
```

**数据自下而上流动，权限自上而下收敛。**

依赖规则（由测试强制，不是倡议）：

- `src/protocol/**` 不得 import 任何其它 `src/` 子目录——它是所有人的公共底座。
- `src/surface/**` 不得 import `src/kernel/**`、`src/runtime/**`、`src/loop/**`——界面层拿不到系统权限。
- `src/loop/**` 不得 import `src/kernel/**`——Loop 是被内核托管的进程，不能反向控制内核。
- 所有跨层数据必须使用 `src/protocol` 里定义的帧类型，不得私造传输格式。

## 3. 关键不变量

- **I1 单写者**：同一时刻一个 Agent 只有一个 Loop 在跑；跨进程协作只经由邮箱与任务板。
- **I2 边界投递**：给运行中 Agent 的消息只在 step boundary 被消费（见 SPEC-003）。
- **I3 事件即真相**：所有状态变化先写事件日志，界面与上下文都是它的投影。
- **I4 可回滚**：任何由 Agent 发起的界面改造都能回到上一个版本（见 SPEC-006）。
- **I5 可夺权**：人类中断在一个 step 内生效（见 SPEC-004）。

## 4. 阶段边界

| 阶段 | 内容 | 本仓库状态 |
| --- | --- | --- |
| P0 | Kernel + 单 Agent Loop 子进程 + 帧协议 + 事件日志 + View Spec 渲染 + CLI | **本期交付** |
| P1 | 进程池多 Agent、任务板、邮箱、写作用域 | 仓库内已有实现，宿主 UI 未接 |
| P2 | 沙箱装载、热更新、回滚快照 UI | 仅留接口 |
| P3 | Agent 改宿主自身代码（自举） | 仅留接口 |

P0 允许用确定性假模型端口替代真实 LLM：这样整条协作链可以在 CI 里离线、可复现地跑通，而协议与状态机是真实实现。

## 验收标准

- **ARCH-001** 四层目录 `src/surface`、`src/protocol`、`src/runtime`、`src/kernel` 必须存在且各自可被独立导入。
- **ARCH-002** 依赖方向：`src/protocol` 不 import 任何其它层；`src/surface` 不 import kernel/runtime/loop；`src/loop` 不 import kernel。
- **ARCH-003** 架构中的「一个 Agent 一个子进程」必须可被观测：Kernel 拉起的 Agent 有独立 pid，且 pid 与宿主不同。
- **ARCH-004** 跨层数据只能是 `src/protocol` 定义的帧类型：所有 `ui.patch` / `human.message` 等字面量必须来自帧规格表。
- **ARCH-005** 每条规格的验收标准都必须被至少一个测试引用（由 `scripts/trace.mjs` 强制）。
