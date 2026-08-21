# bugFix Extension

- 状态：真实模型已接线；合同校验、有限重试、checkpoint 恢复和 traceId 审计已实现；真实 provider E2E 仍需持续验证

## 入口与用户交互

用户通过 `/bugFix <问题描述>` 创建新的 bugFix run；未完成 run 使用 Pi 原生 `/resume` 恢复。用户确认和补充信息发生在主 Pi Session，由 Controller 记录、交接和审计。

当前实现中，Worker 提交 `BLOCKED` 后，Controller 可以从主 UI 收集补充信息，并在新的 investigate Worker Session 中通过 Context Capsule 继续调查；`WAITING_FOR_USER` 使用主 UI 确认。

> TODO：支持在 Worker 仍运行时接收并向当前 Worker 注入用户补充信息，而不必等待该 Worker 结束或创建新 Session。该能力用于研发实现过程中向产品澄清需求、向环境/权限负责人确认外部事实，或处理其他需要人工实时补充上下文的情形。该交互必须经 Controller 审计，记录提问者、问题、回答、目标 Worker、注入时点和后续 Artifact，且不能让外层 Agent 绕过 Workflow 状态机直接推进阶段。

Pi 仅在项目已被信任时读取 `<cwd>/.pi/workflow-models.json`；未信任项目直接使用运行时默认值，不加载项目声明的模型或 skills。文件存在时可按节点覆盖以下运行时默认值；每个 Worker 使用主 Pi Session 传入的 `thinkingLevel`（当前期望为 `high`）：

| 节点 | 默认模型 | 默认 Skill |
| --- | --- | --- |
| investigate | `smartingredients/gpt-5.6-sol` | 无 |
| implement | `smartingredients/gpt-5.6-terra` | `tdd` |
| verify | `smartingredients/gpt-5.6-sol` | 无 |

项目配置可对单个节点或默认值进行覆盖。Node 既可使用原有字符串模型引用，也可使用 `{ "model": "provider/model", "skills": ["skill-name"] }` 对象；创建独立 Worker Session 时只注入该 Node 显式列出的 skills，未列出的全局 skill 不会继承。未知 skill 在创建 session 前失败。skill 只提供调查方法和输出规范，不会自动扩大 tools allowlist 或获得 `bash`、数据库、Redis、SLS 的权限。每个命令、session resume 和每个 node 都写审计，记录模型、skills 与 tools；策略错误或模型解析失败在模型调用前显式失败。

## 当前技术方案

### 职责边界

`/bugFix` 是通用的 Bug 工作流骨架，不内置微信、前端、后端、数据库或任一仓库的排查规则。它稳定地提供调查、实现、验证、用户确认、恢复和交付的阶段边界。

| 层 | 负责什么 | 不负责什么 |
| --- | --- | --- |
| bugFix Workflow / Runtime | 状态机、Worker 生命周期、工具/skill scope、Artifact 交接、Guard、checkpoint、恢复、trace 和审计 | 具体仓库应该检查哪些模块、什么是领域根因、什么测试覆盖某业务 |
| Skill | 调查/实现/验证方法、领域标准、影响面分析、证据要求、何时应返回 `needs_more_evidence` | 状态推进、工具权限、绕过 Artifact 合同或直接 `ACCEPTED` |
| Project Knowledge / Policy | 当前仓库目录、模块关系、前后端/服务/外部依赖边界、测试命令和领域术语 | 修改通用状态机或扩大 Worker 的实际工具权限 |
| Worker | 按当前 Node 的 Skill、项目知识和工具范围完成工作，并提交事实性 Artifact | 决定下一阶段、把模型结论当作验收事实 |

Skill 决定调查质量，Runtime 决定该调查是否留下可审计交付和是否可以按合同推进。对于参数、跳转、token、分享、回调或接口契约等问题，调查 Skill 应定义上游—处理—下游—外部依赖的影响面闭环；若未闭合，应提交 `needs_more_evidence` 或 `blocked`，不能把部分证据包装成完整本地修复。

### Controller 与 Worker 边界

Controller 负责确定性状态迁移、Artifact 合同校验、Transition Guard、checkpoint、用户确认、恢复和最终报告。Worker 只负责当前 Node 的调查、实现或验证工作，不能指定下一状态，也不能直接声明 `ACCEPTED`。

Worker 的模型输出不是状态机事实。只有通过 Runtime 合同校验的 Artifact 才能作为阶段交付；普通自然语言不能推进 workflow。

### Artifact 合同

| Node | 必填交付 | 典型拒绝码 |
| --- | --- | --- |
| `investigate` | 合法 `route`、非空 `rootCause`、非空 `evidence` | `INVALID_INVESTIGATION_ROUTE`、`MISSING_ROOT_CAUSE`、`MISSING_INVESTIGATION_EVIDENCE` |
| `implement` | `summary`、非空 `filesChanged`、`candidateRevision` | `MISSING_IMPLEMENTATION_DETAILS`、`MISSING_IMPLEMENTATION_SUMMARY`、`MISSING_FILES_CHANGED`、`MISSING_CANDIDATE_REVISION` |
| `verify` | `accepted`、非空 `evidence`、被验证的 `candidateRevision` | `MISSING_VERIFICATION_DECISION`、`MISSING_VERIFICATION_EVIDENCE`、`MISSING_VERIFICATION_REVISION` |

`submit_artifact` 的工具提交和严格的 `bugfix-artifact` fenced JSON fallback 都使用同一套 `validateSubmitArtifact()`，不能通过宽松的 `artifact:any` 绕过合同。fallback 仅在没有成功工具提交时尝试，普通文本、多个 JSON block 或不合法 JSON 均拒绝。

### 有限重试与恢复

单个 Worker session 最多执行两次 Artifact 交付尝试：第一次执行 Node 任务，第二次发送 completion-only 纠正指令。两次仍失败时，Controller 最多再创建一个独立 Worker session 重跑同一 Node；不使用无限 prompt loop。

失败不会伪造完成：Controller 写入 `workflow-node-failure`，保留当前阶段 checkpoint，并通过主 Pi UI 提示使用原生 `/resume`。前序已验证 Artifact 会写入 checkpoint，恢复后继续使用同一 Context Capsule。模型响应异常会区分 `MODEL_RESPONSE_ERROR`、`MODEL_RESPONSE_TRUNCATED` 和 `ARTIFACT_NOT_SUBMITTED`。

### Trace 与审计

每个 run 使用同一个公开 `traceId`（同时也是 `runId`）。主窗口显示的 `bugFix-trace`、持久化的 `workflow-trace`、`workflow-command`、`workflow-model-policy`、`workflow-node-failure` 和 `workflow-run` 都带该 ID。trace 会记录阶段、模型、skills、工具 start/end、Artifact attempt、模型 stop reason、错误摘要和恢复动作；错误摘要限制长度，不复制完整问题或隐藏 reasoning。

审计目标不只是在回放模型是否提交了 Artifact，也要能复盘 Skill 定义的调查范围是否被覆盖：已检查的范围和文件、提交的证据、明确未验证项、Artifact 合同/Guard 的接受或拒绝理由。模型的自然语言“已检查”不是证据；实际工具事件和结构化 Artifact 才是审计输入。

### Acceptance 边界

实现 Artifact 只能说明候选修改已交付，不能单独证明修复正确。最终 `ACCEPTED` 必须仍由验证 Artifact 和 Transition Guard 决定。当前实现不使用“文件变更数量”或工作区 diff 大小推断修复质量。

## 当前边界

问题摘要在 workflow checkpoint 中持续保留并用于 Pi session resume，审计 entry 不复制问题全文。项目级 `.pi/workflow-models.json` 可按 Node 覆盖模型和 skills；具体项目策略不提交到本仓库。

- 上游：[仓库组织方案](../../03-项目落地/仓库组织.md)、[Extension 集合目录](../../03-项目落地/扩展目录.md)

## 设计章节

1. 目标和边界
2. Command / Tool / Event
3. 内部节点、确定性状态机和 Transition Guard
4. 主 agent、Controller 与 Worker Runtime
5. skill routing 和 context isolation
6. Artifact、主 Pi Session 和记忆交接
7. 冻结的 Acceptance Criteria
8. review、rebuttal、arbiter
9. verification 和 `ACCEPTED` 计算
10. 失败、取消、重试、`BLOCKED` 和安全边界
11. 候选技术方案和最终决策
