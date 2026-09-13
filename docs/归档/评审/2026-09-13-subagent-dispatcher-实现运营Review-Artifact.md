# Subagent Dispatcher 实现 / 运营轴 Review Artifact

| 项目 | 记录 |
| --- | --- |
| Artifact ID | `review-artifact:subagent-dispatcher:implementation-operations:2026-09-13` |
| 评审轴 | 实现 / 运营 |
| 评审对象 | `@pi/subagent` package 的 runner、dispatcher、session/lock、GC、Fast consumer、details/UI/metadata 边界 |
| 基线 | `e88085b` |
| 评审时点 | 基线之后的未提交 WIP 工作树 |
| 固定 revision | 无；当时没有固定 commit |
| 状态 | 可追溯记录；不是完整原始工具逐字转录 |

## 结论先行

本 Artifact 记录实现安全、恢复、运营和验证证据的评审事实。当前 package 可以继续实现和 focused 验证；真实 provider/TUI、跨进程和崩溃恢复证据仍不足，不能使用“已通过”替代证据。

## 角色与证据边界

| 角色 | 实际职责 | 身份事实 |
| --- | --- | --- |
| `implementer` | 编写 package、测试并回应 Finding | 角色可确认；原始 `workerId` 未保存 |
| `code_reviewer` / implementation-operations reviewer | 独立检查实现、恢复、安全、运营和验证缺口 | 角色可确认；原始 `workerId` 未保存；完整工具转录不存在 |
| 主 Agent | 汇总回应，决定是否允许进入实现阶段 | 不承担独立关闭自身 Finding 的职责 |

评审是在未提交 WIP 上进行，基线是 `e88085b`，没有固定 commit。这里记录实际评审角色、范围和可由当前仓库核对的证据；不声称拥有完整原始工具逐字转录。

## 评审范围

- `runner.ts`：Pi JSON event header、terminal、tool result、错误分类、AttemptResult 投影；
- `dispatcher.ts`：retry/fallback 预算、session registry/header 校验、identity lock 和临时目录清理；
- `index.ts`：details、UI 输出、parent `subagent-session` metadata；
- `session-lock.ts`、`gc.ts`、`fast-inheritance.ts` 及 focused tests；
- 本轮安全 probe 与 `npm test` / `typecheck` / diff / links 证据。

## Findings 与回应轨迹

| 轮次 | P1 Finding | 回应 / 证据 | 当前关闭结论 |
| --- | --- | --- | --- |
| R1（已有摘要所覆盖的实现/运营评审） | session registry/header 不一致时可能误恢复、空 session 或继续 retry；必须 fail closed。 | `dispatcher.ts` 在已有 registry 下查找并校验 JSONL header；缺失或不匹配不 spawn、不 retry/fallback；已有 dispatcher tests 覆盖。 | 历史摘要记为关闭，但没有固定 revision；本 Artifact 只记录为历史 `fixed_claimed`，未重放为 `resolved_fixed`。 |
| R1（同轮） | stale lock / GC 中断恢复若只按 TTL 删除，可能与 live child 或恢复竞态冲突。 | `session-lock.ts`、`gc.ts` 使用 identity lock、live child 检查和 tombstone 路径；focused tests 覆盖等价注入。 | 历史摘要记为关闭；跨进程真实崩溃和生产目录仍未验证。 |
| R1（同轮） | AttemptResult/details/UI/metadata 不能成为 provider 原文、task/prompt、header/Cookie 或嵌套诊断的旁路。 | `index.ts` 对最终、progress、details 和 metadata 使用安全投影；本轮发现文本形态的 `Cookie=` / `X-...` / suffix `Header` 漏洞并追加 runner redaction probes。 | 该安全 Finding 在最新轮次重新打开；本轮 WIP 为 `fixed_claimed`，等待独立 code review，不得提前关闭。 |
| R2（最新 P1 follow-up） | 具体泄露探针为 `Cookie_EQUALS_SECRET`、`Set-Cookie=`、`X-Trace-Header`、`...Header=`/`...Header:`，包括嵌套/assistant echo。 | `runner.ts` 增加 header assignment redaction；`runner.test.ts` 验证正常 assistant final text 保留、AttemptResult/progress 不含 sentinel；`index.test.ts` 验证 details/user-facing output 不含 sentinel。 | focused tests 已通过；正式 Finding 状态仍为 `fixed_claimed`，需要独立 code reviewer 在目标 revision 关闭。 |

## 评审结束时的严重度盘点

| 严重度 | 数量 / 状态 |
| --- | --- |
| P0 | 0 个已记录 Finding |
| P1 | 1 个当前安全 Finding：WIP 已回应，独立复核未完成；历史 session/lock/GC P1 只有无固定 revision 的摘要证据 |
| P2 | 1 个 parent metadata allowlist / 可观测性 Finding：已有摘要称已处理，缺少固定 revision 的可重放闭环 |

## 未验证项

真实 Pi provider 错误时序、长时 TUI/PTY picker、真实 child process/provider E2E、跨进程首次创建、进程级崩溃回放、真实权限/文件系统和网络隔离均未验证。当前 focused Node tests 和单进程/等价故障注入不应升级为生产运营证据。

## 引用

- [Subagent Dispatcher L2 技术设计](../../02-产品实现/subagent-dispatcher-技术设计.md)
- [Subagent Dispatcher L1 Extension](../../01-产品定义/扩展/subagent-扩展.md)
- [产品语义 / 指标轴 Review Artifact](2026-09-13-subagent-dispatcher-产品语义指标Review-Artifact.md)
- [旧评审采纳摘要（已被本 Artifact 组替代）](2026-09-13-subagent-dispatcher-评审采纳摘要.md)
