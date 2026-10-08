# Pi 1.1.0 Subagent 兼容验证记录

本记录归档兼容修复提交 `b6fcd58` 的评审与验证证据，不定义当前产品规则。产品保证见 [L1](../../01-产品定义/扩展/subagent-扩展.md)，当前机制和未关闭风险见 [L2](../../02-产品实现/subagent-dispatcher-技术设计.md#81-pi-110-协议与验证边界)。

## 代码评审与自动化验证

| 项目 | 2026-10-08 结果 |
| --- | --- |
| 独立 `code_reviewer` | 兼容代码切片 `APPROVED`；不代表整个 v2 或默认并发全量门禁通过。 |
| runner/dispatcher 定向测试 | 61 项通过。 |
| `npm run typecheck`、`git diff --check` | 通过。 |
| 串行全量 | 独立取证运行 `node --experimental-strip-types --test --test-concurrency=1 packages/*/test/*.test.ts`，814/814 通过。 |
| 默认 `npm test` | 最后修复后的两次运行分别有 2 项、1 项 fence 测试失败，未全绿。fence 文件隔离重复四次均为 18/18，不能代替默认并发门禁。 |

独立取证确认，基线与修复代码均先由服务端发送 ACK、resolve handshake，再写 child stdin；这不保证 child 已收到 ACK，失败记录包含 `stdin-before-handshake` 反例。其余 graceful/handshake 超时的逐次原因未证实，adoption 并发测试一次波动的根因也未确认。兼容修复未更改这套握手机制，未通过放宽 deadline 或断言消除失败。

## 独立真实调用验收

| 场景 | `verifier` 观察结果 |
| --- | --- |
| 环境 | 实际 Pi 1.1.0、`openai-codex/gpt-6-sol`，生产 `dispatchAgent → runPiAttempt` 路径；临时合成数据、规范真实路径。 |
| 创建 | 一次只读工具调用读取合成随机标记；`success/exit=0/stop`，registry=`settled`，完整 session 校验为 true。 |
| 续接 | 同 handle、同 child session；第二轮提示未复述标记，回复正确回忆；无额外工具调用，`success/exit=0/stop`，session 再次校验为 true。 |
| 调用数 | create、resume 两个实际 Pi 进程，共三次模型响应。 |
| 隔离范围 | child 禁用 ambient extensions/MCP/skills/context；不等同于正常 TUI 安装链路或当前父会话 reload 验收。 |

首次临时 cwd 使用 `/var` 别名而 Pi header 写 `/private/var`，严格身份校验拒绝，create 失败、resume 未执行。后续在新规范真实路径下通过，未放宽校验、未解除上次 quarantine；不能将通过结论扩大为任意路径别名均受支持。

后续规范路径验收的报告脚本曾因漏传 `agentName` 派生出错误 registry key 而报 ENOENT；只读纠正并核实创建结果后才执行唯一一次 resume，没有重复 create。验证期间未修改源码；父会话核对验收前后的已审 diff 一致。
