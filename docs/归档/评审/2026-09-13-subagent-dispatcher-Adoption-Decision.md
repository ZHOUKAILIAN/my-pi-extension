# Subagent Dispatcher Adoption Decision

| 项目 | 记录 |
| --- | --- |
| Decision ID | `adoption-decision:subagent-dispatcher:2026-09-13` |
| 决策 | `BLOCKED_FORMAL_ADOPTION` |
| 决策范围 | 保留目标产品语义、真实 Review Artifact 和 WIP 实现方向作为待治理材料；未满足正式进入实现门禁，WIP 不可合并，待用户治理决定 |
| 输入 Artifact | [产品语义 / 指标轴 Review Artifact](2026-09-13-subagent-dispatcher-产品语义指标Review-Artifact.md)、[实现 / 运营轴 Review Artifact](2026-09-13-subagent-dispatcher-实现运营Review-Artifact.md) |
| 基线 | `e88085b` |
| 决策时点 | 未提交 WIP；没有固定 commit |
| 证据限制 | 不可伪称完整原始工具逐字转录；本 Decision 只引用两条可追溯 Review Artifact |

## 结论先行

1. 保留 Subagent Dispatcher 的目标边界和两条真实 Review Artifact：持久 child 默认、同一 session 的受控 retry/fallback、session integrity fail-closed、有限安全投影、可恢复本地状态和 Fast 首次 spawn 约束。
2. 当前不能形成正式采纳：正式 Reviewer 的 `workerId` 无法由当前 host 提供或核验，不能伪造身份，也不能把本 Decision 当作满足正式进入实现门禁。L1 状态为 `BLOCKED_FORMAL_ADOPTION`；当前源码只能视为 WIP，不可合并，待用户治理决定。
3. 本轮安全 P1 的处理状态是 `fixed_claimed`，不是 `resolved_fixed`：WIP 已补齐通用 `Cookie=` / `Set-Cookie=` / `X-...` / suffix `Header` redaction 和 probes，且本轮继续补充 Cookie 分号片段回归；需由可核验的独立 reviewer 在固定目标 revision 上复核关闭。

## 决策依据与条件

| 条件 | 决策要求 | 当前状态 |
| --- | --- | --- |
| 产品目标与隐私边界 | 正常 assistant final result 保留；header/Cookie/Set-Cookie/token/raw body、嵌套诊断和 task/prompt 不进入 AttemptResult、details、UI、metadata | Review Artifact 保留该目标；本轮 P1 WIP 已回应，待可核验独立复核 |
| 实现与恢复 | registry/header 校验、retry/fallback 闭集、identity lock、GC/tombstone 和临时目录边界不得被 prompt 绕过 | 目标和真实 Review Artifact 保留；正式采纳阻塞，历史摘要证据无固定 revision，需按当前源码与测试复核 |
| 评审治理 | 两条独立评审轴、逐轮 Finding/回应/关闭状态和未验证项必须可追溯，且正式 Reviewer `workerId` 可核验 | 两条真实 Review Artifact 已保留，但当前 host 无法提供/核验正式 Reviewer `workerId`；正式采纳阻塞 |
| 完成门槛 | P0/P1 不能保持未关闭；测试、typecheck、diff/links 必须有命令结果；真实 provider/TUI/崩溃边界不能伪称已验证 | 尚未满足；本 Decision 不授予进入实现或合并权限 |

## 正式采纳阻塞（本 Decision 时点）

| 阻塞项 | 事实 | 影响 |
| --- | --- | --- |
| Formal Reviewer identity | 当前 host 无法提供或核验正式 Reviewer `workerId`；不得伪造 | 无法满足 L1 的独立正式评审身份门禁，Decision 为 `BLOCKED_FORMAL_ADOPTION` |
| WIP 状态 | 源码和测试可继续作为本地 WIP 验证材料 | 不可合并、不可称为正式采纳实现；待用户治理决定 |

## 最终严重度盘点（本 Decision 时点）

| 严重度 | 盘点 |
| --- | --- |
| P0 | 0 个已记录 |
| P1 | 1 个当前安全 P1，`fixed_claimed` / 等待独立 code review；历史 session/lock/GC P1 仅有摘要级、无固定 revision 记录 |
| P2 | 1 个 parent metadata allowlist / 可观测性 P2，历史摘要称已处理但本 Decision 不重新宣称已关闭 |

## 未验证项与不变更范围

真实 provider 错误时序、长时间 TUI/PTY picker、跨进程首次 registry 创建、进程级崩溃回放、真实 Fast child-process E2E、生产 session 目录权限及 OS 文件/网络隔离仍未验证。该 Decision 不授权修改 `~/.pi/agent/settings.json`、`~/.pi/agent/extensions/subagent/` 或任何 global/local extension，也不授权 push、发布或生产写入。

## 关联规范与实现

- L1 owner：[Subagent Dispatcher Extension 产品规范](../../01-产品定义/扩展/subagent-扩展.md)
- L2：[Subagent Dispatcher 技术设计](../../02-产品实现/subagent-dispatcher-技术设计.md)
- 实现：[packages/subagent/src/runner.ts](../../../packages/subagent/src/runner.ts)、[packages/subagent/src/index.ts](../../../packages/subagent/src/index.ts)
- 两条输入 Review Artifact：见本 Decision 顶部表格；旧摘要不再作为唯一评审证据。它们是保留的真实评审事实，不等于当前已满足正式采纳门禁。
