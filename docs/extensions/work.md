# Work Extension

- 状态：`TODO`
- 颗粒度假设：一个完整工作入口对应一个顶层 Pi extension
- 上游：[Extension 颗粒度](../00-repository-organization/extension-granularity.md)、[Extension 集合目录](../01-extension-catalog/README.md)

## 当前边界

`work` 是一个独立的顶层工作流 extension，注册 `/work`，负责已有功能继续工作、任务分类、局部变更、需求变更和技术方案变更。

待总体运行时选型确认后，`work` 必须有明确的 Workflow Controller 负责状态迁移：Worker 只返回调查、分类、实现、review 或验证 Artifact；Controller 校验结果并决定局部实现、进入多 agent 对齐、重路由到 `/bugFix`、回到实现或进入 `BLOCKED` / `ACCEPTED`。Controller 与 Node 最终采用普通 TypeScript 模块、同 runtime Node Extension，还是独立 runtime Node Extension，以上游选型文档为准。

调查、分类、worker 委派、review 和验证目前都是本 extension 内部节点，不预先拆成独立 Pi 子 extension。

## 待对齐

- `/work` 如何判断局部变更、需求变更、方案变更和 Bug 重路由？
- 顶层 Controller 如何用 Artifact 和 Context Capsule 在 Worker 间交接，而不复制完整 session？
- 哪些 skill 只对分类/调查节点开放？
- 哪些修改必须升级到多 agent 方案对齐？
- `/work` 是否需要和其他顶层 extension 直接通信？

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
