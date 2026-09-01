# submit_artifact Per-Kind Schema 上游门禁：方案与评审记录（已采纳）

- 状态：已采纳并实现（commit `b9f9792`，2026-08-31）
- 关联故障：`INVALID_CHANGE_PLAN_REVIEW_ROOT_CAUSE_ALIGNMENT`（评审模型提交 `"rootCauseAlignment": "true"` 字符串，错误回喂后仍连续失败，Run 暂停等 /resume）
- 方案原文：`.pi/proposals/2026-08-31-submit-artifact-per-kind-schema.md`（第五层本地，v2 定稿版）

## 结论先行

| 问题 | 答案 |
| --- | --- |
| 解决了什么 | artifact 结构错误（类型/枚举/必填）从 execute 内事后校验前移到工具声明 + pi 入口校验，生成时约束模型输出 |
| 现状澄清 | 「错误回喂 + session 内重试」是 pi 现状已有能力（agent-loop error tool result 通道），方案的真实增量是**生成时约束**与 **execute 前拦截** |
| 平台事实 | pi 校验管道先 convert 后 validate（typebox Value.Convert）：`"true"`→`true`、`null`→`false`、数字→字符串、null 可选字段删除 |
| 关键技法 | boolean 判决字段（rootCauseAlignment/requiresRepositoryChange/accepted）用 `{enum:[true,false]}`（无 type 关键字）声明，绕开 convert 触发条件，`"true"`/`null`/`1` 被 enum 拒绝——与权威层现状行为一致，杜绝 `null→false` 静默翻转判决 |
| 已接受的 coerce | string 字段数字→字符串（意图等价）、可选字段 null→删除（等价未提供），记录为平台行为 |
| 一致性保证 | contracts 单一 per-kind 字段定义表（`SUBMIT_ARTIFACT_FIELD_RULES`，FieldRule 显式 `required` 属性单源）同时派生 `ARTIFACT_JSON_SCHEMAS` 与驱动 `validateSubmitArtifact` 字段检查 |
| 映射收敛 | `NODE_ARTIFACT_KINDS` 全仓唯一一份（contracts），runtime 删除本地 `NODE_KIND_BY_NODE_ID` 改为导入 |
| 兜底 | 未知 node.id 退最小宽松 schema + `schema_fallback` progress 事件可见；权威层始终兜底 |

## 评审轨迹与关键 findings

| 轮次 | 评审者 | 结论 | 关键 finding |
| --- | --- | --- | --- |
| 方案评审 | solution_reviewer（glm-5.3，独立） | REVISE | ① pi 隐式 coerce：方案标志性场景会被静默改写而非拒绝（P1，方案级盲点）；② 错误回喂是现状已有能力，方案高估增量（P1）；③ 现有测试太薄不足以证等价（P1）；④ NODE_KIND_BY_NODE_ID 与新增映射构成双份漂移（P2）；⑤「workflow 定义已有 artifactKind 字段」表述错误（勘误） |
| 用户决策 | — | 三项 | ① boolean 判决字段不接受隐式 coerce（enum 技法）；② 保留未知 node.id 兜底且可见；③ 映射只留一份放 contracts |
| 代码评审 R1 | code_reviewer | FAIL | F1（P1）：required 派生 type 白名单漏 `stringList`/`implementationDetails`，7 个必填字段未进 schema required，测试全绿掩盖缺口；F2/S1/S2（P2） |
| 修复轮 | implementer | — | required 收敛为 FieldRule 显式属性单源；深冻结导出；`Record<SchemaArtifactKind>` 收紧；补 7 字段双门禁测试 |
| 代码评审 R2 | code_reviewer | PASS with P2 | F1/F2/S1/S2 全部确认修复；新 N1（`in` 命中原型链→裸 TypeError）、N2（测试深路径 import 脆弱） |
| 修复+终审 | implementer + code_reviewer | PASS | N1 改 `Object.hasOwn` + 断言钉住；448/448 全绿 |

## 落点

- 代码：`packages/workflow-contracts/src/index.ts`（定义表/schema 导出/validate 重构/守卫）、`packages/workflow-runtime/src/pi-sdk-worker.ts`（per-node 绑定）、`packages/workflow-runtime/src/index.ts`（映射收敛）、`packages/fix/src/extension-v2.ts`（schema_fallback trace）
- 测试：`equivalence-baseline.test.ts`（17，错误码/信息/顺序等价基线，含重构前源码独立复验）、`artifact-schema-gate.test.ts`（真实 pi 管道 convert→validate 回归，含故障输入固定回归场景）
- L2 文档：`fix-runtime-technical-design.md` 双门禁机制小节；`README.md` drift 表登记「fix 业务逻辑在通用 runtime 待拆」
- L1 无变化（boolean 判决字段拒绝行为与现状一致；coerce 接受项为工具链平台行为，不改产品契约）

## 遗留账

| 项 | 处置 |
| --- | --- |
| N2：测试对 pi-ai 深路径 import 脆弱 | 记账；pi 升级或 node_modules 重排时 `artifact-schema-gate.test.ts` 头部 import 需关注 |
| fix 业务逻辑（submissionContract/node 绑定）在通用 workflow-runtime | L2 drift 表已登记，待拆 |
| `submissionContract` prompt 文本与 schema 字段清单靠测试对齐（无编译级绑定） | 改 prompt 时需跑 gate 测试 |
