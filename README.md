# agent-client

> 客户端不是 Agent 的宿主，而是 Agent 的笔。

按《把界面交给 Agent：原生多 Agent 客户端架构设计》落地的工程实现。当前处于 **P0：内核垂直切片**。

## 当前状态

| 指标 | 值 |
| --- | --- |
| 验收标准 | **77** 条（`specs/*.md`，全部有稳定 ID） |
| 覆盖情况 | **77 / 77** 全部有测试守着（`npm run trace` 门禁通过） |
| 测试 | **76** 个，全绿（约 4.5s，零第三方依赖） |
| 类型检查 | `npm run typecheck` 全绿（tsc 5.9 `--strict --erasableSyntaxOnly`） |
| 已落地 | 帧协议、事件日志、五步 Agent Loop、子进程池与审批门、任务板、邮箱、View Spec 渲染、SurfaceIngest、CLI 端到端 |
| 尚未落地 | 真实模型端口、Electron/Tauri 宿主、iframe 沙箱、热更新（P1–P3） |

## 三条公理

1. **界面是输出，不是外壳** —— UI 与文本、工具调用同级，都是 Agent 的表达通道。
2. **多 Agent 是内核能力，不是提示词技巧** —— Lead / Teammate / Subagent 是运行时一等公民。
3. **一个 Agent，一个子进程** —— 独立内存、独立预算、独立生命周期。

## 四层架构

| 层 | 目录 | 职责 |
| --- | --- | --- |
| Surface | `src/surface` | View Spec → 界面；组件注册表、未知类型降级、四级权限 |
| Bridge | `src/protocol` | 一行一帧的 NDJSON 协议、帧校验、通道 |
| Runtime | `src/runtime` `src/loop` `src/mailbox` `src/taskboard` | Agent Loop 五步状态机、邮箱、任务板、子进程入口 |
| Kernel | `src/kernel` `src/eventlog` | 进程池、审批门、事件日志与快照 |

> **数据自下而上流动，权限自上而下收敛。**

## SDD + TDD 混合驱动

这个仓库的规矩不是「先写代码再补测试」，也不是「写一堆没人看的文档」，而是两者互相咬合：

### SDD：规格先行

- `specs/*.md` 是**唯一事实源**。每份规格末尾都有 `## 验收标准`，每条带稳定 ID（如 `PROTO-003`）。
- 机器可校验的契约放在 `specs/schemas/*.schema.json`，由代码里的**声明式帧表**生成，并有测试断言「磁盘上的 schema == 代码生成的 schema」，防止规格与实现漂移。

### TDD：先红后绿

- 每个测试必须标注它验证的规格条目：`test('...', { }, ...)` 上方的 `@spec PROTO-003` 注释。
- 顺序固定：**写规格 → 写失败测试（红）→ 最小实现（绿）→ 重构**。
- 架构约束本身也是测试：`test/architecture.test.ts` 扫描 `src/**` 的 import，断言分层依赖方向（Surface 不许 import Kernel 实现、Protocol 不许依赖上层……）。

### 咬合点：可追溯性门禁

```bash
npm run check     # = npm run trace && npm test
```

`scripts/trace.mjs` 做双向校验，任一条不满足就**以非零码退出**：

| 违规 | 含义 |
| --- | --- |
| 规格条目没有测试 | 只在文档里存在的承诺，等于没有承诺 |
| 测试引用了不存在的规格 ID | 测试在验证幻觉 |
| schema 与代码不一致 | 契约漂移 |

## 快速开始

```bash
node -v            # 需要 >= 24（原生 TS + node:test，零运行时依赖）
npm run check      # 规格追溯门禁 + 全量测试
npm run typecheck  # 类型检查（无 tsc 时会明确提示「跳过」，不会假装通过）
npm run demo       # 端到端演示：Kernel 拉起源码里的 Agent Loop 子进程
```

`npm run demo` 会：

1. 由 Kernel 以子进程方式拉起一个 Agent Loop；
2. 通过 stdio 发送 `human.message` 帧；
3. Loop 走完五步状态机，回传 `agent.thinking` / `tool.call` / `ui.patch` 帧；
4. Surface 把 View Spec 渲染成 HTML 落盘 `examples/out/`。

## 目录

```
specs/          规格（SDD 事实源）+ schemas + traceability.md（自动生成）
src/protocol/   帧定义、校验、NDJSON 通道
src/eventlog/   追加写事件日志、快照、回放
src/loop/       Agent Loop 五步状态机、上下文组装、模型端口
src/runtime/    子进程入口（一个 Agent 一个进程）
src/kernel/     进程池、审批门
src/taskboard/  任务板 CAS 状态机
src/mailbox/    持久邮箱
src/surface/    View Spec 校验、渲染器、主题令牌
test/           node:test 测试，逐条标注 @spec ID
scripts/        trace.mjs（规格 ⇄ 测试 双向门禁）
```

## 边界

P0 只做**可测的内核垂直切片**：真实模型端口、Electron/Tauri 宿主、iframe 沙箱、热更新属于 P1–P3。当前模型端口是确定性的假实现，因此整套协作流程可以在 CI 里完全离线复现。
