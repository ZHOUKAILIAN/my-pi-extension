# Runtime 实现架构

- 层级：第二层（L2）
- 状态：`IMPLEMENTING`；本文同时标明目标机制与当前实现差距
- 上游：[L1 Core 产品定义](../01-产品定义/领域术语.md)、[Feature 规范](../01-产品定义/扩展/feature-扩展.md)、[Fix 规范](../01-产品定义/扩展/fix-扩展.md)

## 结论先行

| 问题 | 回答 |
| --- | --- |
| Runtime 是什么 | 通用 Workflow 执行内核：状态机、Worker 执行、Artifact 校验、Guard、恢复与审计 |
| 谁拥有业务流程 | 各 Extension（Feature / Fix）拥有自己的 Workflow Definition 与验收标准；共享 Runtime 不内置业务状态图或验收标准 |
| 不可绕过的控制面 | Worker 不修改 Run 状态；Guard 未通过不迁移；任何一方不得自报 `ACCEPTED`；用户决定必须可记录、可恢复、可被 Guard 引用 |
| Extension 能定义什么 | Task、Role、业务上下文、Artifact 字段、Transition 业务条件、Acceptance 证据规则；不能放宽 Runtime 强制项与全局能力上限 |
| 当前状态 | `IMPLEMENTING`；Fix 业务执行门禁 owner 仍在 `workflow-runtime` 待拆分，缺口以[实现地图 drift 表](README.md#已知-l1--l2-drift)为准 |

## 职责总览

L2 把 L1 的产品保证落实为可执行结构：

| 控制面 | 职责 |
| --- | --- |
| 流程定义 | Workflow Definition 数据结构；Stage 枚举与 Transition 图 |
| 执行 | Policy 解析与 Worker Profile；Context Capsule 构造；Worker Session 生命周期与有限重试 |
| 质量门禁 | Artifact schema 与校验；Transition Guard 与 Acceptance 计算 |
| 持久化与可观测 | Run Store、checkpoint、恢复、Trace 与 Audit |

L2 可以改变实现方式，但不能在未经 L1 评审的情况下改变产品完成语义、角色独立性、状态权限或安全承诺。

## Package 责任

```mermaid
flowchart TD
  ext["顶层 Feature / Fix package<br/>注册用户命令和 UI 接线<br/>提供自己的可执行 Workflow Definition"]
  runtime["workflow-runtime<br/>Controller / transition / guard execution<br/>Worker executor / retry / decision gate<br/>checkpoint / restore / trace"]
  contracts["workflow-contracts<br/>Run、Stage、Node、Policy、Capsule<br/>Artifact 与 schema 接口"]

  ext -->|调用| runtime
  runtime -->|调用| contracts
```

| Package | 责任 | 不承载 |
| --- | --- | --- |
| 顶层 Feature / Fix package | 注册用户命令和 UI 接线；提供自己的可执行 Workflow Definition；调用 workflow-runtime | —— |
| workflow-runtime | Controller / transition / guard execution；Worker executor / retry / decision gate；checkpoint / restore / trace | Feature/Fix 的具体状态图或验收标准 |
| workflow-contracts | Run、Stage、Node、Policy、Capsule、Artifact 与 schema 接口 | 执行逻辑 |

当前 owner drift：Fix 业务执行门禁（review kind 映射、check satisfier、change_plan_review gate）与 legacy `fixNodes` 三节点构造器仍放在 `workflow-runtime`；`fixDefinition` 已移出产品源码（仅存 `test/fixtures/legacy-fix-definition.ts`）。详见[实现地图](README.md#已知-l1--l2-drift)。

## Workflow Definition 边界

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

## Node Execution 生命周期

以下生命周期是 L2 要实现的控制机制；当前原型只覆盖其中一部分：

```mermaid
flowchart TD
  select["Controller 选择 Node Definition"] --> resolve["解析 Task / Policy / Worker Profile / Context Capsule"]
  resolve --> create["创建 Node Execution 与 Worker Session"]
  create --> submit["Worker 提交 Artifact"]
  submit --> validate["schema + provenance + revision 校验"]
  validate --> save["保存 Artifact / attempt / tool facts"]
  save --> guard["执行 Transition Guard"]
  guard --> checkpoint["保存 checkpoint 与迁移记录"]
  checkpoint --> next["下一 Node / 重试 / 等待用户 / BLOCKED / Acceptance"]
```

| 场景 | 处理方式 |
| --- | --- |
| 有限重试 | 留在同一个 Node Execution 中并记录 attempt |
| 并行提案、独立 Review 或复核 | 创建独立 Node Execution，以保持身份和 Artifact 来源清晰 |

## 隔离实现

| 控制面 | L2 实现责任 | 不得声称 |
| --- | --- | --- |
| Skill Routing | Resource loader / allowlist / hash / trace | 未发现的 Skill 绝对不可读取 |
| Context Isolation | 最小 Capsule、Artifact 引用、context 清单 | prompt 隔离等于安全隔离 |
| Capability Isolation | 工具白名单、shell wrapper、文件/网络边界、worktree 或容器 | Pi tools 配置本身等于 OS sandbox |

Worker Profile 中的「只读」必须由实际工具和环境能力实现，不能只靠标签或角色 prompt。

## 状态、存储与用户决定

以下为目标机制；当前恢复主要校验已知 Stage，版本兼容性仍在 drift 中：

| 机制 | 规则 |
| --- | --- |
| 状态迁移 | `transition()` 只有在 Guard 通过后才能改变内存 Run 状态 |
| checkpoint | 保存的是已校验状态，不负责自行解释或迁移 Stage |
| 等待用户 | `WAITING_FOR_USER` 必须保存待决问题、可选项、来源 Artifact 和恢复位置 |
| 用户决定 | 用户选择形成 User Decision Artifact，回到原 Run 后由 Guard 消费 |
| 恢复 | reload/resume 必须从最后一个合法 checkpoint 恢复，并校验 Workflow/Policy/schema 版本兼容性 |

```mermaid
flowchart LR
  wait["Run 到达 WAITING_FOR_USER"] --> pending["保存待决问题 / 可选项 / 来源 Artifact / 恢复位置"]
  pending --> action["用户选择 → UserAction（UI 请求）"]
  action --> controller["Controller 校验 Guard / 版本 / 权限"]
  controller --> decision["生成 User Decision Artifact 与 Transition Record"]
  decision --> consume["回到原 Run，由 Guard 消费"]
```

## Artifact 与审计

以下为目标机制；完整 provenance、Node Execution 身份和版本绑定尚未实现：

| 校验维度 | 说明 |
| --- | --- |
| 类型 / schema | Artifact 结构与必要字段 |
| 身份绑定 | `runId`、`nodeExecutionId`、`workerId` |
| 版本绑定 | 基准 / 候选版本；Review 与 Verification 必须绑定固定候选版本 |
| 证据引用 | evidence 必须指向真实工具事件或 Artifact 中的检查证据 |

| 审计规则 | 说明 |
| --- | --- |
| 记录实际事件 | Audit 记录实际事件，不推断未发生的工作；Skill 声明的「应检查」不能替代工具事件或 Artifact 中的检查证据 |
| 不可改写 | Worker 不可任意改写 Artifact、Guard Record、Acceptance Result 或历史 Audit |

## 人友好交互实现

以下为所有 Workflow Extension 共用的 L2 交互约束；它们实现 L1 Core 的人友好化原则，不改变 Extension 自己的业务流程或 Acceptance Definition。

### 交互适配层

```mermaid
flowchart TD
  ext["Extension 产生业务结果 / 待用户决定"] --> adapter["Workflow UI Adapter"]
  adapter --> summary["Summary View：业务摘要"]
  adapter --> detail["Detail View：证据、版本、事件和风险"]
  adapter --> action["Action View：少量业务语言选项"]
  action --> decision["Decision Adapter：交给 Controller"]
```

| 主体 | 职责边界 |
| --- | --- |
| Extension | 只提供结构化 View Model 和业务语言，不直接拼接 Stage、Transition 或内部状态 |
| Workflow UI Adapter | 负责把 Run、Artifact、Finding、Guard、Acceptance 和指标 Snapshot 转换为用户可理解的摘要 |
| Decision Adapter | 只提交结构化意图，Controller 重新校验当前 Run、版本、权限和 Guard 后才改变状态 |
| 技术字段 | `runId`、`nodeExecutionId`、candidate revision、错误码和事件 ID 默认不作为用户输入，作为详情、复制引用或调试信息保留 |
| UI 状态 | UI 不复制 Run 状态、不修改 Artifact/Audit，不在本地形成第二套决定状态 |

### 运行中统一对话适配

该机制是目标 L2 设计，当前尚未实现；当前事实见[实现地图 drift](README.md#已知-l1--l2-drift)。tmux、独立窗口和子终端不属于产品依赖。

```mermaid
flowchart LR
  editor[原对话输入 / 模型选择] --> adapter[Workflow Interaction Adapter]
  adapter --> registry[Active Worker Registry]
  registry --> session[Pi AgentSession]
  session --> events[Session Events]
  events --> adapter
  adapter --> transcript[原对话中的 Worker 输出 / 工具摘要]
  adapter --> supplement[Run 级用户补充记录]
  supplement --> capsule[后续 Context Capsule 引用]
```

| 组件 | 目标责任 |
| --- | --- |
| Active Worker Registry | 以 `runId` / `nodeExecutionId` 定位当前 Worker Session 句柄、状态、实际模型、输入上下文版本和 close fence；不拥有 Run Stage |
| Workflow Interaction Adapter | 把原输入框消息路由为当前 Session 的 `steer` / `prompt`，把当前 subagent picker 的选择路由为绑定 Worker 的模型变化 |
| Event Projection | 订阅模型可见输出和 tool start/update/end，把原文写入受保护 UI sidecar，并以随机 opaque ref生成主对话展示；parent entry不含原文，不伪造隐藏推理 |
| Run Control WAL | 串行持久化补充、close fence、checkpoint 和逐条投递事件；分配 Run 内连续序号，记录目标、模型调用引用和 Artifact 绑定，不用单一水位掩盖失败/跳过 |
| Controller Fence | 原子比较 supplement sequence 与 Node close fence；fence 前的新输入使旧 Artifact 失效，直到新模型调用与绑定最新补充版本的 Artifact 完成 |

输入路由必须遵守单一 owner：第一版同一 UI 最多发布一个可交互 Worker，其他并发 Worker 只投影状态。Controller 先关闭旧目标并写 close fence，再发布新目标；用户提交必须与目标/sequence 分配原子化，fence 后提交返回失败并保留编辑内容，不能因为异步切换自动改写。所有后续 Worker 默认按顺序获得同一 Run 的补充记录；每次 Node Artifact 绑定其实际输入上下文的 `supplementVersion`。

Extension 自有 append-only Run Control WAL 是补充、投递事件、close fence 和 checkpoint 的唯一控制事实；它位于 Pi 本地 agent 状态目录，按 Run 隔离，目录 `0700`、文件 `0600`。每个 Run 还使用Run 目录之外、同一受保护 root `locks/` 下的短持有 operation lock、长持有 writer lease 和单调 `writerEpoch`。每次 append 从取得 operation lock 开始，把 lease/epoch 核验、单条完整 record append 和 file fsync 放在同一跨进程排他临界区，释放后才对调用方确认；takeover 同样先取得该 lock，再原子切换 lease并递增 epoch，因此不存在“核验后、append 前”被接管的窗口。lease 记录 host/process identity、extension instance nonce 和 epoch，每条 WAL record 都携带 epoch。活 owner、旧 reload callback 尚未释放或 owner 无法确定时，恢复/第二 Pi 进程 fail-closed；只有能证明原进程已结束，或用户在 UI 明确确认接管不确定 owner 后，才能隔离旧 lease并接管。追加记录使用稳定 event/supplement ID、checksum、`O_APPEND`，在确认 `recorded` 前完成文件 `fsync`；首次创建/重命名时同步父目录。无法达到该 durability boundary 时输入接收 fail-closed。父 Pi Session 当前 branch 只保存不含原文和内容派生 digest 的随机 opaque ID及粗粒度状态投影；Child Session JSONL 只是执行对话证据，不拥有 Run 状态。

现有未完成 `workflow-run` parent checkpoint 只允许从当前 active branch 幂等导入：临时 WAL generation 完整写入并 fsync、原子 rename及目录 fsync成功前，旧 checkpoint 仍是唯一事实且不得启动 Worker；成功后 WAL header 记录 source entry/checksum，Runtime 只从 WAL 推进，不 dual-write。冲突、未知版本或导入失败 fail-closed。历史 parent entry 不重写且可能被 Pi export/share，但新补充原文/Child 输出不再写入。

Run Control WAL 绑定 `parentSessionId`、开始时的 `parentLeafId` 和 cwd digest。恢复读取完整 WAL，不使用 compaction-aware context；父 Session/branch 存在时校验当前 active branch，父 Session 在首次持久化前崩溃丢失时只允许在同 cwd 经用户确认把未完成 Run 重新绑定到新 Session，并保留原 runId/父引用。投递采用 at-least-once：每条 `supplementId` 在 Worker 上下文中去重；无法证明消费时，只能自动交给同一逻辑 Node Execution 的恢复 attempt并明确展示/审计，跨 Node或待用户决定状态必须保留内容并由用户面向新接收者再次提交。

模型选择由 Workflow UI 自有、无额外命令的 picker 承载，不调用或回滚主 Session 的内建 `/model`。Workflow 自定义 editor 使用注入的 keybindings manager 条件接管 `app.model.select`/cycle：有当前 Worker 时打开 Child picker，无 Worker 时委托原 editor；状态区持续显示当前接收者和 key hint。picker 打开时绑定 `nodeExecutionId`，确认时重新校验目标未变；候选来自 Pi scoped/available 且已认证模型，并由 Runtime 检查当前 Worker 所需工具/schema兼容性。项目 Node `model` 是默认模型，不是第一版候选 allowlist；若未来需要限制集合，必须扩展版本化 Policy schema。Child 注入独立 `SettingsManager.inMemory()`，避免旧 Pi `setModel()` 改写全局默认。

模型选择生命周期为 `requested → pending → applied | not_applied | failed`：`setModel()` 成功只表示待生效；同一 Worker 使用新模型开始下一次模型调用并记录 `effectiveFromModelCallRef` 后才显示“已切换”。Worker 在调用前 close 时记录 `not_applied`，不得带到后续 Node或显示成功。切换不能误改主 Session。

用户补充是运行事实，不是业务 Artifact 或 User Decision。Runtime 可以把它作为版本化 Context Capsule 输入交给 Worker，但 Worker 仍须重新提交满足合同的 Artifact，Controller 仍须执行 Guard 和 Acceptance。

### Pi TUI Review Panel

Pi TUI 适配器使用原生 `ctx.ui.custom()` 和现有组件 `Markdown`、`SelectList`、`Container`、`DynamicBorder`。默认 Review Panel 只展示当前决定所需信息：

```text
Fix / Workflow 结果待确认

发生了什么：<现象和影响>
当前结果：<处置和结论>
验证情况：<已验证内容>
需要注意：<未验证项和剩余风险>

> 接受并完成
  继续处理
  暂不接受
```

| 约束 | 要求 |
| --- | --- |
| 视图 | 默认视图静态、紧凑、宽度自适应；详情通过展开或后续查看动作渐进式呈现 |
| 组件 | 使用 Pi TUI 的换行、截断、主题和焦点机制；每行不超过当前终端宽度 |
| 禁止 | 不手写 ANSI，不实现动画、自动轮播、自定义 spinner 或持续定时刷新 |
| 选择 | 选择项使用业务语言，内部 Stage 和 Transition 由 Controller 根据结构化原因映射 |
| 原因收集 | 「继续处理」和「暂不接受」先选择原因，再按需输入补充说明；取消、关闭和超时不产生同意 |
| 控制面 | TUI 只负责展示和收集选择。决定提交后，Controller 重新校验 `WAITING_FOR_USER`、pending request、当前版本、有效 Artifact 和 Acceptance 条件 |

Review Panel 的通用动作模型：

```ts
type UserAction =
  | { kind: "approve" }
  | { kind: "request_changes"; reasonCode: string; note?: string }
  | { kind: "reject"; reasonCode: string; note?: string };
```

`UserAction` 不是 Run 状态，也不是 User Decision Artifact；它是 UI 到 Controller 的一次请求。只有 Controller 接受并持久化后，才生成 User Decision Artifact 和 Transition Record。

### 非交互模式

RPC、JSON、print、CI 和无 TUI 环境必须提供同等语义的结构化输出：

```json
{
  "runId": "run-001",
  "status": "waiting_for_user",
  "summary": "登录白屏修复已完成自动验证，等待人工确认",
  "availableActions": ["approve", "request_changes", "reject"],
  "currentVersion": "git:abc123",
  "detailsRef": "audit://run-001/acceptance"
}
```

非交互接口可以使用技术字段和机器可读决定值，但不能因为没有 TUI 而绕过 Controller、版本绑定或人工验收策略。普通用户路径不要求记忆这些字段。

### 指标 HTML 看板

指标看板是只读展示层，不是新的控制平面。它读取版本化 Metric Snapshot 或由固定 Audit Event 计算出的 Snapshot，按 Extension 展示统一漏斗和质量指标：

```mermaid
flowchart TD
  ext["选择 Extension"] --> range["选择时间范围 / Bug 类型 / 风险等级"]
  range --> view["查看流程漏斗、质量漏斗、自动化准入状态"]
  view --> drill["展开指标口径、样本量、分子、分母、数据状态和异常原因"]
```

| 边界 | 规则 |
| --- | --- |
| 指标归属 | 每个 Extension 提供自己的 Metric Definition 和漏斗节点；通用看板负责筛选、布局、口径解释和状态展示 |
| 默认展示 | HTML 页面默认显示业务名称、通过数、总数、转换率、趋势和异常原因；`runId`、事件 ID 和原始字段只在详情中展示 |
| 数据状态 | 每个指标都显示 `calculable`、`insufficient_history`、`needs_confirmation` 或 `blocked` 状态，不能把缺失数据渲染为 0% |
| 口径透明 | 页面展示「为什么这个数字是这样」的分子、分母、去重规则、统计窗口、观察窗口、快照时间和数据来源 |
| 只读 | 页面只读，不直接 approve、回退、修改 Run 或写 Audit。用户决定仍回到原 Workflow UI / Controller |
| 首版形态 | 首版优先生成可本地打开的静态 HTML，数据通过内嵌版本化 JSON 或同源只读接口提供；不要求动画和实时刷新 |
| 故障隔离 | 看板渲染失败不影响 Runtime、Run 状态、人工决定或审计写入 |

### 交互验证

L2 测试除验证数据和状态正确外，还应验证：

| 验证项 | 要求 |
| --- | --- |
| 决定可达 | 普通用户无需输入内部 Run/Stage/版本字段即可打开并提交 Review Panel 决定 |
| 非同意安全 | UI 取消、关闭、超时不会生成 approve |
| 过期拒绝 | 过期版本、过期 pending request 和重复决定会被 Controller 拒绝 |
| 布局稳定 | 窄终端、宽终端、长中文文本和长证据不会发生截断、重叠或布局跳动 |
| 语义一致 | 非交互结构化输出与 TUI 展示具有相同的决定语义 |
| 可重算 | HTML 看板的指标数值可由同一组 Audit Event 重算，缺失数据能显示正确状态 |
| 不可绕过 | UI 无法绕过 Guard、Acceptance Definition 或版本绑定 |

## 当前实现选择

所有 host handler 必须把 fail-closed 变成返回值而不是异常：有交互 owner 时，input handler 顶层捕获全部错误、best-effort 恢复原编辑文本并始终返回 `handled`，绝不让补充落入父 Agent；可取消的 `session_before_tree/switch/fork` handler 顶层捕获错误并返回 `{ cancel: true }`。真实 ExtensionRunner 吞异常的行为必须进入故障注入测试。

交互 Registry 以 `(parentSessionId, parentLeafId, runId)` 为 owner key。活跃 Run 期间再次 `/fix` 直接拒绝并显示当前任务；`session_before_tree`、`session_before_switch`、`session_before_fork` 第一版 fail-closed 取消操作，直到 Run settled或已写可恢复 paused checkpoint。`/new`、`/resume` 和 extension command 都不能只依赖 `input` hook，必须在各自 handler/lifecycle event 单独检查 owner。`session_before_tree/switch/fork` 等可取消事件使用真正 fail-closed。`/reload`、退出和信号没有可取消的 before hook：`session_shutdown` 只做 best-effort 关闭输入、完成已经开始的 WAL commit并清理句柄，不能承诺阻止宿主退出；恢复时若 durable WAL 缺少 close/settled 终态，就确定性推断为 interrupted attempt并展示可恢复状态，未经用户确认不自动推进。父分支变化后旧 Registry 不得继续接收输入。

Sidecar 第一版最多 20 个 Worker attempt。含原文的 intermediate Worker/UI sidecar在 Run settled 30 天后到期；没有 live lease 的 unfinished Run 从最后一个 durable event起保留 30 天并持续提示恢复/放弃；parent 缺失的 settled Run 从首次观察起最多再保留 7 天，取更早删除期限。最终用户报告和粗粒度状态仍保留在父对话；过期 intermediate详情显示“已按本地保留策略清理”。

GC 与 writer 使用同一外部 operation lock。扫描快照后、原子 tombstone/rename前必须在锁内重新核验 parent、Run终态、deadline、writer lease/epoch；活 owner或不确定状态一律不删。删除先把 Run 目录 rename到 root trash/tombstone并 fsync目录，再异步删除；恢复端在同一 lock下看到 tombstone必须拒绝。明确放弃在下一次扫描处理，删除失败记录并重试。默认值由 L3 拥有。

非 TUI host 使用同一 `WorkflowInteractionPort`：`submitSupplement({runId, expectedNodeExecutionId, text})`、`requestModelChange({runId, expectedNodeExecutionId, expectedWorkerSessionId, expectedAttemptId, modelRef})` 和带 sequence/status 的事件流。模型 picker 的四元身份 fence（Run、Node Execution、Worker Session、Attempt）在队列内重检，目标变化时 fail-closed。它不是普通用户命令；TUI input hook/picker 只是该端口的适配器。没有交互适配器时仍可执行既有 Workflow，但不得声称支持运行中补充或模型切换。

当前 Worker 由 Pi SDK 独立 `AgentSession` 承载；状态、合同、重试和恢复机制见 [Fix Runtime 技术设计](fix-runtime-technical-design.md)。当前 `/fix` command handler 同步等待整个 Run，Child Session 为内存态且不可从主输入反向控制；统一对话协作仍是未实现目标。第一版把 Run 改为 Extension 管理的后台任务：启动事实和首个 Worker 成功建立后 command handler 返回，`input` hook 在存在当前 Worker 时处理普通输入，避免进入主 Session pending queue；`session_shutdown` 只 best-effort停止接收新输入并清理任务；缺少终态时从已 fsync WAL恢复。第一版继续使用 SDK 承载，增加可寻址 Session registry、事件投影、输入/模型路由和持久化事实，不以 tmux 或新用户命令作为前置条件。是否升级为子进程、RPC、容器或独立 Node Extension，应根据进程隔离、独立凭证/依赖、生命周期和发布需求另行评审。
