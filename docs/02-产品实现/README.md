# 第二层：产品实现

第二层（L2）回答“产品当前怎样实现、真实实现了什么”。源码和测试是运行事实真理源；本目录只提供实现入口、机制设计和已知 drift，不重新定义 L1 产品语义。

## L1 → L2 交接

| L1 产品要求 | L2 owner |
| --- | --- |
| Workflow / Node / Run 通用对象 | `packages/workflow-contracts/src/` |
| 状态迁移、Guard、Worker 生命周期、checkpoint 与恢复 | `packages/workflow-runtime/src/` |
| Fix 的命令、Policy、报告和 Pi UI 接线 | `packages/fix/src/` |
| Fix 的可执行 Node/状态图与业务 Guard | `packages/workflow-runtime/src/index.ts`（待迁回 Fix package） |
| Artifact 合同与运行行为证据 | 对应 `packages/*/test/` |
| 当前 Fix 实现机制说明 | [Fix Runtime 技术设计](fix-runtime-technical-design.md) |

L1 Extension 规范描述 Stage、Artifact、Guard 和 Acceptance 的产品语义；L2 将其落实为状态枚举、Transition 配置、Policy 解析、Artifact schema、Guard 代码、Worker 创建、存储接口和测试。

## 实现地图

| 路径 | 责任 | 当前状态 |
| --- | --- | --- |
| `packages/workflow-contracts/src/` | Stage、Artifact、Worker、checkpoint 和提交接口 | 原型已实现 |
| `packages/workflow-runtime/src/` | 通用状态机、Pi SDK Worker、Skill scope、session checkpoint、恢复；当前还包含 Fix Definition | 有限重试与错误分类已实现；Fix Definition owner 待拆分 |
| `packages/fix/src/` | `/fix` command、模型策略、UI 决策、报告、traceId 和审计接线 | 原型已实现；真实 provider E2E 未完成 |
| `packages/*/test/` | 对应源码的行为和回归证据 | 现有自动测试可运行 |

尚未存在 `packages/feature` 和独立 `workflow-ui` 实现。

## 当前实现边界

- Runtime 通过 Pi SDK 创建独立 `AgentSession` 承载 Worker Session；这隔离对话历史，但不等同于进程、文件系统或 OS sandbox。
- Controller 拥有状态迁移、Artifact 合同校验、有限重试、checkpoint 恢复和 `traceId` 审计；Worker 不能授权下一状态。
- 当前实现使用 `investigate`、`implement`、`verify` 三类 Node 和对应 Artifact 合同。
- SDK custom tool 与严格 fenced JSON fallback 都经过同一 Artifact 校验入口。
- 单个 Worker Session 最多两次交付尝试；失败后 Controller 最多创建一个新 Session 重跑当前 Node，仍失败则保留 checkpoint 并提示 `/resume`。
- 项目可以按 Node 配置模型和 Skill；Skill 不扩大工具 allowlist。
- 主窗口 trace 与持久化 entry 通过稳定 `traceId` 关联。

## 已知 L1 / L2 Drift

以下差异是已报告的当前事实，不应通过文档措辞掩盖：

| L1 目标契约 | L2 当前事实 | 处理方向 |
| --- | --- | --- |
| Fix 支持 triage、disposition、change review、正式方案评审和整体 Acceptance | 当前主要是 investigate → implement → verify | 扩展可执行 Workflow Definition 与合同 |
| Fix Extension 应拥有自己的可执行 Workflow Definition | 当前 `fixDefinition`、`fixNodes` 和业务 Guard 位于共享 `workflow-runtime` | 将入口特有 Definition 迁入 `packages/fix`，Runtime 只保留通用执行机制 |
| Artifact / Node Execution 应具有完整来源、身份和版本绑定 | 当前 contracts 尚无完整 `nodeExecutionId`、`workerId`、proposal/revision provenance | 扩充 contracts、schema 与审计字段 |
| 恢复应校验 Workflow、Policy 与 schema 版本兼容性 | 当前恢复主要校验已知 Stage | 增加版本 digest、兼容性 Guard 与迁移测试 |
| Review Finding 有正式 disposition，争议可交 Arbiter | contracts 尚未完整实现 revision-bound review 与 arbiter | 增加 schema、身份约束和 Guard 测试 |
| Feature 有 L1 产品规范 | 尚无 Feature package 或 Workflow Definition | 实现前先以 L1 规范作为输入完成 L2 设计 |
| Context / Capability Isolation 分层治理 | 当前主要是 Session、tools、skills scope | 继续验证文件系统、网络和 shell 的真实边界 |

在这些差距关闭前，README 或报告不得把 Feature 完整流程、Fix 完整治理流程或完整隔离声称为已实现。`/fix` 命令本身已经实现为原型。

## 命名迁移

本次 0.x 产品收敛将历史 `bugFix` 命名统一为 Fix：package、目录、命令、公开 Runtime 符号、trace、run 前缀和 Artifact fallback 都使用 `fix`。

- 新入口只注册 `/fix`；不继续注册旧命令，避免产品存在两套入口。
- package/API 改名属于 0.x breaking change；外部消费者必须迁移到 `@pi/fix`、`fixDefinition` 和 `fixNodes`。
- Run Store 仍可读取旧 `bugFix-` 前缀的未完成 checkpoint，使已有 Run 能通过 `/resume` 继续；新 Run 只写入 `fix-` 前缀。
- 旧 trace 和 checkpoint 作为历史审计事实保留，不回写改名。

## 验证入口

```bash
npm test
npm run typecheck
git diff --check
```

实现变化后更新最接近行为的测试。若实现与 L1 冲突，必须选择修正实现或重新评审产品契约，并保留明确 drift 记录。
