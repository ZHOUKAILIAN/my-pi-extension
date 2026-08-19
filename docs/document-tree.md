# 文档树

这是 `my-pi-extension` 的问题地图。当前只保留两层核心问题：

```text
docs/
├── document-tree.md                         # 本文件：文档导航
├── 00-repository-organization/              # 仓库组织形式
│   ├── README.md                            # 问题定义和待对齐项
│   └── technical-design.md                  # 仓库组织技术方案
├── 01-extension-catalog/                    # Extension 集合目录
│   └── README.md                            # 集合成员和边界
│
├── extensions/                             # 每个 Pi extension 的独立设计文档
│   ├── workflow-router.md                   # build/work/bug 入口路由
│   ├── task-delegation.md                   # 主 agent 委派 worker
│   ├── solution-review.md                   # 需求/技术方案多 agent 对齐
│   ├── code-review.md                       # A/B 代码评审和 rebuttal
│   ├── verification.md                      # 独立验证和最终验收
│   └── workflow-ui.md                       # 状态、产物和 trace 展示
│
├── adr/                                     # 已定且需要长期保留的架构决策
├── reviews/                                 # 多 agent 评审原文和汇总
├── archive/                                # 被新方案替代的历史文档
└── architecture-selection.md                # 历史整体选型记录
```

## 两层关系

```text
仓库组织形式
  -> extension 集合如何放在一个仓库中
  -> extension 如何安装、加载、启用、禁用和协作
  -> 哪些能力共享，哪些能力独立

Extension 集合目录
  -> 每一个 extension 是否值得存在
  -> 它负责什么、不负责什么
  -> 它如何使用 skill、context、worker、artifact、review、verification
  -> 它如何和其他 extension 协作
```

## 单个 Extension 文档固定结构

每个 extension 使用一个文档，不再把它拆成多个平行文件。文档内部统一包含：

1. 目标和问题边界
2. 用户入口和使用方式
3. 与其他 extension 的职责边界
4. Pi API：command、tool、event、shortcut、UI
5. 工作流和状态迁移
6. Role 与 worker 分工
7. skill routing
8. context isolation
9. artifact 和 trace
10. review、rebuttal 和 arbiter
11. verification 和验收标准
12. 失败、取消、重试和安全边界
13. 技术方案选项和最终决策

skill 隔离、上下文隔离、worker 选型和验证都属于具体 extension 的设计内容，不再作为与 extension 平行的文档分类。

## 推进顺序

1. `00-repository-organization/README.md`
2. `00-repository-organization/technical-design.md`
3. `01-extension-catalog/README.md`
4. `extensions/workflow-router.md`
5. `extensions/task-delegation.md`
6. `extensions/solution-review.md`
7. `extensions/code-review.md`
8. `extensions/verification.md`
9. `extensions/workflow-ui.md`

前两个总体问题没有对齐前，不开始实现任何 extension。

## 文档状态

| 状态 | 含义 |
|---|---|
| `TODO` | 已识别问题，尚未对齐 |
| `ALIGNING` | 正在收集事实和方案选项 |
| `REVIEWING` | 等待多 agent 评审 |
| `DECIDED` | 已形成可作为下游输入的决策 |
| `IMPLEMENTING` | 已批准进入实现 |
| `VERIFIED` | 已有运行时验证证据 |
| `BLOCKED` | 缺少决策、事实或验证，不能继续 |

## 历史文档

- [仓库组织问题](00-repository-organization/README.md)
- [仓库组织技术方案](00-repository-organization/technical-design.md)
- [Extension 集合目录](01-extension-catalog/README.md)
- [历史整体方案选型](architecture-selection.md)
- [gpt-5.6-sol 多模型评审](reviews/2026-08-18-gpt-5.6-sol-design-review.md)
- [Policy 治理 runtime ADR](adr/0001-policy-governed-workflow-runtime.md)
