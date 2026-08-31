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
| `packages/workflow-runtime/src/` | 通用状态机、Pi SDK Worker、Skill scope、session checkpoint、恢复；当前仍承载 Fix 业务执行门禁（review kind 映射、check satisfier、change_plan_review gate） | 有限重试与错误分类已实现；Fix 业务门禁 owner 待拆分（drift） |
| `packages/fix/src/` | `/fix` command、模型策略、UI 决策、报告、traceId 和审计接线 | v2 已实现（8 阶段、独立评审、评审命令、`.pi/workflow.json` 策略）；真实 provider E2E 未完成 |
| `packages/*/test/` | 对应源码的行为和回归证据 | 现有自动测试可运行 |

尚未存在 `packages/feature` 和独立 `workflow-ui` 实现。

## 当前实现边界

- Runtime 通过 Pi SDK 创建独立 `AgentSession` 承载 Worker Session；这隔离对话历史，但不等同于进程、文件系统或 OS sandbox。
- Controller 拥有状态迁移、Artifact 合同校验、有限重试、checkpoint 恢复和 `traceId` 审计；Worker 不能授权下一状态。
- v2 流水线以 `fixDefinitionV2`（8 阶段 `INTAKE`→`INVESTIGATING`→`DISPOSITION`→`IMPLEMENTING`→`VERIFYING`→`WAITING_FOR_USER`→`ACCEPTED`，`BLOCKED` 侧支）驱动：`prepareRun`/`continueRun` 在 `packages/fix/src/extension-v2.ts`，Worker 经 `executeNode` 盖章归档，评审经 `runReview`（quorum + 独立 Worker 身份），人工验收经 `collectDecision` + `evaluateAcceptance` + `decide`，项目级 `.pi/workflow.json` 策略经 `loadEffectivePolicy`，`/fix review` 提供评审命令，`session_start(resume)` 提供恢复。
- 无仓库变更路径（`disposition.requiresRepositoryChange === false`）直接 `DISPOSITION`→`VERIFYING`，不经过 `IMPLEMENTING` 与 `change_review`。
- `IntakeArtifact` 正式字段为 `summary`（一句话摘要）+ `overview`（场景/影响/已知上下文）；原始 `problem` 保留为 Run 级追溯事实（`checkpoint.problem`），不进入报告或人工摘要。旧仅 `phenomenon` 的 checkpoint 视为不完整：契约校验拒绝、验收 marker 不通过、报告显示「尚未确认」，不静默降级。
- 验证失败三向分流：`verification.accepted=false` 必须携带结构化 `failure`（契约强制），按 `failure.kind` 路由 —— `implementation`→回流 `IMPLEMENTING`；`configuration`（无仓库变更的配置问题）→`WAITING_FOR_USER`；`external_condition`→`BLOCKED`（`recordBlocker`，returnStage=VERIFYING）。配置类等待的重新验证出口未定，并入 pendingDecisionKind 专项。
- `BLOCKED` 解锁后，目标阶段 Worker 会执行两次（一次用于解锁过渡，一次为该阶段重跑），属当前规格行为，未做去重。
- `request_changes`/`reject` 决策后主循环按 `fixReasonToStage` 自动回流对应阶段并继续推进，直至再次进入 `WAITING_FOR_USER` 或 `ACCEPTED`；resume 到 `WAITING_FOR_USER` 时仍收集人工选择，不自动通过验收。
- 无 UI 或用户取消时，Run 停留在 `WAITING_FOR_USER`（可 `/fix review` 或 `/resume`）或 `BLOCKED`（`/resume` 后重新输入补充信息）。
- SDK custom tool 与严格 fenced JSON fallback 都经过同一 Artifact 校验入口。
- 单个 Worker Session 最多两次交付尝试；失败后 Controller 最多创建一个新 Session 重跑当前 Node，仍失败则保留 checkpoint 并提示 `/resume`。
- 项目可以按 Node 配置模型和 Skill；Skill 不扩大工具 allowlist。
- 主窗口 trace 与持久化 entry 通过稳定 `traceId` 关联。

## 已知 L1 / L2 Drift

以下差异是已报告的当前事实，不应通过文档措辞掩盖：

| L1 目标契约 | L2 当前事实 | 处理方向 |
| --- | --- | --- |
| Fix 业务验收标准（review kind 映射、`root_cause_alignment` 等 check 语义、`DISPOSITION→IMPLEMENTING` 的 change_plan_review 门禁）由 Fix Extension 拥有，Core Runtime 不拥有 | 执行门禁当前仍在 `packages/workflow-runtime`（`BUSINESS_ARTIFACT_KINDS`/`NODE_KIND_BY_NODE_ID`/`REVIEWED_KIND_BY_REVIEW_KIND`/`REVIEW_CHECK_SATISFIERS`/`assertChangePlanReviewGate` 等），legacy `fixNodes` 三节点构造器也仍由其导出；仅状态图/边/约束在 `packages/fix/src/definition.ts` | 后续迭代：将 Fix 门禁改为 WorkflowDefinition 显式通用 hook 或迁回 `packages/fix`；当前如实记录 owner drift，不声称已迁回 |
| 争议可交 Arbiter | 尚未实现 arbiter 角色与争议裁决流程 | 后续迭代：review finding 争议升级、独立仲裁 Worker |
| 最终处置报告使用 L1 固定结构（结论 4 字段 / 现象确认 / T0–T4 因果时间线 / 已排除候选 / 证据缺口 / 影响链 / 处置范围 / 已执行命令 / 风险与后续） | 当前 `buildFixReport` 为简化 8 节投影（结论/现象/根因/影响面/处置/修改/验证/引用），缺 L1 模板的预期-实际-确认结果、时间线表、已排除候选、证据缺口、影响链、处置范围、已执行命令与“需要你决定或协助”；且“状态”硬编码为「已解决（验收通过）」，未区分可允许的「已缓解 / 无需修改」。根因：`investigation`/`verification`/`disposition` 合同字段不足（无时间线、预期-实际、候选排除等） | 后续迭代：扩充 Artifact 字段并重写报告渲染；当前已满足“由已校验 Artifact 投影、非 Worker 自由文本”的最小要求 |
| `disposition -.-> 需要用户或外部决定 -> WAITING_FOR_USER`（L1 虚线边） | `dispositionType` 预留 `wait_decision`/`external_action`，但 guard 无 `DISPOSITION->WAITING_FOR_USER` 边，continuation 仅区分 insufficient_evidence→BLOCKED 与 requiresRepositoryChange 分支，`wait_decision` 会直接进 VERIFYING | 后续迭代：补边与分支，将需人工/外部决定的处置路由到 WAITING_FOR_USER |
| `verification -.-> 缺少验证条件 -> BLOCKED`（L1 虚线边） | 已实现三向分流：`verification.accepted=false` 按 `failure.kind` 路由 —— `implementation`→回流 `IMPLEMENTING`；`configuration`→`WAITING_FOR_USER`（无仓库变更的配置问题不回 IMPLEMENTING）；`external_condition`→`BLOCKED`（`recordBlocker`，returnStage=VERIFYING）。契约违规仍为重试→暂停。契约层强制 `accepted=false` 必须携带结构化 `failure`（`MISSING_VERIFICATION_FAILURE`），杜绝静默回流 | 配置类等待的重新验证出口未定，并入 pendingDecisionKind 专项 |
| 修改方案改变正式需求/技术方案/架构决策/验收标准时，CHANGE_PLAN_REVIEW 必须升级为 Core 正式方案流程（Proposal→Independent Review→Adoption） | `disposition.requiresFormalPlanReview` 字段已预留，但 continuation 未检查该标志，无升级分支 | 后续迭代：接线 requiresFormalPlanReview 的升级路径 |
| `run_reopened` 触发时机 = ACCEPTED 后发现问题重新打开；`run_rolled_back`/`post_acceptance_issue_confirmed` 在后验收阶段使用 | 当前 `run_reopened` 在 request-changes/reject 回流时发出（返工语义，与 L1 定义偏差）；`run_rolled_back` 与 `post_acceptance_issue_confirmed` 无 emit 点；无 ACCEPTED 后 reopen/rollback 命令。当前没有统一 Bug 记录和后验收观察基础 | 延后到复盘/运营专项；不阻塞当前 Fix 修复、验证和人工验收主流程 |
| 未覆盖项可“明确披露且不影响接受决定”时允许通过 | `FIX_VERIFICATION_REQUIREMENT.allowUnverified: false`，存在 unverified 即拒绝（更保守；策略可配置） | 保持保守默认，如需放宽按风险等级调整策略 |
| Feature 有 L1 产品规范 | 尚无 Feature package 或 Workflow Definition | 实现前先以 L1 规范作为输入完成 L2 设计 |
| Context / Capability Isolation 分层治理 | 当前主要是 Session、tools、skills scope | 继续验证文件系统、网络和 shell 的真实边界 |

在这些差距关闭前，README 或报告不得把 Feature 完整流程或完整隔离声称为已实现。`/fix` v2 流水线已实现，遗留差距见下方「设计文档与实现的当前偏差」。

## 设计文档与实现的当前偏差

以下为 L2 技术设计（`fix-runtime-technical-design.md`）与当前实现事实的偏差，已记录、不再静默补平：

| 设计文档承诺 | 当前实现事实 |
| --- | --- |
| `FixAuditEvent<TType, TPayload>` 双泛型 | 实现为单泛型 `FixAuditEvent<T = Record<string, unknown>>`（类型层简化，事件结构字段一致） |
| 审计事件流（§7.2 的 14 个事件类型） | 9 个类型有 emit 点（14 处调用）：`run_started`、`artifact_submitted`、`artifact_rejected`、`investigation_review_completed`、`change_plan_review_completed`、`change_review_completed`（runReview 按 reviewArtifactKind 派生——change_review / change_plan_review 不再混入 investigation 类型，见 fix-runtime-technical-design.md §7.1）、`human_review_decided`、`run_accepted`、`run_reopened`；`disposition_completed`、`implementation_created`、`verification_completed`、`run_rolled_back`、`post_acceptance_issue_confirmed` 尚无 emit 点（预留枚举）。Fix 扩展在 continueRun 与 applyReviewDecision 两条生产路径创建 `auditSink` 并桥接 `host.appendEntry('workflow-audit', event)`（写失败不阻塞业务）；事件在真实流水中是否落盘取决于 host 订阅，操作可见性与回放仍以 `workflow-*` entries（trace/model-policy/node-failure/blocker/decision-pending/fix-report）承担 |
| fix 特有审计事件类型与 `workflowId: "fix"` 默认值定义于共享 `packages/workflow-contracts` | 按设计文档逐字转写（设计如此），属已知取舍 |
| 旧 `validSkills` 允许空数组 | 新 `parseProjectWorkflowPolicy` 将显式 `skills: []` 判为非法（与 legacy 语义差异） |

## 命名迁移

本次 0.x 产品收敛将历史 `bugFix` 命名统一为 Fix：package、目录、命令、公开 Runtime 符号、trace、run 前缀和 Artifact fallback 都使用 `fix`。

- 新入口只注册 `/fix`；不继续注册旧命令，避免产品存在两套入口。
- package/API 改名属于 0.x breaking change；外部消费者必须迁移到 `@pi/fix`（导出 `fixDefinitionV2`）和 `@pi/workflow-runtime`（导出 `fixNodes`）；历史 `fixDefinition` 产品导出已移除（仅存测试 fixture）。
- Run Store 仍可读取旧 `bugFix-` 前缀的未完成 checkpoint，使已有 Run 能通过 `/resume` 继续；新 Run 只写入 `fix-` 前缀。
- 旧 trace 和 checkpoint 作为历史审计事实保留，不回写改名。

## 验证入口

合并前至少运行：

```bash
npm test
npm run typecheck
git diff --check
```

实现变化后更新最接近行为的测试。若实现与 L1 冲突，必须选择修正实现或重新评审产品契约，并保留明确 drift 记录。
