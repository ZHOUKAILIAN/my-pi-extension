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

## 当前 Package

```text
@pi/fix
  └── @pi/workflow-runtime
        └── @pi/workflow-contracts

@pi/codex-usage-status
  └── optional Fast producer for @pi/subagent

@pi/subagent
  └── isolated Pi child sessions (not a Workflow Runtime worker)
```

- `@pi/workflow-contracts`：当前 Stage、Artifact、Checkpoint、Worker 和提交接口。
- `@pi/workflow-runtime`：当前状态机、Fix Definition、Worker Session、Guard、有限重试、checkpoint 和恢复。
- `@pi/fix`：当前 `/fix` 的策略、报告、trace 和主 Pi UI 接线。
- `@pi/codex-usage-status`：Codex 额度状态与内存态 `/fast` priority processing 接线；合并行已实现，待独立代码复审与真实 Pi TUI/provider E2E；不依赖 Workflow Runtime。
- `@pi/subagent`：通用 `subagent` 工具。默认创建可恢复 child session；每个模型最多首次加两次 allowlist 瞬态重试，随后才按 agent 配置的 fallback 模型切换；可使用返回的 opaque session handle 恢复并人工指定模型。`persistent: false` 仅在当前调用存活。它不创建 Workflow Run、Node、Artifact 或 Worker。

产品目标上，Feature/Fix package 各自拥有自己的可执行 Workflow Definition；共享 Runtime 不拥有入口特有流程。`@pi/subagent` 是独立的通用委派器，不属于该 Workflow 层级。

## 使用 `@pi/subagent`

Pi settings 在 `packages` 中加载本仓库 package（使用本机绝对路径或相对于 settings 文件的路径）：

```json
{
  "packages": [
    "/absolute/path/to/my-pi-extension/packages/subagent"
  ]
}
```

同一 Pi 配置只能注册一个名为 `subagent` 的 extension/tool；迁移前应停用旧的 local dispatcher，避免同名工具冲突。运行时本地状态（child JSONL、registry、lock、GC tombstone）位于 Pi agent 状态根的 `subagent/` 下，不进入 Git。

调用时提供 `agent` 和 `task`；也可使用 `tasks`（并行，最大 8）、`chain`（以 `{previous}` 传递上一步输出），或以 `session` 恢复既有 child。人工模型接管示例：

```ts
subagent({
  agent: "implementer",
  session: "<opaque-session-handle>",
  model: "openai-codex/gpt-5.6-terra",
  task: "继续刚才的任务",
});
```

`@pi/codex-usage-status` 是可选 peer dependency。安装并启用 producer 时，只有新 logical child 的首次 spawn 在严格条件下才可继承 Fast；retry、fallback 和 resume 一律关闭 Fast。

## 验证

```bash
npm test
npm run typecheck
git diff --check
```

历史选型和评审证据保存在 [docs/归档](docs/归档/README.md)，但不属于当前执行规则或正式真理源。
