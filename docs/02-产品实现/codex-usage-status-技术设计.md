# Codex Usage Status + Fast Extension 技术设计

| 项目 | 定义 |
| --- | --- |
| 状态 | `IMPLEMENTING` |
| 层级 | 第二层（L2） |
| L1 owner | [Codex Usage Status + Fast Extension 产品规范](../01-产品定义/扩展/codex-usage-status-扩展.md) |
| 目标 package | `packages/codex-usage-status` / `@pi/codex-usage-status` |
| 当前实现 | `packages/codex-usage-status` 已实现额度状态、Fast 请求/计费接线与 parent-Fast interop；focused tests 覆盖 eligibility、命令、bootstrap/env、事件发布、状态切换、payload hook、ticket/cost correction 与原有 usage 回归；真实 Pi TUI/provider E2E、local dispatcher live E2E 未执行 |

## 1. 结论先行

扩展只在 TUI 的当前模型为 `openai-codex`、`ctx.modelRegistry.isUsingOAuth(ctx.model)` 为真、且模型保有原生 `openai-codex-responses` API 与 `https://chatgpt.com/backend-api` base URL 时，以 `ctx.ui.setStatus()` 写入底栏。它把授权解析、额度读取和 UI 投影拆开：每次成功 scope 确认只授予 60 秒展示 lease，lease 到期先清除旧快照；usage HTTP 单独受 5 秒超时约束；所有异步结果都以 generation 和内存 scope fingerprint 验证后才能提交。

```mermaid
sequenceDiagram
    participant Pi
    participant Extension
    participant Usage as https://chatgpt.com/backend-api/wham/usage
    participant Footer as Pi footer

    Pi->>Extension: session_start / input / model_select / agent_settled
    Extension->>Extension: TUI/provider gate、scope generation、single-flight
    Extension->>Usage: GET（bearer + account scope，manual redirect）
    Usage-->>Extension: snake_case usage payload
    Extension->>Extension: 当前 scope 再验证、白名单投影
    Extension->>Footer: setStatus
```

## 2. Package 与公开边界

| 位置 | 责任 |
| --- | --- |
| `packages/codex-usage-status/src/index.ts` | Pi extension factory、`/fast` 与事件订阅、生命周期清理。 |
| `packages/codex-usage-status/src/fast.ts` | Fast intent/effective state、严格 eligibility、`service_tier` payload hook、bounded request ticket、assistant cost correction 与 Fast footer。 |
| `packages/codex-usage-status/src/usage.ts` | 授权 scope 提取、请求、wire DTO 解析、快照状态与格式化；不含 Fast 或 Pi UI 业务。 |
| `packages/codex-usage-status/test/*.test.ts` | 额度解析、授权/异步状态、格式化、安全回归和 Fast 行为测试。 |
| `packages/codex-usage-status/package.json` | Pi package manifest、运行依赖与入口；Pi peer 约束为 `>=0.84.4 <0.85.0`，直接使用的 `pi-ai` 为 dev `0.84.4`、peer `>=0.84.4 <0.85.0`。 |

该 package 是独立的 provider-status extension，不依赖 `workflow-runtime` 或 `workflow-contracts`，也不注册 Workflow Run、Artifact、Guard 或用户决策。

## 3. Fast Runtime 合同

### 3.1 Intent、eligibility 与 payload

`FastController` 每次 factory 实例化时把 requested intent 初始化为 `false`，只保存在内存。`/fast` 通过 `ctx.hasUI` 保护 TUI/RPC 控制；JSON/print 只发出限制通知，不改变意图。Fast footer 使用独立 `codex-fast` status key，不依赖 `UsageController` 的额度状态。

eligibility 是纯当前模型判断：provider、API、base URL 和模型 id 必须逐项精确匹配 allowlist，且 `isUsingOAuth(model)` 返回真；OAuth 抛错视为不 eligible。它不调用 `getProviderAuth`、usage fetch 或 timer。requested On 在模型切换时保留，effective state 在 Active/Inactive 间变化并更新 footer/通知。

Active 的 `before_provider_request` 仅接受 plain object 且 payload model 精确等于当前模型 id，返回 direct shallow copy `{ ...payload, service_tier: "priority" }`；其他情况返回 `undefined`。Fast footer 的 Active（`⚡ Fast`）文本使用受限 truecolor soft-orange `#D98C3F`（RGB `(217, 140, 63)`，固定 ANSI 序列 `\u001b[38;2;217;140;63m⚡ Fast\u001b[0m`，文本后立即 reset），Inactive（`Fast inactive`）/Off（`Fast off`）使用 Pi theme `muted`。Active 通知固定为 `⚡ Fast enabled — selected user implementer/code_reviewer agents inherit requested Fast.`；TUI 以同一 orange ANSI 渲染并以 `info` 发送，RPC（`context.mode` 非 `tui`）发送不含 ANSI 的相同纯文本并以 `info` 发送；Inactive/Off 保持现有通知语义。Off/Active/Inactive 只描述本扩展，不代表 provider 实际采用了 priority。Pi 0.84.4 没有最终 payload 或最终持久化 message 可观测 hook；支持的组合要求没有后续 `before_provider_request` handler 改变或移除本扩展输出的 `service_tier`。超出该组合时只保证本扩展自己的 hook 输出，不保证 provider 最终 tier 或 session 最终 cost。

### 3.2 Cost ticket 与恢复边界

每次实际改写创建最多 32 项 FIFO ticket，保存请求时复制的 model cost 和 session id/file。assistant `message_end` 按队列首项匹配 provider/API/model/session；不匹配或 malformed 时 fail open 并丢弃该 ticket。匹配后对 cloned usage 调用 public `@earendil-works/pi-ai` `calculateCost`，先分别乘 `gpt-5.5=2.5` 或其他 allowlist model `=2`，再按 Pi 0.84.4 原生顺序将四个 scaled component 相加为 `total`；只替换 `usage.cost` 且已正确计费时不返回 replacement。requested intent 在流式请求中途变化不影响 ticket。shutdown 清理 FIFO 与 Fast footer；session replacement 由 Pi 重建 extension，intent 不持久化。valid 的 `error`/`aborted` assistant message 只要 accrued usage 完整合法也会修正；malformed usage fail open。

Pi 会串行调用 `message_end` handlers。支持的组合要求：没有其他 handler（无论先于还是后于本扩展）改变模型/session 匹配输入、usage token 字段或 corrected `usage.cost`，以致影响本次 correction 或最终 persisted message。Pi 0.84.4 没有最终持久化 message 可观测 hook；超出该组合时只保证本扩展自己的 `message_end` hook 输出，不保证最终 session cost。

该 ticket 只关联触发本扩展 hook 的逻辑 Agent 请求；已构建请求、internal retry、compaction/branch-summary 等没有该 hook 的请求不受影响。消息与 extension 顺序只能提供本 session 内 bounded correlation，后续 payload rewriter 和不可观测的 provider 请求复用仍不在当前保证内。

### 3.3 Parent-Fast interop 当前机制

`src/interop.ts` 定义版本化 channel `@pi/codex-usage-status:fast-requested/v1`、环境名 `PI_CODEX_FAST`、严格 plain-object parser 和安全发布 helper。`index.ts` 在 `session_start` 发布当前 requested，合法且状态改变的 `/fast on|off|toggle` 后发布刷新，`status`、非法参数和 `hasUI=false` 命令不发布，session id 读取失败时 fail closed；`session_shutdown` 发布 false。Fast 激活/模型重新变为 Active 的通知明确提示 selected user `implementer`/`code_reviewer` 的新 spawn 会继承 requested Fast，保留紧凑 orange footer。

factory 启动立即消费 `PI_CODEX_FAST`：仅精确字符串 `"1"` 初始化 requested On，随后无论取值为何删除变量；该变量不会进入 child 的 shell、grandchild 或 reload。它是 advisory trusted-launcher input，不是认证、安全边界或持久化机制。其余 provider/API/base URL/OAuth/model eligibility 仍由 child 自己判断，因此 parent requested On 的 Inactive 不会阻止 eligible child Active；child reload/new/resume/fork 由新 factory 回到 Off。

本 package 不拥有也不复制 subagent dispatcher 的 role/source/config policy。local dispatcher 监听上述 channel，以 exact session id 保存 requested intent，并在每个实际 spawn 前同步构造新 env：先删除 ambient `PI_CODEX_FAST`，再只为 resolved USER-source 且精确名为 `implementer`/`code_reviewer`、frontmatter `codexFast: inherit` 的 agent 设置 `"1"`。project source（含同名 override）和其他 user agent 均不继承。chain 和 queued parallel item 逐个实际 spawn 取快照；已 spawn child 不受 toggle 影响。该 local policy 不是 package-only VERIFIED 证据。

producer `packages/codex-usage-status/src/interop.ts` 与 consumer `/Users/zhoukailian/.pi/agent/extensions/subagent/fast-inheritance.ts` 之间保留事件/env 合同的 duplication drift；两端没有伪称为 shared package import。local parity test 覆盖 consumer 的生产 helper，实际 child process/provider E2E 仍为 UNVERIFIED。

## 4. 额度读取合同

### 4.1 请求安全合同

| 项目 | 规则 |
| --- | --- |
| 前置门禁 | `ctx.mode === "tui" && ctx.model?.provider === "openai-codex" && ctx.model.api === "openai-codex-responses" && ctx.model.baseUrl === "https://chatgpt.com/backend-api" && ctx.modelRegistry.isUsingOAuth(ctx.model)`；不满足时显示 `unavailable`（非 Codex 时清除），且不解析授权、不联网、不创建 timer。该完整性检查拒绝 endpoint/API 覆盖；名称等不改变这些运行时字段的元数据覆盖不可区分且可接受。 |
| URL | 常量 `https://chatgpt.com/backend-api/wham/usage`；不得使用或拼接 provider `baseUrl`。 |
| 方法 | `GET`，无请求体。仅 HTTP `200` 可解析；所有非 200 和 3xx 都失败。 |
| 授权 | 通过 `ctx.modelRegistry.getProviderAuth("openai-codex")` 取得内存 bearer token；从其 JWT payload 的 `https://api.openai.com/auth` claim 提取账户作用域。解析失败即 `unavailable`。 |
| 请求 headers | `Authorization: Bearer ...`、`ChatGPT-Account-ID: ...`；不发送 Reserve opt-in 或其他会改变账户状态的 header。 |
| 重定向 | `redirect: "manual"`；不读取或请求 `Location`。 |
| HTTP 超时 | `AbortSignal.timeout(5000)` 仅约束 usage `fetch`。 |
| 授权解析 | `getProviderAuth` 本身不接受 AbortSignal，可能触发 Pi 最长约 15 秒的刷新/持久化；其结果只能通过 generation 判定是否仍可用，不能阻塞 UI 或输入处理。 |
| body | `content-length` 超过 64 KiB 直接失败；否则流式读取解码后的 body，累计超过 64 KiB 立即 cancel reader/abort，再只接受 JSON plain object。 |
| 调度 | `session_start`、`input`、`model_select`、`agent_settled` 只后台排队；每次成功 scope 确认设置 60 秒 lease，到期先清除 snapshot/递增 generation 再校验。usage 最小刷新间隔 60 秒、定期刷新 5 分钟；同一时刻最多一个授权解析和一个 usage 请求。 |

实现不得读取认证文件、请求用户输入 token、复用代理 base URL 或向非固定 URL 发请求。若服务端要求当前扩展无法安全生成的条件路由 header，视为 `unavailable`。

### 4.2 Wire DTO 与白名单投影

直接 HTTP 响应按如下 snake_case 形态读取：

```typescript
interface UsageWireWindow {
  used_percent?: unknown;
  limit_window_seconds?: unknown;
  reset_at?: unknown;
}

interface UsageWireLimit {
  allowed?: unknown;
  primary_window?: UsageWireWindow;
  secondary_window?: UsageWireWindow;
}

interface UsageWireResponse {
  account_id?: unknown;
  rate_limit?: UsageWireLimit;
  // additional_rate_limits is intentionally ignored and never parsed/projected.
}
```

原始响应、账户 scope、token 和 headers 均不跨出请求状态机。UI 只接收：

```typescript
interface UsageWindow {
  remainingPercent: number;
  windowDurationMins?: number;
  resetsAt?: number;
}

type Availability = "allowed" | "limited" | "unknown";

interface UsageDisplaySnapshot {
  availability: Availability;
  windows: readonly UsageWindow[];
  fetchedAt: number;
}

interface InternalScopedSnapshot {
  display: UsageDisplaySnapshot;
  scopeFingerprint: string; // 仅状态机内存比较，不进入 UI DTO、日志或持久化。
}
```

解析规则：

1. 只读取默认 `rate_limit`；忽略且不解析 `additional_rate_limits`，不读取 app-server camelCase 投影、credits、upsell 或未知字段。
2. 默认 bucket 只依次读取 primary、secondary。`used_percent` 必须为有限数值 `0..100`；`remainingPercent = Math.round(100 - usedPercent)`。`limit_window_seconds` 只接受正整数并换算分钟；`reset_at` 只接受在 `2000-01-01..2100-01-01` 的正整数 Unix 秒级时间。
3. 只有默认 `rate_limit.allowed` 决定全局 `availability`。`true` 是 `allowed`、`false` 是 `limited`，其他值是 `unknown`。
4. 无任一合法默认窗口即解析失败。JWT 必须恰有三段、base64url payload 可解析为 plain object，且若 `exp` 存在必须是未过期的有限 Unix 秒；scope claim 不合法即失败。若响应有 `account_id`，它必须是非空字符串且与请求 scope 匹配；类型错误、空值或失配均丢弃整个响应。比较后立即丢弃账户标识。

## 5. 授权、快照与 UI 状态机

```mermaid
stateDiagram-v2
    [*] --> Hidden: 非 TUI 或非 openai-codex
    [*] --> Refreshing: TUI Codex model
    Refreshing --> Current: scope 当前 + allowed + 有效窗口
    Refreshing --> Limited: scope 当前 + limited + 有效窗口
    Refreshing --> Unknown: scope 当前 + unknown + 有效窗口
    Refreshing --> Stale: 同 scope 失败且 age < 10m
    Refreshing --> Unavailable: 无快照 / scope 变更 / age >= 10m
    Current --> Unavailable: hard-expiry timer
    Limited --> Unavailable: hard-expiry timer
    Unknown --> Unavailable: hard-expiry timer
    Stale --> Unavailable: hard-expiry timer
    Current --> Hidden: model_select 切离 Codex
    Limited --> Hidden: model_select 切离 Codex
    Unknown --> Hidden: model_select 切离 Codex
    Stale --> Hidden: model_select 切离 Codex
```

| 状态 | 底栏 | 规则 |
| --- | --- | --- |
| `Hidden` | 清除 extension status | 无认证/网络/timer。 |
| `Current` | `Codex · 72% ███████░░░ · Sep 16 10:41` | C「胶囊额度」样式；只展示当前 scope 的默认 bucket 合法窗口。 |
| `Limited` | `Codex limit reached` | 不显示会误导许可状态的进度条。 |
| `Unknown` | `Codex status unknown · 72% ███████░░░` | 只展示默认窗口；不推断许可。 |
| `Stale` | `Codex: stale <previous text>` | 仅 `now - fetchedAt < 10m` 且 scope fingerprint 相同。 |
| `Unavailable` | `Codex: unavailable` | 不展示旧数值。 |

每次成功 scope 确认授予 60 秒 scope lease，并安排 lease timer。lease timer 触发时先递增 generation、清除 snapshot 和 hard-expiry timer、显示 `unavailable`，再后台重校验；因此授权解析长期 pending 也不能使旧账户数据展示超过 lease。每次校验后都比较 fingerprint；缺失、变化或不匹配时同样清除。所有在途授权/HTTP 的晚到结果 generation 不一致时丢弃。成功 usage 快照另在 `fetchedAt + 10m` 安排 hard-expiry timer，触发时重新检查 age 与 scope 后清除旧比例；因此没有新请求结果也不会超过硬期限展示 stale。

`formatProgressBar(remainingPercent)` 返回 10 个字符：`filled = clamp(Math.round(remainingPercent / 10), 0, 10)`，前 `filled` 个为 `█`，其余为 `░`。正常状态以受限 truecolor ANSI 输出：比例和填充块 `#74d9a5`（`38;2;116;217;165`），空块 faint `#59677c`（`38;2;89;103;124`），每个被着色片段后立即附 `reset`；不得接受服务端颜色/ANSI。`Codex`/重置时间仍通过 `ctx.ui.theme.fg("dim", …)`，`stale`/`status unknown` 用 `warning`、`limit reached` 用 `error`。`setStatus()` 不提供 extension 可用宽度。格式必须把许可状态、比例和进度条放在重置详情前，让宿主截断时保留主要信息；扩展不得声称自行适配全局 footer 宽度。

## 6. 失败、恢复与可运营性

- 所有失败仅转换为 `Unavailable` 或同 scope 的 `Stale`，不向 Agent、provider 请求和 session 流程抛出。
- `model_select` 切离 Codex 时立即清除状态并失效在途请求；切回时后台触发 scope 校验和受限刷新。
- `session_shutdown` 清除全部定时器、递增 generation、清除底栏；reload/new/resume 不复用旧 session 的内存快照。
- 刷新触发在请求进行时合并为一个后续刷新意图；失败不立即重试。内存中可保留无敏感数据的 reason code（如 `unauthenticated`、`timeout`、`schema_invalid`、`scope_mismatch`）及最后尝试时间，供测试和未来安全诊断使用，但不写入 status、日志或 session。
- HTTP 状态、错误文本、headers 和原始 body 不进入 status、日志、session 或测试快照。
- 上游接口改变时解析失败是可预期状态；不引入网页抓取、浏览器自动化或 token 使用量估算。

## 7. 验证计划

| Fast 验证 | 证据 |
| --- | --- |
| 命令与模式 | focused test 覆盖空参数、`on`、`off`、`toggle`、`status`、非法参数；JSON/print `hasUI=false` 不改变 intent，RPC `hasUI=true` 可改变。 |
| gate 与状态 | focused test 覆盖精确 provider/API/base URL/OAuth/model-id gate，以及 Off/Active/Inactive、独立 status key、模型切换保留 requested On；无授权读取、网络和 timer 副作用。 |
| payload hook 与组合边界 | focused test 覆盖 plain-object/model match、浅复制和嵌套/原 payload 引用保持；L1/L2 明确 Pi 0.84.4 无最终 payload 或最终持久化 message 可观测 hook，支持组合要求没有后续 `before_provider_request` handler 改变/移除 tier；测试只证明本扩展 hook 输出，不假设可观测最终 provider tier。 |
| ticket 生命周期 | focused test 覆盖请求时 model/session 快照、中途 Off、session mismatch、shutdown、32 项 FIFO bound；无本扩展 hook 的 message 不进入 correction，并记录其他 `message_end` handler 不得改变匹配输入或 token 字段的支持边界。 |
| cost correction | focused test 覆盖非 `gpt-5.5` 2x、`gpt-5.5` 2.5x、long-context native tier、scaled component sum、浮点 native-priority idempotence；最终 session cost 仅在其他 `message_end` handler 不影响匹配输入、token 字段或 corrected `usage.cost` 的组合下受支持。 |
| malformed 与 terminal usage | focused test 覆盖负数/非整数 token、缺失必需字段、reasoning/cacheWrite1h 的范围与交叉约束；合法 accrued usage 的 `error`/`aborted` message 仅按支持的 handler 组合修正，测试不假设可观测最终持久化 message。 |
| usage independence/reset | focused test 覆盖 Fast 与 usage 独立 status key/副作用，以及两个 extension factory 实例的 Off reset；真实 ExtensionRunner/Pi provider E2E 仍为 residual。 |
| parent-Fast interop | Repo focused test `node --experimental-strip-types --test packages/codex-usage-status/test/fast-mode.test.ts` 覆盖 exact bootstrap env/delete、继承 JSON child 无 command 时的 eligible `before_provider_request` priority、ineligible child payload unchanged，以及第二次 factory 在 one-shot consume 后 Off。Local production helper test `/Users/zhoukailian/.pi/agent/extensions/subagent/test/fast-inheritance.test.ts` 以 `node --experimental-strip-types --test /Users/zhoukailian/.pi/agent/extensions/subagent/test/fast-inheritance.test.ts` 执行，覆盖 exact/malformed event 与 `codexFast`、session registry true/false/shutdown deletion、user/name/config policy、ambient env sanitization、chain/queued spawn snapshots 和既有 env 不受 toggle 影响。producer/consumer 合同 duplication drift 仍保留，local parity 不是 shared package import；actual child process/provider E2E UNVERIFIED。 |

| 验证 | 证据 |
| --- | --- |
| 单元测试 | 仅默认 bucket（额外 bucket 永不进入投影/UI）、主窗口、多窗口、10 单元进度条、非法/零窗口、剩余比例舍入、availability、非 200、3xx、超大/伪造 content-length、流式膨胀 body、畸形 DTO、JWT base64url/expiry、账户失配。 |
| 时序测试 | 60 秒 scope lease（含认证永久 pending、换号/登出）、5 分钟 timer、60 秒 usage 限频、single-flight、pending refresh、hard expiry、模型切换/shutdown/reload 和晚到 promise 丢弃。 |
| 安全回归 | 固定 URL、OAuth provider/API/baseUrl integrity gate 与 manual redirect；覆盖 `openai-codex.baseUrl` 或 API 的模型均不触发授权/网络。mock response 含账户或 token-like 字符串、headers 时，状态/UI DTO/持久化数据均不含它们。 |
| 模式测试 | TUI 外不调用授权解析、网络或 timer。 |
| TypeScript / 全仓 | 根 `package.json` 与 lockfile 的 Pi 开发依赖为 `0.84.4`；Fast package 的 `pi-ai` dev 为精确 `0.84.4`、peer 限定在 `>=0.84.4 <0.85.0`；运行 `npm run typecheck`、`npm test`。 |
| Pi TUI 手工验证 | 已登录 Codex 会话可显示额度；启动/输入不等待网络，模型切换立即隐藏，失败不阻塞对话。该项不是单元测试可替代的 E2E。 |

本设计与 L1 规范已作为实现输入；当前源码与测试已落地上述机制，真实 Pi TUI/provider E2E 仍待手工验证。
