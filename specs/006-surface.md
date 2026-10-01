# SPEC-006 界面层（Surface）

状态：**已实现（P0 范围）** · 对应架构第「Surface」层 · 上游约束：SPEC-000 §2、SPEC-001 §2

架构公理一：**界面是输出，不是外壳。** Agent 通过 `ui.patch` 帧（SPEC-001）把一份 **View Spec** 交给客户端，Surface 层负责把它渲染成界面，并保证这次改造**可回滚**（SPEC-000 不变量 I4）。

Surface 层只有三件事：**渲染能力**、**安全边界**、**版本历史**。它拿不到任何系统权限——依赖方向铁律规定 `src/surface/**` 只能 import `src/protocol/**`，不得 import kernel / runtime / loop。

## 1. View Spec

View Spec 是一个 JSON 对象，`type` 字段决定它是哪种组件；`panel` 与 `columns` 通过 `children` 递归嵌套，其余组件是叶子。

| `type` | 必填 | 可选 | 说明 |
| --- | --- | --- | --- |
| `panel` | `children` | `title` | 纵向容器，可带标题；`children` 允许为空数组 |
| `text` | `text` | `tone` | 一段文本 |
| `progress` | `label`, `value` | `tone` | 进度条，`value` 是 0~1 的有限数 |
| `action` | `label`, `emit` | `tone` | 可点击动作，`emit` 是回传宿主的事件名 |
| `list` | `items` | `title`, `tone` | 字符串列表 |
| `kv` | `pairs` | `title` | 键值对表，`pairs` 是 `{key, value}[]` |
| `columns` | `children` | `title` | 横向分栏容器 |
| `badge` | `text` | `tone` | 状态徽标 |

`tone` 取值：`default`、`muted`、`strong`、`info`、`success`、`warning`、`danger`。

除 `type` 与组件表声明的字段外，**不允许出现未知字段**（与帧协议同样宁可报错，也不静默忽略）。组件表是**唯一真相来源**：校验器、渲染器、JSON Schema 全部由 `COMPONENT_SPECS` 派生，因此「规格」与「实现」不可能各说各话。

## 2. 校验

`validateViewSpec(value)` 返回 `{ok:true, spec}` 或 `{ok:false, error:{code, message, path}}`，**永不抛异常**——包括 `null`、数组、标量、循环引用与超深嵌套。

| 码 | 触发条件 | 属于 |
| --- | --- | --- |
| `NOT_OBJECT` | 根节点或子节点不是对象 | 结构错误 |
| `UNKNOWN_COMPONENT` | `type` 缺失、不是字符串、或不在组件表中 | 未知类型 |
| `MISSING_FIELD` | 缺少必填字段 | 结构错误 |
| `BAD_FIELD_TYPE` | 字段类型不符 | 结构错误 |
| `BAD_VALUE` | 枚举值不在允许集合内 | 结构错误 |
| `UNKNOWN_FIELD` | 出现未声明字段 | 结构错误 |
| `OUT_OF_RANGE` | 数值越界（如 `progress.value`） | 结构错误 |
| `TOO_DEEP` | 嵌套超过 `MAX_VIEW_DEPTH` | 结构错误 |

「未知类型」与「结构错误」必须在**错误码**上可区分：前者是 `UNKNOWN_COMPONENT`，后者是其余各码。`path` 用 JSON 路径风格定位问题（`$`、`$.children[0].value`）。

## 3. 渲染

`renderViewSpec(spec, {tokens})` 返回一个**自包含 HTML 文档**字符串：内联样式 + `:root` 令牌变量，可直接写盘用浏览器打开。`renderFragment(spec, tokens)` 暴露不带文档外壳的片段，供版本化文档拼整页使用。

安全边界：

- 所有文本与属性值必须 **HTML 转义**（`& < > " '`）；
- **未知组件类型必须降级为占位块**（`data-unknown-component`），既不抛异常也不白屏，兄弟组件照常渲染；
- 非法 spec 整体降级为占位块；
- 渲染器对字段做防御性读取，不信任调用方一定先跑过校验。

## 4. 主题令牌（L0）

`DEFAULT_TOKENS` 提供颜色、字号、圆角、密度四组令牌；`tokensToCss(tokens)` 把它们序列化成 `--ac-*` 自定义属性，渲染器只引用变量与内联样式，不依赖任何外部 CSS。令牌值在写入 CSS 前会剔除可能越出声明块的字符（`; { } < >` 等）。

## 5. 版本化界面文档

`ViewDocument` 按 **scope**（如 `surface.sidebar`）维护区块，对应 `ui.patch` 帧的 `scope` 字段：

| `op` | 语义 | 前置条件 |
| --- | --- | --- |
| `mount` | 在空 scope 上挂载根组件 | scope 必须**不存在**，否则 `SCOPE_EXISTS` |
| `replace` | 用新 spec 整体替换该 scope 的根组件 | scope 必须**存在**，否则 `SCOPE_NOT_FOUND` |
| `patch` | 与现有根组件**深合并**（对象递归合并，数组与标量整体替换） | scope 必须**存在**，否则 `SCOPE_NOT_FOUND` |

`mount` / `replace` 的 `spec` 必须是**完整合法**的 View Spec；`patch` 的 `spec` 是**局部字段补丁**，允许省略 `type` 与必填字段（它只需要是对象），但仍以「合并后的结果」判定合法性。

不变量：

- 提交进文档的 spec **永远是合法 View Spec**——合并后的结果会重新校验，不合法则报 `INVALID_SPEC` 且**不落盘**；
- 版本号从 0（空文档）起**单调递增**：每次成功的变更 +1，失败的变更不变；
- 历史保存每个版本的全量快照；`rollback(version)` 可回到任意历史版本的界面内容，**并产生一个新的递增版本**（版本号只增不减，回滚不是时间旅行而是新的一笔记录）；
- `render()` 输出整页 HTML，包含全部 scope 区块，并复用同一套转义与令牌。

版本号就是架构里说的「快照 v14」。

## 6. 契约漂移门禁

`schemaOf()` 是 View Spec schema 的唯一来源，磁盘副本 `specs/schemas/view-spec.schema.json` 由 SURF-009 逐字节守护。它不并入 `scripts/gen-schema.mjs`（保持脚本零改动），重新生成用：

```bash
node -e "import('./src/surface/viewspec.ts').then(async (m) => { const fs = await import('node:fs'); fs.writeFileSync('specs/schemas/view-spec.schema.json', JSON.stringify(m.schemaOf(), null, 2) + '\n'); })"
```

## 验收标准

- **SURF-001** 组件表 `COMPONENT_SPECS` 是唯一真相来源：校验器、渲染器与 JSON Schema 均由它派生，新增组件只需改这一处。
- **SURF-002** `validateViewSpec` 接受全部已声明组件的合法 spec 并返回 `{ok:true}`，对任意输入（含 `null`、数组、标量、循环引用）永不抛异常。
- **SURF-003** 未知组件类型报 `UNKNOWN_COMPONENT`，与结构错误（`MISSING_FIELD` / `BAD_FIELD_TYPE` / `UNKNOWN_FIELD`）在错误码上可区分，且错误带 `path`。
- **SURF-004** `progress.value` 必须是 0~1 的有限数，越界报 `OUT_OF_RANGE`，边界值 0 与 1 合法。
- **SURF-005** `renderViewSpec` 返回可直接打开的自包含 HTML：含文档外壳、内联样式与 `:root` 令牌变量，progress 的宽度与百分比与 `value` 一致。
- **SURF-006** 所有进入 HTML 的文本与属性值都被转义，注入 `<script>` 只以文本形式出现。
- **SURF-007** 未知组件类型渲染为占位块（带 `data-unknown-component`），不抛异常、不白屏，同级已知组件照常渲染。
- **SURF-008** `DEFAULT_TOKENS` 覆盖颜色/字号/圆角/密度，`tokensToCss` 生成 `--ac-*` 自定义属性。
- **SURF-009** `schemaOf()` 由组件表派生，与磁盘 `specs/schemas/view-spec.schema.json` 逐字节一致（契约漂移门禁）。
- **SURF-010** `ViewDocument.applyPatch` 按 scope 维护区块，支持 `mount` / `replace` / `patch` 三种粒度；非法变更返回错误码且不改变文档。
- **SURF-011** 版本号单调递增：每次成功变更 +1、失败不变；`rollback(version)` 回到任意历史版本的界面内容并产生新的递增版本。
- **SURF-012** `ViewDocument.render()` 输出整页 HTML，包含全部 scope 区块并保持转义。
