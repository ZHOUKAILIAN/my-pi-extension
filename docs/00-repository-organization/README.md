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

## 当前讨论范围

这里暂时只记录需要做出的组织决策，不把候选目录结构写成既定事实。当前需要比较的是：

```text
一个仓库
  -> 一个 Pi package 或多个 Pi package
      -> 一个主 extension 或多个独立 extension entry point
          -> 是否存在共享 core
```

Policy、artifact、trace、skill 和 tests 的具体归属，等 package、extension 和 core 的边界确定后再落目录。

## 本文暂不决定

- 是否一定需要 `core`；
- 第一批 extension 的最终数量；
- CLI、RPC、SDK worker 选型；
- 具体实现代码结构。

## 下游文档

- [仓库组织技术方案](technical-design.md)
- [Extension 集合目录](../01-extension-catalog/README.md)
- [Workflow Router](../extensions/workflow-router.md)
