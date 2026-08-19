# Build Extension

- 状态：`TODO`
- 颗粒度假设：一个完整工作入口对应一个顶层 Pi extension
- 上游：[Extension 颗粒度](../00-repository-organization/extension-granularity.md)、[Extension 集合目录](../01-extension-catalog/README.md)

## 当前边界

`build` 是一个独立的顶层工作流 extension，注册 `/build`，负责新需求从需求对齐到实现、review 和验证的完整闭环。

待总体运行时选型确认后，`build` 必须有明确的 Workflow Controller 负责状态迁移：Worker 只返回当前节点的 Artifact，Controller 校验 Artifact、执行 Transition Guard、冻结 Acceptance Criteria，并决定是否启动下一位 Worker、回到实现或进入 `BLOCKED` / `ACCEPTED`。Controller 与 Node 最终采用普通 TypeScript 模块、同 runtime Node Extension，还是独立 runtime Node Extension，以上游选型文档为准。

需求对齐、技术方案、worker 委派、代码 review 和验证目前都是本 extension 内部节点，不预先拆成独立 Pi 子 extension。

## 待对齐

- `/build` 的完整状态机是什么？
- 哪些节点必须多 agent？
- 顶层 Controller 如何用 Artifact 和 Context Capsule 在 Worker 间交接，而不复制完整 session？
- 哪些 skill 允许进入每个节点？
- 哪些重复规则值得提取为普通共享模块？
- `/build` 是否需要和其他顶层 extension 直接通信？

## 设计章节

1. 目标和边界
2. Command / Tool / Event
3. 内部节点、确定性状态机和 Transition Guard
4. 主 agent、Controller 与 Worker Runtime
5. skill routing 和 context isolation
6. Artifact、主 Pi Session 和记忆交接
7. 冻结的 Acceptance Criteria
8. review、rebuttal、arbiter
9. verification 和 `ACCEPTED` 计算
10. 失败、取消、重试、`BLOCKED` 和安全边界
11. 候选技术方案和最终决策
