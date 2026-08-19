# Bug Extension

- 状态：`TODO`
- 颗粒度假设：一个完整工作入口对应一个顶层 Pi extension
- 上游：[Extension 颗粒度](../00-repository-organization/extension-granularity.md)、[Extension 集合目录](../01-extension-catalog/README.md)

## 当前边界

`bug` 是一个独立的顶层工作流 extension，注册 `/bug`，负责已有行为异常的事实调查、根因判断、局部修复或技术方案升级。

调查、根因判断、worker 委派、review 和验证目前都是本 extension 内部节点，不预先拆成独立 Pi 子 extension。

## 待对齐

- Bug 的事实、根因和最小可接受修复如何区分？
- 何时走局部修复，何时进入需求/技术方案多 agent 对齐？
- 日志、数据库、Redis、外部系统等 skill 如何按节点隔离？
- 子 agent 之间如何交接证据而不共享无关上下文？
- `/bug` 是否需要和其他顶层 extension 直接通信？

## 设计章节

1. 目标和边界
2. Command / Tool / Event
3. 内部节点和状态机
4. 主 agent 与 worker
5. skill routing 和 context isolation
6. Artifact、session 和记忆交接
7. review、rebuttal、arbiter
8. verification
9. 失败、取消、重试和安全边界
10. 候选技术方案和最终决策
