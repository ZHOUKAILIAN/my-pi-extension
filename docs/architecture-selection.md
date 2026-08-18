# 多 Agent Pi Extension 技术方案选型

## 1. 要解决的问题

希望把 `work`、`build` 一类开发任务从“一个主 agent 自行读代码、改文件、自己确认完成”的模式，变为有强制协作门禁的工程流程：

1. 技术方案由多个独立角色提出、质疑、收敛。
2. 实现工作委派给有边界的 worker agent。
3. 代码审查不是实现者自审；至少存在交叉审查和独立验证。
4. 主 agent 不可绕开委派机制直接使用项目读写/执行工具。
5. 系统按照任务阶段和角色，控制可发现/调用的 skill、可见上下文和实际能力。
6. 系统保留从用户需求到最终验证结论的完整证据链。

Pi 原生提供 extension、工具、事件、CLI 和 SDK，但**没有内建的 subagent 编排产品能力**。因此这个仓库实现的是 Pi 上层的**工作流治理 runtime**，而不是接一个已有的 Pi 原生 `subagent` API。

术语以仓库根目录的 [CONTEXT.md](../CONTEXT.md) 为准。这里特别区分三个不能混用的控制面：

| 控制面 | 解决的问题 | 第一版机制 | 是否是安全边界 |
|---|---|---|---|
| Skill Routing | 这个角色可使用哪些工作方法 | `--no-skills` 加显式 `--skill <path>`，加上 Policy 校验 | 否 |
| Context Isolation | 这个角色本轮能看到哪些信息 | 最小 Context Capsule；只传允许的 Artifact，不传主会话全文 | 否 |
| Capability Isolation | 这个角色实际能读、写、执行什么 | Pi 工具白名单、shell wrapper、worktree/容器、自定义工具 | 是，前提是底层隔离可信 |

## 2. 概念与职责

```text
用户
  -> 主 agent（任务判断和阶段推进）
  -> delegate_task extension tool（权限控制、启动 worker、记录 trace）
  -> worker Pi agent（完成一个边界明确的子任务）
  -> 结构化结果回到主 agent / 协调器
```

### 主 agent

主 agent 是编排决策者，不是默认执行者。它只允许调用 `delegate_task`、读取 worker 的结构化结果，并根据阶段门禁决定下一步。它不能直接调用 `read`、`bash`、`edit`、`write` 等项目操作工具。

### Policy 与 `delegate_task`

Policy 是版本化的唯一控制源，至少定义：阶段状态迁移、Role、工具白名单、skill 白名单、上下文规则、产物 schema、预算和批准条件。`delegate_task` 是本 extension 提供的工具，不是 Pi 自带工具；它解释并执行当前 Policy：

- 校验当前阶段允许委派哪个角色；
- 按角色和阶段生成 Context Capsule、worker prompt、工具白名单和 skill 白名单；
- 启动/取消 worker；
- 收集 stdout、退出码、工具事件、耗时和 token usage；
- 校验 worker 输出的结构化结果；
- 将结果和 trace 写入 session 或本地 trace 文件。

这意味着主 agent 不能自行决定“现在加载一个额外 skill”或“把所有历史发给 reviewer”。它只能请求委派，extension 依据 Policy 决定该请求是否有效。

### Worker agent

Worker 是一个独立运行的 Pi agent，不是 extension 自己实现一套 LLM loop。第一版由 extension 调用子 Pi CLI 进程启动；Pi 仍负责模型调用、工具调用和 agent loop。

Worker 必须只承担一个完整子任务，例如“只读定位根因”“提出方案并列出权衡”“按既定设计修改代码”“独立执行验证”“审查某个指定 diff”。不要为每次 `read` 或每条 shell 命令启动一个新 worker。

每个 Worker 只收到一个 Context Capsule：任务目标、角色约束、基准版本、验收条件、允许的 Artifact 引用、允许 skill 路径以及必要文件引用。默认不继承主 agent 的完整对话、其他 worker 的隐藏推理或全局 skill 清单。

子 Pi 使用 `-p --no-session` 时会启动新的 Pi session，不会自动继承主 session 的消息树；这正适合 worker 隔离。worker 获得什么信息，必须由 `delegate_task` 显式放入 Context Capsule 或由允许的资源发现规则加载。

### Policy 最小模型

第一版不应把策略写死在 TypeScript 的 `if/else` 里。将策略存为版本化 JSON/YAML，extension 只做 schema 校验和执行。例如：

```ts
type RolePolicy = {
  role: "investigator" | "architect" | "challenger" | "implementer" | "reviewer" | "verifier" | "arbiter";
  allowedStages: string[];
  tools: string[];
  skillPaths: string[];
  allowedArtifactTypes: string[];
  context: {
    includeUserGoal: boolean;
    includeProjectInstructions: boolean;
    includeFullSession: false;
    maxArtifactBytes: number;
  };
  writeMode: "none" | "current-worktree" | "isolated-worktree";
  budget: { maxWorkers: number; maxDurationMs: number; maxTurns?: number };
};
```

实际启动 worker 时，Policy 映射为 Pi CLI 参数和 Context Capsule：

```text
Policy.tools       -> --tools <allowlist>
Policy.skillPaths  -> --no-skills + repeat --skill <path>
Policy.context     -> 由 extension 构造 workerPrompt，不转发主 session
writeMode          -> cwd / 临时 worktree / 容器及对应文件系统权限
allowedArtifacts   -> capsule 内可引用/展开的 artifact 白名单
budget             -> timeout、并发锁、轮次和成本阈值
```

这样 skill 选择本身也能审计：trace 应记录某次委派实际允许了哪些 skill 路径、worker 是否读取了该 skill、以及它产出了哪个 Artifact。

## 3. 方案选项

| 方案 | 实现方式 | 优点 | 代价 | 结论 |
|---|---|---|---|---|
| A. 子 Pi CLI worker | extension 用 `pi.exec()` 启动 `pi -p` | 进程隔离清晰；复用现有认证、模型、工具；容易观察和 kill；首版实现小 | 初期只能从 stdout 得到结果；需设计输出协议和并发控制 | **第一版采用** |
| B. Pi SDK in-process worker | extension 内用 `createAgentSession()` 创建内存 session | 可订阅 tool/message 事件；有类型和 usage；更适合并发、细粒度 trace | 生命周期、资源加载、认证、取消和 session 隔离复杂；容易与宿主 runtime 混淆 | 第二阶段演进 |
| C. 引入已有 agent-team/package | 安装并适配一个既有协作运行时 | 可能较快获得团队管理能力 | 依赖的协议、持久化和权限模型未验证；会把核心控制权交给外部实现 | 先调研，暂不作为基础 |

### 推荐：A，子 Pi CLI worker

典型执行形态：

```ts
const result = await pi.exec(
  "pi",
  [
    "-p",
    "--no-session",
    "--no-extensions",
    "--tools",
    workerTools,
    workerPrompt,
  ],
  { signal },
);
```

这里的关系需要明确：

- `delegate_task` 是本项目写的 extension 工具；
- 子进程里的 agent、模型调用和 `read`/`bash`/`edit`/`write` 工具仍然由 Pi 提供；
- `--no-extensions` 防止 worker 自动加载本 extension 后递归生成 worker；
- worker 在当前项目 `cwd` 运行，允许写入时修改会直接落到当前 worktree；
- 初期用 `-p` 取得结果，后续可转向 `--mode rpc`，获得流式、结构化的事件协议。

不应默认添加 `--no-context-files`。项目 `AGENTS.md` 常含工程约束，worker 通常应继承。若某些上下文文件不可信或会污染角色约束，应通过独立的 worker cwd/资源加载策略处理，而不是静默丢弃项目规则。

Skill Routing 的 CLI 原型应为 `--no-skills` 配合角色允许的重复 `--skill <path>`，防止 Pi 自动发现所有全局和项目 skill。注意：这只控制 Pi 的 skill 发现和 system prompt；拥有 `read`/`bash` 的 worker 仍可能从磁盘访问未授权 skill。因此禁止访问本身要由文件系统/容器/自定义只读工具实现。

## 4. 为什么不是“extension 自己编排全部流程”

有两种运行模型：

| 模型 | 谁决定下一步 | 适用情况 |
|---|---|---|
| 固定 pipeline | extension 状态机 | `work`/`build` 的标准流程、需要可预测门禁的场景 |
| 委派工具 | 主 agent | 开放式任务，主 agent 根据结果决定是否继续调查、返工或补验证 |

本项目采用**混合模式**：extension 拥有不可绕过的阶段状态机和权限门禁；主 agent 在允许的阶段内选择具体委派内容和顺序。

这避免两个极端：

- 全交给主 agent：流程会退化为提示词约束，容易绕过。
- 全写死在 extension：每一种工程问题都要重新编码流程，弹性不足。

## 5. 协作工作流

### 5.1 技术方案阶段

技术方案不能由单一 agent 直接进入实现。建议的最小闭环：

```text
DISCOVERED
  -> RESEARCHING
  -> PROPOSING
  -> CHALLENGING
  -> DECIDING
  -> APPROVED_FOR_IMPLEMENTATION
```

| 阶段 | 角色 | 输入 | 强制输出 | 通过条件 |
|---|---|---|---|---|
| 调研 | investigator | 用户目标、代码/现状 | 事实、影响面、未知项、证据路径 | 事实与假设显式区分 |
| 提案 | architect A、architect B | 调研包 | 至少两个可比较方案、权衡、风险、验证方式 | 方案独立生成，不能互相复制 |
| 质疑 | challenger A、challenger B | 对方方案，不提供作者身份 | 反例、遗漏约束、失败模式、替代建议 | 每项关键质疑有可判定结论 |
| 裁决 | arbiter | 两套方案、质疑和证据 | 选型、拒绝理由、未决风险、验收门槛 | 不能简单“折中”；必须说明为何选择 |

`architect A/B` 不是要无休止互相辩论。应采用最多两轮的受限协议：

1. A、B 独立提案，互相不可见。
2. A/B 匿名审查对方，输出可证伪的质疑。
3. Arbiter 根据事实和质疑裁决；只有“缺少决定性证据”才允许一次定向补充调研。
4. 达到轮次上限仍无法决定时，状态为 `BLOCKED_DECISION`，由用户而非模型猜测性推进。

### 5.2 实现与验证阶段

```text
APPROVED_FOR_IMPLEMENTATION
  -> IMPLEMENTING
  -> CROSS_REVIEW
  -> VERIFYING
  -> ACCEPTED | CHANGES_REQUESTED | BLOCKED
```

| 阶段 | 角色与权限 | 输入 | 输出 | 门禁 |
|---|---|---|---|---|
| 实现 | implementer，唯一写权限 | 已批准决策、验收标准 | diff、变更说明、执行过的检查 | 同一 worktree 同时仅一个写 worker |
| 交叉审查 | reviewer A/B，只读 | 固定 commit/diff、设计决策 | findings，含严重度、证据和建议 | A/B 彼此审查不同来源的实现，或对同一 diff 独立审查 |
| 反驳/修复 | implementer + reviewer | findings | 接受/拒绝每项 finding 的理由，必要的修复 diff | implementer 无权自行关闭自己的 finding |
| 独立验证 | verifier，只读，允许测试命令 | 验收标准、最终 diff | 实际命令、结果、覆盖缺口、结论 | verifier 不得是本次 implementer |
| 最终判定 | arbiter 或主 agent | review disposition、验证证据 | accepted / changes requested / blocked | P0/P1 finding 为零；必需验证通过或明确被阻塞 |

“A 给 B、B 给 A 掰扯”应解释为**交叉 review 与受控 rebuttal**，而不是两人互相说服：

- reviewer 只提交带文件/行号、复现方式和风险的 finding；
- implementer 对每项 finding 给出 `accepted`、`fixed` 或 `rejected`，`rejected` 必须引用证据；
- reviewer 只复核 disposition 是否成立；
- 对同一 finding 最多一轮 rebuttal，之后交给 arbiter；
- arbiter 不能既是 implementer 又是本 diff 的唯一 reviewer。

## 6. 权限与并发模型

### 主 agent 的工具面

主 agent 只启用：

```text
delegate_task
get_workflow_status
get_artifact
```

extension 需要同时做两层控制：

1. `pi.setActiveTools()` 只激活上述工具，作为默认策略；
2. `tool_call` hook 阻止 `read`、`bash`、`edit`、`write` 以及之后动态加入的直接项目操作工具，作为兜底。

单靠拦截不够，单靠 system prompt 更不够。工具白名单才是主要控制面。

### Worker 权限矩阵

| 角色 | 读项目 | 执行命令 | 写项目 | 可启动 worker |
|---|---:|---:|---:|---:|
| investigator | 是 | 只读检查 | 否 | 否 |
| architect/challenger/arbiter | 只读材料优先 | 否或有限 | 否 | 否 |
| implementer | 是 | 是 | 是 | 否 |
| reviewer | 是 | 只读检查/测试 | 否 | 否 |
| verifier | 是 | 是 | 否 | 否 |

Pi 的 `bash` 工具本身无法可靠地区分“只读命令”和“写命令”。第一版中，非 implementer 若需要跑测试，应该使用一个受限 shell wrapper 或隔离 worktree/container；不能仅靠 prompt 声明“不要写”。这是一项必须验证的安全边界。

### 文件与并发

- 写 worker 串行运行；第一版禁止两个 implementer 并发写同一 worktree。
- 只读 worker 可以并行，但应在其输入中固定基准 commit/工作区快照，防止对不同版本得出难以比较的结论。
- 若以后需要并行实现，必须使用独立 worktree 或 patch-only worker，并引入明确的合并者角色。

## 7. 状态、产物与审计

每次任务生成一个 `runId`，保存机器可读状态。建议初期使用 JSON，文档/说明使用 Markdown：

```ts
type DelegationRecord = {
  runId: string;
  taskId: string;
  stage: string;
  role: string;
  workerId: string;
  inputArtifactIds: string[];
  outputArtifactId?: string;
  baseRevision: string;
  writeAccess: boolean;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  usage?: unknown;
};
```

每一个 worker 的输出必须是可校验的结构化结果，而不是一段无法机读的散文：

```ts
type WorkerResult = {
  status: "ok" | "blocked" | "failed";
  summary: string;
  claims: Array<{ statement: string; evidence: string[] }>;
  changedFiles: string[];
  commands: Array<{ command: string; exitCode: number; summary: string }>;
  findings: Array<{
    severity: "P0" | "P1" | "P2" | "info";
    location?: string;
    issue: string;
    evidence: string;
    recommendation: string;
  }>;
  risks: string[];
  nextAction: string;
};
```

输出协议可先让 worker 在最后输出唯一 JSON block；生产化时应改用 Pi custom tool 或 RPC 事件，避免从自由文本 stdout 解析。

应记录的最小证据：

- 原始用户任务和执行时的工作目录/基准 commit；
- 实际给每个 worker 的 prompt、角色、工具白名单和输入材料版本；
- 每个 worker 的退出码、输出、耗时、usage 与失败原因；
- 实现 diff；
- 所有 review finding 和 disposition；
- 验证命令、实际结果和残余风险；
- 最终裁决者、结论及其依据。

## 8. 风险与反形式主义机制

| 风险 | 后果 | 控制 |
|---|---|---|
| 多个 agent 都继承同一错误前提 | 看似有共识，实为同源错误 | 提案独立生成；challenge 先看证据后看结论；必要时引入专门的反证角色 |
| agent 无限互评 | 成本失控，决策不收敛 | 固定轮数、finding 格式、arbiter 裁决、`BLOCKED_DECISION` 升级给用户 |
| implementer 自审或 verifier 复用实现结论 | 验证失效 | 角色隔离；不同 worker ID；verifier 只读且必须给出实际命令输出 |
| worker 递归加载本 extension | 子 agent 无限套娃 | worker 使用 `--no-extensions`；不向 worker 暴露 `delegate_task` |
| 多写者冲突 | 改动互相覆盖 | 单写者锁；后续使用 worktree/patch 合并 |
| 只靠 prompt 限权 | 角色可能仍执行危险命令 | 工具白名单、shell wrapper、容器/worktree 隔离 |
| stdout 叙述不可靠 | 状态无法自动推进 | schema 校验；失败时状态停在当前阶段，不将自然语言当作完成证明 |
| 成本不可见 | 多 agent 工作流难以运营 | 每次委派记录 usage、时长、重试和阶段预算 |

## 9. 分阶段实施建议

### Phase 0: 治理模型验证

- 定义 Policy、Context Capsule、Artifact、`delegate_task` 和 `WorkerResult` schema。
- 用一个只读 investigator worker 和一个只写 implementer worker 做端到端试验。
- 验证 `--no-extensions`、`--no-skills` 加显式 `--skill`、取消信号、项目上下文继承、认证继承和 worker cwd。
- 明确非 implementer 的 shell 和文件系统隔离方案，不能把 role prompt 当作权限控制。
- 用真实 worker trace 重新执行 architect/challenger/arbiter 评议，检验此设计是否可行。

### Phase 1: 最小可用治理 runtime

- 注册 `delegate_task`、`get_workflow_status`、`get_artifact`。
- 主 agent 只保留 delegate/status/artifact 工具。
- 解释一个版本化 Policy：角色白名单、skill 路由、Context Capsule、产物 schema 和单写者锁。
- 子 Pi CLI worker，记录本地 JSON trace，并将摘要写进 Pi session。
- 支持 `investigator`、`implementer`、`verifier`、`reviewer`，并拒绝不符合阶段、权限或 skill policy 的委派。

### Phase 2: 方案协作门禁

- 引入 architect A/B、challenger A/B、arbiter 的阶段状态机。
- 交叉 review、finding disposition 与轮次上限。
- `work`/`build` 命令映射到状态机启动，而不是仅展开提示词。

### Phase 3: 运行时增强

- 从 CLI stdout 协议迁移到 `--mode rpc` 或 Pi SDK，取得可靠的流式事件和 usage。
- 使用独立 worktree 支持受控并行实现。
- 增加可视化 trace、失败恢复、预算上限和策略配置。

## 10. 需要验证、尚未结论的事项

以下项不能在没有实际运行测试前声称已经成立：

1. 当前 Pi 安装的 CLI worker 能否在不显式传 key 的情况下继承所需认证与模型选择。
2. `pi.exec()` 的 cwd 和环境继承是否符合 worker 预期。
3. `AbortSignal` 是否能完整终止 worker 及其 tool 子进程。
4. `--no-extensions` 与项目 `AGENTS.md` / settings 的实际加载组合。
5. 受限 shell wrapper 或容器是否能有效避免 reviewer/verifier 写入工作区。
6. `-p` stdout 的结构化输出在截断、错误和模型偏离时是否可靠；是否应立即采用 RPC。
7. 多 agent 角色提示词能否稳定输出 `WorkerResult` schema，还是应使用 custom tool 作为强制收口。
8. `--no-skills` 加显式 `--skill` 是否在当前 Pi 版本中完全满足资源发现白名单预期，以及 project `AGENTS.md` 中是否会泄漏不应交给当前角色的上下文。
9. Policy 文件如何按项目覆盖全局默认策略，以及策略变更如何版本化、审核和回滚。

## 11. 当前建议的决策

先实现 **CLI worker + 有限状态机 + 单写者 + 结构化 trace**，而不是一开始做 in-process SDK 多 session 或同时引入外部 agent-team runtime。

原因不是 CLI 是最终形态，而是它以较小的代码面验证最关键的产品问题：角色拆分是否真正提高方案质量和审查质量，交叉 review 是否能收敛，权限隔离能否成立，证据链是否足够支撑最终结论。上述机制经真实任务验证后，再迁移 SDK/RPC 才有明确收益。

## 12. 本次设计过程的证据缺口

本文件原计划调用多个现有 Pi subagent，从产品协作、runtime 选型和工程风险三个方向独立评议。2026-08-18 的调用均因当前模型账户 5 小时额度限制返回 HTTP 429，未获得任何 subagent 输出。

因此，本文件中的多 agent 协作流程是待实现的设计目标，不应被误解为已由实际 subagent 评审通过。Phase 0 完成后，应使用真实 worker trace 对本方案重新进行一次 architect/challenger/arbiter 评议，并将结果作为后续实现的依据。
