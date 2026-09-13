# my-pi-extension

个人工作流 Pi extension 集合。目标产品提供 `/feature`、`/fix` 两个 Workflow 入口，以及独立的通用 `subagent` child dispatcher。当前已实现 `/fix` 原型与 `@pi/subagent`；`/feature` 尚未实现。

## 开始阅读

1. [五层文档总览](docs/README.md)
2. [L1 产品上下文摘要](docs/01-产品定义/产品上下文摘要.md)
3. [L1 权威产品定义](docs/01-产品定义/领域术语.md)
4. [Feature 产品规范](docs/01-产品定义/扩展/feature-扩展.md) / [Fix 产品规范](docs/01-产品定义/扩展/fix-扩展.md) / [Subagent Dispatcher 产品规范](docs/01-产品定义/扩展/subagent-扩展.md)
5. [L2 当前实现与 drift](docs/02-产品实现/README.md)
6. [L2 Runtime 实现架构](docs/02-产品实现/runtime-实现架构.md) / [Subagent Dispatcher 技术设计](docs/02-产品实现/subagent-dispatcher-技术设计.md)
7. [L3 仓库组织](docs/03-项目落地/仓库组织.md) / [扩展目录](docs/03-项目落地/扩展目录.md)

Agent 在仓库中工作前必须读取 [AGENTS.md](AGENTS.md)。

## 产品目标与当前实现

| 范围 | 产品目标（L1） | 当前事实（L2/L3） |
| --- | --- | --- |
| Feature | `/feature`，独立 `@pi/feature` package | 尚未实现 |
| Fix | `/fix` | `/fix`、`@pi/fix`、`packages/fix` 已实现原型 |
| Runtime | 执行可审计的 Policy、Artifact、Guard 与 Acceptance | Pi SDK Runtime 原型已实现，完整治理合同尚未完成 |
| Subagent | `subagent` 工具，隔离委派、默认持久 child session、瞬态重试与 fallback | `@pi/subagent` 已实现；headless provider 创建和同 handle 恢复 smoke 已通过，真实 TUI/retry/fallback/Fast child E2E 待验证 |
| Provider 验证 | 真实环境可验证 | Workflow 的真实 provider E2E 尚未完成；Subagent 的 headless 创建/恢复 smoke 已通过 |

完整功能差异见 [L2 已知 L1/L2 Drift](docs/02-产品实现/README.md#已知-l1--l2-drift)。目标契约不能被当作已实现行为。

## Extension 目录

| Extension / package | 入口 | 作用 | 当前状态与说明 |
| --- | --- | --- | --- |
| `@pi/feature` | `/feature` | Feature Workflow 入口。 | 尚未实现；见 [Feature 产品规范](docs/01-产品定义/扩展/feature-扩展.md)。 |
| `@pi/fix` | `/fix` | Fix Workflow 的策略、报告、trace 和主 Pi UI 接线。 | 原型已实现；依赖共享 Runtime 与 Contracts。 |
| `@pi/codex-usage-status` | 状态栏 / `/fast` | 展示 Codex 额度状态，并提供 Fast priority processing 的 producer。 | 合并行已实现；真实 Pi TUI/provider E2E 待验证；不依赖 Workflow Runtime。 |
| `@pi/subagent` | `subagent` 工具 | 通用隔离 child-session dispatcher：默认持久会话、瞬态重试、模型 fallback 与恢复。 | 已实现；不创建 Workflow Run/Node/Artifact/Worker。具体合同和验证边界见 [L2 技术设计](docs/02-产品实现/subagent-dispatcher-技术设计.md)。 |
| `@pi/workflow-runtime` | 共享内部依赖 | Workflow 状态机、Fix Definition、Worker Session、Guard、有限重试、checkpoint 和恢复。 | Pi SDK Runtime 原型已实现。 |
| `@pi/workflow-contracts` | 共享内部依赖 | Stage、Artifact、Checkpoint、Worker 与提交接口合同。 | 由 Runtime 和 Workflow 入口共同使用。 |

产品目标上，Feature/Fix package 各自拥有自己的可执行 Workflow Definition；共享 Runtime 不拥有入口特有流程。`@pi/subagent` 是独立的通用委派器，不属于该 Workflow 层级。

## 验证

```bash
npm test
npm run typecheck
git diff --check
```

历史选型和评审证据保存在 [docs/归档](docs/归档/README.md)，但不属于当前执行规则或正式真理源。
