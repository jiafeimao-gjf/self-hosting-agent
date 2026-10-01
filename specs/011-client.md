# SPEC-011 可用客户端（P2）

状态：**已实现**

P0/P1 交付的是内核：跑得通、测得准，但人类只能看 CLI 输出。**可用**的定义是：人类打开一个地址，就能跟 Agent 说话，并且**亲眼看着它改自己的界面**。

## 1. 形态

Kernel 起一个本地 HTTP 服务，浏览器是 Surface。选浏览器而不是 Electron：同一套 Surface Runtime 逻辑既能跑在浏览器里，也能被将来的桌面壳包住，而沙箱（iframe srcdoc）在浏览器里是现成且真正隔离的。

```
浏览器 Surface ──HTTP/SSE──▶ Kernel（进程池 + 事件日志 + 界面文档）
                                  │ stdio NDJSON
                                  ▼
                            Agent Loop 子进程
```

## 2. HTTP 接口契约

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 客户端页面 |
| GET | `/app.js` `/style.css` `/renderer.js` | 静态资源（仅限 `src/client/` 目录内） |
| GET | `/api/state` | 全量快照：界面文档、Agent 进程表、任务板、消息、事件尾部 |
| GET | `/api/stream` | SSE 事件流 |
| POST | `/api/message` | `{text}` → 交给 Lead（人类输入） |
| POST | `/api/interrupt` | `{reason?}` → 人类夺权 |
| POST | `/api/rollback` | `{version}` → 界面回滚到指定版本 |

SSE 事件类型（`event:` 字段）：

| 事件 | data | 何时发 |
| --- | --- | --- |
| `state` | 与 `/api/state` 同构 | 连接建立时、任何状态变化后 |
| `frame` | `{agent, frame}` | Agent 每发一帧 |
| `document` | `{version, html, scopes}` | 界面文档变化（Agent 改了界面） |
| `done` | `{reason}` | 一轮结束 |

## 3. 客户端界面（Surface）

- **对话面板**：人类输入、Agent 的 `agent.thinking`、工具调用的可读摘要（谁、调了什么、成功还是失败）
- **界面面板**：Agent 给的 View Spec 渲染结果，放在 **sandbox iframe** 里（`srcdoc`）实时更新，**不刷新页面**；显示版本号与回滚按钮
- **检查器**：Agent 进程表（id/pid/存活）、任务板、事件时间线
- **控制**：中断（人类夺权）按钮、连接状态

## 4. 多轮记忆

上下文**由事件日志投影而来**（`message.received` + `agent.thinking`），而不是靠进程内存里的一个数组。因此：

- 多轮对话连续；
- 进程重启后历史还在（日志在磁盘上）；
- 「界面 = f(事件日志)」这条不变式同样适用于「上下文 = f(事件日志)」。

## 5. 模型

默认接**本机 Ollama**（真模型、离线、无 API Key）：`http://127.0.0.1:11434/v1`。也可用环境变量切到任意 OpenAI 兼容端点。Ollama 不可用时明确报错，不假装正常。

## 验收标准

- **CLI-001** `GET /api/state` 返回界面文档、进程表、任务板、消息与事件尾部，字段齐全且可 JSON 解析。
- **CLI-002** `GET /api/stream` 建立 SSE 连接后，先收到一次 `state` 快照。
- **CLI-003** `POST /api/message` 把人类输入交给 Lead，Agent 的帧通过 SSE 以 `frame` 事件实时推给客户端。
- **CLI-004** Agent 发出 `ui.patch` 后，客户端收到 `document` 事件，且其中的 HTML 含该组件、版本号前进（**不刷新页面**）。
- **CLI-005** `POST /api/interrupt` 让正在跑的一轮在最近边界停下，SSE 收到 `done{reason:'interrupted'}`。
- **CLI-006** `POST /api/rollback` 把界面文档退回指定版本，并广播新的 `document` 事件。
- **CLI-007** 静态资源只允许 `src/client/` 内的文件：路径穿越（`../`）被拒绝。
- **CLI-008** 多轮记忆：第二轮请求的上下文包含第一轮的人类消息与 Agent 回复（由事件日志投影）。
- **CLI-009** 模型不可用时（HTTP 端口报错）客户端收到可读的错误帧，服务本身不崩。
- **CLI-010** 服务端可以只监听 127.0.0.1（默认），不对外暴露。
- **CLI-012** `/api/state` 的 `messages` 是**完整对话投影**（人类消息 + Agent 说过的话，按时间归并）。前端会据此整体重建对话流，只投影邮件类消息会把 Agent 的回复冲掉。
- **CLI-011** `POST /api/client/revert` 让人类**不必经过 Agent** 就能把被改过的客户端源码回滚（架构底线：人类永远能一键回滚）。
