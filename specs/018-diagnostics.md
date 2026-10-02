# SPEC-018 诊断日志

状态：**已实现**

## 为什么要有它：一次真实的排障

用户反馈：「发出去之后，没看到 agent 的任何实质性的动作和报错」。

翻代码得到的答案是：**这条链路上最该看的东西恰好被丢掉了**。

| 环节 | 现状（补之前） |
| --- | --- |
| Agent 子进程的 stderr | 收到 `#stderr` 字符串里，发一个 `'stderr'` 事件，**生产代码没有任何订阅者** |
| 宿主 HTTP 服务 | 一条请求日志都没有；403 / 404 / 500 外部不可见 |
| 崩溃 | 没有 `uncaughtException` / `unhandledRejection` 兜底，父子进程都只是"打一段堆栈到没人看的 stderr，然后死" |
| 事件日志坏行 | `issues()` **只有测试在用**，生产环境静默跳过 |
| 日志文件 | 只增不减，无轮转 |

真正的根因（工具名带点号被端点 400）最后是我手工 `curl` 端点才挖出来的——**如果当时有诊断日志，这个结论第一分钟就能看到**。这就是本规格存在的理由。

## 1. 与事件日志的分工（别混）

| | `EventLog` | `Logger` |
| --- | --- | --- |
| 定位 | **领域事实**：谁改了什么、界面 = f(事件日志) | **排障证据**：进程为什么崩、端点连没连上 |
| 受众 | 回放、审计、时间旅行 | 人类排障 |
| 位置 | `<runDir>/events/events.jsonl` | `<runDir>/logs/app.log` |
| 丢了会怎样 | 状态不可重建（严重） | 出事时查不出原因（也严重，但性质不同） |

## 2. 形态

- 结构化 JSONL：`{ts, level, scope, message, data?}`
- 级别 `debug < info < warn < error`，**过滤在写入之前**
- `scope` 可派生：`app` → `pool` → `agent:lead`
- 可选 `echo`：同时写一行可读文本到 stderr
- **记日志绝不许把主流程搞挂**：任何写盘 / 序列化异常都被吞掉，并在内存里保留最后 500 条兜底

## 3. 关键接线

- `AgentPool` 订阅子进程 stderr → 逐行写入 `scope=agent:<id>` 的日志（**这就是"补齐"的核心**）
- HTTP 服务记录每条请求：`method / path / status / ms`，4xx 记 warn、5xx 记 error
- 子进程与宿主都注册 `uncaughtException` / `unhandledRejection`，记 `error` 级后退出（宿主只记不杀，客户端不该因为一个未处理拒绝就死）
- 启动时读一次 `EventLog.issues()`，有坏行就 warn

## 验收标准

- **DIAG-001** 记录器按级别过滤：低于阈值的记录既不落盘也不进 sink；每条含 `ts/level/scope/message`，可带结构化 `data`。
- **DIAG-002** 记日志失败不影响主流程：目录不可写时自动退化为内存日志，调用方不抛异常。
- **DIAG-003** 子进程 stderr 被消费：内容逐行写入诊断日志，且带 `agent:<id>` 标签（补之前它没有任何订阅者）。
- **DIAG-004** stderr 缓冲有上限：只保留尾部，长会话不会无限增长。
- **DIAG-005** HTTP 访问日志：每条请求记录 method / path / status / 耗时；5xx 为 error 级。
- **DIAG-006** 崩溃兜底：父进程与子进程都注册 `uncaughtException` / `unhandledRejection`，前者记 error 级日志。
- **DIAG-007** 启动时上报事件日志的损坏行（`issues()` 不再只有测试在调）。
- **DIAG-008** 事件日志可按 `maxBytes` 轮转：超过上限把当前文件滚到 `<file>.1`，磁盘不会无限增长（默认关闭，显式开启）。
