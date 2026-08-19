# 00：仓库组织形式技术方案

- 状态：`ALIGNING`
- 对应问题：[仓库组织形式](README.md)
- 上游：无
- 下游：[Extension 集合目录](../01-extension-catalog/README.md)

## 1. 方案目标

确定 `my-pi-extension` 如何组织一组服务于个人工作流的 Pi extension，包括：

- Git 仓库边界；
- Pi package 边界；
- extension 入口边界；
- 共享代码和共享协议边界；
- Policy、skill、artifact、trace 和测试的归属；
- 安装、加载、启用、禁用和升级方式。

本文件只决定仓库组织，不决定具体 extension 的内部技术实现。

## 2. 组织层次

```text
Git Repository
  └── Pi Package
        ├── Extension A
        ├── Extension B
        └── Shared Core
```

三者职责不同：

| 层次 | 职责 | 主要生命周期 |
|---|---|---|
| Git Repository | 源码、文档、测试、版本协作 | Git branch / commit / PR |
| Pi Package | 安装、分发和依赖管理 | `pi install` / package version |
| Extension | Pi runtime 中注册 command/tool/event/UI | Pi startup / reload / session |

## 3. 候选方案

### 方案 A：一个仓库、一个 Pi package、多个 extension

```text
my-pi-extension/
├── package.json
├── extensions/
│   ├── workflow-router.ts
│   ├── task-delegation.ts
│   ├── solution-review.ts
│   ├── code-review.ts
│   ├── verification.ts
│   └── workflow-ui.ts
├── src/
│   └── core/
├── policies/
├── skills/
├── tests/
└── docs/
```

优点：

- 和你的个人工作流属于同一个版本边界；
- 共享 `core`、Policy、Artifact 和 Trace 协议简单；
- extension 之间便于联调；
- 安装和升级简单；
- 适合当前从设计到实现的阶段。

风险：

- 单个 package 的 extension 之间可能形成隐式依赖；
- 默认全部加载时，工具、命令和权限面会扩大；
- 需要明确 extension 的启用和依赖规则。

### 方案 B：一个仓库、多个 Pi package

```text
my-pi-extension/
├── packages/
│   ├── workflow-router/
│   ├── task-delegation/
│   ├── solution-review/
│   └── code-review/
└── packages/core/
```

优点：

- extension 可以独立安装、升级和禁用；
- 包之间的依赖边界更显式。

风险：

- 需要处理多个 package 的版本兼容；
- `core` 需要单独发布或通过 workspace 管理；
- 早期开发和联调复杂度明显增加；
- 个人工作流被拆成多个发布单位。

### 方案 C：一个主 extension，内部模块化

```text
my-pi-extension/
└── extensions/index.ts
```

优点：

- 初始实现最简单；
- 所有状态天然在一个 runtime 中。

风险：

- extension 边界消失；
- 任意模块都可能修改全局状态；
- 工具、命令、事件和权限耦合；
- 后续无法独立启用、禁用或替换；
- 最终容易变成一个超大 extension。

## 4. 当前推荐

当前推荐采用：

> **一个 Git 仓库、一个 Pi package、多个独立 extension entry point，共享一个普通 TypeScript core。**

```text
my-pi-extension/
├── package.json
├── extensions/                  # Pi extension entry points
│   ├── workflow-router.ts
│   ├── task-delegation.ts
│   ├── solution-review.ts
│   ├── code-review.ts
│   ├── verification.ts
│   └── workflow-ui.ts
├── src/core/                    # 不直接注册 Pi API 的共享模块
├── policies/                    # 版本化 Policy
├── skills/                      # 本集合自带 skill（如需要）
├── tests/                       # core 和 extension 测试
└── docs/                        # 问题、设计、评审和决策文档
```

### 为什么选择这个边界

1. 这些 extension 都服务同一个个人工作流，而不是互不相关的工具集合。
2. 它们需要共享 Workflow Run、Policy、Artifact、Review 和 Trace 协议。
3. 当前主要风险是工作流边界是否合理，不是发布拆包能力不足。
4. 一个 package 可以先验证完整工作流，再根据真实依赖和使用方式拆包。
5. 独立 entry point 保留了未来按 extension 启用或拆包的可能性。

## 5. Extension 的独立性要求

虽然暂时放在一个 package 中，每个 extension 仍必须有独立边界：

- 独立的入口文件和 factory；
- 独立注册自己的 Pi API；
- 独立的 Policy 适配；
- 独立的输入/输出 Artifact；
- 不直接修改其他 extension 的内存状态；
- 通过 `src/core`、typed Artifact 或 `pi.events` 协作；
- 能明确列出上游和下游依赖；
- 可以被配置禁用，或明确声明为其他 extension 的必需依赖。

`src/core` 只放真正跨 extension 共享的内容：

- domain types；
- schema；
- 状态转换校验；
- Artifact 和 Trace 协议；
- worker/runtime 抽象；
- 通用 Policy 校验。

`src/core` 不直接注册 `/build`、`delegate_task` 或其他用户入口。

## 6. 加载与启用的初步设计

初步采用：

- 安装单位：整个 repository 对应的一个 Pi package；
- 代码单位：多个独立 extension entry point；
- 默认策略：由 package manifest 加载候选 extension；
- 运行策略：由 project/global settings 或 Policy 决定具体启用项；
- 依赖策略：extension 显式声明依赖，缺少必需依赖时 fail closed；
- 版本策略：初期统一版本，后续根据真实使用情况决定是否拆包。

这里的“默认加载候选 extension”和“实际启用 extension”需要在后续实现前进一步验证 Pi package 的过滤和 settings 行为，不能只靠约定。

## 7. 需要后续决定的问题

1. Pi package manifest 如何列出多个 extension entry point？
2. 是全部自动发现，还是显式列出每一个入口？
3. extension 禁用配置放在 package settings、Policy，还是两者分工？
4. extension 依赖如何声明和校验？
5. `src/core` 是否需要独立测试包或 build step？
6. 一个 extension 加载失败时，其他 extension 是否继续加载？
7. 哪些 extension 需要共享同一个 runtime instance？
8. 未来拆成多个 package 的触发条件是什么？

## 8. 评审要求

本方案在进入实现前需要至少经过：

- 一个关注 package/repository 边界的独立方案评审；
- 一个关注 extension 生命周期和 Pi 加载机制的独立方案评审；
- 一个关注依赖、故障隔离和升级的独立方案评审；
- 一个 arbiter 形成最终决策；
- 用户确认最终组织边界。

## 9. 暂定结论

当前暂定结论为方案 A，但状态仍是 `ALIGNING`。在 `01-extension-catalog` 完成之前，不创建具体 extension 的实现代码。
