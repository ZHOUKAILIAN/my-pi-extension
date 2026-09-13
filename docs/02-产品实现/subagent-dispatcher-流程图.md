# Subagent Dispatcher 执行流程图

| 项目 | 定义 |
| --- | --- |
| 状态 | `IMPLEMENTING` — 首版源码、focused tests、独立代码复审及 headless provider 创建+恢复 smoke 已完成；真实 TUI/retry/fallback/Fast child E2E 待验证。 |
| 层级 | 第二层（L2）可视化设计页 |
| 上游 | [Subagent Dispatcher 产品规范](../01-产品定义/扩展/subagent-扩展.md)、[Subagent Dispatcher 技术设计](subagent-dispatcher-技术设计.md) |
| 目的 | 只呈现首版实现遵循的执行流程；源码和自动化测试已覆盖关键门禁，真实 provider/TUI E2E 仍未完成。 |

## 1. 创建与持久化决策

`session_start` 同时启动一次后台 best-effort 30 天 GC；GC 不在主任务路径上 await，失败不会阻塞 dispatch。

```mermaid
flowchart TD
  A[主 Pi 调用 subagent] --> B[解析 agent / cwd / model]
  B --> C{单次 persistent?}
  C -->|指定| D[使用单次布尔值]
  C -->|未指定| E{agent frontmatter persistent?}
  E -->|指定| F[使用 agent 布尔值]
  E -->|未指定| G[使用全局 defaultPersistent = true]
  D --> H{persistent 为 true?}
  F --> H
  G --> H

  H -->|false| I[创建调用内临时 Pi session<br/>结束后 finally 删除]
  H -->|true| J{调用给了 session handle?}
  J -->|否| K[仅生成 logical handle]
  J -->|是| L[规范化显式 handle]
  K --> M[派生 identity key]
  L --> M
  M --> N[以 identity key 原子获取 lock]
  N -->|已锁定| X[返回 session-busy]
  N -->|成功| O{锁内检查 tombstone}
  O -->|存在或无法确认| Y[返回 cleanup-pending<br/>不建 registry / 不 spawn]
  O -->|不存在| P[锁内读/建 registry<br/>校验 parent session / cwd / agent]
  P --> Q[首次才分配 UUID；登记 JSONL 绝对路径]
  Q --> R[启动 Pi child<br/>首次：--session-id<br/>恢复：--session absolute-jsonl-path]
  R --> PID[将 child PID + child session identity 写入 lock]
  I --> R
  R --> S[运行；临时模式 finally 删除]
```

**关键点**：`persistent: true` 是默认值，但未提供 handle 的新委派仍会生成**新** child session；不会按 agent 名称错误接入旧任务。

## 2. 模型请求、重试与 fallback

```mermaid
flowchart TD
  A[以候选模型 1 启动或恢复 child] --> B[解析 JSON event stream<br/>累积助手文本 / 脱敏 tool 投影 / usage / 诊断计数]
  B --> C{本地 abort?}
  C -->|是| CA[标记 cancelled<br/>不重试]
  CA --> Z
  C -->|否| D{signal / 协议 / missing terminal?}
  D -->|是| U[标记 unknown_transport<br/>fail closed / 不重试]
  U --> Z
  D -->|否| E{最终助手 aborted?}
  E -->|是| EB[标记 cancelled<br/>不重试]
  EB --> Z
  E -->|否| F{最终 provider error?}
  F -->|是| H{仅瞬态 provider 错误?}
  H -->|否| I[标记 non-transient provider failure<br/>不重试/换模型]
  I --> Z
  H -->|是| J{当前模型 retry 次数 < 2?}
  J -->|是| K[记录 retry attempt<br/>有限退避]
  K --> L[同 child session 投递 continue prompt]
  L --> B
  J -->|否| M{还有 fallback model?}
  M -->|是| N[记录 fallback 原因<br/>选择下一候选模型]
  N --> O[同 child session 以新模型继续]
  O --> B
  M -->|否| P{persistent 为 true?}
  P -->|是| R[标记 recoverable failed<br/>保留 handle 与所有 attempts]
  P -->|否| S[返回 attempts diagnostics<br/>删除临时 session，不可继续]
  R --> Z
  S --> Z
  F -->|否| G{进程 exit 非零?}
  G -->|是| U2[标记 unknown_transport<br/>不重试]
  U2 --> Z
  G -->|否| L2{最终 length?}
  L2 -->|是| T[标记 incomplete：未完整返回<br/>保留捕获报告 / 不自动重试]
  T --> Z
  L2 -->|否：最终 stop| OK[标记 success：已返回<br/>保留助手报告与过程诊断，不代表验收通过]
  OK --> Z
```

最终 `length` 标记 `incomplete`：保留已捕获报告、不自动重试。只有以下闭集错误类别进入 `H`：

> 终态候选在后续 assistant `message_start`、assistant `toolUse` 或任一 tool execution 事件后失效；普通 `turn_end`/`agent_end` 不清除。`phase=running` 的 progress 不画最终失败图标。`fetch failed`、`ECONNRESET`、`ECONNREFUSED`、`ETIMEDOUT`、明确 timeout、HTTP 429、502、503、504。认证、模型配置、401/403、未知 transport、测试或命令失败不会触发 fallback。

## 3. 持久 child 候选耗尽后的继续与手动换模型

```mermaid
sequenceDiagram
  participant U as 用户
  participant P as 主 Pi Agent
  participant D as Dispatcher
  participant R as Registry + Lock
  participant C as Child Pi session

  C-->>D: 所有候选模型耗尽
  D-->>P: recoverable_failed(handle, attempts, diagnostics)
  P-->>U: 任务暂停；可继续或换模型
  U->>P: 继续，改用 gpt-5.6-sol
  P->>D: subagent(session=handle, model=sol)
  D->>R: 获取 identity lock；校验 registry 和 JSONL header
  R-->>D: absolute session path
  D->>C: --session absolute-jsonl-path --model sol<br/>continue same task
  C-->>D: 新的 JSON events / final result
  D->>R: 记录 attempt，释放 lock
  D-->>P: result(handle, actualModel=sol)
```

手动 `model` 只覆盖这一次恢复/继续请求。它不修改主 Pi 模型、不修改 agent frontmatter，也不改变其他 child session。

## 4. 并发、锁与保留期

```mermaid
flowchart LR
  A[调用 A<br/>session=fix-auth] --> L[尝试原子创建 lock]
  B[调用 B<br/>session=fix-auth] --> L
  L -->|成功| R[运行同一 child session]
  L -->|已存在| X[返回 session-busy<br/>不写 JSONL]
  R --> S[完成 / 取消 / recoverable failed]
  S --> U[释放 lock]
  S --> M[更新 session metadata]
  M --> G{超过 30 天?}
  G -->|否| K[保留，可继续]
  G -->|是| T[session_start 后台 GC<br/>尝试同一 identity lock]
  T -->|锁被占用| K
  T -->|获取成功| V[锁内复核到期条件<br/>tombstone 下先删 session+metadata<br/>成功后再删 tombstone]
  L --> C{stale lock?}
  C -->|dispatcher 存活| X
  C -->|child state=starting| X
  C -->|记录 child PID 存活| X
  C -->|dispatcher 与 child 均不存在| N[允许接管 lock]
```

- lock 文件记录 dispatcher PID、child PID、child session identity 和恢复 session path；只有确认 dispatcher 与实际记录的 Pi child 都不存在时才可作为 stale lock 清理。`starting` 状态默认先经过 5 秒 grace，之后扫描同主机可读进程表中的 `--mode json --session-id` / `--session` 匹配；PID 存活、匹配 child 存活、身份/路径缺失或进程表不可读都一律 fail closed，不能仅因时间到期释放运行中的 session。只有扫描成功且没有匹配 child 才可接管；这不覆盖 OS 进程表权限、平台命令差异和扫描竞态。
- GC 只处理 dispatcher 自己创建的 child storage，不扫描或删除主 Pi session。

## 5. Fast 继承的 spawn 边界

```mermaid
flowchart LR
  A{新 logical child 的首次 spawn?} -->|否：retry / fallback / resume| F[克隆 env 并清除 PI_CODEX_FAST]
  A -->|是| B[读取 parent requested Fast snapshot]
  B --> C[克隆 env 并删除环境残留 PI_CODEX_FAST]
  C --> D{user source + exact agent<br/>+ codexFast: inherit?}
  D -->|是| E[仅首次 spawn 注入 PI_CODEX_FAST=1]
  D -->|否| F
  E --> G[child factory 启动即消费并删除]
  F --> G
```

retry、fallback 与恢复都可能启动新的 child 进程，但它们不是新 logical child：一律不读取 parent Fast snapshot、只以 Off 启动；不会把 Fast 写入持久 child session 或 dispatcher registry。
