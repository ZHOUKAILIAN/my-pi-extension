# 第二层：产品实现

第二层（L2）回答“产品当前怎样实现、真实实现了什么”。源码和测试是运行事实真理源；本目录只提供实现入口、机制设计和已知 drift，不重新定义 L1 产品语义。

## L1 → L2 交接

| L1 产品要求 | L2 owner |
| --- | --- |
| Workflow / Node / Run 通用对象 | `packages/workflow-contracts/src/` |
| 状态迁移、Guard、Worker 生命周期、checkpoint 与恢复 | `packages/workflow-runtime/src/` |
| Fix 的命令、Policy、报告和 Pi UI 接线 | `packages/fix/src/` |
| Fix 的调查复核、Disposition、Change Plan Review、Change Review 和 Acceptance Definition | `packages/fix/src/definition.ts`（已实现：`fixDefinitionV2`、`FIX_REVIEW_POLICIES`、`FIX_ACCEPTANCE`） |
| Fix 的可执行 Node/状态图与业务 Guard | 状态图/边/约束在 `packages/fix/src/definition.ts`（`fixDefinitionV2`）；执行门禁（review kind 映射、`root_cause_alignment` 等 check satisfier、`DISPOSITION→IMPLEMENTING` 的 change_plan_review gate）仍在 `packages/workflow-runtime`，owner 待拆（见 drift 表） |
| Artifact 合同与运行行为证据 | 对应 `packages/*/test/` |
| 当前 Fix 实现机制说明 | [Fix Runtime 技术设计](fix-runtime-technical-design.md) |

L1 Extension 规范描述 Stage、Artifact、Guard 和 Acceptance 的产品语义；L2 将其落实为状态枚举、Transition 配置、Policy 解析、Artifact schema、Guard 代码、Worker 创建、存储接口和测试。

## 实现地图

| 路径 | 责任 | 当前状态 |
| --- | --- | --- |
| `packages/workflow-contracts/src/` | Stage、Artifact、Worker、checkpoint 和提交接口 | 原型已实现 |
| `packages/workflow-runtime/src/` | 通用状态机、Pi SDK Worker、Skill scope、Session checkpoint、Run Control WAL、交互队列、恢复与 GC；当前仍承载 Fix 业务门禁 | 已实现：有限重试、close fence、补充/模型生命周期审计、participant 级评审恢复、parent branch 校验、tombstone/trash GC；Fix 门禁 owner 待拆分（drift） |
| `packages/fix/src/` | `/fix` command、模型策略、UI 决策、报告、traceId、实时 Worker 输入和 Child picker 接线 | v2 主流程与 Extension 交互适配已实现；真实 provider E2E、长时 TUI 稳定性和真实崩溃回放仍待验证 |
| `packages/*/test/` | 对应源码的行为和回归证据 | 现有自动测试可运行 |
| `packages/codex-usage-status/` | ChatGPT Codex 额度状态栏与 Fast 扩展 | 已实现独立 Pi extension；固定 ChatGPT usage endpoint、OAuth scope lease、白名单 DTO、TUI 状态投影、Fast priority hook/cost ticket 与 parent-Fast interop 见 [Codex Usage Status + Fast 技术设计](codex-usage-status-技术设计.md)；local dispatcher role/source policy 与真实 Pi TUI/provider E2E 未执行 |

尚未存在 `packages/feature` 和独立 `workflow-ui` 实现。

## 当前实现边界

- Runtime 通过 Pi SDK 创建独立 `AgentSession` 承载 Worker Session；这隔离对话历史，但不等同于进程、文件系统或 OS sandbox。
- 当前 Worker Session 仍由 `PiSdkWorkerExecutor.execute()` 创建并在 Node 完成后释放；Extension 通过 `ActiveWorkerRegistry` 在执行期间寻址当前 Child，并用 `WorkflowInteractionPort` 路由输入、模型切换和事件。Child 运行句柄不是独立进程，WAL 才是 Run 控制事实；真实 TUI 长时间运行、宿主退出时序和跨进程崩溃回放尚未被 provider E2E 证明。
- 实时交互已实现：输入按 Run/Node/Session/Attempt 复核，补充在 WAL 中分配 sequence；`turn_start` 建立累计 supplement snapshot，`turn_end` 与 `bindArtifact` 在同一队列线性化，`prompt`/`steer` 的等待在队列外执行以允许 Pi 回调重入；close fence 后 fail-closed。`PiSessionRunStore` 在 Pi API 可用时使用完整 `getBranch`，只投影当前 active branch；Run Control WAL 的 `loadLast()` 另按 Child lifecycle 折叠恢复。
- Parent 恢复允许 header leaf 是当前 session active branch 的 ancestor/member；header 保存 parent session file path/existence。仅当 header 明确 `parentSessionFileExists=false`、原 parent file 仍不可发现且 cwd 相同时，UI 才会展示 Run 并在明确确认后允许以不同的新 Session ID rebind；header 曾显示已有文件的 Run、其他仍存在 Session 的 Run 和无 UI 场景均不进入 no-file orphan 接管。
- Controller 拥有状态迁移、Artifact 合同校验、有限重试、checkpoint 恢复和 `traceId` 审计；Worker 不能授权下一状态。
- v2 流水线以 `fixDefinitionV2`（8 阶段 `INTAKE`→`INVESTIGATING`→`DISPOSITION`→`IMPLEMENTING`→`VERIFYING`→`WAITING_FOR_USER`→`ACCEPTED`，`BLOCKED` 侧支）驱动：`prepareRun`/`continueRun` 在 `packages/fix/src/extension-v2.ts`，Worker 经 `executeNode` 盖章归档，评审经 `runReview`（quorum + 独立 Worker 身份），人工验收经 `collectDecision` + `evaluateAcceptance` + `decide`，项目级 `.pi/workflow.json` 策略经 `loadEffectivePolicy`，`/fix review` 提供评审命令，`session_start(resume)` 提供恢复。
- 无仓库变更路径（`disposition.requiresRepositoryChange === false`）：常规处置直接 `DISPOSITION`→`VERIFYING`，不经过 `IMPLEMENTING` 与 `change_review`；处置等待（`dispositionType` 为 `wait_decision`/`external_action`）先停 `WAITING_FOR_USER`（`pendingDecisionKind` 区分 `disposition_decision`/`external_action_completion`），用户决定/外部动作完成后由 `continue_disposition` 回 `DISPOSITION`（重落地处置）或 `VERIFYING`（外部动作完成证据）。
- `IntakeArtifact` 正式字段为 `summary`（一句话摘要）+ `overview`（场景/影响/已知上下文）；原始 `problem` 保留为 Run 级追溯事实（`checkpoint.problem`），不进入报告或人工摘要。旧仅 `phenomenon` 的 checkpoint 视为不完整：契约校验拒绝、验收 marker 不通过、报告显示「尚未确认」，不静默降级。
- 验证失败三向分流：`verification.accepted=false` 必须携带结构化 `failure`（契约强制），按 `failure.kind` 路由 —— `implementation`→回流 `IMPLEMENTING`；`configuration`（无仓库变更的配置问题）→`WAITING_FOR_USER`；`external_condition`→`BLOCKED`（`recordBlocker`，returnStage=VERIFYING）。配置类等待的重新验证出口为 `continue_verification`→回 `VERIFYING`（`pendingDecisionKind='configuration_wait'`）。契约层强制 `accepted=false` 必须携带结构化 `failure`（`MISSING_VERIFICATION_FAILURE`），杜绝静默回流。
- `BLOCKED` 解锁后，目标阶段 Worker 会执行两次（一次用于解锁过渡，一次为该阶段重跑），属当前规格行为，未做去重。
- `request_changes`/`reject`/`continue_disposition` 决策后主循环按 `fixReasonToStage` 自动回流对应阶段并继续推进，直至再次进入 `WAITING_FOR_USER` 或 `ACCEPTED`；resume 到 `WAITING_FOR_USER` 时仍收集人工选择，不自动通过验收。`continue_disposition` 只在处置等待（`disposition_decision`/`external_action_completion`）下合法：`disposition_decision`→回 `DISPOSITION`，`external_action_completion`→无仓库变更回 `VERIFYING`、声明仓库变更回 `DISPOSITION`（不持有该等待种类时 `CONTINUE_DISPOSITION_NOT_AVAILABLE` fail-closed）。
- F1（continue_disposition 携带处置决定内容）：用户继续处置时必须提供决定内容——UI 路径经 `collectDecision` 输入收集为 `note`（有输入能力时空/取消视为放弃继续），CLI 路径 `/fix review continue-disposition <内容>` 以 `reasonCode` 承载；决定内容随 Runtime 决策记录（`checkpoint.decisionRecord.note`/`reasonCode`）落盘为 trace 事实（完整 UserDecision Artifact 持久化仍为延后专项）。continueRun 的 `DISPOSITION` 分支重跑处置时从最新 checkpoint 读回该记录并作为 `capsule.userDecision` 瞬态传给 disposition worker（同一调用内 UI 决策回流与 `/fix review` 后跨调用 `/resume` 均覆盖），worker 可读到“用户决定了什么”，不再只带原始 problem。
- 无 UI 或用户取消时，Run 停留在 `WAITING_FOR_USER`（可 `/fix review` 或 `/resume`）或 `BLOCKED`（`/resume` 后重新输入补充信息）。
- SDK custom tool 与严格 fenced JSON fallback 都经过同一 Artifact 校验入口。
- 单个 Worker Session 最多两次交付尝试；失败后 Controller 最多创建一个新 Session 重跑当前 Node，仍失败则保留 checkpoint 并提示 `/resume`。
- 项目可以按 Node 配置模型和 Skill；Skill 不扩大工具 allowlist。
- 主窗口 trace 与持久化 entry 通过稳定 `traceId` 关联。

## 已知 L1 / L2 Drift

以下差异是已报告的当前事实，不应通过文档措辞掩盖。「分期」依据 L1《Fix 扩展》「第一版范围」：第一版 = 主流程走通 + 全量人工验收，防错 / 纠错类机制由人工验收兜底。

| L1 目标契约 | L2 当前事实 | 处理方向 | 分期 |
| --- | --- | --- | --- |
| Fix 业务验收标准（review kind 映射、`root_cause_alignment` 等 check 语义、`DISPOSITION→IMPLEMENTING` 的 change_plan_review 门禁）由 Fix Extension 拥有，Core Runtime 不拥有 | 执行门禁当前仍在 `packages/workflow-runtime`（`BUSINESS_ARTIFACT_KINDS`/`NODE_ARTIFACT_KINDS`/`REVIEWED_KIND_BY_REVIEW_KIND`/`REVIEW_CHECK_SATISFIERS`/`assertChangePlanReviewGate` 等），legacy `fixNodes` 三节点构造器也仍由其导出；仅状态图/边/约束在 `packages/fix/src/definition.ts` | 后续迭代：将 Fix 门禁改为 WorkflowDefinition 显式通用 hook 或迁回 `packages/fix`；当前如实记录 owner drift，不声称已迁回 | 第一版（待重构；在途改动落地后执行） |
| 争议可交 Arbiter | 尚未实现 arbiter 角色与争议裁决流程 | 后续迭代：review finding 争议升级、独立仲裁 Worker | 后续版本（人工裁决兜底） |
| 最终处置报告为摘要级固定结构（第一版；完整模板为后续优化） | `buildFixReport` 为 8 节摘要投影（结论/现象/根因/影响面/处置/修改/验证/引用）；「状态」按 `dispositionType` 映射 L1 状态枚举（remediation/external_action→已解决、mitigation→已缓解、explanation→无需修改，其余保守→未解决，ACCEPTED 后产出统一带验收通过后缀）；空字段有「无/未提供」兑底 | 第一版已对齐；完整模板（预期-实际-确认结果、T0–T4 时间线、已排除候选、证据缺口、触及链路、已执行命令等）为后续优化，需先扩 `investigation`/`verification`/`disposition` 合同字段，方案见归档评审件《2026-08-29-fix-报告重构-方案与评审》 | 后续优化（摘要版已对齐） |
| `PendingDecisionKind` 四值枚举与 `continue_disposition` 的 stage 映射由 Fix Extension 拥有（Fix 专属等待语义） | `PendingDecisionKind` 类型定义在 `packages/workflow-contracts`；持久化/恢复/未知值校验/`continue_disposition` 的 stage 映射（`disposition_decision`→DISPOSITION；`external_action_completion`+无仓库变更→VERIFYING、声明仓库变更→DISPOSITION）都在 `packages/workflow-runtime`（`applyTransition`/`restore`/`decideCore`），Fix 包仅在使用点 `setPendingDecisionKind`/`getPendingDecisionKind` 声明与消费。这些 Fix 业务语义仍在 shared Runtime，owner 待拆。处置等待/continue_disposition 语义因此跨包重复（Fix 包内 `definition.ts` guard 与 `extension-v2` 的动作集收窄 vs shared Runtime 的 `decideCore`/`restore` 交叉校验），是 owner drift 的体现，待 owner 重构收敛 | 后续迭代：通过 WorkflowDefinition 显式 capability/hook（如 `pendingDecisionKinds`/`decisionRouting`）收敛或迁回 `packages/fix`；当前如实记录 owner drift，不声称已迁回 Fix 包 | 第一版（待重构；与 Fix 门禁同一重构专项） |
| 修改方案改变正式需求/技术方案/架构决策/验收标准时，CHANGE_PLAN_REVIEW 必须升级为 Core 正式方案流程（Proposal→Independent Review→Adoption） | 部分实现（保守策略）：`disposition.requiresFormalPlanReview === true` 时 continuation 一律 `BLOCKED`（`recordBlocker` + `guard_rejection`），不静默进 `IMPLEMENTING`/`VERIFYING`；声明 `false` 走正常流程，但仅是 Worker 判断、不代表产品正式采纳。Core 的 Proposal→Independent Review→Adoption 升级流程本身未实现 | 后续迭代：实现 Core 正式方案采纳流程后接线升级路径；当前“声明 true → BLOCKED”是唯一合法接线，各阶段 guard 亦拒绝 `requiresFormalPlanReview===true` 的处置直进（`FORMAL_PLAN_REVIEW_REQUIRED`） | 后续版本（保守 BLOCKED 兑底） |
| 后验收 reopen/rollback 事件语义源自归档评审草案，当前 L1 不定义任何审计事件（待 D6 专项随 L1 回写）：`run_reopened` = ACCEPTED 后发现问题重新打开，`run_rolled_back`/`post_acceptance_issue_confirmed` 在后验收阶段使用 | 无 ACCEPTED 后 reopen/rollback 命令，三个事件均无 emit 点（返工回流已用独立 `run_rework` 事件，不占用 `run_reopened`）；当前没有统一 Bug 记录和后验收观察基础 | 延后到后验收 reopen/rollback 专项（D6）；不阻塞当前 Fix 修复、验证和人工验收主流程 | 后续版本（D6 专项；人工发现验收后问题可新建 Run） |
| 未覆盖项可“明确披露且不影响接受决定”时允许通过 | `FIX_VERIFICATION_REQUIREMENT.allowUnverified: false`，存在 unverified 即拒绝（更保守；策略可配置） | 保持保守默认，如需放宽按风险等级调整策略 | 无需修改（严于 L1 下限，合规） |
| Fix 业务提交合同（每 Node 的 `submissionContract` 文本、`submit_artifact` 的 per-kind schema 绑定与 fallback 语义）是 Fix Extension 拥有的业务逻辑 | 仍在通用 `packages/workflow-runtime` 的 `pi-sdk-worker.ts`（per-kind schema 本体已由 contracts 单一定义表派生并导出，但 `submissionContract` 文本与 schema 绑定/fallback 的消费点仍在 shared Runtime） | 后续迭代：与 Fix 门禁 owner 重构同一专项，将 `submissionContract`/节点绑定迁回 `packages/fix` 或改为 WorkflowDefinition 显式 hook；当前如实记录 owner drift，不声称已迁回 | 第一版（待重构；与 Fix 门禁同一重构专项） |
| Feature 有 L1 产品规范 | 尚无 Feature package 或 Workflow Definition | 实现前先以 L1 规范作为输入完成 L2 设计 | Feature 专项（非 Fix 第一版；启动前应先完成 Fix owner 重构） |
| 执行中统一对话协作：原对话补充、当前 Worker 展示、Child picker、close fence 和后续 Worker 继承 | `LiveFixRunManager`、`ActiveWorkerRegistry`、`WorkflowInteractionPort`、Run Control WAL、`LiveWorkerEditor` 已实现；participant 恢复已修复为 Artifact + review cursor + 清除 active attempt 的单 checkpoint 提交；no-file orphan 仅在 header 明确无 parent file、原路径不可发现、同 cwd 且 UI 明确确认时允许不同新 Session ID rebind。`/fix review` 仍保留为等待/诊断兼容入口 | 上轮已锁定 Pi `0.84.2`，provider CLI smoke 成功；本轮自动化补了 participant 边界故障注入、no-file 不同 Session ID 和 Focus/CURSOR_MARKER。长时 TUI/PTY picker E2E、真实进程崩溃回放仍未做，不能把 smoke 或自动化等同于完整生产 E2E | 第一版（机制已实现，运营验证未完成） |
| Context / Capability Isolation 分层治理 | 当前主要是 Session、tools、skills scope | 继续验证文件系统、网络和 shell 的真实边界 | 持续验证 |
| L1 指标收敛为 5 步公开漏斗（第一版），完整指标体系与完整事件表已声明归档 | `fix-runtime-technical-design.md` §7.1–7.6 仍以目标设计承载已归档的完整指标体系（完整事件枚举、质量指标、自动化准入），与 §7.7（第一版公共漏斗）并存；5 步漏斗与公开 API 已在 `feat/fix-metrics-cloudflare` 分支（独立 worktree）实现，待合入；原归档件《2026-08-28-fix-automation-evolution-metrics.md》在本地清理中丢失、未进入 Git 历史，内容留存于 L2 §7.1–7.6 | 第一版（文档）：§7.1–7.6 标注为已归档目标或裁剪至重写归档件（以 L2 内容为基础），仅 §7.7 为第一版活跃目标设计；metrics 分支合入后更新实现状态 | 第一版（文档 + 分支合入） |

在这些差距关闭前，README 或报告不得把 Feature 完整流程或完整隔离声称为已实现。`/fix` v2 流水线已实现，遗留差距见下方「设计文档与实现的当前偏差」。

## 设计文档与实现的当前偏差

以下为 L2 技术设计（`fix-runtime-technical-design.md`）与当前实现事实的偏差，已记录、不再静默补平：

| 设计文档承诺 | 当前实现事实 |
| --- | --- |
| `FixAuditEvent<TType, TPayload>` 双泛型 | 实现为单泛型 `FixAuditEvent<T = Record<string, unknown>>`（类型层简化，事件结构字段一致） |
| 审计事件流（§7.2 的 16 个事件类型，其中 `resolution_completed` 仅存在于 §7.2 设计、未入 contracts 枚举） | 9 个类型有 emit 点（17 处 `recordEvent` 调用）：`run_started`、`artifact_submitted`、`artifact_rejected`、`investigation_review_completed`、`change_plan_review_completed`、`change_review_completed`（runReview 按 reviewArtifactKind 派生——change_review / change_plan_review 不再混入 investigation 类型，见 fix-runtime-technical-design.md §7.1）、`human_review_decided`、`run_accepted`、`run_rework`（返工回流专用，返工 emit 点见 `decideCore` 的 request_changes/reject/continue_* 路径）；contracts 剩余 6 个（`disposition_completed`、`implementation_created`、`verification_completed`、`run_reopened`、`run_rolled_back`、`post_acceptance_issue_confirmed`）尚无 emit 点（`run_reopened` 留给后验收 reopen 专项，其余预留枚举）。Fix 扩展在 continueRun 与 applyReviewDecision 两条生产路径创建 `auditSink` 并桥接 `host.appendEntry('workflow-audit', event)`（写失败不阻塞业务）；事件在真实流水中是否落盘取决于 host 订阅，操作可见性与回放仍以 `workflow-*` entries（trace/model-policy/node-failure/blocker/decision-pending/fix-report）承担 |
| fix 特有审计事件类型与 `workflowId: "fix"` 默认值定义于共享 `packages/workflow-contracts` | 按设计文档逐字转写（设计如此），属已知取舍 |
| 旧 `validSkills` 允许空数组 | 新 `parseProjectWorkflowPolicy` 将显式 `skills: []` 判为非法（与 legacy 语义差异） |

## 命名迁移

本次 0.x 产品收敛将历史 `bugFix` 命名统一为 Fix：package、目录、命令、公开 Runtime 符号、trace、run 前缀和 Artifact fallback 都使用 `fix`。

- 新入口只注册 `/fix`；不继续注册旧命令，避免产品存在两套入口。
- package/API 改名属于 0.x breaking change；外部消费者必须迁移到 `@pi/fix`（导出 `fixDefinitionV2`）和 `@pi/workflow-runtime`（导出 `fixNodes`）；历史 `fixDefinition` 产品导出已移除（仅存测试 fixture）。
- Run Store 仍可读取旧 `bugFix-` 前缀的未完成 checkpoint，使已有 Run 能通过 `/resume` 继续；新 Run 只写入 `fix-` 前缀。
- 旧 trace 和 checkpoint 作为历史审计事实保留，不回写改名。

## 当前验证证据与未覆盖边界

| 范围 | 当前事实 | 未覆盖 |
| --- | --- | --- |
| 自动化 | `npm test` 已覆盖 participant 单 checkpoint/quorum 恢复、active-branch/no-file parent 恢复、delegated editor focus/CURSOR_MARKER、0.84.2 ExtensionRunner fail-closed lifecycle、prompt/steer 交互重入和 GC fault injection | 自动化不替代长时 TUI、PTY picker 或进程级崩溃/恢复 |
| Provider | 上轮在锁定的 Pi `0.84.2` 上完成 provider CLI smoke；该结果只证明 CLI 接缝可运行 | 长时 TUI/PTY picker E2E 和完整真实 provider 工作流尚未做；默认测试不携带真实凭证，不能据此声称完整 provider E2E |
| TUI | `LiveWorkerEditor` 使用 Pi 0.84.2 keybinding、Focusable 和 cursor marker 合同；无 Worker 时委托原 editor，有 Worker 时只接管模型 picker 键 | 尚无长时间 TUI 稳定性或真实 PTY picker E2E 证据 |

## 验证入口

合并前至少运行：

```bash
npm test
npm run typecheck
git diff --check
```

实现变化后更新最接近行为的测试。若实现与 L1 冲突，必须选择修正实现或重新评审产品契约，并保留明确 drift 记录。
