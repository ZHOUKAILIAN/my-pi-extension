# my-pi-extension

个人工作流 Pi extension 集合。

这个仓库不是单个 `delegate_task` extension，而是一组独立的顶层工作流 extension。当前候选是 `/build`、`/work`、`/bugFix`：每个入口各自拥有 command、主 agent -> worker 编排、内部工作流节点和 session 级记忆交接。需求对齐、方案评审、代码 review、验证、skill 路由和 context 隔离首先属于对应顶层 extension 的内部设计，不预先拆成 Pi 子 extension。

## 文档入口

从 [文档树](docs/document-tree.md) 开始，按两个问题推进：

1. [仓库组织形式](docs/00-repository-organization/README.md)：这个仓库如何承载多个 Pi extension。
   - [仓库组织技术方案](docs/00-repository-organization/technical-design.md)
   - [Extension 颗粒度技术方案](docs/00-repository-organization/extension-granularity.md)
2. [Extension 集合目录](docs/01-extension-catalog/README.md)：集合里有哪些 extension，以及每个 extension 的职责边界。

之后进入 [extensions/](docs/extensions/) 下的单个 extension 设计文档。

## 当前候选 Extension

- `build`：新需求的完整工作流。
- `work`：已有功能继续工作、分类和变更。
- `bugFix`：Bug 调查、根因判断和修复。
- `workflow-ui`：可选的状态、artifact、finding 和阻塞展示。

总体架构已确定为：每个顶层工作流 extension 一个 Pi package（P2）。当前已完成 Pi-native workflow runtime bootstrap、bugFix command 及运行模型策略接线；尚未接入真实 provider E2E 与 build/work 业务流程。

## 历史资料

- [历史整体方案选型](docs/architecture-selection.md)
- [多模型评议记录](docs/reviews/2026-08-18-gpt-5.6-sol-design-review.md)
- [领域术语](CONTEXT.md)

已完成 Pi-native workflow runtime bootstrap、bugFix command 和运行模型策略接线；尚未接入真实 provider E2E 与 build/work 业务流程。
