# my-pi-extension

个人工作流 Pi extension 集合。

这个仓库不是单个 `delegate_task` extension，而是用多个 extension 固化 `build`、`work`、`bug`、方案评审、代码评审和独立验证等工作方式。每个 extension 都单独做需求对齐和技术方案评审；skill 路由、context 隔离、worker 选型、review 和 verification 都属于对应 extension 的设计内容。

## 文档入口

从 [文档树](docs/document-tree.md) 开始，按两个问题推进：

1. [仓库组织形式](docs/00-repository-organization/README.md)：这个仓库如何承载多个 Pi extension。
   - [仓库组织技术方案](docs/00-repository-organization/technical-design.md)
2. [Extension 集合目录](docs/01-extension-catalog/README.md)：集合里有哪些 extension，以及每个 extension 的职责边界。

之后进入 [extensions/](docs/extensions/) 下的单个 extension 设计文档。

## 当前候选 Extension

- `workflow-router`：路由 `build`、`work`、`bug`。
- `task-delegation`：主 agent 委派 worker。
- `solution-review`：需求和技术方案多 agent 对齐。
- `code-review`：A/B review、rebuttal 和 arbiter。
- `verification`：独立验证和最终验收。
- `workflow-ui`：展示 run、stage、artifact、finding 和阻塞状态。

这些只是待评审候选，不代表已经实现或最终确定。

## 历史资料

- [历史整体方案选型](docs/architecture-selection.md)
- [多模型评议记录](docs/reviews/2026-08-18-gpt-5.6-sol-design-review.md)
- [领域术语](CONTEXT.md)

## 状态

文档对齐阶段。尚未实现、发布或安装任何 extension。
