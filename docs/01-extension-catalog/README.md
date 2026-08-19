# 01：Extension 集合目录

- 状态：`DECIDED`
- 类型：Extension 集合总体方案
- 上游：[仓库组织形式](../00-repository-organization/README.md)

## 要回答的问题

这套个人工作流需要哪些 Pi extension？每个 extension 的边界是什么？

## 当前候选目录

| Extension | 解决的问题 | 关键入口 | 当前状态 |
|---|---|---|---|
| `build` | 新需求的完整工作流 | `/build` | `PACKAGE_DECIDED` |
| `work` | 已有功能继续工作、分类和变更 | `/work` | `PACKAGE_DECIDED` |
| `bug` | Bug 调查、根因判断和修复 | `/bug` | `PACKAGE_DECIDED` |
| `workflow-ui` | 可选：展示 run、stage、artifact、finding 和阻塞状态 | TUI 状态展示 | `TODO` |

## 已确认边界

1. `/build`、`/work`、`/bug` 分别作为三个顶层 workflow extension。
2. 每个顶层 workflow extension 对应一个独立 Pi package，但三个 package 保持在同一个 Git monorepo。
3. 需求对齐、方案对齐、委派、review、验证首先作为各自 package 内的普通 Workflow Node。
4. 三个 package 基于共享 Workflow Runtime 和 Contracts workspace library 定义自己的 loop 和 hooks。
5. Worker 通过 Pi SDK 创建独立 `AgentSession`，通过 `Task + Policy + Context Capsule` 输入和 Artifact 输出交接。
6. `workflow-ui` 是否独立成为 Pi extension，留待后续评审。

## 下游文档

- [Build Extension](../extensions/build.md)
- [Work Extension](../extensions/work.md)
- [Bug Extension](../extensions/bug.md)
- [Workflow UI](../extensions/workflow-ui.md)
