# Subagent Delegation Recovery Adoption Decision

| 项目 | 记录 |
| --- | --- |
| Decision ID | `adoption-decision:subagent-delegation-recovery:2026-09-14` |
| 状态 | `ADOPTED_DESIGN` |
| Proposal base HEAD | `e1439e4e198fe5a62c988177774c72c93b4ad4e9` |
| 5 owning-doc combined diff SHA-256 | `6b2f6b54d1e8c45ea82e9355aa9e2782ed4677185879c2db586bc5c0fc9cb734` |
| 输入 Artifact | [产品语义 / 指标轴 Review Artifact](2026-09-14-subagent-dispatcher-产品语义指标Review-Artifact.md)、[实现 / 运营轴 Review Artifact](2026-09-14-subagent-dispatcher-实现运营Review-Artifact.md) |
| 决策日期 | 2026-09-14 |
| 授权范围 | 采纳 L1 产品契约与 L2 目标设计，允许按切片进入实现 |
| 非完成声明 | 不表示源码、测试、TUI、provider 或真实运营链路已实现或验证 |

## 结论先行

固定 proposal revision 已正式采纳。Subagent Dispatcher L1 状态进入 `DECIDED`；L2 Delegation Recovery 目标设计进入 `DECIDED / 待实现`。实现可以开始，但只能按已采纳边界推进；任何尚未由源码、测试与运行证据完成的 v2 能力都不得声称已完成。

当前 v1 Child Session、retry/fallback、attempt diagnostics、lock/GC/Fast 等基线事实保持不变。L2 已列出的 Call/Delegation、WAL、recovery、control、delivery、bridge-v1、interceptor/IPC、迁移和 shared cleanup drift 仍为未实现。

## 采纳依据

| 门禁 | 最终结果 |
| --- | --- |
| Proposal revision 固定 | base HEAD 与五文档 combined diff SHA-256 已固定 |
| 产品语义 / 指标轴 | `APPROVE`；P0=0，P1=0；AR3-5、AR3-4=`resolved_fixed`，S1–S43 连续，无既有闭环回退 |
| 实现 / 运营轴 | `APPROVE`；P0=0，P1=0，P2=0；diagnostics、fenced retention 及此前 WAL/resolver/recovery/cancel/delivery/side-effect/迁移/隐私闭环无回退 |
| 采纳版本一致性 | 本 Decision 只采纳上述固定 hash；后续实质改变目标、风险或 S1–S43 时必须重新评审与采纳 |

## 授权的实现切片

| 顺序 | 实现切片 | 完成边界 |
| --- | --- | --- |
| 0 | `bridge-v1` 兼容桥与 capability 验证 | 保持 v1 explicit-handle 行为；先证明 preservation pin、mtime/GC 与 rollback 前置。未通过时既有 v1 adoption=0。 |
| 1 | Durable control foundation | Call/Delegation/private payload、WAL durability/replay、reference、独立 Call Aggregate Proof 与 materialized view。 |
| 2 | Admission、resolver 与 lineage | pre-binding、raw→trust→shadow→effective resolver、canonical provenance、active lineage 与 startup normalization。 |
| 3 | Execution / recovery supervisor | initial/cycle reserve、spawn budget、reattach/replacement、owner fencing、Darwin death proof、continuation 与 Fast 回归门禁。 |
| 4 | Control、orchestration 与 delivery | strict cancel、parallel/chain/call-wide slot 收敛、status、normal host observation、custom outbox 与 delivery abandon。 |
| 5 | Side-effect 与隐私控制 | recovery child allowlist/interceptor-last、IPC peer/frame/ACK/watchdog、private payload/argv/temp 清理和公开投影。 |
| 6 | Migration、delete 与 retention | 独立 v2 namespace、adoption/rollback、single delete transaction、whole-Call/retention shared cleanup、orphan cleanup、tombstone/keyring。 |
| 7 | Surface 与完成验证 | TUI/PTY/provider 接线、故障注入、真实进程/E2E 及 S1–S43 证据汇总。 |

切片可以按依赖拆分 PR，但不得通过局部实现改变 L1 语义或跳过整体 Acceptance。`bridge-v1` 是采用任何既有 v1 session 的部署前置；其他 v2 基础实现不等于允许迁移旧 session。

## 安全与迁移门禁

- **Bridge 先行**：未发布、安装并验证真实 `bridge-v1` capability 前，既有 v1 session 保持 legacy explicit-handle-only，adoption 必须为 0；更老 v1 binary 不能作为安全回滚目标。
- **Fail closed**：identity、lineage、WAL durability、owner/child death、action outcome、delivery、reference、proof、权限或 cleanup 顺序不可证明时，不 spawn、不 send、不 delete、不迁移。
- **Side-effect fence**：外部动作结果不确定时进入人工处置；不得以自动恢复重复未知或已成功动作。
- **隐私边界**：task/prompt/token/header/raw payload/绝对路径不得进入公开投影；argv、临时文件、IPC、private store、tombstone 与 keyring 按已采纳权限和最小化合同验收。
- **当前事实隔离**：目标设计不能写成 v1 当前能力。每个切片完成后必须同步 L2 实现事实与 drift，并接受独立代码评审。
- **变更控制**：影响目标、风险、迁移、安全边界或 S1–S43 的实质修改使本 Decision 失效，必须在新固定 revision 上重新两轴评审。

## 完成验收

`ADOPTED_DESIGN` 只授权进入实现。只有下列条件全部满足，才可把 Delegation Recovery v2 声称为实现完成或验证完成：

1. L1 [Acceptance S1–S43](../../01-产品定义/扩展/subagent-扩展.md#10-acceptance-definition) 连续、无缺号且逐项有对应源码 / 测试 / 运行证据；不得改变其实质语义来适配实现。
2. L2 验证矩阵、崩溃点矩阵、固定 GC 锁序、bridge-v1 前置与迁移 / rollback 条件均有真实产生点和可复核证据。
3. 每个 coding 切片完成 `implementer → code_reviewer`，P0/P1 和需修复 P2 全部关闭；相关 focused tests、`npm test`、`npm run typecheck`、`git diff --check` 通过。
4. S22/S23/S26 等要求的真实 interceptor/IPC、隐私、双进程/OS kill、Darwin、active lineage、TUI/PTY/provider 和 shared cleanup kill-point E2E 已执行；不能用 mock 或 v1 基线证据代替。
5. L2 当前事实已更新为实际达到的状态，所有剩余 drift 与未验证项明确披露；未满足时状态保持 `IMPLEMENTING` 或明确的未验证状态，不能标记 `VERIFIED`。

## 证据限制与历史边界

本 Decision 依据两份 2026-09-14 固定 revision Review Artifact；不补写或虚构完整逐字工具转录或 `workerId`。2026-09-13 的 Subagent Dispatcher Review / Adoption 文件只覆盖旧基线和历史 WIP，不评审、不阻塞也不替代本次固定 proposal revision。

## 活跃 owner

- L1：[Subagent Dispatcher Extension 产品规范](../../01-产品定义/扩展/subagent-扩展.md)
- L2：[Subagent Dispatcher 技术设计](../../02-产品实现/subagent-dispatcher-技术设计.md)
- 可视化：[Subagent Dispatcher 流程图](../../02-产品实现/subagent-dispatcher-流程图.md)
