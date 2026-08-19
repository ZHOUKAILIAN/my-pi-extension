# Work Extension

- 状态：`TODO`
- 颗粒度假设：一个完整工作入口对应一个顶层 Pi extension
- 上游：[Extension 颗粒度](../00-repository-organization/extension-granularity.md)、[Extension 集合目录](../01-extension-catalog/README.md)

## 当前边界

`work` 是一个独立的顶层工作流 extension，注册 `/work`，负责已有功能继续工作、任务分类、局部变更、需求变更和技术方案变更。

调查、分类、worker 委派、review 和验证目前都是本 extension 内部节点，不预先拆成独立 Pi 子 extension。

## 待对齐

- `/work` 如何判断局部变更、需求变更、方案变更和 Bug 重路由？
- 子 agent 如何共享必要 Artifact 而不共享完整上下文？
- 哪些 skill 只对分类/调查节点开放？
- 哪些修改必须升级到多 agent 方案对齐？
- `/work` 是否需要和其他顶层 extension 直接通信？

## 设计章节

1. 目标和边界
2. Command / Tool / Event
3. 内部节点和状态机
4. 主 agent 与 worker
5. skill routing 和 context isolation
6. Artifact、session 和记忆交接
7. review、rebuttal、arbiter
8. verification
9. 失败、取消、重试和安全边界
10. 候选技术方案和最终决策
