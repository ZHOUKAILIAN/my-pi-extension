# Tool Text Contrast 技术说明

## 目标与根因

契约见 [L1 扩展规范](../01-产品定义/扩展/tool-text-contrast-扩展.md)。这是内置工具显示兼容修复，不改变 Subagent 的产品契约。

Pi 1.0.4 的 `write` renderer 对已识别语言直接使用 `highlightCode()` 输出。高亮主题缺少默认 foreground，未识别的 Markdown scope 与普通正文可能不产生前景色 ANSI；卡片背景却已使用 Pi 主题颜色。在深色终端中选浅色 Pi 主题时，终端浅色字因此落在浅色卡片上。内置 `read` 共用同一高亮函数。

## 实现边界

- 独立 package：`packages/tool-text-contrast`。
- 通过公共 `registerToolRenderer` 和 `next()` 包装 `read/write` 的已有 call/result renderer；不访问 Pi 私有模块，不重新实现语法分析或工具执行。
- 在最终渲染行上提供主题默认前景色，保留已有 foreground、背景、属性和链接；内部 reset 之后必须恢复主题默认 foreground。
- 每次 render 使用当前传入的主题，不把 ANSI 颜色永久存入业务状态；保留组件缓存、invalidate 和宿主的 lastComponent 约定。
- 非目标工具、缺失 renderer、空结果与图片输出保持原行为。

## 实现与验证状态

已实现于 `packages/tool-text-contrast/src/index.ts`。`ForegroundComponent` 提供逐行前景色补齐、原组件缓存解包、invalidate 及可选输入/鼠标/焦点能力转发；`applyTextForeground()` 跳过 CSI/OSC/APC 控制序列，仅为未显式设色的文本补色，识别 SGR 0/39 和 38/48/58 扩展颜色，逐行关闭前景色而不重置背景或文字属性。

| 项目 | 当前范围 |
| --- | --- |
| 兼容声明 | Pi `>=1.0.4 <1.2.0`；开发依赖固定 1.1.0，不升级其他 package 的 0.84.4 依赖。 |
| 自动化 | 真实 Pi 1.1.0 read/write renderer 以 `plain.ts` 未着色标识符精确断言 light/dark 的主题正文色及相邻语法色，原 renderer 基线缺色；另覆盖流式参数、主题切换、缓存、结果更新、错误/空结果、图片 fallback 与窄宽布局。ANSI 测试覆盖 SGR 和 BEL/ST 超链接。 |
| 宿主加载 | Pi 1.0.4 与 1.1.0 隔离 RPC loader 均可加载 package；1.0.4 内置 renderer call/result smoke 已验证。 |
| 隔离 PTY | 独立验证覆盖两版本的 light/dark 前景色、语法色保留、成功/错误/空输出、折叠/展开、窄宽及主题切换；本地 loopback SSE 夹具驱动真实 CLI 的分段参数与仅在临时目录执行的 read/write，流式与完成后颜色一致。 |
| 验证缺口 | 用户实际终端的视觉对比、`showImages: true` 内联图像显示，以及 1.1.x 其他 patch 未逐个验收。ANSI 检查不替代用户终端视觉验收。 |

[Pi 上游 issue #11092](https://github.com/earendil-works/pi/issues/11092)跟踪共享高亮器缺省前景色问题。本扩展不依赖其修复；移除本地 package 配置即可停用，启用或移除后运行 `/reload` 或启动新会话。
