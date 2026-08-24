# Feature Extension 产品规范

- 状态：`DECIDED`
- 层级：第一层（L1 Extension）
- 入口：`/feature <新能力或目标描述>`
- 上游：[Core 产品定义](../领域术语.md)

## 1. 目标与边界

Feature 用于建设尚不存在的新产品能力。它从目标确认开始，按任务需要完成需求定义、正式方案评审、实现、变更 Review、验证和最终验收。

Feature 不等于“固定的长流程”。只有当目标和产品契约已经存在且未改变时，任务才能采用轻量路径；Guard 必须记录所引用的既有契约版本。Run 级验证条件只是对既有验收契约的实例化，不等于改变正式验收标准。新增或改变产品行为、公共契约、兼容边界、架构约束或正式 Acceptance Definition 时，必须经过提案与独立评审。所有跳过决定都必须由 Guard 根据可审计事实作出，不能由 Worker 口头宣布。

已有系统中观察到的异常、回归或维护问题由 [Fix](fix-扩展.md) 承载。调查过程中若确认目标是新增或改变产品能力，可以经用户或已定义路由创建/转入 Feature，但原 Fix 的证据和决定必须以 Artifact 交接。

## 2. 输入与完成语义

最小输入是用户希望获得的新能力或目标。信息不足时，Run 可以先调查现状和约束；会实质改变目标、范围、风险或验收的歧义必须等待用户决定。

Feature 只有在以下事实整体成立时才算完成：

- 目标、范围和验收标准已经明确；
- 产生或改变的正式方案已完成独立交叉评审并形成采纳决定；
- 最终候选版本与已采纳需求和方案一致；
- 必需 Review Finding 已正式关闭；
- 目标场景、关键影响面和回归边界已有验证证据；
- 未验证项和剩余风险已披露，且不阻止接受。

## 3. Stage 与允许路径

Feature Workflow Definition 应支持以下产品阶段语义；具体状态 ID、Transition 配置和实现属于 L2。

```text
INTAKE → DISCOVERY → REQUIREMENT_PROPOSAL
                            ↓
                    REQUIREMENT_REVIEW
                      ↓            ↑
              RESPONSE / REVISION ─┘
                            ↓ adoption
                    TECHNICAL_PROPOSAL
                            ↓
                     TECHNICAL_REVIEW
                      ↓            ↑
              RESPONSE / REVISION ─┘
                            ↓ adoption
IMPLEMENTATION → CHANGE_REVIEW → VERIFICATION → ACCEPTED
      ↑                 ↓               ↓
      └──── required finding / failed verification
                            ↓
                         BLOCKED
```

阶段含义：

| Stage | 产品目的 | 典型 Artifact |
| --- | --- | --- |
| `INTAKE` | 确认入口、目标和最小输入 | intake record |
| `DISCOVERY` | 了解现状、约束、影响面和未知项 | discovery report |
| `REQUIREMENT_PROPOSAL` | 定义正式需求、范围和验收标准 | requirement proposal |
| `REQUIREMENT_REVIEW` | 独立评审需求方案 | review findings、response、adoption decision |
| `TECHNICAL_PROPOSAL` | 定义需要正式采纳的技术方案 | technical proposal |
| `TECHNICAL_REVIEW` | 独立评审技术方案 | review findings、response、adoption decision |
| `IMPLEMENTATION` | 形成绑定基准与候选版本的变更 | implementation artifact |
| `CHANGE_REVIEW` | 对固定候选版本进行 Review | review findings、dispositions |
| `VERIFICATION` | 验证目标、影响面和回归边界 | verification artifact |
| `BLOCKED` | 缺少必要事实、权限或决定 | blocker record |
| `ACCEPTED` | 整体满足 Acceptance Definition | acceptance result |

允许的轻量路径示例：

```text
既有目标与产品契约未改变：
INTAKE → DISCOVERY → [轻量路径 Guard：引用既有契约版本]
→ IMPLEMENTATION → CHANGE_REVIEW → VERIFICATION → ACCEPTED
```

是否跳过 Requirement 或 Technical Proposal/Review，必须由对应 Guard 记录判断依据。只要产出或改变正式需求、技术方案、架构决策或验收标准，就必须执行 Core 的跨入口正式方案评审规则。

## 4. Node 与 Role

同一 Stage 可以执行多个 Node；同一个 Node Definition 可以因并行提案、独立复核或有限重试产生多次 Node Execution。

Feature 可按需要使用以下 Node 类型和 Role：

| 工作 | 典型 Role | 主要输出 |
| --- | --- | --- |
| 现状与约束调查 | `investigator` | discovery artifact |
| 需求提议 | `requirement_proposer` | requirement proposal |
| 技术方案提议 | `architect` | technical proposal |
| 独立挑战 | `challenger` / `reviewer` | findings |
| 实现 | `implementer` | candidate revision / diff artifact |
| 变更 Review | `reviewer` | revision-bound findings |
| 验证 | `verifier` | verification evidence |
| 争议裁决 | `arbiter` | arbitration decision |

每个 Worker Session 只承担一个 Node；跨 Node 只通过经校验的 Artifact 交接。

## 5. Artifact 与 Guard

Feature 至少应能形成以下 Artifact 类型，实际 schema 属于 L2：

- intake / discovery；
- requirement proposal；
- technical proposal；
- independent review findings；
- proposer response 与 adoption decision；
- implementation / candidate revision；
- change review finding 与 disposition；
- verification；
- blocker、user decision 与 acceptance result。

关键 Guard 语义：

- 目标或验收存在实质歧义时，不得进入实现；
- 正式方案未独立评审、必需方案 Finding 未正式关闭或未形成采纳决定时，不得作为实现依据；
- `reviewedProposalRevision` 必须等于 `adoptedProposalRevision`，Adoption Decision 必须引用被接受的 Review Artifact 集合；
- 影响结论、范围、风险或验收标准的提案修改会使旧采纳失效并返回 Review；
- 实现 Artifact 必须绑定基准和候选版本；
- Change Review 与 Verification 必须绑定同一最终候选版本；
- 必需 Finding 未关闭时，不得进入 `ACCEPTED`；
- 验证未覆盖目标场景或关键影响面时，不得声称完整完成；
- `blocked`、超预算或缺少必要用户决定时必须暂停推进。

## 6. 用户决策点

以下情况必须等待用户决定，除非已存在明确且版本化的项目策略：

- 多个目标解释会导致不同产品行为；
- 范围、兼容性、安全或成本取舍超出既有契约；
- 需要接受未验证的关键边界或剩余风险；
- 方案争议无法在规定评审轮次内基于证据收敛；
- 需要显著扩大用户授权的修改范围。

用户决定必须进入原 Workflow Run，形成可审计记录，并被后续 Guard 引用。

## 7. Acceptance Definition

进入 `ACCEPTED` 前至少检查：

```text
目标与验收标准已冻结
必要正式方案已评审并采纳
最终候选版本唯一且可追溯
必需 Findings 已正式关闭
目标场景验证通过
关键影响面与回归边界已有证据
未验证项、剩余风险和用户决定已记录
```

单个 Node 成功、实现完成或 Reviewer 口头通过，都不能替代整体 Acceptance Result。

## 8. 非目标与 L2 交接

本规范不定义模型名称、Policy 合并优先级、具体工具/Skill 列表、状态枚举代码、Guard 表达式、Artifact JSON Schema、Worker 创建方式、存储接口或测试实现。这些属于 L2 的可执行 Feature Workflow Definition 和源码。

Feature 必须复用 Core 的 Artifact、隔离、正式方案评审、Finding/Disposition、Arbiter 与 Audit 规则，不在本文件复制另一套通用治理定义。
