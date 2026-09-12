# my-pi-extension

个人工作流 Pi extension 集合。目标产品提供 `/feature` 与 `/fix` 两个独立入口，以及共享的 Workflow Runtime 和 Contracts。当前已实现 `/fix` 原型；`/feature` 尚未实现。

## 开始阅读

1. [五层文档总览](docs/README.md)
2. [L1 产品上下文摘要](docs/01-产品定义/产品上下文摘要.md)
3. [L1 权威产品定义](docs/01-产品定义/领域术语.md)
4. [Feature 产品规范](docs/01-产品定义/扩展/feature-扩展.md) / [Fix 产品规范](docs/01-产品定义/扩展/fix-扩展.md)
5. [L2 当前实现与 drift](docs/02-产品实现/README.md)
6. [L2 Runtime 实现架构](docs/02-产品实现/runtime-实现架构.md)
7. [L3 仓库组织](docs/03-项目落地/仓库组织.md)

Agent 在仓库中工作前必须读取 [AGENTS.md](AGENTS.md)。

## 产品目标与当前实现

| 范围 | 产品目标（L1） | 当前事实（L2/L3） |
| --- | --- | --- |
| Feature | `/feature`，独立 `@pi/feature` package | 尚未实现 |
| Fix | `/fix` | `/fix`、`@pi/fix`、`packages/fix` 已实现原型 |
| Runtime | 执行可审计的 Policy、Artifact、Guard 与 Acceptance | Pi SDK Runtime 原型已实现，完整治理合同尚未完成 |
| Provider 验证 | 真实环境可验证 | 真实 provider E2E 尚未完成 |

完整功能差异见 [L2 已知 L1/L2 Drift](docs/02-产品实现/README.md#已知-l1--l2-drift)。目标契约不能被当作已实现行为。

## 当前 Package

```text
@pi/fix
  └── @pi/workflow-runtime
        └── @pi/workflow-contracts
```

- `@pi/workflow-contracts`：当前 Stage、Artifact、Checkpoint、Worker 和提交接口。
- `@pi/workflow-runtime`：当前状态机、Fix Definition、Worker Session、Guard、有限重试、checkpoint 和恢复。
- `@pi/fix`：当前 `/fix` 的策略、报告、trace 和主 Pi UI 接线。
- `@pi/codex-usage-status`：Codex 额度状态与内存态 `/fast` priority processing 接线；合并行已实现，待独立代码复审与真实 Pi TUI/provider E2E；不依赖 Workflow Runtime。

产品目标上，Feature/Fix package 各自拥有自己的可执行 Workflow Definition；共享 Runtime 不拥有入口特有流程。

## 验证

```bash
npm test
npm run typecheck
git diff --check
```

历史选型和评审证据保存在 [docs/归档](docs/归档/README.md)，但不属于当前执行规则或正式真理源。
