# Workflow UI Extension 产品规范

- 状态：`TODO`
- 层级：第一层（L1 Extension）
- 上游：[Core 产品定义](../领域术语.md)

## 1. 目标与边界

Workflow UI 用于展示 Workflow Run 的当前状态、执行证据、阻塞原因和待用户决定事项，并把用户决定交回原 Run。

它可以读取 Stage、Node Execution、Worker 状态、Artifact、Finding、Guard/Transition Record、checkpoint 和 Acceptance Result，但不拥有或复制 Workflow Definition，也不能成为第二套 Run 状态源。

Workflow UI 不得：

- 绕过 Controller 直接修改 Stage；
- 把展示状态当作 Acceptance Result；
- 修改或覆盖 Worker Artifact 和 Audit；
- 在 UI 本地保存一套无法与 Run 对账的决定；
- 让用户看不到关键阻塞、未验证项或剩余风险。

## 2. 用户体验目标

用户应能在不理解 Agent 或 Runtime 实现细节的情况下回答：

```text
任务现在在哪里？
当前正在做什么、由什么角色执行？
已经得到哪些可追溯结果？
为什么可以或不可以进入下一步？
有哪些 Finding、未验证项和风险？
现在是否需要我决定，决定会造成什么影响？
任务最终为何被接受、阻塞或未完成？
```

## 3. 展示对象

最低展示范围：

- Run 标识、入口类型、基准/候选版本和当前 Stage；
- 当前及历史 Node Execution、Role、状态和 attempt；
- 已接受 Artifact 的摘要、来源和证据引用；
- Transition Guard 的决定与理由；
- Review Finding 和正式 Disposition；
- 未验证项、剩余风险与 blocker；
- 用户决定请求及其影响；
- Acceptance Result 与最终依据。

Trace 可以为可读性做摘要；Audit 仍是可回放控制记录，UI 不得用摘要替代原始审计引用。

## 4. 用户决定

需要用户输入时，UI 必须显示：

- 为什么当前无法自动推进；
- 可选项及各自影响；
- 关联 Artifact、风险和默认/推荐项（如有）；
- 决定将影响哪条 Transition 或 Acceptance 条件。

用户选择必须形成 User Decision Artifact，交回 Controller，持久化到原 Workflow Run，并由 Guard 消费。取消、超时或 UI 关闭不得被解释为同意。

## 5. 状态与错误

UI 必须区分：

```text
正在执行
等待有限重试
等待用户
已阻塞
执行失败但可恢复
已接受
未接受但已停止
```

错误展示至少包含当前 Run/Stage、失败 Node、可公开错误摘要、恢复动作和 trace 引用。UI 不显示隐藏推理，也不因压缩展示而丢失未验证项。

## 6. Acceptance Definition

Workflow UI 只有在以下条件满足时才可视为达到产品验收：

- 展示状态与 Runtime Run 状态一致；
- 用户决定可追溯地回到原 Run；
- reload/resume 后不会产生第二套状态；
- BLOCKED、Finding、未验证项和 Acceptance 依据可被用户辨认；
- UI 无法绕过 Controller、Guard 或 Artifact 合同推进任务；
- 无 UI 环境不影响 Runtime 的正确性和可恢复性。

## 7. 待评审事项

- 它是否需要成为独立 Pi Extension/package，还是由各入口共享普通 UI 模块；
- 多 Run 列表、Run 详情和实时事件的最小交互模型；
- Artifact 敏感字段、脱敏和访问边界；
- 非交互模式下用户决定请求的承载方式；
- 大量 trace、Finding 和并行 Node 的摘要与展开规则。

这些事项在形成正式方案后，必须遵守 Core 的跨入口独立交叉评审规则。

## 8. L2 交接

UI API、事件协议、组件结构、缓存方式、Pi UI 接线、状态订阅、性能预算和测试实现属于 L2。L2 可以选择具体技术方案，但必须保持本规范中的单一状态源、可追溯用户决定和不可绕过 Runtime 的产品保证。
