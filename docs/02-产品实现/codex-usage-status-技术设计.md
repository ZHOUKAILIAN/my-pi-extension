# Codex Usage Status + Fast 技术实现

这个扩展做两件事：后台读取 ChatGPT Codex 额度，在输入框下方展示；通过 `/fast` 控制符合条件的模型请求是否携带 `service_tier: "priority"`。两项能力共享一行 UI，但额度状态不控制 Fast 开关。

| 入口 | 说明 |
| --- | --- |
| 产品契约 | [Codex Usage Status + Fast 产品规范](../01-产品定义/扩展/codex-usage-status-扩展.md) |
| 源码 | [`packages/codex-usage-status/src/`](../../packages/codex-usage-status/src/) |
| 当前状态 | 额度、Fast、费用修正、Subagent 继承及本地开启事件已有实现；成功写入的事件已接显式许可下的项目指标本地outbox/Worker投递。真实RPC、CF部署及投递验收状态见[项目指标实现](项目指标-技术设计.md)；真实 TUI/provider/child 组合未验证；查询仅CLI，无私有看板 |

## 1. 模块与接线

```mermaid
flowchart LR
    pi[Pi 命令与生命周期事件] --> entry[index.ts]
    entry --> fast[FastController]
    entry --> usage[UsageController]
    fast -->|展示快照| usage
    usage -->|授权检查与查询| api[固定 ChatGPT usage 接口]
    usage --> widget[输入框下方合并行]
    fast -->|请求改写与费用处理| hooks[Provider / Message hooks]
    entry --> interop[interop.ts]
    interop -->|requested 事件| child[Subagent consumer]
    entry --> event[fast-enabled-event.ts]
    event -->|完整本地事件文件| local[Pi agentDir / metrics / codex-fast-enabled / v1]
    entry -->|成功提交记录ID/时间| metrics[项目指标私有 outbox / CLI]
```

| 文件 | 责任 |
| --- | --- |
| [`index.ts`](../../packages/codex-usage-status/src/index.ts) | 创建两个 Controller，注册 `/fast`、生命周期与请求/消息 hooks；导出扩展符号 |
| [`usage.ts`](../../packages/codex-usage-status/src/usage.ts) | 授权作用域、额度查询、快照有效性、唯一合并 widget |
| [`fast.ts`](../../packages/codex-usage-status/src/fast.ts) | 请求意图、模型资格判断、payload 改写、响应关联和费用修正；只提供展示快照 |
| [`interop.ts`](../../packages/codex-usage-status/src/interop.ts) | 进程内 requested 事件与 child 一次性启动参数；通过 `@pi/codex-usage-status/interop` 提供公共协议 |
| [`fast-enabled-event.ts`](../../packages/codex-usage-status/src/fast-enabled-event.ts) | 每次有效用户开启写一份独立私有的本地事件文件；不处理读取、恢复或投递 |

`session_start`、`input`、`model_select`、`agent_settled` 更新状态；`before_provider_request` 交给 Fast 改写请求，`message_end` 交给 Fast 处理费用。`session_shutdown` 发布 requested=false，并清理 Controller 的计时器、状态和队列。

## 2. 额度查询与展示

```mermaid
flowchart TD
    event[生命周期触发] --> gate{TUI 与官方 Codex OAuth 条件满足?}
    gate -->|否| hide[清理显示，不解析授权或联网]
    gate -->|是| scope[后台确认账户作用域与 lease]
    scope --> fetch[固定 URL 请求，禁止重定向]
    fetch --> dto[校验响应并提取白名单字段]
    dto --> current{generation 与账户仍匹配?}
    current -->|是| display[快照与合并行]
    current -->|否| discard[丢弃晚到结果]
```

安全 gate 要求 provider=`openai-codex`、API=`openai-codex-responses`、base URL=`https://chatgpt.com/backend-api`，并由 Pi 确认当前模型使用 OAuth。额度查询还要求 TUI 模式。

授权来自 Pi 的 `getProviderAuth()`。Controller 在内存中解析 token 的账户作用域；无法安全解析时显示不可用。请求只发往 `https://chatgpt.com/backend-api/wham/usage`，使用 manual redirect、5 秒 HTTP timeout 和 64 KiB 响应上限。授权解析属于 Pi 操作，不受这 5 秒 HTTP 时限约束。token、账户标识和原始响应不进入 UI、日志或 session。

| 机制 | 当前行为与理由 |
| --- | --- |
| 账户有效期 | 每次确认作用域后持有 60 秒 lease；到期先清除快照，再后台校验，避免登录变化后继续展示旧账户数据 |
| 刷新与并发 | 授权和 HTTP 查询各自 single-flight，合并重复触发；普通 usage 请求最小间隔 60 秒，刷新 timer 为 5 分钟，lease 重校验可触发立即查询 |
| 晚到结果 | 模型切换、失效或关闭会推进 generation；写入前复核 generation、context 和账户，防止旧请求恢复已清除的显示 |
| 响应合同 | 只取默认 `rate_limit` 的 primary/secondary 窗口及 `allowed`；存在响应账户字段时必须匹配。`additional_rate_limits` 不进入投影 |
| 数值 | `used_percent` 必须是 `0..100` 有限值，展示 `round(100 - used_percent)`；时长和重置时间缺失时不猜测，无有效窗口按失败处理 |
| 失败与过期 | 同账户有效快照在失败后可显示 stale，但必须未满 10 分钟；满 10 分钟定时清除，无新响应也显示 unavailable。lease 到期同样会提前清除 |

`UsageController` 独占 `belowEditor` 的 `codex-usage-status` widget，格式为 `<Fast 状态> · <Codex 额度>`。它清理 `codex-usage-status` 和 `codex-fast` 两个 status key，不替换 Pi footer；隐藏、切换和 shutdown 同时清理 widget 与 status。渲染使用 ANSI-safe `truncateToWidth`，始终至多一行。

`allowed=false` 显示 `limit reached`，缺失时显示 `status unknown`；进度条表示剩余比例，不代表当前获准使用。默认 bucket 也不能证明 Spark 等专属 bucket 的可用性。具体样式和状态文案由 L1 拥有。

## 3. Fast 请求与费用

### 意图与生效条件

`requested` 是内存中的用户意图，模型切换不清除它，也不写配置或 session。factory 默认 Off；唯一启动例外是下节的 child bootstrap。

| 状态 | 条件 |
| --- | --- |
| Off | requested=false |
| Active | requested=true，且模型满足资格条件 |
| Inactive | requested=true，但模型不满足资格条件 |

资格条件包括上述官方 provider/API/base URL/OAuth gate，以及精确小写 `gpt-` 前缀、非空且无空白的 suffix；`gpt-`、`GPT-*` 和非 GPT 型号不符合。`isFastEligible()` 只检查当前模型，不解析额度授权、不联网、不启动 timer。

`/fast` 支持空参数切换及 `on/off/toggle/status`，参数非法时只提示用法；只有 `hasUI=true` 的 TUI/RPC 可改变意图，JSON/print 命令不改变它。命令的纯展示刷新不触发额度查询。额度 limited、stale 或 unavailable 不会自动关闭 Fast。

### 请求与响应关联

```mermaid
flowchart LR
    request[Active 请求] --> match{plain payload 且 model 精确匹配?}
    match -->|是| rewrite[浅复制并写 priority]
    rewrite --> ticket[保存请求时模型 / session / 费用策略]
    ticket --> response[assistant message_end 消费 FIFO 首项]
    response --> known[已知型号：修正 cost]
    response --> unknown[未知型号或校验失败：不改 cost]
```

`rewriteProviderPayload()` 仅处理 plain-object 且 `payload.model === context.model.id` 的请求；返回浅复制，保留原对象和嵌套引用。其他输入返回 `undefined`。

每次成功改写都入队一个 ticket，最多 32 项，溢出丢最老项。ticket 保存请求时的模型（含 pricing）、session 身份和费用策略。响应只消费队首，再核对 provider/API/model/session；不匹配或 usage 非法时丢弃该 ticket、不改消息，也不扫描后续 ticket。shutdown 清空队列。

这样即使请求期间切换模型或关闭 Fast，费用也按请求时状态处理。未知型号同样占队列位置，避免它的响应误用后续已知型号的费用策略。

| 费用策略 | 行为 |
| --- | --- |
| `gpt-5.5` | Pi `calculateCost` 的原生费用乘 2.5 |
| `gpt-5.4`、`gpt-5.6-luna`、`gpt-5.6-sol`、`gpt-5.6-terra` | 原生费用乘 2 |
| 其他 eligible `gpt-*` | 消费 ticket，`usage.cost` 原样保留 |

`FAST_COST_CORRECTION_MODEL_IDS` 是上述已知计费集合的 canonical 公共导出；deprecated `FAST_MODEL_IDS` 为兼容性导出，并与其指向同一数组。两者均只表示 known pricing/cost correction 型号，不是 eligibility allowlist；资格由前述 Codex gate 与 `gpt-*` 形状独立判定。费用计算使用原生 pricing tier，将 input/output/cacheRead/cacheWrite 分量分别缩放后求和；费用已相同时不再替换。usage 的 token 计数必须为非负安全整数，reasoning 不超过 output、cacheWrite1h 不超过 cacheWrite，cost 分量必须有限；缺失或非法时不修正。合法的 error/aborted assistant message 也按已发生的 usage 处理。

未知型号激活、查询状态，以及涉及未知型号的模型切换（包括 unknown→unknown）会提示：priority 只是请求意图，费用未校正/不保证。切回已知型号使用对应通知和费用策略。TUI 通知可带颜色，RPC 保持纯文本。

### 本地开启事件 producer

`index.ts` 的 `/fast` handler 记录命令执行前的 requested，并在 `finally` 中检查 `hasUI=true` 且实际 Off→On。`on`、空参数和 `toggle` 依原有命令语义触发；重复 `on`、Off 方向、`status`、非法/非 UI 命令均不写。通知或 requested bus 发布在状态改变后抛错时仍尝试写入，保留原业务错误；事件写入失败仅尝试发送固定警告 `本次计量记录无法确认`，警告失败也不逃逸，Fast 不回滚。启动、child 继承、模型切换和 shutdown 不调用 producer。RPC 的 `hasUI=true` 命令与 TUI 同口径，模型 Inactive 时仍记录用户 requested 意图。

producer 用 Pi 0.84.4 公开的 `getAgentDir()`，在 `<agentDir>/metrics/codex-fast-enabled/v1/` 写入每次开启的独立 `<eventId>.json`。JSON 精确字段为 `{ "schemaVersion": 1, "eventId": "UUID", "occurredAt": "UTC ISO 8601", "source": "user_command" }`；文件名中的 UUID 与内容一致。`metrics`、`codex-fast-enabled`、`v1` 创建时均为 `0700`；已存在的自有目录必须是 `0700`，符号链接或非目录拒绝，拒绝不合规权限而不调整 Pi 根或其他目录。事件临时文件 `0600`，先完整写入并同步，再通过排他 hard link 提交到最终文件名，提交后删除临时文件；已存在的文件/链接不覆盖。只有完整合法的 `.json` 文件可按 eventId 去重计数，`.tmp`、损坏或未完成文件不计成功；当前没有读取方。此目录是本地元数据而非 outbox；不会扫描旧文件作远端回填，崩溃/断电前未完成的 I/O 不保证保存。成功提交的记录ID和时间由命令接缝交给[项目指标投递链](项目指标-技术设计.md)，仅在显式配置启用时入独立私有outbox。

记录独立于 SessionManager、assistant、授权和额度查询：无 assistant 或 `--no-session` 的正常命令写入仍留在本地；不调用 `appendEntry`，不从事件恢复 requested，也不经 Pi Session export/share。本地记录模块不读 session、凭证、prompt、账号或模型内容，不发 HTTP；投递由独立项目指标client读取显式私有配置并执行，不产生跨会话常驻展示。本地存储文件不能等同云端已接收统计；Cloudflare 尚未部署。

## 4. Subagent 继承

| 边界 | 当前机制 |
| --- | --- |
| Producer | 通过 `pi.events` 发布 `@pi/codex-usage-status:fast-requested/v1`，只接受精确 `{ version: 1, sessionId, requested }`，缺失、多余或非法字段忽略 |
| Consumer | [`packages/subagent/src/fast-inheritance.ts`](../../packages/subagent/src/fast-inheritance.ts) 动态加载公共 parser，按 parent session 保存意图；producer 缺失或协议不可用时安全 Off |
| 传递条件 | 首次逻辑 child spawn 时读取 parent requested；仅 resolved user-source、exact `implementer`/`code_reviewer` 且 `codexFast: inherit` 命中；project agent 和其他 user agent 不继承 |
| 启动环境 | consumer 先复制环境并删除 `PI_CODEX_FAST`，条件满足才设为精确 `"1"`；child factory 读取后立即删除，一次性使用 |
| 时间边界 | chain / 排队 parallel 各自在实际 spawn 时取快照，已启动 child 不随 parent toggle 改变；reload/new/resume/fork 的新 factory 默认 Off |

继承的是 requested 意图，不是 Active 状态。child 独立检查模型资格；parent Inactive 不妨碍符合条件的 child Active。该协议是 advisory，不是认证或安全隔离，角色与来源筛选由 Subagent consumer 拥有。

## 5. 验证入口与当前边界

| 范围 | 证据入口 / 状态 |
| --- | --- |
| Fast、FIFO、费用、通知、hooks 及开启事件命令链 | [`fast-mode.test.ts`](../../packages/codex-usage-status/test/fast-mode.test.ts) |
| 本地事件 schema、私有权限、排他写入、链接与非目录拒绝 | [`fast-enabled-event.test.ts`](../../packages/codex-usage-status/test/fast-enabled-event.test.ts) |
| Fast 0.84.4 真实RPC命令与本地Worker loopback | 已执行离线：Off→On有效命令得到2条本地记录、2条已接收，pending=0；不是Cloudflare验收 |
| 额度 DTO、授权、刷新、过期、UI 与副作用 | [`usage.test.ts`](../../packages/codex-usage-status/test/usage.test.ts) |
| 仓库内 child 继承接线 | [`fast-inheritance.test.ts`](../../packages/subagent/test/fast-inheritance.test.ts) |
| Pi 1.0.4 loader、ExtensionRunner、命令/event bus、UI widget、请求替换、AI cost helper 与 shutdown | 使用本机 1.0.4 的真实 loader/runner 加载 package 并执行，核对组件 factory/`belowEditor`/ANSI 截断和 1.0.4 `calculateCost` 输出，无模型 HTTP 请求；可用 `PI_CODING_AGENT_1_0_4_PATH=<package-dir> node --experimental-strip-types --test packages/codex-usage-status/test/pi-1.0.4-compat.test.ts` 重复验证。peerDependencies 保留 Pi 0.84.4 系列，并显式支持 1.0.4 的 `pi-coding-agent`、`pi-ai`、`pi-tui`；没有扩大到其他 1.x 版本。依据为本机宿主 package manifest（其 AI/TUI 依赖均为 1.0.4）、ExtensionRunner/loader 实现与兼容测试 |
| Pi 1.0.4 tree cancellation | ExtensionRunner 源码确认 before-event 的 `{ cancel: true }` 会提前返回，AgentSession 只在未取消的流程后发 `session_tree`；package 的取消/退出隔离仍由 `fast-nonblocking.test.ts` 模拟接缝验证，未以真实 SessionManager 执行 tree 导航 |
| 真实交互式终端、真实账户额度请求、provider 对外请求及真实 child spawn | 未验证；兼容 smoke test 不访问凭据、不发模型请求，也不构成 TUI/provider/child E2E |

扩展只保证自身 hook 的输出。Pi 0.84.4 与 1.0.4 均没有最终 provider payload 或最终持久化 message 的可观测 hook；1.0.4 增加的 `before_provider_headers` 只允许修改请求头，不能证明最终请求 payload。后续请求 handler 可能改写 priority，其他消息 handler 可能改写 model/session、usage token 或 cost。因此支持费用关联与持久化结果的组合要求这些输入和结果不被其他 handler 改变；不能从 Active 推断 provider 接受 priority、实际加速或最终费用。

额度失败不阻塞、取消或改变模型请求；本扩展不自动重试/fallback 模型请求，也不持久化 Fast 意图。授权和 usage 接口是外部依赖，不能可靠读取时显示不可用，不估算额度。

自动化入口为根目录 `npm run test:agent` 与 `npm run typecheck`。固定 revision 的评审与验证记录见[证据归档](../归档/评审/codex-usage-status-fast-gpt-v1-交付记录.md)，不作为当前测试执行结果。
