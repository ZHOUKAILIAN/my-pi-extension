# Subagent Dispatcher 产品语义 / 指标轴 Review Artifact

| 项目 | 记录 |
| --- | --- |
| Artifact ID | `review-artifact:subagent-dispatcher:product-semantics-metrics:2026-09-13` |
| 评审轴 | 产品语义 / 指标 |
| 评审对象 | Subagent Dispatcher L1 Extension、L2 技术设计与当前实现边界 |
| 基线 | `e88085b` |
| 评审时点 | 基线之后的未提交 WIP 工作树 |
| 固定 revision | 无；当时没有固定 commit |
| 状态 | 可追溯记录；不是完整原始工具逐字转录 |

## 结论先行

本 Artifact 记录产品语义、隐私边界、可观测性和验收条件的评审事实。它支持“允许继续实现”的 Adoption Decision，不支持把当前实现称为已验证或把所有 Finding 称为已关闭。

## 角色与证据边界

| 角色 | 实际职责 | 身份事实 |
| --- | --- | --- |
| `implementer` | 提出并回应实现方案，提交 WIP 修复 | 角色可确认；原始 `workerId` 未保存 |
| `product_semantics_metrics_reviewer` | 独立检查用户目标、隐私/可见边界、指标与验收可验证性 | 角色可确认；原始 `workerId` 未保存 |
| 主 Agent / Adoption 决策者 | 汇总评审输入并记录采纳条件 | 角色可确认；不等同于 Reviewer |

评审发生在未提交 WIP 上，基线为 `e88085b`，没有固定 commit。仓库没有保留完整原始工具调用逐字转录；以下内容只重建实际可由现有摘要、源码、测试和本轮任务确认的范围与结论，不伪称为原始转录。

## 评审范围

- L1：用户目标、持久/临时 child、重试/fallback、可见反馈和安全/隐私验收；
- 指标/证据：attempt 顺序、失败分类、可复核摘要、未验证项和不把“模型说通过”当证据；
- L2：`packages/subagent/src/runner.ts`、`dispatcher.ts`、`index.ts` 及对应 Node tests；
- 评审治理：Review Artifact、Adoption Decision、实现状态与验证状态的区分。

## Findings 与回应轨迹

| 轮次 | P1 Finding | 回应 / 证据 | 当前关闭结论 |
| --- | --- | --- | --- |
| R1（已有摘要所覆盖的首轮实现评审） | 结果投影不能把 task/prompt、provider 原文、Cookie/Set-Cookie、headers、token、raw body 或嵌套诊断带入可见边界；该 Finding 同时影响产品隐私验收和可观测性可信度。 | WIP 增加 allowlist 投影、tool result 的 type/length/hash 摘要、task/system prompt 阻断和基础脱敏；摘要引用 `runner.ts` 与 runner probe。 | 摘要曾写“已关闭”，但没有固定 revision，故本 Artifact 将其保留为历史 `fixed_claimed`，不视为可重放的 `resolved_fixed`。 |
| R2（最新 P1 follow-up） | `Cookie=`、`Set-Cookie=`、任意 `X-...` header 以及 `...Header=`/`...Header:` 形式在 assistant 正常文本、嵌套对象回显中仍可能泄露 header value。只丢弃 top-level unknown fields 不足以证明 assistant 最终结果安全。 | 本轮 WIP 在 runner 的文本投影增加通用 header assignment redaction，并加入 `Cookie_EQUALS_SECRET`、`Set-Cookie`、`X-Trace-Header`、suffix `Header` 与嵌套 assistant echo probes；保留非敏感 assistant final text。 | 当前为 `fixed_claimed`；focused tests 通过后仍需独立 code review 在目标 revision 复核，不能提前记为正式关闭。 |

本轴没有记录独立的指标 P1；上述泄露 Finding 仍必须按产品隐私和验收 P1 处理。指标相关的未验证项没有被改写成“通过”。

## 评审结束时的严重度盘点

| 严重度 | 数量 / 状态 |
| --- | --- |
| P0 | 0 个已记录 Finding |
| P1 | 1 个当前安全 Finding：已在未提交 WIP 中 `fixed_claimed`，等待独立复核 |
| P2 | 1 个历史可观测性 Finding（parent metadata 只保留 allowlist 摘要）：摘要称已处理，但因无固定 revision，本 Artifact 不重新宣称已关闭 |

## 未验证项

真实 provider 错误时序、长时间 TUI/PTY picker、跨进程首次 registry 创建、进程级崩溃回放、Fast child-process E2E、生产 session 目录权限以及 OS 级文件/网络隔离仍未验证。自动化 probe 只能证明投影函数和等价故障注入边界，不能替代这些验证。

## 引用

- [Subagent Dispatcher L1 Extension](../../01-产品定义/扩展/subagent-扩展.md)
- [Subagent Dispatcher L2 技术设计](../../02-产品实现/subagent-dispatcher-技术设计.md)
- [旧评审采纳摘要（已被本 Artifact 组替代）](2026-09-13-subagent-dispatcher-评审采纳摘要.md)
