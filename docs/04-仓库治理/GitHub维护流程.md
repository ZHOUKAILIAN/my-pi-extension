# GitHub 维护流程

- 状态：`DECIDED`
- 层级：第四层

本项目使用单一 GitHub monorepo 维护。GitHub Issue 和 PR 保存共享工作记录；各层的活跃文档、源码、测试和配置仍是对应责任的正式真理源。

## 开始工作

1. 在 Issue、用户请求或任务说明中确定目标和边界。
2. 按 `docs/README.md` 将内容路由到主要层级；涉及 L1 时继续区分 Core 与具体 Extension owner。
3. 找到已有 owner 文档、源码模块和测试；已有 owner 时不得创建平行真理源。
4. 若 L1 产品行为尚未对齐，先完成对齐再实现；若 L1 已对齐但本次不实现，必须在 L2 记录 drift。

## 分支与变更范围

- 使用与任务对应的分支和 PR；直接维护 `main` 的策略由仓库所有者决定。
- 一个 PR 可以影响多个层，但必须说明每层为何变化以及写回了哪个正式入口。
- 保持变更聚焦，不回退无关用户改动，不夹带生成物或本地 session 状态。

## Review 与验证

所有需要产生 coding diff 的任务都必须由 `implementer` 执行代码改动，再由独立的 `code_reviewer` 评审。该规则覆盖源码、测试、脚本、构建/运行配置和 UI 代码，不按 work、build、Figma/UI 或改动规模区分；纯文档、纯调查和只读评审不适用。实现者自检或测试通过不能替代独立代码评审。

跨层产品/技术方案在进入实现前，至少经过两条独立评审轴：

- 产品语义/指标评审：检查目标、合法分支、漏斗、分子/分母、去重、终态、隐私和验收语义；
- 实现/运营评审：检查当前源码事实、事件产生点、失败恢复、外部服务、部署、安全和 E2E。

评审 Agent 只报告 finding，不修改方案。主 Agent 负责合并意见，并保留当前事实、目标设计、L1/L2 drift 和未解决分歧。未解决的 P0/P1 finding 或关键产品决策未确认时，不得进入实现。

PR 至少说明：

- 目标和影响范围；
- 受影响的层级与正式 owner；
- L1 与 L2 是否一致；若不一致，drift 是否已明确记录；
- 执行的验证命令及结果；
- 未执行检查、已知缺口和剩余风险。

最低自动验证：

```bash
npm test
npm run typecheck
```

涉及真实 provider、Pi UI 或外部运行环境的行为，仅有单元测试时不得声称 E2E 已完成。

执行中 Worker 协作能力合并前还必须验证：

| 验证项 | 最低证据 |
| --- | --- |
| 单一输入路由 | streaming/idle 输入都到提交时绑定的 Worker；Node close fence 前输入使旧 Artifact 失效并触发绑定最新补充版本的重新交付，fence 后提交保留内容且不广播、不静默改投；真实 ExtensionRunner 吞异常时 input 仍返回 handled、before lifecycle 仍返回 cancel |
| 上下文连续 | recorded/enqueue_accepted/model_call_completed/artifact_bound 逐条可核对；同一 Run 后续 Capsule 使用连续 supplementVersion，恢复后无跳过 |
| 模型切换 | 选择器目标变化 fail-closed；候选满足 scoped/认证/兼容约束；已请求/待生效/已切换/未应用/失败与 Child AgentSession、Audit 一致且不误改主 Session |
| 控制边界 | 补充信息和模型变化不能扩大 tools/skills/capability，不能绕过 Artifact、Guard 或 Acceptance |
| 恢复 | 在 Run Control WAL append/fsync、enqueue、模型调用、Artifact、checkpoint 各边界做崩溃故障注入；operation lock + writer lease/epoch覆盖双 Pi进程、核验/append竞态、reload旧callback迟到和stale owner接管；compaction/sibling branch不作为控制事实；同 Node恢复重投明确展示，跨 Node不自动改投；legacy导入幂等且失败不双写 |
| 父 Session 生命周期 | `/tree`、switch/fork/new/resume、重复 `/fix` 对可取消接缝 fail-closed；reload/shutdown 不虚假承诺可阻止退出，缺少终态时从 durable WAL 推断 interrupted；旧 branch 不再收输入，父 Session 首次落盘前崩溃可经用户确认重绑 |
| 本地数据 | 受控目录实际为 `0700`、文件为 `0600`；20 attempts上限、settled intermediate 30 天、无 live lease unfinished 30 天、parent缺失 settled最多7天可验证；GC锁内复核、tombstone/rename和删除重试覆盖与恢复竞态；新 Run export/share只含 opaque ID/粗状态，legacy边界有提示，公开 Trace/Telemetry无原文 |
| 宿主兼容 | lockfile Pi 版本与受支持宿主均验证；Child 独立 SettingsManager、input hook、后台任务、自定义 editor/keybinding、picker 和 session API 有契约测试，接缝缺失时 fail-closed |
| 真实交互 | 至少一次真实 Pi TUI + provider E2E，证明 `/fix` 单一入口、同一输入框补充和 Child 专用模型选择；单元测试不能替代 |

## 文档写回

- Bug、回归和已有能力优化：产品契约不变时只更新 L2 实现与测试；契约变化时更新对应 L1 owner，并同步实现或记录 drift。
- 新能力：在对应 L1 Extension 建立或补齐产品规范，再实现 L2。
- 纯重构：更新 L2；明确 L1 行为未变。
- L1 产品上下文摘要只能从权威定义派生，不得成为第二套规则源。
- package、配置或目录：更新第三层。
- 协作或质量规则：更新第四层和必要的 `AGENTS.md`。
- 调查、方案比较和评审原文：进入归档，并从已采纳层链接到结论的正式写回位置。

## 完成与合并

只有以下条件满足时才可以声称任务完成：

1. 所有受影响层都有明确 owner 和必要写回。
2. 未报告的产品定义与实现漂移为零。
3. 自动验证已通过，或阻塞已明确说明。
4. Markdown 内部链接在文档变更后仍可解析。
5. Git diff 中没有 secrets、生成物、临时 trace 或无关改动。
