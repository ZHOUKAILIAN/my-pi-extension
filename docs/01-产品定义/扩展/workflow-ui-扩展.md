# Workflow UI Extension 产品规范

- 状态：`DECIDED`
- 层级：第一层（L1 Extension）
- 上游：[Core 产品定义](../领域术语.md)

## 结论先行

| 问题 | 第一版结论 |
| --- | --- |
| 用户入口 | 不新增 UI 控制命令；复用 `/fix <问题描述>` 等原 Workflow 入口 |
| 执行展示 | 在原对话展示当前活跃 Worker 的角色、实际模型、可见输出和工具活动摘要 |
| 执行中输入 | 复用原输入框补充信息，自动绑定并路由到提交时的当前 Worker |
| 模型切换 | 在原对话提供当前 subagent 的模型选择器，作用于当前活跃 Worker Session |
| 控制边界 | UI 不复制 Run 状态，不以自然语言输入绕过 Artifact、Guard 或 Acceptance |
| 当前状态 | 产品方案已采纳，L2 尚未实现；独立 package、多 Run 和并行 Worker 详情仍待后续评审 |

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

Workflow UI 遵循 Core 的人友好化原则：默认隐藏不影响决策的 Runtime 术语和技术细节，优先让用户用业务语言完成理解和决定；完整技术事实仍可在渐进式详情中查看。

用户应能在不理解 Agent 或 Runtime 实现细节的情况下回答：

```text
任务现在在哪里？
当前正在做什么、由什么角色和模型执行？
我现在输入的信息会交给谁？
已经得到哪些可追溯结果？
为什么可以或不可以进入下一步？
有哪些 Finding、未验证项和风险？
现在是否需要我决定，决定会造成什么影响？
任务最终为何被接受、阻塞或未完成？
```

用户不需要进入独立的“介入模式”。Workflow 主动执行时，原对话就是当前活跃 Worker 的可见交互面：用户继续使用同一输入框补充信息，并使用当前 subagent 的模型选择器切换模型。内部路由、会话句柄和标识不成为用户任务。

## 3. 展示对象

最低展示范围：

- 默认视图中的业务任务摘要、当前 Worker 角色、实际模型、用户可见输出、工具活动摘要和输入接收者；
- 详情中的 Run 标识、入口类型、基准/候选版本和当前 Stage；
- 详情中的当前及历史 Node Execution、Role、状态和 attempt；
- 已接受 Artifact 的摘要、来源和证据引用；
- Transition Guard 的决定与理由；
- Review Finding 和正式 Disposition；
- 未验证项、剩余风险与 blocker；
- 用户决定请求及其影响；
- Acceptance Result 与最终依据。

Trace 可以为可读性做摘要；Audit 仍是可回放控制记录，UI 不得用摘要替代原始审计引用。

## 4. 运行中输入与用户决定

### 用户补充信息

Workflow 主动执行期间，原输入框接收用户补充信息。UI 必须先持久化，并在提交时原子绑定 Run、活跃 Worker Session 和顺序，再交给 Runtime 投递；同一 Run 后续 Worker 默认通过版本化上下文引用按顺序获得这些信息。

提交采用严格 close fence：只有 fence 前完成耐久记录并获得连续顺序的内容才成为已提交补充，且必须由原 Worker Session 或同一逻辑 Node 的显式 recovery attempt 获得一次包含该输入的后续模型调用，并由绑定最新补充版本的新 Artifact 重新交付后才可迁移；fence 后失败不占补充顺序并保留待重试文本，UI 显示新的接收者，用户再次提交后才可投递。不得静默丢失、广播或改投。UI 可区分已耐久记录、队列已接收、对应模型调用已完成和已绑定新 Artifact，但不能声称知道模型隐藏推理如何使用了信息。同一逻辑 Node 的崩溃恢复 attempt可以自动重投未完成补充，但必须展示“恢复投递”和新 Session 身份；跨 Node 不允许。

补充信息用于增加事实、约束和方向修正，不是 User Decision Artifact。UI 不得把“先不要修改”“只检查登录后场景”、自然语言 `approve`/`reject` 或暂停/完成措辞直接解释为 Stage 迁移、Artifact 接受或最终验收。补充信息只在消息边界生效，不承诺立即中止当前工具或回滚已经发生的副作用；停止/取消不属于本能力第一版新增范围。补充原文只在所属 Run 的受控上下文、审计和恢复范围内使用，默认不进入 Git、公开 Trace、公开 Telemetry 或指标字段。

### 当前 Worker 模型选择

原对话中的当前 subagent 模型选择器以当前活跃 Worker 为目标。项目 Node 模型是默认值；第一版候选模型必须属于 Pi scoped/available 已认证范围，并满足当前 Worker 的模型/工具兼容约束。UI 必须明确显示目标 Worker 和实际模型，并统一展示 `requested/已请求 → pending/待生效 → applied/已切换`，或终止为 `not_applied/未应用`、`failed/失败`；只有同一 Worker 用新模型开始后续调用才进入 applied，Worker 先结束则进入 not_applied。选择器打开或确认期间目标变化时 fail-closed 并要求重新选择。该选择不修改主 Session、项目默认 Policy，不扩大工具、Skill 或环境能力，且不默认影响后续 Node。没有活跃 Worker 时不得让用户误以为已切换某个 Worker 模型。

### 用户决定

需要用户作出 Workflow 决定时，UI 必须显示：

- 为什么当前无法自动推进；
- 可选项及各自影响；
- 关联 Artifact、风险和默认/推荐项（如有）；
- 决定将影响哪条 Transition 或 Acceptance 条件。

用户选择必须形成 User Decision Artifact，交回 Controller，持久化到原 Workflow Run，并由 Guard 消费。取消、超时或 UI 关闭不得被解释为同意。

对于 Fix 等需要最终验收的入口，默认使用静态 Review Panel：展示问题、结论、处置、验证、未验证项和风险，提供“接受并完成”“继续处理”“暂不接受”等少量业务语言选项。Stage、Node、`runId`、版本和错误码作为详情或调试信息渐进式展示，不作为普通用户必须记忆的输入。

用户选择“继续处理”或“暂不接受”后，再要求选择原因并补充说明；原因选项必须映射到结构化回流路径，不能要求用户直接填写内部 Stage 或 Transition。

## 5. 状态与错误

UI 必须区分：

```text
正在执行且可补充信息
补充信息已耐久记录 / 队列已接收 / 对应模型调用已完成 / 已绑定新 Artifact / 失败
模型已请求 / 待生效 / 已切换 / 未应用 / 失败
等待有限重试
等待用户
已阻塞
执行失败但可恢复
已接受
未接受但已停止
```

错误展示至少包含当前 Run/Stage、失败 Node、可公开错误摘要、恢复动作和 trace 引用。UI 不显示隐藏推理，也不因压缩展示而丢失未验证项。

## 6. 认知成本与交互质量

Workflow UI 以及各入口的用户交互至少应满足：

- 默认状态能用一段简短业务语言说明“发生了什么、当前结果怎样、下一步需要谁做什么”；
- Workflow 主动执行时复用原输入框，并在原对话提供当前 subagent 模型选择器，不要求用户学习“接入/介入”、tmux、内部 ID 或专用控制命令；
- 输入目标必须清晰；Node/Worker 切换时不得把已经提交的内容静默改投，提交失败时应保留编辑内容供用户确认新接收者后重试；
- 用户决定优先使用少量明确选项；技术参数和内部标识按需展开，不成为默认输入负担；
- 错误、阻塞和回流动作说明原因、影响和恢复路径；取消、关闭或超时不会被误解为同意；
- 长文本、中文文本、窄终端和宽终端都不会造成截断、重叠或布局跳动；
- 默认界面不依赖动画表达进度或状态，状态变化以稳定文本和明确结果表达；
- 关键字段、证据引用和审计事实仍可追溯，不因摘要而丢失。

## 7. Acceptance Definition

Workflow UI 只有在以下条件满足时才可视为达到产品验收：

- 展示状态与 Runtime Run 状态一致；
- 用户补充信息可追溯地绑定、投递并被当前 Worker 及同一 Run 后续 Worker 按版本消费；
- 用户切换模型后，展示、实际执行和审计中的模型一致；
- Worker 切换竞态不会导致输入静默丢失、广播或错误改投；
- 用户决定可追溯地回到原 Run；
- reload/resume 后不会产生第二套状态；
- BLOCKED、Finding、未验证项和 Acceptance 依据可被用户辨认；
- UI 无法绕过 Controller、Guard 或 Artifact 合同推进任务；
- 无 UI 环境不影响 Runtime 的正确性和可恢复性。

## 8. 待评审事项

- 它是否需要成为独立 Pi Extension/package，还是由各入口共享普通 UI 模块；
- 多 Run 列表、Run 详情和并行 Worker 的前台接收者选择；
- Artifact 敏感字段、脱敏和访问边界；
- 非交互模式下用户决定请求的承载方式；
- 大量 trace、Finding 和并行 Node 的摘要与展开规则。

这些事项在形成正式方案后，必须遵守 Core 的跨入口独立交叉评审规则。

## 9. L2 交接

UI API、事件协议、组件结构、缓存方式、Pi UI 接线、状态订阅、性能预算和测试实现属于 L2。L2 可以选择具体技术方案，但必须保持本规范中的单一状态源、可追溯用户决定和不可绕过 Runtime 的产品保证。
