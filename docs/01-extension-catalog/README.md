# 01：Extension 集合目录

- 状态：`ALIGNING`
- 类型：Extension 集合总体方案
- 上游：[仓库组织形式](../00-repository-organization/README.md)

## 要回答的问题

这套个人工作流需要哪些 Pi extension？每个 extension 的边界是什么？

## 当前候选目录

| Extension | 解决的问题 | 关键入口 | 当前状态 |
|---|---|---|---|
| `workflow-router` | 把 `build`、`work`、`bug` 路由到正确工作流 | `/build`、`/work`、`/bug` 或等价输入 | `TODO` |
| `task-delegation` | 主 agent 按 Policy 委派 worker | `delegate_task` | `TODO` |
| `solution-review` | 需求和技术方案的多 agent 对齐 | 方案评审阶段 | `TODO` |
| `code-review` | A/B review、rebuttal、arbiter | 代码变更阶段 | `TODO` |
| `verification` | 独立验证和最终验收 | 验证阶段 | `TODO` |
| `workflow-ui` | 展示 run、stage、artifact、finding 和阻塞 | TUI 状态展示 | `TODO` |

## 待对齐问题

1. 上述 extension 是否都应该存在？
2. 哪些 extension 可以合并，哪些必须独立？
3. 哪个 extension 拥有 Workflow Run 的状态机控制权？
4. `solution-review` 和 `code-review` 是否共享 review 协议但保持独立入口？
5. `verification` 是独立 extension，还是 code-review 的最后阶段？
6. `workflow-ui` 是否第一阶段就需要？
7. extension 之间共享哪些 artifact、Policy 和事件？

## 下游文档

- [Workflow Router](../extensions/workflow-router.md)
- [Task Delegation](../extensions/task-delegation.md)
- [Solution Review](../extensions/solution-review.md)
- [Code Review](../extensions/code-review.md)
- [Verification](../extensions/verification.md)
- [Workflow UI](../extensions/workflow-ui.md)
