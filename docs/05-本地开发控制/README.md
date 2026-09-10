# 第五层：本地开发控制

第五层回答“什么只用于维持当前本地工作现场”。真实第五层材料默认不进入 GitHub；本目录只记录边界和提升规则，不存放 live 状态。

## 本地保留对象

- 当前任务卡、临时 handoff 和 session 恢复草稿；
- Worker Session JSONL、Run Control WAL、用户补充信息投递事件和失败恢复现场；
- Pi TUI 录屏/截图、调试 trace、临时日志和一次性真实 provider 验证输出；
- 未采纳的个人模型、模型切换实验或 skill 试验配置；
- `node_modules/`、`dist/`、`*.tsbuildinfo` 等可再生成材料；
- 包含本地路径、账号、凭证或用户数据的工作材料。

这些对象不是正式真理源，不得覆盖第一至第四层。不能仅因“不应公开”就删除仍用于当前工作的本地材料。目标实现把 Run Control WAL、Child Session 和含原文的 UI 投影保存在 Extension 自有的 Pi agent 本地状态子目录：创建目录时强制 `0700`、文件强制 `0600`，启动时校验并收紧权限；不能满足时 fail-closed，不依赖 Pi SessionManager 当前 `0755/0644` 默认。它们不得提交、自动上传 Telemetry 或写入公开 Trace；正式层只记录脱敏后的协议、验收结论和可重复验证证据。

新 Run 的父 Pi Session custom entries 只保存不含补充原文、内容派生 digest、Worker 完整输出或工具参数的随机 opaque ID 和粗粒度状态投影；原对话由 renderer 按引用读取受保护 sidecar。Pi 普通 export/share 即使包含这些新 custom entries，也不能自动附带 Child JSONL、Run Control WAL 或完整 UI 投影。迁移前历史 Session 的旧 `workflow-run` entry 不会被静默重写，仍遵循当时 Pi export/share 行为，恢复旧 Run 时必须显示 legacy 数据边界提示。若未来需要导出 Child 详情，必须单独展示范围和敏感信息提示，并由用户明确确认。

Worker Session、WAL 和 UI sidecar 是父 Pi Session/Workflow Run 的从属本地材料。每 Run 最多 20 个 Worker attempt；intermediate Worker/UI 原文在 settled 30 天后到期，无 live lease 的 unfinished Run从最后 durable event起保留30天；parent缺失的 settled Run从首次观察起最多再保留7天并取更早期限。最终用户报告和粗状态留在父对话，过期详情显示已按本地策略清理。

Pi 没有可靠删除事件，因此不能声称父 Session 删除时立即清理。GC 与 writer 共用 Run 目录外的 operation lock，删除前在锁内复核 parent、终态、deadline和 lease/epoch；活或不确定 owner一律不删。符合条件时先原子 rename为受保护 root 下的 tombstone并 fsync目录，再异步删除；恢复端看到 tombstone必须拒绝，删除失败持续重试。默认值由 L3 拥有、机制由 L2 拥有；不得仅因未出现在当前 branch 就误删仍可恢复的 Run。

## 提升规则

需要跨任务稳定复用时，先去除临时状态和敏感信息，再按责任提升：

- 产品语义或契约进入第一层；
- 源码、测试或可执行 runtime contract 进入第二层；
- 仓库默认和项目配置进入第三层；
- GitHub 协作和验证规则进入第四层；
- 研究、比较和历史证据进入归档。

提升必须写入目标层的现有 owner；不得直接提交 live handoff 或 session dump 来代替正式化。
