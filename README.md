# my-pi-extension

一个用于探索 Pi extension 多 agent 协作编排的私有实验仓库。

目标不是给 Pi 再套一层提示词，而是用 extension 实现可执行、可审计的**工作流治理 runtime**：

- 主 agent 只负责理解任务、拆分工作和作出下一步决策。
- Worker agent 分别承担调研、方案、实现、验证和审查等完整子任务。
- `build` 必须先经过多 agent 需求与技术方案对齐，再进入实现。
- `work` 先判断是否涉及需求或技术方案变更；涉及方案变更时进入多 agent 对齐。
- `bug` 先调查事实和根因；只有根因要求改变架构、边界或契约时，才升级到多 agent 方案对齐。
- 进入实现后，代码必须经过交叉审查和独立验证，不能由实现者自行宣布完成。
- Policy 按任务阶段和角色选择可用工具、可发现 skill、可见上下文及产物 schema。
- Worker 默认只获得最小上下文包，不继承主会话全文；跨角色的信息通过版本化 artifact 交接。
- 每次委派、输入、输出、审查意见、裁决和验证证据都应留存。

术语定义见 [CONTEXT.md](CONTEXT.md)。当前阶段只有架构选型，没有可执行 extension。请从 [技术方案选型](docs/architecture-selection.md) 开始。

## 当前决定

- 第一版使用 extension 注册 `delegate_task`，由主 agent 进行任务级编排。
- 每个 worker 使用独立的子 Pi CLI 进程运行，避免第一版直接承受 SDK session 生命周期复杂度。
- Policy 是角色、skill 路由、上下文规则、工具白名单、阶段门禁和审计 schema 的唯一控制源。
- 写入权限默认关闭；只有获批准的 implementer 可以在同一时刻写当前 worktree。
- 多 agent 的价值来自独立视角和可追溯的反驳/裁决，不是无限互相讨论。

入口规则和状态机见 [技术方案选型](docs/architecture-selection.md) 的“入口路由”章节。

## 状态

设计中。尚未实现、发布或安装任何 extension。
