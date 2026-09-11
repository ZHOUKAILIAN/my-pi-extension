# 第一层：产品定义

第一层（L1）回答“产品是什么、必须保证什么”。它同时按责任分为 Core 和 Extension：Core 保存所有入口共享的语义；每个 Extension 保存自己的目标、流程、产物和最终验收语义。

## 正式入口

### Core

- [Workflow Governance Runtime 产品定义](领域术语.md)：`DECIDED`，共享运行中协作契约已采纳
- [产品上下文摘要](产品上下文摘要.md)：由权威定义压缩而来，供 Agent/Runtime 注入；仍属于 L1
- [策略治理工作流运行时 ADR](架构决策/0001-策略治理工作流运行时.md)：已采纳的产品级架构边界
- [统一对话中的活跃 Worker 协作 ADR](架构决策/0002-统一对话中的活跃Worker协作.md)：`DECIDED`，定义单一输入、补充信息和当前 Worker 模型切换

### Extensions

- [Feature Extension 产品规范](扩展/feature-扩展.md)：`DECIDED`
- [Fix Extension 产品规范](扩展/fix-扩展.md)：`DECIDED`
- [Workflow UI Extension](扩展/workflow-ui-扩展.md)：`DECIDED`
- [Codex Usage Status Extension](扩展/codex-usage-status-扩展.md)：`REVIEWING`

## L1 与 L2 的边界

```text
L1 产品定义
├── Core 产品定义
├── Core 产品上下文摘要（派生）
└── Extension 产品规范
    └── 目标、用户路径、Stage 语义、Artifact 要求、Guard 与 Acceptance 语义

L2 产品实现
├── 可执行 Workflow Definition
├── 状态枚举、Transition / Guard 实现
├── Policy 解析、Artifact schema 与 Worker 生命周期
└── 源码、测试和当前运行事实
```

判断标准：描述“产品必须保证什么”属于 L1；描述“Runtime 当前怎样保证”属于 L2。文档篇幅、是否供 Agent 使用，都不改变其层级。

## 维护规则

- `领域术语.md` 是 Core 唯一语义源；上下文摘要不得独立引入产品规则。
- Feature/Fix 特有规则写入各自 Extension，不复制到 Core。
- Extension 引用 Core 的 Artifact、评审、Finding、隔离和审计规则，只补充入口特有要求。
- 产品定义变化时先更新权威 L1，再同步上下文摘要；若实现尚未跟进，必须在 L2 明确记录 drift。
- 当前实现是否满足产品语义，只能由 L2 源码、测试和运行证据证明。
- 候选方案和评审原文放入归档，只有采纳结论写回 L1 后才生效。
