# 00：仓库组织形式

- 状态：`ALIGNING`
- 类型：Extension 集合总体方案

## 要回答的问题

`my-pi-extension` 这个仓库如何承载多个 Pi extension？

## 待对齐问题

1. 是一个 Pi package，还是一个仓库内多个可独立安装的 package？
2. 共享 core 是否需要存在？如果需要，哪些能力进入 core？
3. extension 是独立加载，还是由一个主 extension 统一注册？
4. Policy、artifact、trace、skill 和测试放在哪里？
5. extension 之间如何协作：共享库、事件、artifact，还是其他协议？
6. 如何安装、启用、禁用、升级和回滚单个 extension？
7. 如何保证一个 extension 的失败不会污染其他 extension？

## 当前候选结构

```text
my-pi-extension/
├── package.json
├── src/                         # 共享 TypeScript 实现
│   ├── core/                    # 只有明确共享的协议和运行时能力
│   └── extensions/              # 每个 Pi extension 的入口
├── policies/                    # 可版本化策略
├── skills/                      # 本集合自带 skill（如需要）
├── tests/
└── docs/
```

## 本文暂不决定

- 是否一定需要 `core`；
- 第一批 extension 的最终数量；
- CLI、RPC、SDK worker 选型；
- 具体实现代码结构。

## 下游文档

- [Extension 集合目录](01-extension-catalog.md)
- [Workflow Router](extensions/workflow-router.md)
