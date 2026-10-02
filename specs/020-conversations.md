# SPEC-020 多对话与 / 常用命令

状态：**已实现**

## 一个对话现在等于什么

在补齐之前，「客户端」就是「一个对话」：一个 `ClientSession`、一个 Lead 子进程、一份界面文档、一个浏览器文档、一份事件日志。人与 Agent 的所有往来都挤在这一条线上。

现在一个**对话**是一个独立单元，自带：

| 组成 | 位置 |
| --- | --- |
| 自己的 Agent | 独立 Lead 子进程（互不干扰，可并行干活） |
| 自己的界面 / 浏览器文档 | 切回来还在，不会被别的对话覆盖 |
| 自己的事件日志与上下文 | `<dir>/conversations/<id>/` |
| 自己的工作空间 | `<dir>/conversations/<id>/workspace/`（SPEC-021） |

**切走不打断**：Agent 在后台继续跑，事件照常落盘；切回来 `GET /api/state` 一次同步到位。

## 一、HTTP 契约（冻结）

所有既有路由都接受 `?conversation=<id>`，省略即 `default`（因此旧调用与旧测试语义不变）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/conversations` | `{ok, active, conversations:[{id,title,createdAt,lastActiveAt,messages}]}` |
| POST | `/api/conversations` | body `{title?}` → 新建并置为 active |
| DELETE | `/api/conversations/<id>` | 删除（默认对话不可删） |
| GET | `/api/state?conversation=<id>` | 与既有形状一致，另加 `conversation` 字段 |
| GET | `/api/stream?conversation=<id>` | 只推该对话的事件 |
| POST | `/api/command?conversation=<id>` | body `{text:"/clear"}`，见下 |

`id` 规则：`[a-z0-9][a-z0-9_-]{0,31}`，由服务端生成（`c1`、`c2`… 或用户给的 slug），**不接受客户端指定任意 id**。

## 二、`/` 命令

命令由**服务端**执行（客户端只按前缀路由）：输入以 `/` 开头就发 `POST /api/command`，否则发 `/api/message`。
好处是命令能直接碰会话状态（清空、写历史、读工作空间），而客户端保持"哑"。

| 命令 | 行为 |
| --- | --- |
| `/help` | 列出全部命令 |
| `/clear` | **清空当前对话的可见内容与上下文**：写一条 `conversation.cleared` 事件，投影只保留它之后的部分；磁盘上的旧日志不删（审计还在） |
| `/history` | 把当前对话导出成 Markdown 落到 `<dir>/conversations/<id>/history/<时间戳>.md`，返回路径与行数 |
| `/history list` | 列出已保存的历史文件 |
| `/new [标题]` | 新建对话并切过去 |
| `/list` | 列出全部对话 |
| `/switch <id>` | 切换当前对话 |
| `/files` | 列出当前工作空间的文件（SPEC-021） |
| `/cat <路径>` | 读取工作空间里的文件并展示（动态加载） |
| `/help` 之外的未知命令 | 明确报错，**不得**当成普通消息发给模型 |

命令结果统一 `{ok, command, output, action?}`：
- `output` 是给人看的纯文本（客户端渲染成一条系统消息）；
- `action` 是给客户端的结构化动作：`{type:'switch'|'created'|'cleared', conversation?}`。

## 三、客户端

- 顶栏有对话切换器（下拉 + 「新建」），显示每个对话的标题与消息数；
- 输入以 `/` 开头时左上提示这是命令，不当作消息发送；
- 命令的 `output` 渲染成系统消息（不与人类/Agent 消息混色）；
- 切换对话即重开 SSE 并重画全部区域（对话流、界面、浏览器、文件），**不刷新页面**。

## 一处刻意的取舍

命令的 `output` **不进服务端事件日志**，由客户端渲染成系统消息（每个对话在客户端保留最近 20 条，切对话清空）。
理由：命令结果是**瞬时反馈**（像终端回显），不是对话内容——写进事件日志会污染「对话 = 人类与 Agent 的往来」这条语义，
也会让 `/clear` 的边界变复杂。代价是刷新页面后看不到之前的命令输出；要长期保留的东西本来就有 `/history`（落盘）。

## 验收标准

- **CONV-001** `ConversationRegistry` 按 id 惰性创建会话：同一 id 两次拿到同一实例，不同 id 互不相同，且各自 `dir` 在 `<root>/conversations/<id>` 下。
- **CONV-002** 新建对话返回合法 id 与标题；省略标题时给默认标题；id 冲突时自动避让而不是覆盖已有对话。
- **CONV-003** 非法 id（超长、大写、`..`、路径分隔符）一律拒绝，不接受客户端指定任意目录。
- **CONV-004** `GET /api/conversations` 列出全部对话并标出 active；`POST` 新建后 active 指向新对话；`DELETE` 删除后不再出现，且默认对话不可删。
- **CONV-005** 不传 `conversation` 时所有既有路由都作用在 `default` 上（向后兼容）。
- **CONV-006** 每个对话的事件流互不串扰：给 A 发消息只会在 A 的流上看到事件。
- **CONV-007** 切换对话不丢状态：A 渲染过界面文档后切到 B 再切回 A，A 的文档版本与内容原样还在。
- **CONV-008** 删除对话会回收它的 Agent 子进程（不留孤儿）。
- **CONV-009** 前后端版本漂移要可诊断：新客户端打在缺这些接口的旧服务端上会拿到 404/405，此时必须明确提示「服务端是旧版本，重启后再试」，而不是甩一个 `METHOD_NOT_ALLOWED`；对话/文件/命令三条路径口径一致。
- **CMD-001** `/help` 列出全部命令，且每条命令都真的存在（表中没有幽灵命令）。
- **CMD-002** `/clear` 清空可见对话与上下文，但**不删磁盘上的历史**；清空后投影只剩清空之后的内容，Agent 下一轮也看不到清空前的对话。
- **CMD-003** `/history` 导出 Markdown 到 `history/` 目录，返回真实存在的路径与行数；`/history list` 能列出来。
- **CMD-004** `/new` 新建并切换，`/list` 列出，`/switch <id>` 切换；切换通过 `action` 告知客户端。
- **CMD-005** 未知命令返回明确错误，且**不会**被当成消息送给模型（不产生 `mail.message`，不惊动 Agent）。
- **CMD-006** 命令不依赖模型：整个过程不发生模型调用（用假模型/脚本模型也能跑通）。
- **CMD-007** 命令对空参数/多余参数的处理明确：`/switch` 缺参数报错，`/new a b c` 以剩余文本为标题。
