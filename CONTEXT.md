# Ubiquitous Language

## Work Governance Runtime

由 Pi extension 承载的运行时控制层。它根据策略决定任务怎样拆分、哪些角色可参与、角色可调用哪些 skill/工具、可看到哪些上下文，以及何时可以推进或结束任务。

它不是一个用于提醒模型遵守流程的 prompt 集合；它必须以工具白名单、状态转换校验、产物 schema 和审计记录执行控制。

## Workflow Run

从一个用户目标创建的一次受状态机控制的工作实例，以 `runId` 标识。一个 Workflow Run 由若干阶段、委派记录和产物组成，且绑定工作目录与基准修订版本。

## Stage

Workflow Run 中受状态机约束的阶段，例如调研、方案提议、质疑、实现、交叉审查和验证。阶段定义允许的角色、所需输入产物、期望输出 schema、推进条件及预算。

## Role

在一个委派中授予 worker 的职责与权限集合，例如 `investigator`、`architect`、`challenger`、`implementer`、`reviewer`、`verifier`、`arbiter`。Role 不是模型名称，也不是用户身份。

## Worker

受 Work Governance Runtime 委派、执行一个边界明确子任务的独立 Pi agent runtime。第一版中一个 Worker 对应一个子 Pi CLI 进程；它不能再委派其他 Worker。

## Policy

按 Workflow Run、Stage 和 Role 选择的版本化控制规则。Policy 至少定义角色、状态迁移、工具白名单、skill 白名单、上下文规则、产物 schema、预算和审批条件。

## Skill Routing

Policy 对一个 Role 在某个 Stage 可发现、显式加载和调用哪些 skill 的规则。它用于缩小模型的工作方法集合，避免所有 skill 的摘要和指令同时进入 worker。

Skill Routing 不是安全权限控制。即使未被 Pi 发现的 skill，拥有普通文件读取或 shell 能力的 worker 仍可能从文件系统访问它。

## Context Capsule

由 Policy 构造并交给单个 Worker 的最小、版本化输入包。它可包含任务目标、角色指令、允许的 skill 摘要/路径、指定上游产物、验收标准、基准版本和必要的文件引用；默认不包含主 agent 的完整会话历史。

## Context Isolation

限制一个 Worker 可获得的信息范围的机制。它有三个层次：资源发现隔离、prompt/context capsule 隔离、文件系统与网络隔离。只有第三层可作为安全边界。

## Capability Isolation

限制一个 Worker 实际可执行动作的机制，例如 Pi 工具白名单、受限 shell wrapper、只读挂载、临时 worktree、容器或自定义工具。Role prompt 不是 Capability Isolation。

## Artifact

由阶段产出的、带 schema、来源、版本和可追溯引用的事实材料，例如调研报告、方案、challenge、diff、review finding、验证记录或裁决。后续角色应引用 Artifact，而不是复制整个历史对话。

## Review Finding

针对某个固定 diff 或产物提出的可判定问题，必须包含严重度、位置、证据、影响和建议。它通过 disposition 收敛，不能以自由讨论无限延长。

## Disposition

对 Review Finding 的正式处理结论：`fixed`、`accepted`、`rejected` 或 `blocked`。实现者不能单独关闭自己的 Finding；必要时由 Reviewer 复核并由 Arbiter 裁决。

## Arbiter

对达到轮次上限、证据冲突或影响状态推进的争议作出正式决定的 Role。Arbiter 不得兼任当前变更的唯一实现者和唯一审查者。
