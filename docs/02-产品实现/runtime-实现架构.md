# Runtime 实现架构

- 层级：第二层（L2）
- 状态：`IMPLEMENTING`；本文同时标明目标机制与当前实现差距
- 上游：[L1 Core 产品定义](../01-产品定义/领域术语.md)、[Feature 规范](../01-产品定义/扩展/feature-扩展.md)、[Fix 规范](../01-产品定义/扩展/fix-扩展.md)

## 1. L2 职责

L2 把 L1 的产品保证落实为可执行结构，包括：

```text
Workflow Definition 数据结构
Stage 枚举与 Transition 图
Policy 解析与 Worker Profile
Context Capsule 构造
Artifact schema 与校验
Transition Guard 与 Acceptance 计算
Worker Session 生命周期与有限重试
Run Store、checkpoint、恢复、Trace 与 Audit
```

L2 可以改变实现方式，但不能在未经 L1 评审的情况下改变产品完成语义、角色独立性、状态权限或安全承诺。

## 2. Package 责任

```text
顶层 Feature / Fix package
├── 注册用户命令和 UI 接线
├── 提供自己的可执行 Workflow Definition
└── 调用 workflow-runtime

workflow-runtime
├── Controller / transition / guard execution
├── Worker executor / retry / decision gate
├── checkpoint / restore / trace
└── 调用 workflow-contracts

workflow-contracts
└── Run、Stage、Node、Policy、Capsule、Artifact 与 schema 接口
```

顶层 Extension 拥有业务 Workflow Definition；共享 Runtime 不应内置 Feature/Fix 的具体状态图或验收标准。

当前原型仍将 `fixDefinition` 放在 `workflow-runtime` 中，这是待拆分的 L1/L2 owner drift，见[实现地图](README.md#已知-l1--l2-drift)。

## 3. 目标可执行 Definition 边界

以下是 L1 向 L2 交接的目标接口，不代表当前 contracts 已全部实现；当前缺口以[实现地图的 drift 表](README.md#已知-l1--l2-drift)为准。字段名称可以随实现演进：

```ts
type WorkflowDefinition = {
  id: string;
  initialStage: string;
  nodes: Record<string, WorkflowNodeDefinition>;
  transitions: TransitionDefinition[];
  acceptance: AcceptanceDefinition;
};

type WorkflowNodeDefinition = {
  id: string;
  buildTask(input: NodeInput): Task;
  resolvePolicy(input: NodeInput): Policy;
  buildWorkerProfile(input: NodeInput): WorkerProfile;
  buildContextCapsule(input: NodeInput): ContextCapsule;
  artifactContract: ArtifactContract;
};
```

| Extension 可定义 | Runtime 必须强制 |
| --- | --- |
| Task、Role、业务上下文和 Artifact 字段 | Node 不得直接修改 Run Stage |
| Node tools/skills/profile | 不得放宽 Runtime 全局能力上限 |
| Transition 的业务条件 | Guard 未通过不得迁移 |
| Acceptance 证据规则 | Worker 或主 Agent 不得自报 `ACCEPTED` |
| 用户决策条件 | 决策必须记录、恢复并可被 Guard 引用 |

## 4. 目标 Node Execution 生命周期

以下生命周期是 L2 要实现的控制机制；当前原型只覆盖其中一部分：

```text
Controller 选择 Node Definition
→ 解析 Task / Policy / Worker Profile / Context Capsule
→ 创建 Node Execution 与 Worker Session
→ Worker 提交 Artifact
→ schema + provenance + revision 校验
→ 保存 Artifact / attempt / tool facts
→ 执行 Transition Guard
→ 保存 checkpoint 与迁移记录
→ 下一 Node、重试、等待用户、BLOCKED 或 Acceptance
```

有限重试应留在同一个 Node Execution 中并记录 attempt；并行提案、独立 Review 或复核应创建独立 Node Execution，以保持身份和 Artifact 来源清晰。

## 5. 隔离实现

| 控制面 | L2 实现责任 | 不得声称 |
| --- | --- | --- |
| Skill Routing | Resource loader / allowlist / hash / trace | 未发现的 Skill 绝对不可读取 |
| Context Isolation | 最小 Capsule、Artifact 引用、context 清单 | prompt 隔离等于安全隔离 |
| Capability Isolation | 工具白名单、shell wrapper、文件/网络边界、worktree 或容器 | Pi tools 配置本身等于 OS sandbox |

Worker Profile 中的“只读”必须由实际工具和环境能力实现，不能只靠标签或角色 prompt。

## 6. 目标状态、存储与用户决定

以下为目标机制；当前恢复主要校验已知 Stage，版本兼容性仍在 drift 中：

- `transition()` 只有在 Guard 通过后才能改变内存 Run 状态。
- checkpoint 保存的是已校验状态，不负责自行解释或迁移 Stage。
- `WAITING_FOR_USER` 必须保存待决问题、可选项、来源 Artifact 和恢复位置。
- 用户选择形成 User Decision Artifact，回到原 Run 后由 Guard 消费。
- reload/resume 必须从最后一个合法 checkpoint 恢复，并校验 Workflow/Policy/schema 版本兼容性。

## 7. 目标 Artifact 与审计实现

以下为目标机制；完整 provenance、Node Execution 身份和版本绑定尚未实现：

Artifact 校验至少覆盖：类型/schema、`runId`、`nodeExecutionId`、`workerId`、基准/候选版本、证据引用和必要字段。Review 与 Verification 必须绑定固定候选版本。

Audit 记录实际事件，不推断未发生的工作：Skill 声明的“应检查”不能替代工具事件或 Artifact 中的检查证据。Worker 不可任意改写 Artifact、Guard Record、Acceptance Result 或历史 Audit。

## 8. 当前实现选择

当前 Worker 由 Pi SDK 独立 `AgentSession` 承载；状态、合同、重试和恢复机制见 [Fix Runtime 技术设计](fix-runtime-technical-design.md)。是否升级为子进程、RPC、容器或独立 Node Extension，应根据进程隔离、独立凭证/依赖、生命周期和发布需求另行评审。
