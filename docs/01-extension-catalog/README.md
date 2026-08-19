# 01：Extension 集合目录

- 状态：`ALIGNING`
- 类型：Extension 集合总体方案
- 上游：[仓库组织形式](../00-repository-organization/README.md)

## 要回答的问题

这套个人工作流需要哪些 Pi extension？每个 extension 的边界是什么？

## 当前候选目录

| Extension | 解决的问题 | 关键入口 | 当前状态 |
|---|---|---|---|
| `build` | 新需求的完整工作流 | `/build` | `TODO` |
| `work` | 已有功能继续工作、分类和变更 | `/work` | `TODO` |
| `bug` | Bug 调查、根因判断和修复 | `/bug` | `TODO` |
| `workflow-ui` | 可选：展示 run、stage、artifact、finding 和阻塞状态 | TUI 状态展示 | `TODO` |

## 待对齐问题

1. `/build`、`/work`、`/bug` 是否分别作为顶层 extension？
2. 需求对齐、方案对齐、委派、review、验证是否都先作为各自 extension 内部节点？
3. 哪些重复规则达到什么条件后才抽成普通共享模块？
4. 是否需要一个独立的 `workflow-ui` extension？
5. 顶层 extension 之间是否需要直接协作，还是各自管理自己的 worker 和 session？
6. 顶层 extension 之间共享哪些 Artifact、Policy 或协议？

## 下游文档

- [Build Extension](../extensions/build.md)
- [Work Extension](../extensions/work.md)
- [Bug Extension](../extensions/bug.md)
- [Workflow UI](../extensions/workflow-ui.md)
