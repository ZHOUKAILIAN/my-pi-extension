# bugFix Extension

- 状态：真实模型已接线，尚未完成真实 provider E2E 验证

## 唯一公共入口

唯一命令是 `/bugFix <问题描述>`，每次调用都创建新 run；`start`、`resume`、`decision` 前缀均返回 usage，不是公共协议。恢复对话使用 Pi 原生 `/resume`。在 `session_start` 的 `reason === "resume"` 时，若存在当前主 session 的未完成 run，扩展会显示问题摘要和 stage，确认后继续；拒绝或无 UI 不调用模型。

## 交互边界

工作流进入 `BLOCKED` 后，当前命令最多一次通过主 UI `input` 请求补充信息；非空内容作为下一次 investigate 的 capsule 交给 worker。取消、空输入或无 UI 保持 BLOCKED，后续不循环。`WAITING_FOR_USER` 使用主 UI confirm，单次执行最多确认一次。

模型策略读取 `<cwd>/.pi/workflow-models.json`；文件缺失时所有 node 默认继承当前模型，文件存在时按配置覆盖。每个命令、session resume 和每个 node 都写审计；策略错误或模型解析失败在模型调用前显式失败。

## 当前边界

Controller 负责确定性状态迁移和 checkpoint；worker 只提交 artifact。问题摘要在 workflow checkpoint 中持续保留并用于 Pi session resume，审计 entry 不复制问题全文。

- 上游：[Extension 颗粒度](../00-repository-organization/extension-granularity.md)、[Extension 集合目录](../01-extension-catalog/README.md)

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
