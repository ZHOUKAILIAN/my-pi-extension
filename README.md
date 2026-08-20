# my-pi-extension

个人工作流 Pi extension 集合。项目通过一个 GitHub monorepo 维护，规划包含 `/build`、`/work`、`/bugFix` 三个独立顶层工作流 extension，以及共享的 Workflow Runtime 和 Contracts。

当前已完成 Pi SDK workflow runtime 原型、`/bugFix` command 和项目模型策略接线；尚未完成真实 provider E2E，也尚未实现 `/build` 与 `/work`。

## 开始阅读

1. [五层文档总览](docs/README.md)
2. [领域术语](docs/01-产品定义/领域术语.md)
3. [当前实现地图](docs/02-产品实现/README.md)
4. [bugFix Runtime 技术方案](docs/bugfix-runtime-technical-design.md)
5. [仓库组织方案](docs/03-项目落地/仓库组织.md)
6. [GitHub 维护流程](docs/04-仓库治理/GitHub维护流程.md)

Agent 在仓库中工作前必须读取 [AGENTS.md](AGENTS.md)。

## 当前 Package

| Package | 责任 | 状态 |
| --- | --- | --- |
| `@pi/workflow-contracts` | Workflow、阶段级 Artifact 合同、Worker 和 checkpoint 类型契约 | 已实现原型 |
| `@pi/workflow-runtime` | 状态机、SDK Worker、有限重试、checkpoint 恢复和 trace | 已实现原型 |
| `@pi/bugfix` | 注册并执行 `/bugFix`，提供 traceId、恢复和 BugFix 报告 | 已实现原型 |
| `@pi/build` | 注册并执行 `/build` | 尚未实现 |
| `@pi/work` | 注册并执行 `/work` | 尚未实现 |

## 架构关系

`bugFix` 是基于共享 Runtime 实现的具体业务工作流，不绕开 Runtime：

```text
@pi/bugfix
  └── @pi/workflow-runtime
        └── @pi/workflow-contracts
```

- `@pi/workflow-contracts`：定义 Stage、Artifact、Checkpoint、Worker 和阶段级合同校验。
- `@pi/workflow-runtime`：提供通用 Controller 能力，包括 Worker Session、tools/skills scope、状态迁移、Guard、有限重试、checkpoint、`/resume` 和 trace 审计。
- `@pi/bugfix`：定义 `/bugFix` 的调查—实现—验证 Node、业务路由、模型策略、用户确认、BugFix Report 和主 Pi UI 接线。

因此，Runtime 是可复用的工作流控制引擎，`bugFix` 是第一个基于它组装的业务 Extension；未来 `/build` 和 `/work` 也应复用 Runtime，但定义各自的 Node、Artifact、Guard 和 Acceptance Criteria。

`/bugFix` 当前支持阶段级 Artifact 强校验、有限 Worker 重试、Pi 原生 `/resume` 恢复，以及带稳定 `traceId` 的主窗口和 session 审计。真实 provider E2E 仍需持续验证。

## 验证

```bash
npm test
npm run typecheck
git diff --check
```

历史选型和评审证据保存在 [`docs/归档/`](docs/归档/README.md)，但不属于当前执行规则或正式真理源。
