# Subagent Dispatcher Extension 产品规范

| 项目 | 定义 |
| --- | --- |
| 状态 | `DECIDED / v2 未完成、未启用` — 2026-09-14 已正式采纳本 L1 产品契约与对应 L2 目标设计；S1–S43 连续。slice0–7 gated internal foundations 已有源码/测试（admission/recovery、cancel/call orchestration、delivery、action ledger/fence、cleanup、bridge adoption/rollback foundations）；这只是 L2 当前事实摘要，不改变 L1 产品契约。产品级 v2 未完成/未启用，capability disabled，root/v1 wiring=0；真实 bridge-v1 binary+30d、side-fence production proof、Darwin/跨进程/power-loss/provider/TUI/delivery host/control adapters E2E 均未完成，不得声称 production ready。 |
| 正式评审与采纳 | [2026-09-14 产品语义/指标 Review Artifact](../../归档/评审/2026-09-14-subagent-dispatcher-产品语义指标Review-Artifact.md)、[实现/运营 Review Artifact](../../归档/评审/2026-09-14-subagent-dispatcher-实现运营Review-Artifact.md)、[Adoption Decision](../../归档/评审/2026-09-14-subagent-dispatcher-Adoption-Decision.md)；2026-09-13 文件只覆盖旧基线/历史 WIP，不覆盖本方案。 |
| 层级 | 第一层（L1 Extension） |
| 用户目标 | 调用者按稳定角色意图委派，不必记住脆弱 Agent 文件名或 Child Session ID；每个已受理委派都可诊断、可恢复且默认自动续跑，同时不重复不可确认的外部副作用。 |
| 入口 | 主 Pi Agent 的`subagent`工具；独立`subagent_cancel/subagent_delivery/subagent_delete`写控制与control-read-only的`subagent_status`。status不执行控制动作，只可幂等落账已存在的host normal toolResult observation。 |
| 上游 | [Core 产品定义](../领域术语.md)；不属于 Feature/Fix Workflow。 |
| 当前实现 | 以 [L2 技术设计](../../02-产品实现/subagent-dispatcher-技术设计.md) 与源码/测试为准；本次修订存在明确 drift。 |

## 1. 结论先行

Subagent Dispatcher 的耐久身份是 **Dispatch Call + Delegation**，不是 Child Session。Call Aggregate Proof 是独立、非 private 的 Call 对象，不是 Delegation 或删除 tombstone。合法 task unit 必须先被记录，再做 Agent discovery 或 spawn；初始执行与 recovery cycle 1/2/3 严格分开，每个 Delegation **至多一次 initial spawn/execution**。显式 cancel 若在 initial spawn 前耐久生效，可使 initial spawn/execution 为 0；正常受理且未取消的执行仍至多发生 1 次 initial。每个 Delegation 最多 4 次逻辑 child spawn（不含 reattach），不存在第 4 个 recovery cycle，第 5 次总逻辑 spawn 必须为 0。Startup reconciler 扫描当前 active lineage 的全部非终态 durable records，但只做 owner-fenced/CAS 归一化，不直接执行；普通 recovery executor 仍只能 claim `recovery_ready`。用户显式取消、已返回、配置暂停、外部副作用不确定和非当前 active lineage 都不得进入普通 recovery claim。原 tool call被中断后保留`interrupted`事实；恢复完成或Call取消可通过带稳定`deliveryId`的新custom message通知，绝不补写或伪称恢复原`toolResult`。运行中的 tool 不阻塞用户从 command/UI/RPC/tool 适配器即时提交同一耐久 cancel；不再需要的 delivery 只允许显式 abandon，第一版不允许重发。受恢复管理的 Child 必须排除 ambient extension，并让 fence interceptor 最后观察最终 tool 输入与最终 middleware result。每个 attempt 的可选 `phase` 与安全 diagnostics、固定中性诊断段由本 L1 owner；正常 retention 不得直接删除，必须与 whole-Call delete 进入同一 fenced cleanup lifecycle。

```mermaid
flowchart TD
  A[合法 subagent call] --> C[创建 Dispatch Call Record]
  C --> D[为实际 task unit 创建 Delegation Record]
  D --> REF[WAL: call_delegation_reference_added<br/>required slot + stable index]
  REF --> R[精确解析 canonical name / alias]
  R -->|唯一| B[canonical admitted/bound]
  R -->|无匹配或歧义| PC[paused_configuration]
  PC -->|审计到修复；不加 cycle| NM
  B --> IR[durable initial_reserved(reservationId)]
  IR --> IREADY[initial_ready(reservationId)]
  IREADY -->|spawn_started| E[initial/recovery running]
  E -->|明确返回| P{原 tool call 仍活跃?}
  P -->|是| TR[正常返回原 toolResult]
  P -->|否；原调用 interrupted| PR[durable recovery outbox]
  E -->|中断且可安全恢复| RR[recovery_ready]
  E -->|副作用结果不明| PU[paused_uncertainty]
  ST[startup reconciler：扫描 active lineage 全部非终态记录] --> NM[先 durable CAS / owner-fenced claim 后归一化]
  NM -->|admitted/prebinding/resolving| RZ[resolution-ready]
  NM -->|bound 无 initial reserve| IB[等待 initial reservation executor]
  NM -->|已有 reserved event 且未 spawn_started| ZR[initial-ready / cycle-ready reservationId投影；不append reserve/计数]
  NM -->|spawned live| RO[reattach-only]
  NM -->|spawned dead 且未返回| RR
  NM -->|cancel/paused/terminal/delete| SR[专门 reconciler / 终态规则]
  RR --> CR[durable cycle_reserved(reservationId,+1)]
  CR --> CREADY[cycle_ready(reservationId)]
  CREADY -->|spawn_started| E
  RS[reattach executor claim] --> E
  RZ --> RX[resolution executor逐行动重读cancel] --> R
  IB --> IR
  ZR -->|executor重读后spawn_started| E
  RO --> RS
  PR --> PD[new custom recovery/cancel message<br/>at-most-once / 可查询]
  X[持久、可审计的用户显式 cancel] --> CRQ[cancel_requested]
  CRQ --> PRE{当前待执行 scope 出现过<br/>spawn_started / spawned?}
  PRE -->|否；无 child/live ref<br/>且无 action intent/outstanding action| CX[cancelled<br/>pre-spawn completion]
  PRE -->|是| WAIT[terminate/wait 或核验既有 death]
  WAIT -->|child death + action 对账均已证明| CX
  CRQ -->|unresolved action| PU
  CD[subagent_cancel tool/command/RPC/UI] --> CRQ
  DD[subagent_delivery action=abandon] --> DA[delivery_abandoned / no_future_send]
  DEL[subagent_delete] --> DG{single reference_release_eligible?<br/>或whole Call cleanup eligible?}
  RET[normal retention 到期] --> RE{retention_eligible?}
  DA --> DEL
  DG -->|否| DF[fail closed；delete/prune=0]
  RE -->|否| DF
  DG -->|single是| TX[同一fenced WAL事务<br/>Call Proof → release → delete_requested → prune]
  DG -->|whole是| CL[call_cleanup_requested<br/>冻结Call/claim]
  RE -->|是| CL
  CL --> DT[复核终态 + delivery/proof<br/>按引用顺序release/级联]
  DT --> RM[删除private records / CallAggregateProof<br/>最小tombstone → cleanup_complete]
  TX --> DC[Delegation delete_completed；Call Proof继续保留]
  OR[single orphan Delegation retention] --> OE{terminal + no live refs/actions?}
  OE -->|是| OCL[fenced delegation cleanup<br/>最小tombstone → cleanup_complete]
  OE -->|否| DF
```

本 Extension 不拥有 Feature/Fix 的 Stage、Artifact、Guard、Acceptance 或 Workflow Worker 语义，不创建 Workflow Run。受控 Workflow Node 仍由 `workflow-runtime` / `@pi/fix` 管理。

## 2. 权威术语与记录边界

| 术语 | 产品定义 | 关键边界 |
| --- | --- | --- |
| Dispatch Call | 一次合法 `subagent` tool call 的编排单元，覆盖 single、parallel 或 chain。 | 不是 Workflow Run；负责模式、item/step 顺序、聚合、原调用 interrupted 事实与 recovery notification。 |
| Dispatch Call Record | Dispatch Call 的耐久、幂等记录。身份至少绑定 `parentSessionId + activeLineageId + activeBranchAnchor + toolCallId`。 | 防止重启后重复创建 item、重复推进 chain 或重复恢复通知。 |
| Required Slot | Call 在稳定 index/order 上必须结算的 item/step 位置。call-wide cancel 后只能处于三类终态之一：`returned_before_call_cancel`、已受理 Delegation=`cancelled`、`not_admitted_due_to_call_cancel`。 | 第一类固化取消前已经 returned 的不可变审计事实；第三类不创建 Delegation，admission/spawn 均为 0；三类共同参与 Call cancelled 收敛。 |
| Call→Delegation Reference | Dispatch Call 对 required aggregate 所依赖 Delegation 的耐久引用。 | 由 `call_delegation_reference_added` 建立；single delete 的 preflight 只检查派生谓词 `reference_release_eligible`，随后在同一 fenced WAL 事务内按 proof→release→delete_requested 顺序完成，避免要求“先 release 才可进入 release 流程”。 |
| Call Aggregate Proof | 独立、非 private 的 Call 对象，按稳定 slot index/order保存 slot 终态、Call outcome 与有界安全结果引用。 | 单 Delegation 删除后继续保留；只有 whole-Call delete 或 Call normal retention 进入共享 fenced cleanup lifecycle 后才删除。它不是 private record，也不塞入最小 tombstone。 |
| Normal ToolResult Delivery Proof | 未中断 Call 的原 `toolResult` 已由宿主持久化到同一 active lineage，且 entry 的 `toolCallId` 与原调用匹配的可审计事实。 | 后续 delete/status 扫描宿主持久记录并幂等写 `normal_tool_result_observed`；等价于 final delivery complete。找不到就不能据此删除。Extension 不声称在 `execute()` 返回前原子控制宿主持久化。 |
| Delegation | 一个独立逻辑任务。single 为一个；parallel 每个 item 各自一个；chain 每个实际开始的 step 各自一个。 | 不是 provider request、进程或 Child Session。 |
| Pre-binding Identity | canonical 解析前的委派身份：`delegationId + parent + active lineage/anchor + effective cwd + requestedTarget + discoveryScope`。 | 即使多个 parallel item 的其余字段相同，`delegationId` 仍使其互不复用；配置修复只能回到同一 pre-binding identity。 |
| Delegation Record | 合法 task unit 在自身 discovery/spawn 前创建的耐久控制记录。 | 至少保存 pre-binding identity、Dispatch Call 归属、原始任务安全引用、canonical 绑定与 provenance、恢复策略/状态/周期、attempt 和 side-effect 摘要。 |
| Initial Execution | Delegation 首次逻辑 child 的 spawn/execution；每个 Delegation 至多发生一次。 | 单独记账；不是第 0 个恢复周期，也不由 recovery supervisor 启动。pre-spawn 显式取消时允许为 0。 |
| Recovery Cycle | 初始执行未明确返回后，由 supervisor 真正启动的一轮新 execution scope。 | 只允许 cycle 1/2/3；连同 initial 最多 4 次逻辑 child spawn，reattach 不计 spawn；provider retry/fallback 不增加该计数。 |
| Child Session | 一次 Delegation 执行使用的 Pi 子会话。 | 可替换、隔离或删除；不承担 Delegation 身份。 |
| Requested Target | 调用者原样提交的 Agent/角色字符串。 | 解析前不等于 canonical Agent。 |
| Canonical Agent + provenance | 唯一 Agent 正式名称及其 `source + discoveryRootRealpath + fileRealpath + digest`。 | 唯一解析后原子绑定；越界 symlink fail closed。已绑定 revision 只能经审计更新同 name/source/root 的 digest，跨 source/name/root 不得静默改投。 |
| Alias | 在 canonical Agent 定义自身声明的显式、精确别名。 | 不允许 package 内第二份映射表或模糊猜测。 |
| Provider Attempt | 某个模型的一次实际请求。 | 属于 initial execution 或某个 recovery cycle 的内层预算。 |
| Recovery Completion Notification | 原 tool call 保持 `interrupted` 后，向同一 active lineage/branch 新增的 custom message；Call 取消终态时可发送“已取消”通知。 | 带稳定 `deliveryId`，由 durable recovery outbox、active-branch receipt scan 与单 owner/fencing 控制；目标是 at-most-once，不是补写原 `toolResult`，也不承诺 exactly-once。 |
| Cancel Control | `subagent_cancel(delegationId｜dispatchCallId, scope=item｜call)` 的耐久写控制。 | tool、command、RPC 与 UI 只是适配器，必须共享同一 control service；只有同 parent + active lineage actor 可写，command/UI 不等待当前 LLM 再发 tool call。 |
| Delivery Disposition | `subagent_delivery(deliveryId, action=abandon)` 对 pending/sending/uncertain delivery 作出的显式处置。 | 第一版仅 `abandon/no_future_send`，不允许 resend；保留原 tool call `interrupted` 与完整审计。 |
| Cleanup Tombstone | whole-Call delete、normal retention 或 eligible orphan Delegation cleanup 留下的防 claim、防复活控制事实。 | 只在 fenced cleanup lifecycle 删除 private records/proof 后写入；仅含五个普通字段`idHash + objectKind + schemaVersion + deletedAt + status`及`actorScopeTag`，不含proof/slot/outcome/private payload，30天后GC。 |
| Fenced Cleanup Lifecycle | whole-Call delete 与 normal retention 共用的唯一 Call 清理状态机。 | `retention_eligible → call_cleanup_requested → terminal/delivery/proof复核 → 按引用顺序release/级联 → 删除private records/CallAggregateProof → 最小tombstone → cleanup_complete`；任一 kill point由startup幂等续做。 |

原始 task、有效 cwd 和恢复所需上下文只允许存在于受控本地记录/Child Session 边界；普通 UI、Tool details、attempt 摘要和 Git 只展示安全 scope、哈希引用与必要脱敏摘要。

## 3. Admission、解析与强身份

### 3.1 先记录、后 discovery

结构/模式非法或缺少必填 task 的输入尚未成为合法调用，可以不创建记录。其余调用必须先建立 Dispatch Call Record；每个实际 task unit 必须先建立 Delegation Record，再执行 Agent discovery、alias 解析或 child spawn。

- single：一个 call、一个 delegation。
- parallel：每个合法 item 拥有独立 delegation id、状态、attempts 与恢复预算；结果按原 item 顺序聚合。
- chain：只在 step 实际开始时建立该 step 的 delegation；已物化 task 的当前 step 先恢复，明确返回后才物化/启动未来 step。

### 3.2 Raw candidates、合法 shadow 与唯一解析

`aliases` 必须由 canonical Agent Markdown frontmatter 自身声明；Dispatcher package 不维护另一份 alias 真理源。首批兼容意图是 `implement → implementer`、`code-review → code_reviewer`、`product → product_aligner`，但实际映射只有写入相应 canonical 定义并通过 resolver 校验后才生效。

Resolver 必须按固定顺序执行：

1. 保留 user/project **raw candidates**，先分别解析 `discoveryRootRealpath` 与 `fileRealpath`，校验 parent 已确认的 project trust、文件属于 discovery root、普通文件/owner/权限与 symlink 边界；越界、悬空或不可证明的 symlink fail closed，不能先 shadow 掩盖非法 candidate。
2. 对通过校验的 raw candidates 按明确的 **project-over-user** 规则形成 effective set。同 canonical name 的合法 project Agent 只覆盖跨 source 的同名 user Agent，属于合法 shadow，不算 duplicate；同一 source 内的同名 candidates 不折叠，留给 effective-set duplicate 检查。被 shadow 的 user candidate 仍保留在审计 provenance 中但不参与有效解析。
3. 只对 effective set 检查 duplicate canonical、alias↔canonical、alias↔alias 与大小写归一冲突，再按 requested target 精确解析；无匹配或非唯一命中进入 `paused_configuration`，spawn=0。

item 自带 cwd 只决定执行 cwd，不能授权另一个 project 的 Agent root。任何冲突都不得模糊匹配或伪装成 provider/transport failure。

### 3.3 Pre-binding、原子 canonical binding 与配置 revision

Delegation 在 discovery 前先绑定：

```text
delegationId
+ parentSessionId
+ activeLineageId / activeBranchAnchor
+ effectiveCwd
+ requestedTarget
+ discoveryScope
```

唯一解析成功后，才原子追加 canonical binding：

```text
canonicalName
+ source
+ discoveryRootRealpath
+ fileRealpath
+ digest
```

已绑定 Agent 的 digest 变化必须先进入 `paused_configuration`，经审计 `config_revision_accepted` 才能更新；该事件只允许同一 canonical name、source 与 discovery root/file realpath 更新 digest。canonical name、source 或 root/path 变化属于身份变化，必须拒绝自动接管，不能借“配置修复”静默改投。

### 3.4 Active lineage 与恢复身份

自动恢复必须同时匹配 pre-binding identity、已绑定 canonical provenance 与可判定的当前 active lineage。`activeLineageId` 表示创建调用所在的线性分支身份：正常追加保留该 identity，`/tree` 分叉、fork/clone 或切换到共享同一 ancestor 的另一分支必须产生/命中不同 lineage。`activeBranchAnchor` 在当前 branch 中只是必要条件，不是充分条件；即使另一分支也包含 anchor，只要 lineage 不同就不得 claim、通知或接管。

`delegationId` 区分同一 call 中字段完全相同的 parallel item。新 top-level parent session、不同 active lineage、不同 cwd/requested target/discovery scope 或不同 canonical provenance 都不得接管旧 Delegation。

## 4. 生命周期、取消与严格 claim

### 4.1 概念状态

| 状态 | 产品含义 | 是否可被 recovery supervisor 启动 |
| --- | --- | --- |
| `admitted` / `prebinding` / `resolving` | 已记录但 canonical binding 尚未完成。 | 否；startup 先以 durable CAS/owner fence 归一为 `resolution_ready`；显式 cancel 可走 pre-spawn completion。 |
| `resolution_ready` | pre-binding identity 已确认，可由 resolution executor claim。 | 否；不属于普通 recovery claim。 |
| `bound` | canonical 已绑定，但尚无 initial reservation。 | 否；initial reservation executor 只能追加一次 `initial_reserved`，再投影为 `initial_ready(reservationId)`。 |
| `initial_ready(reservationId)` | durable `initial_reserved` 已存在且 initial 尚未 `spawn_started`。 | 否；initial executor 复用该 reservation；显式 cancel 封存后 initial=0。 |
| `cycle_ready(reservationId)` | `recovery_ready` 后已 durable 追加一次 `cycle_reserved(+1)`，当前 recovery scope 尚未 `spawn_started`。 | 否；cycle executor 复用该 reservation；startup 不再 append reserve 或增加计数。 |
| `initial_running` / `recovery_running` | 对应 scope 已出现 `spawn_started` 或正在运行。 | 否；startup 先按 WAL 与 child 生死归一。 |
| `reattach_only` | scope 已 spawned，且匹配 child 被证明 live。 | 否；只能由 reattach executor claim，同 reserve 新 spawn=0。 |
| `recovery_ready` | scope 已 spawned、child 被证明 dead/未返回；下一次 spawn 必须创建新 cycle +1。 | **是，普通 recovery executor 唯一可 claim 状态。** |
| `cancel_requested` | 显式取消已耐久；新 resolution/binding/intent/spawn 被禁止。通常按当前 scope 的 spawn 事实分流；若来源是 `paused_configuration`，必须按该 Delegation 全部历史分流：历史从未 `spawn_started` 才可 pre-spawn completion，历史曾 spawn 则先证明历史 child 终止并完成 action reconciliation。 | 否；只由 cancel reconciler 处理。 |
| `paused_configuration` | Agent/alias 冲突，canonical 配置、模型、认证等非瞬态配置问题阻塞。 | 否；由 configuration reconciler 处理，不消耗 cycle。 |
| `paused_uncertainty` | 外部副作用或取消对账仍有 unresolved action。 | 否；需人工确认。 |
| `paused_integrity` | parent/branch/identity/WAL/child death 完整性无法安全证明，或恢复预算耗尽。 | 否；需修复或人工处置。 |
| `delete_requested` | 删除 tombstone 已耐久，禁止任何 claim/spawn/send。 | 否；只由 delete reconciler 清理。 |
| `returned` / `cancelled` / `delete_completed` | Delegation 已返回、已完成取消或已完成主动删除。 | 否；按各自终态/retention 规则处理。 |

`parent-delivery-complete` 仅表示新的 custom recovery/cancel message 已在目标 active branch 取得 receipt，不表示原 `toolResult` 被恢复；它是 Dispatch Call 的通知终态，不是 Delegation 可恢复状态。Startup 对 paused、`cancel_requested`、`cancelled`、`returned`、`delete_requested/delete_completed` 和 delivery complete 分别交给专门 reconciler 或终态规则，绝不塞入普通 recovery claim。Delegation execution owner 与 Call outbox owner 是两条 fenced claim：`returned`/`cancelled` 不再 spawn，但 outbox owner仍可按 Call 终止合同对账/发送通知。

### 4.2 取消来源与运行中控制面

只有通过 Dispatcher 明确取消动作产生、已持久且可审计的用户显式 cancel，才能把 Delegation/Call 置为 `cancelled`。唯一写语义由共享 control service 持有；`subagent_cancel(delegationId | dispatchCallId, scope=item | call)` tool、command、RPC 与 UI 只是等价适配器。actor 必须与目标记录的 `parentSessionId + activeLineageId` 同时匹配。`scope=item` 必须以 `delegationId` 精确指定已物化 item；`scope=call` 以 `dispatchCallId` 指定整 Call，也可由 `delegationId` 唯一解析其所属 Call；`dispatchCallId + scope=item` 因无法唯一指 item 而 fail closed。

command/UI/RPC 不依赖等待当前 LLM 结束或产生下一次 tool call；即使 child 正在运行 tool，也必须能即时调用 control service。响应只在 `cancel_requested` 已 durable 后返回稳定 receipt（target、scope、actor 安全引用、WAL sequence 与 `requested/already_requested`），不把 receipt 说成取消完成。相同 actor/target/scope 的重复请求幂等返回同一事实；并发适配器只能有一个 WAL append winner。以下情况都只能视为可恢复中断或保守暂停，不能证明用户意图：parent shutdown/reload、新会话/恢复/fork/tree 生命周期切换、进程 signal、超时、parent tool call abort、无法归因的 child `aborted`。

取消是严格状态机，不允许把“已请求”提前写成“已完成”；但 pre-spawn completion 不得虚构 child death：

```text
显式 cancel + actor/target 校验
→ durable cancel_requested
→ supervisor 阻止新 resolution / binding / spawn / action intent
→ fenced WAL 判定当前待执行 scope
   ├─ 从未出现 spawn_started/spawned
   │  + 无 child/live ref
   │  + 无 outstanding action/action intent
   │  → 消耗/封存未 spawn reservation（若有）→ durable cancelled
   └─ 已出现 spawn_started/spawned
      → terminate/wait 或核验既有 death
      → 对账 outstanding action ledger
      → OS waitpid/child death 已证明且无 unresolved
      → durable cancelled
```

pre-spawn completion 覆盖 `admitted/resolving/prebinding`、`resolution_ready`、`bound`、`initial_ready(reservationId)` 与 `cycle_ready(reservationId)`。对于 cycle 情形，“从未 spawn”通常指**当前待执行 recovery scope**；历史 scope 的 death/action 必须已在创建该 cycle reserve 前完成对账，但 cancel reconciler 不为当前 reserve再次虚构 child death。`paused_configuration` 是更严格的历史分流例外：只有 fenced WAL 证明该 Delegation 历史从未出现任何 `spawn_started`，才可走 pre-spawn completion；只要历史曾 spawn，就必须先证明对应历史 child 已终止并对账全部 outstanding action，再写 `cancelled`。存在未 spawn reservation 时由 cancel 耐久事件消费/封存，之后永久不可 spawn；`admitted/prebinding/resolving/resolution_ready/bound` 等尚无 reservation 的状态必须追加 durable no-reservation fact，不能省略证据或伪造 reservation。resolution executor 在每个 resolution 行动前都须以当前 fence 重读 cancel 状态；一旦看到 `cancel_requested`，后续 discovery/解析/binding/spawn 均为 0并转交 cancel reconciler。

若 action ledger 有 unresolved intent/result，进入 `paused_uncertainty`；对已出现 spawn 事实的 scope，若无法以 OS `waitpid`/等价 child-death 证据证明 child 已退出，进入 `paused_integrity`。Startup 必须有独立 cancel reconciler：`resolution_ready` 与其余 pre-spawn 状态满足无执行事实三条件时，有 reservation 则封存、无 reservation 则写 durable fact，再提交 `cancelled`；live child 继续 terminate/wait；dead child 继续 action 对账。四类都不得进入普通 recovery claim。

### 4.3 Startup normalization 与 Supervisor claim 前置条件

Startup/reload/resume/tree 必须扫描该 parent **当前 active lineage 的全部非终态 durable records**，而非只扫 `recovery_ready`。扫描器不能直接 resolution/spawn/reattach/send；它必须先取得匹配 generation 的 owner-fenced claim，并对每个归一化转移执行 durable CAS：

| WAL / observed fact | 确定性归一结果 |
| --- | --- |
| `admitted/prebinding/resolving` | `resolution_ready`，后续由 resolution executor另行 claim；其每个行动前重读 fenced cancel 状态。 |
| canonical `admitted/bound` 且无 `initial_reserved` | 保持 `bound` 并路由 initial reservation executor；该 executor 另行 claim 后一次性 append `initial_reserved`，再投影 `initial_ready(reservationId)`。 |
| 已有 initial/cycle `reserved` event 且无 `spawn_started` | 只从既有 event 投影 `initial_ready(reservationId)` 或 `cycle_ready(reservationId)`；startup 不 append reserve、不增加 cycle。 |
| `spawned` 且匹配 child live | `reattach_only`；同 reserve 新 spawn=0。 |
| `spawned` 且 child dead/未返回 | `recovery_ready(needsNewCycle=true)`；下一 spawn 先新 cycle +1。 |
| paused、`cancel_requested`、`delete_requested` | 路由到 configuration/uncertainty/cancel/delete 专门 reconciler；cancel reconciler 对包括 `resolution_ready` 在内的 pre-spawn scope：有 reservation 则封存、无 reservation 则写 durable no-reservation fact，并在无 child/live ref、无 action intent/outstanding action时直接提交 `cancelled`；`paused_configuration`另按Delegation完整spawn历史分流，其余按 live/dead child 对账；不进入普通 recovery claim。 |
| Call=`cancel_requested` | 同Call fence按stable index结算三类：cancel前returned→不可变`returned_before_call_cancel`；已admit非终态→strict cancel；未admit→`not_admitted_due_to_call_cancel`且Delegation/spawn=0。三类全终态后Call cancelled。 |
| Call=`call_cleanup_requested` | Call/claim/admission/control/outbox/references保持冻结，路由 startup cleanup reconciler 按 durable reference-order cursor 续做；execution/recovery/send=0。 |
| `cancelled`、`returned`、`delete_completed`、delivery complete | 按终态/Call outbox规则对账；不进入普通 recovery claim。 |

每次 executor 真正行动前还须重新 owner-fenced claim并重读 WAL/lineage；仅有扫描结果或内存投影不授权执行。

普通 recovery executor 每次 claim 时，只有同时满足下列条件的 `recovery_ready` 才可被唯一 owner claim：

1. parent 是可跨重启恢复的持久 Pi session；仅进程内恢复时可放宽为当前仍存活的 parent。
2. 当前 `activeLineageId` 与原 lineage 相同，且 active branch 包含原 `activeBranchAnchor`；仅 ancestor membership 不足，fork/tree 的 sibling 或 abandoned lineage 不得续跑或通知。
3. pre-binding identity、canonical provenance、project trust、realpath/symlink 边界与 effective cwd 仍一致；digest revision 只有已审计 `config_revision_accepted` 才可生效。
4. 没有 `cancel_requested`/已取消/删除 tombstone，状态不是 returned/任何 paused，且 Dispatch Call 未 `parent-delivery-complete`。
5. 没有未解决 external side-effect uncertainty；continuation 必须有新 `continuationEpoch`。`recovery_ready` 只允许 dead post-spawn child 进入下一新 cycle，且当前 cycles used 小于 3；未 spawn reserve 与 live child 分别走 `initial_ready/cycle_ready` 和 `reattach_only` executor。
6. 没有其他有效 owner。若 fenced WAL 在 identity lock 内两次稳定观察均证明该 Delegation **从未**出现 `spawn_started`、无 child/live ref、无 action intent/outstanding action，则 pre-spawn owner transfer 只要求旧 supervisor death proof；child absence 由 WAL/no-ref 事实证明，禁止虚构 child death。任何历史 `spawn_started` 之后的 transfer 才同时要求旧 supervisor与历史 child death proof，并完成 action reconciliation。lease TTL、单次 `kill(0)`、authenticated revoke/terminate/terminal ACK 都不能替代。直属进程由 waitpid 证明；重启后 Darwin 以 host/PID/process birth identity/session/path/argv digest 在 identity lock 内至少两次稳定观察：PID 不存在，或同 PID 的稳定可读 birth identity mismatch，证明**原进程**已死；birth mismatch 的复用 PID 绝不能接收 signal。同 PID同birth但session/path/argv不匹配是完整性事故。birth identity 缺失/不可读、权限不足或两次观察不稳定时进入 `paused_integrity`；action 未清零时进入 `paused_uncertainty`，spawn=0。Child IPC intent/result ACK 也必须匹配当前 generation。

任一 preflight 失败都不得 spawn；必须保持/进入可诊断暂停或等待原分支，而不是“尽量恢复”。

## 5. Initial Execution、三层预算与配置暂停

### 5.1 三层预算

| 层级 | 单位与预算 | 触发/不触发 |
| --- | --- | --- |
| Initial Execution | 每个 Delegation 至多一次 initial spawn/execution；pre-spawn 显式取消允许为 0，正常受理且未取消的执行至多为 1。 | 不计入 recovery cycle；崩溃时回放原预留，不再创建“第二个 initial”；cancelled pre-spawn reserve 永不执行。 |
| Provider retry/fallback | initial 或每个 recovery cycle 内，每个候选模型为 initial request + 最多 2 次闭集瞬态 retry；耗尽后才进入下一 fallback candidate。 | 仅 `fetch failed`、`ECONNRESET`、`ECONNREFUSED`、`ETIMEDOUT`、明确 timeout、HTTP 429/502/503/504。 |
| Delegation recovery | 只允许 cycle 1/2/3；initial dead 后首次 replacement 是 cycle 1。initial + 三轮 recovery 合计最多 4 次逻辑 child spawn。 | 第 4 个 recovery cycle 禁止；因此第 5 次总逻辑 child spawn=0。provider attempt、配置/人工决定本身、取消和 notification 均不计；live reattach 或 never-spawn reserve 首次使用不新增 spawn/cycle。 |

每个 recovery cycle 拥有自己完整的 provider candidate 序列；fallback candidate 各自获得 initial + 2 retry。非瞬态模型/认证/配置错误不重试、不 fallback，并进入 `paused_configuration`；修复后从同一 Delegation 恢复，不要求“所有候选先耗尽”。

### 5.2 Reserve、spawn 与 continuationEpoch

唯一合法投影固定为：

```text
admitted/bound（canonical binding 已完成） --durable initial_reserved(reservationId)--> initial_ready(reservationId)
initial_ready(reservationId) --spawn_started--> initial_running

recovery_ready --durable cycle_reserved(reservationId, recoveryCyclesUsed+1)--> cycle_ready(reservationId)
cycle_ready(reservationId) --spawn_started--> recovery_running
```

`initial_reserved` / `cycle_reserved` 是 WAL 事件，不是夹在 ready 前后的第二套状态。startup 若发现已有 reserved event，只能投影到携带同一 `reservationId` 的 ready，不能再次 append reserve 或增加 cycle。

- ready 所引用 reservation 从未记录 `spawn_started` 时，在未取消条件下可首次使用；若显式 cancel 已耐久，则有 reservation 时封存、无 reservation 时写 durable no-reservation fact，之后永久不可 spawn。
- 一旦记录 `spawn_started`/`spawned`，同一 reservation 只能 reattach 仍存活且身份匹配的 child；禁止用同一 reservation 再 spawn。
- 已开始 spawn 的 child 已死且没有明确返回时，下一次 spawn 必须从 `recovery_ready` 追加新的 `cycle_reserved` 并耐久 `recoveryCyclesUsed + 1`，再投影 `cycle_ready(reservationId)`；initial child 死亡后的首次 replacement 是 cycle 1。已有 cycle 的 child 再次中断则进入下一 cycle，最多到 cycle 3；禁止创建 cycle 4，initial + cycle 1/2/3 后的第 5 次总逻辑 spawn=0。
- 配置修复和副作用人工确认各自增加单调 `continuationEpoch`。该决定本身不增加 recovery cycle；它只能继续 admission/resolution、使用从未 spawn 的 ready reservation、reattach live child，或在 dead child 需要新 spawn 时按上一条新建 cycle。
- 同一 `(executionScope, continuationEpoch, fencingGeneration)` 最多允许一次 spawn intent；重复 spawn 必须 fail closed。

### 5.3 配置修复后的自动继续

当用户明确修改 Agent/alias/model/auth 配置，或 Dispatcher 检测到可审计 revision 变化时，`paused_configuration` 可以重新校验。同 canonical name/source/root/path 的 digest 修复须先写 `config_revision_accepted`，然后增加 `continuationEpoch`；跨 source/name/root/path 变化拒绝自动继续。未观察到新 revision/epoch 时不得自旋重试。

### 5.4 Resume 与 replacement

- 有效且仍存活的 Child Session：在原 reserve 下 `retry-resume`/reattach，先检查会话历史、工作树和已有产物，只做剩余工作。
- 从未 `spawn_started` 的 reserve：可首次使用该 reserve，计数不变。
- 已 `spawn_started` 的 child 已死且未返回：`retry-new-session` 仍使用同一 Delegation，但必须新建 recovery cycle并先耐久 +1；替代 child 收到原始任务和有界恢复摘要，并先检查已有工作，不盲目重放。

Fast 继承只有 Delegation 第一个 logical child 的首次 spawn 可按 [Codex Usage Status + Fast 规范](codex-usage-status-扩展.md#21-parent-fast-继承例外)命中。provider retry、fallback、retry-resume、retry-new-session 均不得再次继承 Fast。

## 6. 外部副作用不确定性

默认自动续跑的唯一执行风险例外，是发布、生产写、发消息等外部动作可能已经开始但结果不可确认。判断必须来自可审计的动作/工具状态或显式 Policy；不能仅依赖 task 关键词、Child 自由文本或“应该幂等”的猜测。

| 人工处置 | 后续状态/行为 |
| --- | --- |
| `confirmed_succeeded` | 记录动作已成功，不重复该动作；仅继续其后的剩余工作，或在 Call 满足终止条件后进入 recovery notification/query。 |
| `confirmed_not_started` | 增加 `continuationEpoch` 并允许继续；决定本身不加 cycle。若原 reserve 从未 spawn 可复用，若已 spawn 且 child 已死，下一次 spawn 必须新建 cycle。 |
| `confirmed_failed_safe_to_retry` | 记录失败/可重试依据并增加 `continuationEpoch`；决定本身不加 cycle，但 dead child replacement 仍必须新建 cycle。 |
| `still_unknown` | 保持 `paused_uncertainty`，不 spawn。 |
| `cancel` | 进入严格 `cancel_requested` 状态机；pre-spawn scope满足无 spawn事实、无child/live ref、无action intent/outstanding action时可直接耐久`cancelled`；post-spawn仍只有child death已证明且action ledger无unresolved才完成。 |

当外部系统支持 idempotency key 时必须使用同一稳定 action identity；不支持或工具无法分类时保守暂停。任何崩溃恢复路径都不得让同一已成功/未知动作重复执行。

## 7. Dispatch Call 编排与 delivery proof / recovery notification

Dispatch Call Record 至少持有 mode、稳定 item/step 顺序、Delegation IDs、chain cursor/前驱结果安全引用、parallel 聚合控制状态、独立 Call Aggregate Proof 引用，以及 normal/custom delivery 的可审计状态。durable recovery outbox 仅用于原调用已 `interrupted` 的 recovery/cancel custom notification。

- single：Delegation `returned` 后才形成正常 Call outcome；显式取消完成严格 cancel 状态机后 Call outcome=`cancelled`。
- parallel item cancel：只把目标 item 推入 `cancel_requested`，其他 item 继续；该 item 完成取消后以明确 `cancelled` 状态进入最终聚合。只有全部 required item 分别达到 `returned` 或 item-level `cancelled`，才可按原 index 形成正常 item-cancel aggregate/delivery。
- parallel call-wide cancel：在 Call owner 临界区先冻结新 admission，再按 cancel 生效点把每个 stable required slot **恰好一次**结算为三类终态：
  1. cancel 前已 `returned`：Delegation 的 returned 事实不可改写，slot 追加不可变 `returned_before_call_cancel(index, resultRef)`；
  2. 已 admit 且仍非终态：写 `cancel_requested`，按 pre/post-spawn 严格状态机最终收敛为 Delegation=`cancelled`；
  3. 尚未 admit：写 `not_admitted_due_to_call_cancel(index)`，Delegation=0、spawn=0，且不得事后 admit。
  只有三类 required slots 全部终态后，Call outcome 才写 `cancelled`，并可建立取消 notification。不得生成或声称 partial-success aggregate；`subagent_status`/query 可以按原 index显示哪些 slot 已在取消前返回，但该可见事实不改变 Call cancelled outcome。startup/并发 owner 必须幂等补齐缺失结算并拒绝终态改写。
- chain：严格执行 `NEXT → admit delegation → execute/recover → returned → advance cursor`。任一已物化 step被显式取消后，等待其严格取消完成；future step永不admit，只在Call编排记录中标为`not_admitted_due_to_call_cancel`，全部required step slots达到该取消终止条件后Call写`cancelled`，既有前驱结果不得aggregate为success。只有所有 required step 按顺序 `returned` 才形成正常 aggregate。
- paused/progress：均是非终态；可以向 UI 发状态，但不写 final Call outcome、Call Aggregate Proof、recovery/cancel delivery receipt 或 `parent-delivery-complete`。

### 7.1 未中断 Call 的正常 `toolResult` delivery proof

正常、未崩溃的 tool `execute()` 返回原 `toolResult`，但 Extension 只能控制返回值，**不能在返回前原子控制或证明宿主已把该 toolResult 持久化**。因此“execute 已返回”与“final delivery complete”必须分开：

1. Call normal outcome 与独立 Call Aggregate Proof 先 durable；
2. 后续 `subagent_delete` 或 `subagent_status` 在同一 active lineage 扫描 host-persisted entries，寻找 `toolResult.toolCallId == originalToolCallId` 的唯一匹配；
3. 唯一匹配且内容引用/Call identity 校验通过时，幂等追加 `normal_tool_result_observed(hostEntryRef, toolCallId)`；该状态等价 final delivery complete；
4. 找不到、跨 lineage、匹配不唯一或身份不一致时不得写 observed。delete fail closed，status 只报告 delivery 尚未证明/完整性异常。

`subagent_status` 仍是 control-read-only：不 cancel、不 delete、不 spawn、不 send，也不伪造 custom receipt；它唯一允许的写入是把宿主中已经存在、可复核的 normal toolResult 投影为上述幂等 observation fact。

### 7.2 原调用 interrupted 后的新 custom notification

一旦原 tool call 因 parent/进程中断而结束，该调用永久保留 `interrupted` 事实；恢复完成后只能发送一个新的 custom recovery completion message，内容带稳定 `deliveryId`、`dispatchCallId` 与安全结果引用，明确说明“这是恢复通知，不是原 toolResult”。Call 达到 `cancelled` 后也可通过同一 durable outbox 发送带稳定 `deliveryId` 的 at-most-once“已取消”custom notification。

恢复完成或 Call 取消通知采用 durable outbox + active-lineage/branch receipt scan + 单 owner/fencing 去重，目标是同一 active branch **可见至多一次（at-most-once）**：

1. normal aggregate 或 `Call=cancelled` durable 后建立稳定 `deliveryId` 与 outbox item；
2. 发送前由唯一 owner 在当前 active lineage/branch 扫描同 `deliveryId` custom message receipt；
3. 已存在则只对账 receipt；不存在且投递前置条件可证明时发送新的 custom message；
4. `sending` 在调用 parent append/send 前必须先耐久；重启看到 `sending` 时，只有 receipt 可完成，无法证明消息从未对用户可见时一律转 `uncertain`、不再调用 send。保留可查询 outbox/状态。

该边界不声称 exactly-once，也不保证至少一次通知。主 Agent 必须能用稳定 `delegationId` / `dispatchCallId` / `deliveryId` 查询 execution、Call Aggregate Proof、normal/custom delivery 与 uncertainty 状态。只有 parent session 可持久恢复、active lineage 可判定且 branch receipt 可扫描时，才承诺跨重启自动恢复；in-memory parent 仅保证同一进程内自动恢复，并在 admission/状态查询中明确降级。

不再需要 custom notification 时，独立写控制 `subagent_delivery(deliveryId, action=abandon)` 必须校验同一 `parentSessionId + activeLineageId` actor，随后 durable 写入 `delivery_abandoned(no_future_send)`。第一版只允许 abandon，不提供 resend/requeue；`pending/sending/uncertain` 一经 abandon，任何 owner 后续 send=0。该 disposition 可解除 delete 的 custom-delivery 阻塞，但不改变原 tool call 的 `interrupted`、Call/Delegation outcome 或既有 receipt，并保留谁、何时、对哪个 delivery 作出 abandon 的安全审计。重复 abandon 幂等；已 receipted delivery 只返回既有终态，不倒写 abandon。

## 8. Child Session、兼容与保留

Child Session 保留与 Delegation 持久化是两个维度：

| 情形 | Delegation / Call Record | Child Session | 恢复行为 |
| --- | --- | --- | --- |
| 默认 / `persistent:true` | 持久到终态保留期 | 默认保留 | 有效时 resume；无效时 replacement。 |
| `persistent:false` | **Call/Delegation/private recovery payload 仍持久到终态保留期** | attempt 安全落账后不保留 | 中断后支持 `retry-new-session`；只允许 cycle 1/2/3，含 initial 总逻辑 spawn 最多 4 次。 |
| Child 损坏/隔离 | 保留并引用审计事实 | quarantine，不再 resume | 门禁通过后创建 replacement。 |

公共 `persistent` 参数的名称/类型/默认值保持兼容，L2 可内部映射为 `retainChildSession`；但 `persistent:false` 从“整个调用临时、不可跨 session 恢复”变为“只不保留 Child Session，Call/Delegation/private recovery payload 仍耐久并可 retry-new-session”，这是明确的行为与隐私语义变化，**不称完全向后兼容**。Admission 必须说明持久对象、保留期、parent 是否仅进程内恢复及退出/删除入口。Child 只有在 attempt 终态、captured output、side-effect 状态和恢复所需摘要已安全进入控制记录后才能删除；崩溃残留由 GC 清理。

本地 Call/Delegation、private payload 与 Child 默认从最后耐久活动起保留 30 天。**到期只产生 eligibility 检查，不授权直接删除。** active、nonterminal、完整性/副作用 uncertain、pending/sending/uncertain delivery、未完成 cancel、outstanding action、active claim/live child 或仍有外部 live reference 的 Call/Delegation 一律 `retention_eligible=false`。Call 自身已物化、将在 cleanup 中按序释放的 Call→Delegation references 不属于此外部 blocker。上述不 eligible 对象不得删除原始 task/cwd、Child、private records 或 proof。必要时可停止自动恢复并保持可查询的暂停状态，但不能把未终态到期改写为 cleanup terminal。只有满足 §8.1 fenced cleanup lifecycle 的终态对象才可清理；任一条件不可证明都保留并等待显式处置。

旧 v1 Child Session registry 永久只支持 legacy explicit-handle continuation，不会被自动恢复。v2 adoption 采用 **bridge-v1 先行**：在允许采用任何既有 v1 session 前，必须先发布、安装并验证仍保持 v1 行为但能识别 backward-compatible preservation pin 的 bridge-v1。未检测到已验证 bridge capability 时，adoption=0，既有 session 明确保留 legacy explicit-handle-only。当前更老 v1 binary 不承诺识别或保护 v2 adoption，不能宣称可以直接安全回滚。

不存在原始 task/cwd 事实时不得伪造或推断 Delegation；只有 bridge 前置与 adoption preflight 均通过，且后续显式调用同时提供可验证 task/cwd/target、无 live v1 writer/child、source 完整、目标 v2 namespace 可原子创建时，才可幂等采用。采用前先建立受 bridge-v1 保护的 preservation pin，再把源 session 复制/分叉为**独立 v2 child namespace**；v2 live child 不再引用 v1 session 路径，也不受 v1 GC 管理。v1 原件在默认 30 天回滚窗口内保持 legacy explicit-handle-only。只有真实 bridge-v1 binary 已验证整个 30 天 pin/mtime/GC 边界和 rollback preflight，才可把 rollback列为可用；回滚仍必须停止/隔离 v2 owner 与 child、确认 death proof 与 outstanding action=0、无 in-flight outbox，并重新校验 v1 header/handle/GC 状态。两个 namespace 各自由自己的 GC 管理，任何一方不得删除另一方 live reference。

### 8.1 `subagent_delete` 主动删除合同

`subagent_delete` 是独立写控制。只有同一 `parentSessionId + activeLineageId` 的已认证 actor 可以请求删除；branch anchor、opaque id 或文件权限本身都不能越权。`subagent_status` 不产生删除等控制副作用；仅可按 §7.1 把宿主已有 normal toolResult 观测幂等落账。

删除必须 fail closed。active child、尚未完成的 `cancel_requested`、unresolved/uncertain action、未完成且未 abandon 的 custom outbox、未证明的 normal toolResult delivery、live v1 adoption/rollback reference 都是 blocker。

对 single Delegation delete，reference 子流程不得循环依赖：preflight **只检查**由当前 fenced materialized view 派生的 `reference_release_eligible`，不要求 proof 或 release 已经存在。eligible 至少要求 Call 已终态、全部 required slots 已终态、对应 final delivery complete（custom=`receipted/parent-delivery-complete` 或 `delivery_abandoned(no_future_send)`；normal=`normal_tool_result_observed`）、Call/slot identity 完整、无上述 blocker。若不 eligible，整个事务删除数为 0。若 eligible，同一 fenced WAL 事务必须固定顺序：

```text
confirm/write independent non-private Call Aggregate Proof
→ call_delegation_reference_released(proofRef)
→ delegation delete_requested
→ prune private payload / Child / IPC / temp refs
→ delegation delete_completed
```

proof/release/delete_requested 之间不得释放 owner fence 或要求调用者重试另一条“先 release”流程；已有匹配 proof/release 可幂等确认，冲突、错 slot、重复矛盾或任一步 durability 不明都 fail closed。

whole-Call delete 与 normal retention 不得分叉成两套删除路径。显式 delete 仍先做 actor/终态 blocker preflight；normal retention 到期先计算 durable `retention_eligible`。两者只有在 Call terminal、全部 required slots terminal、final delivery complete、Call Aggregate Proof 可确认，且没有 active claim/live child/外部 live reference、未完成 cancel、uncertain/outstanding action、pending/sending/uncertain delivery 或 live adoption/rollback reference 时，才可进入同一 **fenced cleanup lifecycle**：

```text
explicit whole-Call delete eligible 或 retention_eligible
→ call_cleanup_requested(trigger=explicit_delete | retention)
  （冻结 Call / claim / admission / control / outbox / references）
→ 在同一 Call fence 下重新确保 terminal + final delivery + Call Aggregate Proof
→ 按 stable reference/slot order release 并级联 Delegations cleanup
→ 删除 Call/Delegation private records 与独立 Call Aggregate Proof
→ 写最小防复活 tombstone
→ cleanup_complete
→ tombstone 保留 30 天后 GC
```

`call_cleanup_requested` 一旦耐久，任何 execution/recovery/send/admission/control claim 都必须为 0。任一 crash/kill point由 startup cleanup reconciler 以同一 fence、同一引用顺序幂等续做；已完成步骤只确认不倒退，未知 durability、顺序冲突或 blocker重新出现时 fail closed，不得复活或跳步。正常 retention 绝不能绕过 `call_cleanup_requested` 直接删除 proof/private records。

Call Aggregate Proof 是独立、非 private 对象：只删某个 Delegation 时，它继续保存 slot/order/outcome 与有界安全结果引用；不得因单项 cleanup 而消失。它只在上述 whole-Call shared lifecycle 中、完成 reference release/Delegation cascade 后删除。最小 tombstone 仅含五个普通字段 `idHash + objectKind + schemaVersion + deletedAt + status`，另含非敏感 `actorScopeTag`；不含 slot/order/outcome、proof、原始 parent/lineage/object id、task、cwd、Agent/provenance 或 secret。30 天后 tombstone 自身 GC。

single orphan Delegation（经 WAL/replay 证明不存在任何 live Call→Delegation reference 的历史/迁移孤儿）也不能由 retention 直接删除。只有 Delegation terminal、无 live claim/child/reference、无未完成 cancel、无 action intent/outstanding/uncertainty、无 pending delivery依赖时，才可在 Delegation owner fence 下写 cleanup request，依次清理 private payload/Child/IPC/temp refs、写最小 tombstone并 `cleanup_complete`；startup 在任一 kill point幂等续做。仍存在任一 Call reference 时必须回到 Call lifecycle，不得把它误判为 orphan。

`call_delegation_reference_added(dispatchCallId,delegationId,slotIndex,required)` 必须不晚于 Delegation admission 生效。replay必须拒绝缺 reference 的 admitted Delegation、先 release 后 proof、proof不覆盖全部 required slots、重复/错 slot release及 release 后 aggregate回退。whole-Call delete/normal retention由 `call_cleanup_requested` 冻结后按固定引用顺序清理；single delete 由同一 fenced WAL 事务保证 proof→release→delete_requested/裁剪。

`actorScopeTag = HMAC(localSecret, length-prefixed(parentSessionId + activeLineageId + objectId + schemaVersion))`。重复 delete 必须由当前已认证 actor 重算 tag并恒定时间验证：匹配时对 `delete_requested` 幂等续做、对 `delete_completed` 返回同一完成事实；不匹配或 secret/验证不可用时 fail closed，且不能恢复执行。任何崩溃点由 delete/cleanup reconciler 从 WAL、cleanup request、tombstone/事务事实继续，绝不复活 v1/v2 child；清理中的对象也不得成为 v1 adoption source/target。

## 9. 执行结果、反馈与隐私

本节恢复并继续拥有修订前已采纳的执行结果产品契约；[既有执行结果方案与评审](../../归档/评审/2026-09-13-subagent-执行结果语义-方案评审.md)只提供历史评审证据，不能替代本 L1 owner。

`FailureKind` 是一次 Child/provider attempt 的唯一闭集结果分类：`success | incomplete | cancelled | transient_provider | non_transient_provider | unknown_transport | task_failure`。它不拥有 alias、Call cancel、配置暂停、uncertainty、delivery 或产品验收语义。

| FailureKind | 产品语义 | retry / 反馈边界 |
| --- | --- | --- |
| `success` | 当前有效最终助手为 `stop` 且进程/协议完整、正常退出；表示**已返回**。 | 不触发 provider retry；不等于任务完成或验收通过。测试失败等正常业务失败报告仍属于已返回。 |
| `incomplete` | 当前有效最终助手为 `length` 且正常退出，输出被长度截断。 | 不自动 provider retry；保留已捕获报告并明确“未完整返回”。 |
| `cancelled` | 当前调用收到可归因本地 abort，或完整性检查通过后的最终助手 `aborted`。 | 不 provider retry；非本地 signal close 仍由更高优先级裁为 `unknown_transport`。它不同于 durable Call/Delegation 显式取消状态机。 |
| `transient_provider` | 当前最终助手 `error` 自身证明闭集瞬态 provider 错误。 | 仅此类别可使用当前模型有限 retry，再有序 fallback。 |
| `non_transient_provider` | 当前最终助手 `error` 自身证明认证、模型、请求合同或其他非瞬态 provider 错误。 | 不 retry、不 fallback；不得被过程工具状态污染。 |
| `unknown_transport` | spawn/进程/流式协议/header/terminal 完整性无法证明，或 stop/length 伴随非零退出。 | fail closed，不 provider retry；不得借旧 terminal 声称返回。 |
| `task_failure` | 只为旧历史/外部注入兼容读取保留。 | 当前 runner 不由过程工具错误生成；按非重试失败处理，不回写为 success。 |

当前 attempt 的终态裁决顺序固定且不可调整：

1. 当前调用本地 abort → `cancelled`；
2. spawn/JSON/header/身份失败、空输出、畸形记录、signal close(code=null) 或没有当前有效最终助手候选 → `unknown_transport`；
3. 当前最终助手 `aborted` → `cancelled`；
4. 当前最终助手 `error` → **只读该消息自身**的类型化 status/errorMessage，裁为 transient/non-transient provider；
5. 其余 `stop/length` 但进程非零 → `unknown_transport`；
6. 当前最终 `length` → `incomplete`；
7. 当前最终 `stop` 且正常退出 → `success`。

终态候选只属于最新消息周期。候选后出现 assistant `message_start`、assistant `toolUse`（包括承载该 toolUse 的 assistant message）或任一 tool execution start/end event，旧候选立即失效；普通 `turn_end` / `agent_end` 不清除候选。没有新的有效 terminal 就必须 fail closed，不得复用旧 stop/error。历史工具状态、旧 provider error、stderr 或过程 `tool_execution_end.isError` 只进入有界、脱敏 diagnostics，不参与当前 provider 分类，也不触发 provider retry/fallback。

每个 attempt 允许可选 `phase=running | finished`；它只表达 attempt 生命周期，不是第二套结果或验收状态。新 runner 在运行投影中给出 `running`，完成裁决后给出 `finished`；历史记录缺 `phase` 仍合法。`phase=running` 或 host `isPartial` 表示 progress，必须显示“执行中”，不得依据暂存 `failureKind` 绘制终局失败图标或文案。

每个 attempt 允许可选 `diagnostics={toolErrorCount, providerErrorCount}`。新 runner 必须始终输出这两个 `Number.isSafeInteger(value) && value >= 0` 的安全整数；历史记录整体或任一计数字段缺失时，对应值显示“未提供”，不得解释、聚合或补写为 0。`toolErrorCount` 按该 attempt 的全部工具结束事件计数；工具详情可以有界截断，但截断只影响详情条数，绝不改变、归零或封顶计数。`providerErrorCount` 只统计该 attempt 已完成的 assistant provider error 消息，不参与最终 provider 分类的来源扩张。

所有 surface 使用同一个严格白名单、安全投影；diagnostics 与详情不得包含 token、Cookie/Set-Cookie、header、原始 provider error/body/status、stderr、raw tool args/result/payload、task/prompt、绝对路径或嵌套未脱敏对象。用户与下游传播的固定中性段只能是：`[执行诊断：不代表验收结论；工具异常 N；模型异常 M]`；N/M 分别使用安全整数或“未提供”，不得改写为“通过/失败/已解决”，也不得用计数推导验收结论。

组合反馈固定为：single 在报告后附该 attempt 的固定中性段；chain 仅因前一步 `failureKind != success` 停止，并把前一步最终助手报告与其固定中性段一起传播给下一步，即使模板未引用 `{previous}` 也不能丢失；parallel 按原 index保留每项报告、FailureKind 与各自固定中性段，再统计“已返回 N/M”，不得把逐项诊断折叠、覆盖或称 succeeded/通过。single/chain 正常 `success` 只显示“已返回”。任何正常业务失败报告仍按“已返回”传播，但不能授权超范围动作或代表验收通过。

| 时点 | 默认反馈 | 必须可展开事实 |
| --- | --- | --- |
| Admission | “已受理委派” | call/delegation 安全引用、parent 持久性/进程内降级、cwd scope、requested target；`persistent:false` 明示“仅不保留 Child Session，恢复记录/private payload 仍按保留期持久”。 |
| Alias 修正 | “已将 implement 解析为 implementer” | canonical provenance 与配置版本引用。 |
| 配置暂停 | “委派已暂停：配置需修复” | 冲突/认证/模型类别、修复动作；不得显示 provider transport 假因。 |
| 自动恢复 | “正在继续上次委派（恢复 1/3）” | cycle、resume/new-session、child 安全引用与分层 attempts。 |
| 副作用不确定 | “已暂停，需确认外部动作结果” | action 类别、最后确认点、重复风险与五种人工选项。 |
| Cancel receipt | “已收到取消请求，正在安全取消” | control surface、target/scope、安全actor引用、WAL receipt与`requested/already_requested`；不得提前称已取消。 |
| 取消处理中 | “正在安全取消委派” | `cancel_requested`、pre-spawn无执行事实核验（有reserve封存/无reserve fact）或post-spawn child wait/death与action对账状态；不得提前称已取消。 |
| 显式取消完成 | “委派已取消” | pre-spawn completion证据（无spawn、无child/live ref、无action intent/outstanding action，且有reservation已封存或已写no-reservation fact）或post-spawn child death/action对账证据，以及可审计用户动作与生效范围。 |
| Recovery notification | “恢复完成（新消息）”或“结果可查询、通知状态不确定” | stable deliveryId、canonical Agent、实际模型、attempts、outbox/receipt 状态；明确原 tool call 仍 interrupted，不称恢复原 toolResult/exactly-once。 |
| Cancel notification | 原调用 interrupted 时可发“已取消（新消息）”，或“取消结果可查询、通知状态不确定” | stable deliveryId、Call cancelled、outbox/receipt；无法证明发送则不重发。 |
| Normal delivery proof | “正常结果已由宿主持久化”或“正常投递尚未证明” | 原 toolCallId、同 active lineage host entry 安全引用、`normal_tool_result_observed`；不得称 execute 返回与宿主持久化原子完成。 |
| Call-wide cancel status | “整批调用已取消” | 按原 index 展示 `returned_before_call_cancel` / admitted-cancelled / not-admitted 三类；不得生成 partial-success aggregate。 |
| Delivery abandon | “已放弃后续通知” | deliveryId、`delivery_abandoned/no_future_send`、安全actor/时间；明确不重发且不改变原调用 interrupted/outcome。 |

隐私边界按表验收：

| 表面 | 必须保证 |
| --- | --- |
| argv / process list | 不出现原始 task、system prompt、token/header、private payload 内容或可读 secret；只允许无业务语义的 opaque id/ref。 |
| 临时 system prompt / recovery payload | owner-only 权限、拒绝 symlink/非 owner；成功、异常、signal 与重启清扫都可证明清理。 |
| IPC socket/pipe | endpoint 目录与对象 owner-only；握手校验 supervisor/child identity、delegation、execution scope 与 fencing generation；伪造、旧 generation、重放或乱序 ACK fail closed。 |
| IPC frame / WAL / outbox | 长度与 schema 有界，敏感字段先 redaction 再记录；原始 token、header、provider body、绝对 cwd、task/prompt 不进入普通 frame 日志或公开投影。 |
| TUI / Tool details / query | 只返回白名单安全摘要；notification 明确 at-most-once 与 interrupted 边界。 |

存储内不可避免的敏感原文必须最小化、权限受控并受保留/GC 约束；Git 永不承载这些材料。

## 10. Acceptance Definition

| 编号 | 可执行场景 | 通过条件 |
| --- | --- | --- |
| S1 | single/parallel/chain admission 与 startup pre-execution | Dispatch Call 与每个实际 task unit 在 discovery/spawn 前持久化；非法 shape 不建记录。Startup 扫描当前 active lineage 全部非终态 durable records，只能先 durable CAS/owner-fenced 归一，扫描本身 resolution/spawn/reattach/send=0。 |
| S2 | `agent=implement`，canonical 为 `implementer` | raw candidates 先做 realpath/trust 校验；合法 project-over-user shadow 不算 duplicate；唯一 effective match 原子绑定 `source + discoveryRootRealpath + fileRealpath + digest`。 |
| S3 | resolver 负向矩阵 | 越界/悬空 symlink、非法 raw candidate、effective-set duplicate canonical、alias↔canonical、alias↔alias、unknown target 全部 fail closed 到 `paused_configuration`，spawn=0；名称问题不伪装 provider failure。 |
| S4 | startup reserve/binding 回放 | 唯一边为 `admitted/bound(canonical-bound) --initial_reserved--> initial_ready(reservationId) --spawn_started--> initial_running` 与 `recovery_ready --cycle_reserved(+1)--> cycle_ready(reservationId) --spawn_started--> recovery_running`。startup 发现既有 reserved event 只投影对应 ready(reservationId)，reserve append/计数均为0；canonical admitted/bound无reserve仍停原投影并交reservation executor。每次转移先 CAS/fenced claim，同 `(scope, continuationEpoch, fence generation)` 第二个 spawn intent被拒。 |
| S5 | post-spawn child 生死回放 | `spawn_started/spawned` 后只 reattach 身份匹配的 live child；dead child 且无 return 时同 reserve respawn=0，下一 spawn 先 durable 新 cycle +1；initial dead 进入 cycle 1。 |
| S6 | 三层预算 | 每个 Delegation 至多一次 initial spawn/execution；pre-spawn 显式取消时 initial=0，正常受理且未取消时 initial≤1。initial 不计 cycle；每 cycle 每模型 initial+最多2个闭集瞬态 retry，再有序 fallback；仅允许 recovery cycle 1/2/3。initial + 三轮 recovery 最多 4 次逻辑 child spawn（reattach 不计）；cycle 4 与第 5 次总逻辑 spawn均为 0。 |
| S7 | 配置修复/人工确认 continuation | 每次有效决定单调增加 `continuationEpoch` 且决定本身不加 cycle；只允许继续 admission、使用未 spawn reserve或 reattach live child；dead child replacement 仍新建 cycle。 |
| S8 | supervisor 混合状态与 owner transfer | 普通 recovery 只 claim `recovery_ready`。pre-spawn transfer仅在fenced WAL两次稳定证明从未`spawn_started`、无child/live ref、无action intent/outstanding action时要求旧supervisor death proof，child absence只记WAL/no-ref proof且不得虚构child death。任何历史`spawn_started`后才要求supervisor+child death proof及action reconciliation。lease TTL、单次`kill(0)`、revoke/terminate/terminal ACK均不能替代。Darwin同PID但稳定可读birth identity mismatch经identity lock内两次稳定观察即为原进程death proof且绝不signal复用PID；birth缺失/不可读/观察不稳定才`paused_integrity`、spawn=0。 |
| S9 | cancel/interruption | shutdown/reload/signal/timeout/不明 aborted 只记 interruption。显式取消先 durable `cancel_requested`并阻止新spawn/intent。通常pre-spawn scope按无spawn/child/action事实封存reservation或写no-reservation fact后直接`cancelled`，不虚构death；post-spawn须terminate/wait、death证明与action对账。`paused_configuration`必须按Delegation历史分流：历史从未`spawn_started`才走pre-spawn completion，历史曾spawn则必须证明历史child已终止并对账outstanding action后才cancelled。resolution executor每次行动前重读fenced cancel；unresolved→`paused_uncertainty`，post-spawn死亡不可证明→`paused_integrity`；覆盖paused_configuration两条历史、cancel WAL后且从未spawn的恢复、cancel WAL后/terminate前、terminate后/outcome前、in-flight action cancel。 |
| S10 | active lineage | 相同 parent/anchor 但 sibling fork/tree lineage 不 claim、不通知；只有相同 activeLineageId + anchor + pre-binding/canonical identity 才可继续。in-memory parent 仅进程内恢复并明确反馈。 |
| S11 | chain cancel 与顺序 | 严格 `NEXT→admit→execute/recover→returned→advance cursor`；任一step显式取消后等待其严格取消完成，future step admission/spawn=0并只记`not_admitted_due_to_call_cancel`；全部required step slots达到取消终止条件后Call=`cancelled`，success aggregate=0。仅全部 required steps returned 才正常聚合。 |
| S12 | parallel item/call-wide cancel | item cancel只取消该item、其他item继续，最终按原index聚合且包含该item=`cancelled`。call-wide cancel停止新admission，并把每个required slot恰好结算为三类：cancel前已returned→不可变`returned_before_call_cancel`；已admit非终态（含`resolution_ready`）→按S9收敛`cancelled`；未admit→`not_admitted_due_to_call_cancel(index)`且Delegation/spawn=0。三类全终态后Call outcome=`cancelled`；不生成/声称partial-success aggregate，但status/query按原index显示取消前返回项。startup/并发cancel/kill幂等补齐且禁止改写returned。 |
| S13 | Call 最终门禁与取消通知 | paused/progress 不是 final outcome/delivery。正常item-cancel/chain只有满足其正常终止条件才生成aggregate；call-wide cancel三类slots全部终态后只生成Call cancelled outcome与独立proof，不生成partial-success aggregate。原调用interrupted时稳定deliveryId取消custom message同branch可见≤1；投递不可证明不重发且status可查询。 |
| S14 | canonical revision | 同 name/source/root/file 的 digest变化只有`config_revision_accepted`后继续；跨source/name/root/path更新拒绝。 |
| S15 | recovery completion message | 原 tool call 保持 interrupted；恢复只新增带稳定 deliveryId 的 custom message，不补写原 toolResult。单 active branch 可见同 deliveryId 消息至多 1 条。 |
| S16 | recovery outbox 崩溃窗口 | durable outbox、active-branch receipt scan 与单 owner/fencing 生效；无法证明已投递时不重发、状态为 queryable uncertainty，不声称 exactly-once/至少一次。主 Agent 可按稳定 id 查询结果。 |
| S17 | side-effect intent/result ACK | recovery-managed child以`--no-extensions`启动，只按版本固定allowlist顺序显式`-e`加载必要custom-tool extension，fence interceptor最后加载；ambient/auto-discovered extension=0。所有tool name/args改写必须在interceptor前完成；interceptor hash/持久并ACK最终输入，之后handler改写=0。仅Policy需fence工具在intent ACK前执行=0；result ACK基于最后middleware result，失败由独立watchdog终止并暂停。加载顺序/排他性不可证明时该工具自动恢复=0并进入`paused_integrity/uncertainty`。 |
| S18 | 身份与 canonical revision 组合场景 | 并行两个相同 requestedTarget/cwd/discoveryScope item 仍有独立 Delegation；pre-binding 配置修复不换 id；同 canonical name/source/root/file 的 digest 只有 `config_revision_accepted` 后更新；跨 source/name/root/path 自动 rebind=0。 |
| S19 | `persistent:false` | admission 明示行为/隐私变化与 cancel/query/`subagent_delete` 入口；Call/Delegation/private payload 保留，Child 不保留；中断可 retry-new-session，不能称完全向后兼容。 |
| S20 | v1 adoption/rollback | bridge-v1必须先发布/安装并用真实bridge binary验证可识别独立受保护preservation marker及30天mtime/GC/rollback边界；未安装bridge时既有v1 adoption=0并保持legacy explicit-handle-only。adoption只复制/分叉到独立v2 namespace；当前更老v1 binary不承诺保护v2 adoption或直接安全回滚。rollback仍要求death proof、outstanding action=0且无in-flight outbox。 |
| S21 | Child quarantine、namespace 与 GC | v1/v2/live Delegation 引用不被跨 namespace 删除；固定锁序无死锁；崩溃残留可重入清理。 |
| S22 | Pi 0.84.4 interceptor E2E | `--no-extensions` + allowlist `-e` + interceptor-last 的实际加载清单/version/digest均可证明；真实 custom tool 覆盖 return-isError/throw、前置args rewrite、后续handler改写反例与最终result rewrite。interceptor持久hash必须等于实际执行输入，result ACK必须等于最终middleware result；排他性失败或ACK失败时watchdog杀child并暂停。 |
| S23 | IPC 与进程隐私 | argv/process list、IPC endpoint/frame、伪造/旧 generation ACK、临时 prompt 权限与异常/重启清理全部通过负向测试，无敏感原文公开泄漏。 |
| S24 | 保留与查询 | 30 天到期只触发 eligibility 检查。active/nonterminal、任一 uncertainty、pending/sending/uncertain delivery、outstanding action、active claim/live child/外部 live reference 一律 retention 不 eligible，原文/private/proof不得删除；状态继续可查询。只有满足 S43 的终态对象才可 fenced cleanup。 |
| S25 | Fast 回归 | 仅第一个 logical child 首次 spawn 可命中；provider retry/fallback、resume、replacement、continuation 和 crash replay 注入次数均为 0。 |
| S26 | 真实进程/生命周期 E2E | headless + PTY/TUI/provider覆盖crash/restart、active/sibling lineage、parallel、chain、owner fencing、side-effect、notification与delete/reference kill points；pre-spawn transfer证明无child事实但不生成child death，post-spawn transfer证明双death/action。Darwin覆盖同PID birth mismatch（判原进程death且signal=0）、birth不可读/缺失/两次观察不稳定（paused）、直属waitpid与两个真实Node进程kill/restart；不以TTL、单次kill0、mock或不可用pidfd措辞替代。 |
| S27 | 五种 side-effect 人工处置与引用释放 | succeeded不重做；not_started/safe-to-retry增加continuationEpoch；still_unknown保持暂停；cancel走严格状态机；dead child后续spawn仍消耗新cycle。action/cancel未对账时`reference_release_eligible=false`、single delete=0；对账完成仍须满足normal/custom final delivery与全部slot终态，再按S40事务生成proof/release。 |
| S28 | startup reconciler 全状态矩阵 | active lineage 的 admitted/prebinding/resolving、bound、已有reserved event、spawned-live、spawned-dead分别归一/路由到`resolution_ready`、bound reservation executor、`initial_ready/cycle_ready(reservationId)`、reattach-only、recovery_ready；startup已有reserve时append reserve/count=0。paused/cancel/delete/terminal/delivery complete走专门reconciler/终态；`paused_configuration` cancel按Delegation完整spawn历史分流。pre-spawn owner transfer两次稳定观察WAL/no-ref且只证明supervisor death，post-spawn才要求child death/action。parallel call-wide cancel回放按同fence保留returned-before-cancel、推进admitted非终态cancel、补齐未admit占位，三类全终态后Call cancelled。并发startup重复执行/spawn/count=0。 |
| S29 | `subagent_delete` 权限、引用完整性、幂等与崩溃 | 只有同parent/active lineage actor可删；active child、取消未完成、uncertain action、未完成custom delivery、未证明normal delivery、live v1 adoption ref均fail closed。single preflight只检查`reference_release_eligible`；false时delete/prune=0，true时同一fenced WAL事务按独立非private proof→reference_released→delete_requested→prune执行，无先release循环。single删除后proof保留；whole-Call delete必须进入S43共享`call_cleanup_requested` lifecycle，不能直接删proof/private records。 |
| S30 | 运行中 `subagent_cancel` 控制面 | tool/command/RPC/UI共享同一control service；command/UI在当前child tool运行期间无需等待下一LLM call即可durable写`cancel_requested`并返回receipt。同parent+active lineage、target/scope组合、item/call-wide语义均fail closed；并发重复请求只有一个append winner且反馈区分requested/already_requested/completed。 |
| S31 | `subagent_delivery(action=abandon)` | 仅同parent+active lineage actor可把pending/sending/uncertain delivery写成`delivery_abandoned(no_future_send)`；resend/requeue=0，重复abandon幂等，已receipted不倒写。status不做control/send/delete；仅S39允许把既有host normal toolResult写成幂等observation。 |
| S32 | Darwin death-proof adapter | durable process identity含host、PID、process birth/start identity、child session/path与argv digest；直属进程由waitpid裁决。重启后Darwin inspection中，PID不存在或同PID但稳定可读birth identity mismatch，经identity lock内两次稳定观察即证明原进程死亡；复用PID signal=0。同PID同birth但session/path/argv不匹配为integrity事故；仅birth identity缺失/不可读、权限不足或观察不稳定才`paused_integrity`。transfer另按S8区分pre/post-spawn并要求相应action事实。 |
| S33 | `FailureKind` 闭集与表面映射 | 唯一闭集恰为`success/incomplete/cancelled/transient_provider/non_transient_provider/unknown_transport/task_failure`；API、registry、metadata、Tool details/UI对同attempt一致。每attempt的`phase`仅可选为`running|finished`并只作生命周期投影；缺失兼容历史记录，不新增验收状态。 |
| S34 | 固定终态裁决顺序 | 同一fixture组合本地abort、signal/协议失败、aborted/error、非零exit、length/stop时严格按§9的1–7顺序得唯一FailureKind；最终provider分类只读当前error自身status/errorMessage，旧tool/provider/stderr不污染。 |
| S35 | terminal候选失效 | stop/error/aborted/length候选后出现assistant `message_start`、assistant `toolUse`或任一tool execution事件时旧候选失效；无新terminal→`unknown_transport`。普通`turn_end/agent_end`后候选仍有效。 |
| S36 | 业务失败与过程工具错误 | 测试/命令失败但Child正常交回报告→`success`并显示“已返回”，同时保留脱敏tool diagnostics且不称验收通过；过程tool error不产生`task_failure`、不触发provider retry/fallback。 |
| S37 | single/chain/parallel反馈传播 | single附报告+固定中性诊断段；chain仅failureKind非success停止，并传前一步报告+同段，即使无`{previous}`也不丢；parallel按原序保留每项FailureKind/报告/同段并显示“已返回N/M”，不用succeeded/通过。固定段恰为`[执行诊断：不代表验收结论；工具异常 N；模型异常 M]`。 |
| S38 | call-wide cancel已返回项 | cancel与return竞态由同一Call owner fence线性化；cancel前returned slot只写不可变`returned_before_call_cancel`且不被倒写cancelled，非终态admitted最终cancelled，未admit写占位；三类齐全后Call=cancelled，partial-success aggregate=0，status仍可展示已返回项。 |
| S39 | normal toolResult delivery proof | execute返回后尚无宿主持久化证明时delete=0。后续delete/status只在同active lineage扫描到唯一、与originalToolCallId匹配的host-persisted toolResult后幂等写`normal_tool_result_observed`；其等价final delivery complete。跨lineage/缺失/重复匹配fail closed，不声称返回前原子持久。 |
| S40 | reference release无循环 | single delete preflight不要求proof/release已存在，只计算`reference_release_eligible`；false时WAL delete/prune=0，true时同一fenced WAL事务严格proof确认/写入→release→delete_requested→prune，全部kill points重放幂等且不越序。 |
| S41 | Call Aggregate Proof与GC | proof为独立非private Call对象，覆盖slot/order/outcome与有界安全ref。single Delegation删除不删proof；whole-Call delete或normal retention只有进入S43共享fenced cleanup lifecycle、按引用顺序级联后才删除proof/private records并留五普通字段+actorScopeTag最小tombstone30天；不得直接GC proof。 |
| S42 | attempt diagnostics完整契约 | 每attempt可选`phase=running|finished`；新runner始终输出`toolErrorCount/providerErrorCount`两个非负安全整数，历史缺任一字段逐项显示“未提供”且不解释为0；100条等有界tool详情截断不改变全量计数；所有投影无敏感/raw payload。running/isPartial只显示progress且无终局失败图。single/chain/parallel严格按S37传播固定中性段。目标实现与回归证据见[L2 §5](../../02-产品实现/subagent-dispatcher-技术设计.md#5-当前基线执行结果分类重试与-fallback)、[§9.8](../../02-产品实现/subagent-dispatcher-技术设计.md#98-dispatch-call-编排delivery-proof-与-recovery-notification)和[§9.11](../../02-产品实现/subagent-dispatcher-技术设计.md#911-验证矩阵目标)。 |
| S43 | normal retention / whole-Call共享cleanup | normal retention不得直接删除。`retention_eligible`仅在Call/slots终态、final delivery/proof完整且无active/nonterminal/uncertain/pending delivery/action/active claim/live child/外部live ref时成立；随后与whole-Call delete共用`call_cleanup_requested`冻结→复核terminal/delivery/proof→按reference顺序release/级联Delegations→删除private records/CallAggregateProof→最小tombstone→`cleanup_complete`。startup在任一kill点幂等续做。single orphan Delegation也须terminal、无live refs/actions后走fenced cleanup；否则删除为0。目标WAL、锁序和kill E2E见[L2 §9.3](../../02-产品实现/subagent-dispatcher-技术设计.md#93-delegation-wal-与崩溃一致性)、[§9.9](../../02-产品实现/subagent-dispatcher-技术设计.md#99-persistentfalsev1v2-namespace回滚与-gc)、[§9.10–§9.11](../../02-产品实现/subagent-dispatcher-技术设计.md#910-崩溃点矩阵)。 |

## 11. 继续前提

本方案已由同一固定 revision 的[产品语义/指标轴](../../归档/评审/2026-09-14-subagent-dispatcher-产品语义指标Review-Artifact.md)与[实现/运营轴](../../归档/评审/2026-09-14-subagent-dispatcher-实现运营Review-Artifact.md)批准，并由[Adoption Decision](../../归档/评审/2026-09-14-subagent-dispatcher-Adoption-Decision.md)正式采纳。AR3-4/AR3-5 及此前 required Findings 已为 `resolved_fixed`；Acceptance 保持 S1–S43 连续。

已采纳，可按 Adoption Decision 的切片进入实现。继续前提是：

1. `bridge-v1` 必须在采用任何既有 v1 session 前先发布、安装并验证；未满足时 adoption=0，旧 session 保持 legacy explicit-handle-only；
2. 每个 coding 切片保持当前 v1 基线事实不变，按 `implementer → code_reviewer` 关闭实现 Finding，并同步 L2 当前事实与剩余 drift；
3. 最终完成必须逐项满足 S1–S43 及 L2 真实 E2E/安全门禁。

当前 L2 事实摘要：slice0–7 gated internal foundations 已有源码/测试（admission/recovery、cancel/call orchestration、delivery、action ledger/fence、cleanup、bridge adoption/rollback foundations）；这只是 L2 当前事实摘要，不改变 L1 产品契约。产品级 v2 仍未完成/未启用，capability disabled，root/v1 wiring=0；真实 bridge-v1 binary+30d、side-fence production proof、Darwin/跨进程/power-loss/provider/TUI/delivery host/control adapters E2E 均未完成，不得声称 production ready。

详细当前事实与 drift 以 [L2 §9](../../02-产品实现/subagent-dispatcher-技术设计.md#9-目标设计尚未实现) 及其源码/测试为准；本节不重复实现细节，避免形成 L1/L2 双 owner。
