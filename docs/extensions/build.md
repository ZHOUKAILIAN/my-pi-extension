# Build Extension

- 状态：`TODO`
- 颗粒度假设：一个完整工作入口对应一个顶层 Pi extension
- 上游：[Extension 颗粒度](../00-repository-organization/extension-granularity.md)、[Extension 集合目录](../01-extension-catalog/README.md)

## 当前边界

`build` 是一个独立的顶层工作流 extension，注册 `/build`，负责新需求从需求对齐到实现、review 和验证的完整闭环。

需求对齐、技术方案、worker 委派、代码 review 和验证目前都是本 extension 内部节点，不预先拆成独立 Pi 子 extension。

## 待对齐

- `/build` 的完整状态机是什么？
- 哪些节点必须多 agent？
- 子 agent 的 Context Capsule 和 Artifact 如何交接？
- 哪些 skill 允许进入每个节点？
- 哪些重复规则值得提取为普通共享模块？
- `/build` 是否需要和其他顶层 extension 直接通信？

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
