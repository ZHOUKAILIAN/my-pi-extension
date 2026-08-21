# 第二层：产品实现

第二层回答“当前真实实现了什么”。本层的正式真理源是源码和测试，不在 Markdown 中复制第二份实现说明。

## 实现地图

| 路径 | 责任 | 当前状态 |
| --- | --- | --- |
| `packages/workflow-contracts/src/` | Stage、Artifact、Worker、checkpoint 和提交接口 | 强 Artifact 合同已实现 |
| `packages/workflow-runtime/src/` | 状态机、Pi SDK Worker、skill scope、session checkpoint、恢复和 Worker trace | 有限重试与错误分类已实现 |
| `packages/bugfix/src/` | `/bugFix` command、模型策略、UI 决策、报告、traceId 和审计接线 | 已实现，真实 provider E2E 仍需持续验证 |
| `packages/*/test/` | 对应源码的行为和回归证据 | 现有测试通过 |

尚未存在 `packages/build`、`packages/work` 和独立 `workflow-ui` 实现。

## 当前边界

- Worker 使用 Pi SDK 独立 `AgentSession`，不是历史研究中的 CLI worker 方案。
- Controller 拥有状态迁移、Artifact 合同校验、有限重试、checkpoint 恢复和 `traceId` 审计；Worker 不能授权下一状态。
- investigate、implement、verify 的 Artifact 必填字段由 Runtime 分类校验；工具提交和严格 fenced JSON fallback 使用同一合同。
- 单个 Worker session 最多两次交付尝试，失败后 Controller 最多新建一个 session 重跑同一 Node；仍失败则保留 checkpoint 并提示 `/resume`。
- 项目支持按 Node 配置模型和 skill，但 skill 不扩大工具 allowlist。当前 `group_pals` 本地策略将 implement 模型配置为 `smartingredients/gpt-5.6-terra`，该文件不提交到本仓库。
- 主窗口 trace 同时写入 `workflow-trace`，并以稳定 `traceId` 关联 command、policy、failure、checkpoint 和模型事件。
- `/bugFix` 已有 fake/injected worker 行为测试和 SDK adapter 测试；真实 provider E2E 尚未完成。
- 当前 contracts 尚未完整实现设计文档中的 revision-bound review、arbiter 和完整 Acceptance Criteria。

## 验证入口

```bash
npm test
npm run typecheck
```

实现变化后更新最接近行为的测试。若实现与第一层产品契约冲突，必须明确记录 drift，并决定修改实现还是重新对齐产品定义。
