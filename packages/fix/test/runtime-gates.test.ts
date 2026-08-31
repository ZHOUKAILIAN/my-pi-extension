// fixDefinitionV2 的 Runtime 控制面门禁：公共 runNode()/transition() 不能绕过 v2 Review 门禁。
// - INVESTIGATING 下直接提交 investigation 不得进入 IMPLEMENTING/DISPOSITION；
// - IMPLEMENTING -> VERIFYING 必须有当前有效、通过、all_closed 且版本绑定的 change_review。
import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowRuntime, serializeReviewPolicy, PiSessionRunStore, type NodeDefinition, type Artifact, type ReviewPolicy } from '@pi/workflow-runtime';
import { fixDefinitionV2 } from '../src/definition.ts';

const throwsCode = (fn: () => unknown, code: string) => assert.throws(fn, (e: unknown) => (e as { code?: string }).code === code);

const store = () => ({ saveCheckpoint() {}, loadLast() { return undefined; } });

const bareWorker = (shape: () => Artifact, workerId = `w-${Math.random().toString(36).slice(2)}`): NodeDefinition['worker'] => ({
  workerId,
  execute: async () => shape(),
});

const investigationOf = (extra: Record<string, unknown> = {}) => (
  { kind: 'investigation', route: 'local_fix', rootCause: 'cause', evidence: ['trace'], conclusion: { status: 'accepted', summary: 'inv' }, ...extra }
);
const ireviewOf = (extra: Record<string, unknown> = {}) => (
  { kind: 'investigation_review', rootCauseConclusion: 'x', evidenceSufficiency: 'sufficient', gaps: [], conclusion: { status: 'accepted', summary: 'ok' }, ...extra }
);
const creviewOf = (extra: Record<string, unknown> = {}) => (
  { kind: 'change_review', reviewedRevision: 'rev-1', findings: [], findingDisposition: 'all_closed', conclusion: { status: 'accepted', summary: 'ok' }, ...extra }
);

test('fixDefinitionV2：裸 runNode 提交 local_fix investigation 不能绕过 investigation review 门禁', async () => {
  const runtime = new WorkflowRuntime(fixDefinitionV2, store(), 'fix-gate-1', () => 1, () => 'gen');
  await runtime.executeNode(
    { id: 'intake', worker: bareWorker(() => ({ kind: 'intake', summary: '登录后白屏', overview: '登录后无法操作', conclusion: { status: 'accepted', summary: 'ok' } })) }, {},
  );
  runtime.transition('INVESTIGATING', runtime.getArtifacts().at(-1)!);
  // 无 investigation_review 时，runNode 的 local_fix 流程必须在 INVESTIGATING->IMPLEMENTING 被拒。
  await assert.rejects(
    () => runtime.runNode(
      { id: 'investigate', worker: bareWorker(() => investigationOf()) },
      {},
    ),
    (e: unknown) => (e as { code?: string }).code === 'INVESTIGATION_REVIEW_NOT_BOUND',
  );
  assert.equal(runtime.stage, 'INVESTIGATING');
  // 配对评审（executeNode + 成对产生）后，允许进入 DISPOSITION。
  const investigation = (await runtime.executeNode({ id: 'investigate', worker: bareWorker(() => investigationOf()) }, {})).artifact;
  await runtime.executeNode({ id: 'investigation_review', worker: bareWorker(() => ireviewOf()) }, {});
  runtime.transition('DISPOSITION', investigation);
  assert.equal(runtime.stage, 'DISPOSITION');
});

test('fixDefinitionV2：调查被拒（rejected conclusion）+ 通过且配对的评审也不能进入 DISPOSITION', async () => {
  const runtime = new WorkflowRuntime(fixDefinitionV2, store(), 'fix-gate-rej-1', () => 21, () => 'gen');
  await runtime.executeNode(
    { id: 'intake', worker: bareWorker(() => ({ kind: 'intake', summary: '登录后白屏', overview: '登录后无法操作', conclusion: { status: 'accepted', summary: 'ok' } })) }, {},
  );
  runtime.transition('INVESTIGATING', runtime.getArtifacts().at(-1)!);
  // 调查结论 rejected：即使 investigation_review 通过并配对，也不得进入 DISPOSITION。
  const rejectedInvestigation = (await runtime.executeNode(
    { id: 'investigate', worker: bareWorker(() => investigationOf({ conclusion: { status: 'rejected', summary: '证据不足，根因未确认' } })) }, {},
  )).artifact;
  await runtime.executeNode({ id: 'investigation_review', worker: bareWorker(() => ireviewOf()) }, {});
  throwsCode(() => runtime.transition('DISPOSITION', rejectedInvestigation), 'INVESTIGATION_NOT_ACCEPTED');
  assert.equal(runtime.stage, 'INVESTIGATING');
  assert.ok(runtime.evaluateAcceptance({}).missing.includes('investigation_accepted'));
  // 补齐结论 accepted 的新调查（重开周期）后正常评审放行。
  const fresh = (await runtime.executeNode({ id: 'investigate', worker: bareWorker(() => investigationOf({ conclusion: { status: 'accepted', summary: '证据补齐后确认' } })) }, {})).artifact;
  await runtime.executeNode({ id: 'investigation_review', worker: bareWorker(() => ireviewOf({ rootCauseConclusion: 'fresh confirmed' })) }, {});
  runtime.transition('DISPOSITION', fresh);
  assert.equal(runtime.stage, 'DISPOSITION');
});

test('fixDefinitionV2：route 不可行动（needs_more_evidence）的 investigation 即使评审通过也不得进入 DISPOSITION', async () => {
  const runtime = new WorkflowRuntime(fixDefinitionV2, store(), 'fix-gate-route-1', () => 22, () => 'gen');
  await runtime.executeNode(
    { id: 'intake', worker: bareWorker(() => ({ kind: 'intake', summary: '登录后白屏', overview: '登录后无法操作', conclusion: { status: 'accepted', summary: 'ok' } })) }, {},
  );
  runtime.transition('INVESTIGATING', runtime.getArtifacts().at(-1)!);
  const investigation = (await runtime.executeNode(
    { id: 'investigate', worker: bareWorker(() => investigationOf({ route: 'needs_more_evidence', rootCause: '证据不完整', conclusion: { status: 'accepted', summary: '需要补充证据' } })) }, {},
  )).artifact;
  await runtime.executeNode({ id: 'investigation_review', worker: bareWorker(() => ireviewOf()) }, {});
  throwsCode(() => runtime.transition('DISPOSITION', investigation), 'INVESTIGATION_NOT_ACCEPTED');
  assert.equal(runtime.stage, 'INVESTIGATING');
});

test('fixDefinitionV2：IMPLEMENTING -> VERIFYING 由 Runtime 强制 change_review 硬门禁', async () => {
  const runtime = new WorkflowRuntime(fixDefinitionV2, store(), 'fix-gate-2', () => 2, () => 'gen');
  await runtime.executeNode(
    { id: 'intake', worker: bareWorker(() => ({ kind: 'intake', summary: '登录后白屏', overview: '登录后无法操作', conclusion: { status: 'accepted', summary: 'ok' } })) }, {},
  );
  runtime.transition('INVESTIGATING', runtime.getArtifacts().at(-1)!);
  const investigation = (await runtime.executeNode({ id: 'investigate', worker: bareWorker(() => investigationOf()) }, {})).artifact;
  await runtime.executeNode({ id: 'investigation_review', worker: bareWorker(() => ireviewOf()) }, {});
  runtime.transition('DISPOSITION', investigation);
  await runtime.executeNode(
    { id: 'disposition', worker: bareWorker(() => ({ kind: 'disposition', dispositionType: 'remediation', requiresRepositoryChange: true, minimalScope: 'a.ts', risks: [], verificationTarget: '登录流程', conclusion: { status: 'accepted', summary: 'ok' } })) }, {},
  );
  // 仓库变更处置必须经过配对 change_plan_review（Runtime 硬门禁 + runReview 记账周期）才能离开 DISPOSITION。
  await runCplanReview(runtime, () => cplanOf(), 'cpr-gate-2');
  runtime.transition('IMPLEMENTING', runtime.getArtifacts().filter((a) => a.kind === 'disposition').at(-1)!);
  await runtime.executeNode(
    { id: 'implement', worker: bareWorker(() => ({ kind: 'implementation', artifact: { summary: '修复登录', filesChanged: ['a.ts'], candidateRevision: 'rev-1' }, conclusion: { status: 'accepted', summary: 'ok' } })) }, {},
  );
  // 缺 change_review：IMPLEMENTING -> VERIFYING 必须被拒。
  throwsCode(() => runtime.transition('VERIFYING', runtime.getArtifacts().at(-1)!), 'CHANGE_REVIEW_NOT_BOUND');
  assert.equal(runtime.stage, 'IMPLEMENTING');
  // change_review 与当前 implementation 版本不一致：同样被拒。
  await runtime.executeNode({ id: 'change_review', worker: bareWorker(() => creviewOf({ reviewedRevision: 'rev-9' })) }, {});
  throwsCode(() => runtime.transition('VERIFYING', runtime.getArtifacts().at(-1)!), 'CHANGE_REVIEW_NOT_BOUND');
  // 绑定当前版本并通过硬条件后放行。
  await runtime.executeNode({ id: 'change_review', worker: bareWorker(() => creviewOf()) }, {});
  runtime.transition('VERIFYING', runtime.getArtifacts().filter((a) => a.kind === 'implementation').at(-1)!);
  assert.equal(runtime.stage, 'VERIFYING');
});

test('fixDefinitionV2：验证失败回流后重交同版本 fresh implementation 不能被旧 change_review 放行（runNode 直接路径）', async () => {
  const runtime = new WorkflowRuntime(fixDefinitionV2, store(), 'fix-gate-3', () => 3, () => 'gen');
  await runtime.executeNode(
    { id: 'intake', worker: bareWorker(() => ({ kind: 'intake', summary: '登录后白屏', overview: '登录后无法操作', conclusion: { status: 'accepted', summary: 'ok' } })) }, {},
  );
  runtime.transition('INVESTIGATING', runtime.getArtifacts().at(-1)!);
  const investigation = (await runtime.executeNode({ id: 'investigate', worker: bareWorker(() => investigationOf()) }, {})).artifact;
  await runtime.executeNode({ id: 'investigation_review', worker: bareWorker(() => ireviewOf()) }, {});
  runtime.transition('DISPOSITION', investigation);
  await runtime.executeNode(
    { id: 'disposition', worker: bareWorker(() => ({ kind: 'disposition', dispositionType: 'remediation', requiresRepositoryChange: true, minimalScope: 'a.ts', risks: [], verificationTarget: '登录流程', conclusion: { status: 'accepted', summary: 'ok' } })) }, {},
  );
  // 仓库变更处置必须经过配对 change_plan_review（Runtime 硬门禁 + runReview 记账周期）才能离开 DISPOSITION。
  await runCplanReview(runtime, () => cplanOf(), 'cpr-gate-3');
  runtime.transition('IMPLEMENTING', runtime.getArtifacts().filter((a) => a.kind === 'disposition').at(-1)!);
  const implOf = () => ({ kind: 'implementation', artifact: { summary: '修复登录', filesChanged: ['a.ts'], candidateRevision: 'rev-1' }, conclusion: { status: 'accepted', summary: 'ok' } });
  await runtime.executeNode({ id: 'implement', worker: bareWorker(implOf) }, {});
  await runtime.executeNode({ id: 'change_review', worker: bareWorker(() => creviewOf()) }, {});
  runtime.transition('VERIFYING', runtime.getArtifacts().filter((a) => a.kind === 'implementation').at(-1)!);
  // 验证失败（实现类）回流 IMPLEMENTING，再重交同 candidateRevision 的 fresh implementation：
  // 旧 review 不得放行。
  await runtime.executeNode(
    { id: 'verify', worker: bareWorker(() => ({ kind: 'verification', accepted: false, evidence: ['test:回归失败'], candidateRevision: 'rev-1', failure: { kind: 'implementation', reason: '回归未通过' }, conclusion: { status: 'rejected', summary: '验证未通过' } })) }, {},
  );
  runtime.transition('IMPLEMENTING', runtime.getArtifacts().filter((a) => a.kind === 'verification').at(-1)!);
  await assert.rejects(
    () => runtime.runNode({ id: 'implement', worker: bareWorker(implOf) }, {}),
    (e: unknown) => (e as { code?: string }).code === 'CHANGE_REVIEW_NOT_BOUND',
  );
  assert.equal(runtime.stage, 'IMPLEMENTING');
  // 重新评审后放行进入 VERIFYING。
  await runtime.executeNode({ id: 'change_review', worker: bareWorker(() => creviewOf({ conclusion: { status: 'accepted', summary: 're-reviewed' } })) }, {});
  runtime.transition('VERIFYING', runtime.getArtifacts().filter((a) => a.kind === 'implementation').at(-1)!);
  assert.equal(runtime.stage, 'VERIFYING');
});

// ============================================================
// Change Plan Review 硬门禁（DISPOSITION -> IMPLEMENTING 仓库变更路径）：
//  normal repo-change 路径必须经过当前有效 Change Plan Review（accepted conclusion +
//  rootCauseAlignment + 正式非-open finding 处置）且配对当前处置/方案的评审；
//  Direct Runtime 直传未归档 fresh disposition 不能绕过评审。
// ============================================================
const cplanOf = (extra: Record<string, unknown> = {}) => (
  { kind: 'change_plan_review', rootCauseAlignment: true, changedScope: 'a.ts', risks: [], compatibility: [], verification: [], rollback: [], findings: [], conclusion: { status: 'accepted', summary: 'ok' }, ...extra }
);
const dispositionOf = (extra: Record<string, unknown> = {}) => (
  { kind: 'disposition', dispositionType: 'remediation', requiresRepositoryChange: true, minimalScope: 'a.ts', risks: [], verificationTarget: 'tests', conclusion: { status: 'accepted', summary: 'plan' }, ...extra }
);

// 通过 runReview 记账周期产出的 change_plan_review：内容不全/被拒的评审可继续用 executeNode 直传
// 伪造来验证内容门禁层（内容检查先于周期检查）；通过路径必须走 runReview（无账本周期不得放行）。
const cplanPolicy = { reviewers: [{ model: 'inherit' }], mode: 'parallel' as const, requiredApprovals: 1, requireIndependentWorker: true, excludeNodes: ['investigate', 'implement'], onRejected: 'return_to_disposition' };
const runCplanReview = (runtime: WorkflowRuntime, shape: () => Artifact, reviewerWorkerId: string) =>
  runtime.runReview(
    'change_plan_review',
    [{ id: 'change_plan_review', worker: bareWorker(shape, reviewerWorkerId) }],
    cplanPolicy,
    { reviewedNodeId: 'disposition', reviewArtifactKind: 'change_plan_review' },
  );
const bootToDisposition = async (runtime: WorkflowRuntime) => {
  await runtime.executeNode(
    { id: 'intake', worker: bareWorker(() => ({ kind: 'intake', summary: '登录后白屏', overview: '登录后无法操作', conclusion: { status: 'accepted', summary: 'ok' } })) }, {},
  );
  runtime.transition('INVESTIGATING', runtime.getArtifacts().at(-1)!);
  const investigation = (await runtime.executeNode({ id: 'investigate', worker: bareWorker(() => investigationOf()) }, {})).artifact;
  await runtime.executeNode({ id: 'investigation_review', worker: bareWorker(() => ireviewOf()) }, {});
  runtime.transition('DISPOSITION', investigation);
};

test('fixDefinitionV2：DISPOSITION -> IMPLEMENTING 仓库变更路径必须有配对通过 change_plan_review', async () => {
  const runtime = new WorkflowRuntime(fixDefinitionV2, store(), 'fix-gate-cpr-1', () => 31, () => 'gen');
  await bootToDisposition(runtime);
  const disposition = (await runtime.executeNode({ id: 'disposition', worker: bareWorker(() => dispositionOf()) }, {})).artifact;
  // 缺 change_plan_review：不得进入 IMPLEMENTING。
  throwsCode(() => runtime.transition('IMPLEMENTING', disposition), 'CHANGE_PLAN_REVIEW_NOT_BOUND');
  assert.equal(runtime.stage, 'DISPOSITION');
  // review 存在但未通过（rootCauseAlignment=false / rejected conclusion）：同样不得进入。
  await runtime.executeNode({ id: 'change_plan_review', worker: bareWorker(() => cplanOf({ rootCauseAlignment: false, conclusion: { status: 'rejected', summary: '方案与根因不对齐' } })) }, {});
  throwsCode(() => runtime.transition('IMPLEMENTING', disposition), 'CHANGE_PLAN_REVIEW_NOT_PASSED');
  assert.equal(runtime.stage, 'DISPOSITION');
  // review 有 open finding（无正式非-open disposition）：不得进入。
  await runtime.executeNode({ id: 'change_plan_review', worker: bareWorker(() => cplanOf({ findings: [{ id: 'f1', summary: '风险未评估', disposition: 'open' }] })) }, {});
  throwsCode(() => runtime.transition('IMPLEMENTING', disposition), 'CHANGE_PLAN_REVIEW_NOT_PASSED');
  assert.equal(runtime.stage, 'DISPOSITION');
  // 配对通过（runReview 记账周期 + review 晚于当前 disposition + finding 全部正式关闭）→ 放行。
  await runCplanReview(runtime, () => cplanOf({ findings: [{ id: 'f1', summary: '风险已接受', disposition: 'accepted_with_note' }] }), 'cpr-pass');
  runtime.transition('IMPLEMENTING', disposition);
  assert.equal(runtime.stage, 'IMPLEMENTING');
});

test('fixDefinitionV2：重开处置周期后旧 change_plan_review 不构成当前方案评审（配对要求）', async () => {
  const runtime = new WorkflowRuntime(fixDefinitionV2, store(), 'fix-gate-cpr-2', () => 32, () => 'gen');
  await bootToDisposition(runtime);
  // 旧 review baseline：第一轮处置之后、新处置之前归档（曾经通过 runReview 周期）。
  await runtime.executeNode({ id: 'disposition', worker: bareWorker(() => dispositionOf()) }, {});
  await runCplanReview(runtime, () => cplanOf(), 'cpr-old');
  // 重开处置周期：新 disposition 归档（旧 review 产生于它之前）→ 旧 review 不构成当前方案评审。
  const freshDisposition = (await runtime.executeNode({ id: 'disposition', worker: bareWorker(() => dispositionOf({ minimalScope: 'b.ts' })) }, {})).artifact;
  throwsCode(() => runtime.transition('IMPLEMENTING', freshDisposition), 'CHANGE_PLAN_REVIEW_NOT_BOUND');
  assert.equal(runtime.stage, 'DISPOSITION');
  // 配对评审（晚于当前 disposition）后放行。
  await runCplanReview(runtime, () => cplanOf({ changedScope: 'b.ts' }), 'cpr-new');
  runtime.transition('IMPLEMENTING', freshDisposition);
  assert.equal(runtime.stage, 'IMPLEMENTING');
});

test('fixDefinitionV2：直传未归档 fresh disposition 不能绕过 change_plan_review；归档后的当前处置可放行', async () => {
  const runtime = new WorkflowRuntime(fixDefinitionV2, store(), 'fix-gate-cpr-3', () => 33, () => 'gen');
  await bootToDisposition(runtime);
  const disposition = (await runtime.executeNode({ id: 'disposition', worker: bareWorker(() => dispositionOf()) }, {})).artifact;
  await runCplanReview(runtime, () => cplanOf(), 'cpr-a');
  // 已有通过且配对的 review，但直传一个未归档的 fresh disposition：公共入口不得用它放行新处置。
  throwsCode(
    () => runtime.transition('IMPLEMENTING', { kind: 'disposition', dispositionType: 'remediation', requiresRepositoryChange: true, minimalScope: 'c.ts', risks: [], verificationTarget: 'tests', conclusion: { status: 'accepted', summary: 'fresh' } } as Artifact),
    'CHANGE_PLAN_REVIEW_NOT_BOUND',
  );
  assert.equal(runtime.stage, 'DISPOSITION');
  // 归档后的当前处置 + 配对评审 → 正常放行（Extension continueRun 的正确调用形状）。
  runtime.transition('IMPLEMENTING', disposition);
  assert.equal(runtime.stage, 'IMPLEMENTING');
});

test('fixDefinitionV2：Acceptance 的 change_plan_review_accepted 要求根因对齐 + 正式 finding 处置 + 与当前处置配对 + Runtime 记账周期', async () => {
  const runtime = new WorkflowRuntime(fixDefinitionV2, store(), 'fix-gate-cpr-4', () => 34, () => 'gen');
  const missing = () => runtime.evaluateAcceptance({ requiresRepositoryChange: true }).missing.includes('change_plan_review_accepted');
  await bootToDisposition(runtime);
  await runtime.executeNode({ id: 'disposition', worker: bareWorker(() => dispositionOf()) }, {});
  // 无 review：marker 缺失。
  assert.ok(missing());
  // 直接 executeNode 产出评审 Artifact（无 Runtime 记账周期）：内容/配对都满足，但没有账本背书
  // ——验收不接受无周期评审（防“删账本后伪造 ACCEPTED”），marker 仍缺失。
  await runtime.executeNode({ id: 'change_plan_review', worker: bareWorker(() => cplanOf()) }, {});
  assert.ok(missing());
  // runReview 记账产出配对评审（绑定当前处置 + 当前策略摘要 + quorum）→ marker 满足。
  await runCplanReview(runtime, () => cplanOf(), 'cpr-accept-ok');
  assert.ok(!missing());
  // open finding → marker 缺失（正式非-open disposition 要求）。
  await runCplanReview(runtime, () => cplanOf({ findings: [{ id: 'f2', summary: '未处置', disposition: 'open' }] }), 'cpr-accept-open');
  assert.ok(missing());
  // 重开处置（新 disposition 在旧 review 之后）→ 旧 review 不再配对，marker 缺失。
  await runtime.executeNode({ id: 'disposition', worker: bareWorker(() => dispositionOf({ minimalScope: 'd.ts' })) }, {});
  assert.ok(missing());
  // 新配对评审 → marker 恢复满足。
  await runCplanReview(runtime, () => cplanOf(), 'cpr-accept-new');
  assert.ok(!missing());
});

// ============================================================
// 二轮 code_reviewer 补测：Change Plan Review 门禁绑定“当前有效策略”：
//  24a) 同一 worker 双票（重复 workerId）→ runReview 直接拒绝（REVIEWER_WORKER_ID_REPEATED）；
//  24b) 配置 reviewPolicyFor 后，用降级策略（两人批准→一人）runReview → REVIEW_POLICY_MISMATCH；
//  24c) 录账被篡改（digest 为降级策略摘要 / 保持当前摘要但 requiredApprovals=1+approvals=1+passed）→
//       门禁按当前策略重算，分别 NOT_BOUND / NOT_PASSED，不允许降级或虚增通过。
// ============================================================

// 24a（SP4）：同一 worker 以同一身份多次投票不能凑足 quorum——独立评审者身份必须唯一。
// 独立性是“不同的人投票”，不是“同一个身份投多次”。
test('fixDefinitionV2：同一 worker 重复出票（重复 workerId）→ runReview 拒绝（REVIEWER_WORKER_ID_REPEATED）', async () => {
  const runtime = new WorkflowRuntime(fixDefinitionV2, store(), 'fix-gate-dup-1', () => 41, () => 'gen');
  await bootToDisposition(runtime);
  await runtime.executeNode({ id: 'disposition', worker: bareWorker(() => dispositionOf()) }, {});
  const twoApprove: ReviewPolicy = { mode: 'parallel', requiredApprovals: 2, requireIndependentWorker: true, excludeNodes: ['investigate', 'implement'], reviewers: [{ model: 'inherit' }], onRejected: 'return_to_disposition' };
  // 两个评审者使用同一个 worker 身份：唯一身份计数只有 1，不能算作 2 个独立评审者。
  assert.rejects(
    () => runtime.runReview(
      'change_plan_review',
      [
        { id: 'change_plan_review', worker: bareWorker(() => cplanOf(), 'dup-worker') },
        { id: 'change_plan_review', worker: bareWorker(() => cplanOf(), 'dup-worker') },
      ],
      twoApprove,
      { reviewedNodeId: 'disposition', reviewArtifactKind: 'change_plan_review' },
    ),
    (e: unknown) => (e as { code?: string }).code === 'REVIEWER_WORKER_ID_REPEATED',
  );
});

// 24b（SP3 降级路径）：受控扩展把当前有效策略绑定进 Runtime（reviewPolicyFor）。调用方用
// 弱于当前策略的策略（requiredApprovals 2→1、排除节点不同等）runReview 必须被拒：门禁不允许
// 调用方自行降级批准门槛。
test('fixDefinitionV2：reviewPolicyFor 绑定当前策略，降级策略 runReview 被拒绝（REVIEW_POLICY_MISMATCH）', async () => {
  const currentPolicy: ReviewPolicy = { mode: 'parallel', requiredApprovals: 2, requireIndependentWorker: true, excludeNodes: ['investigate', 'implement'], reviewers: [{ model: 'inherit' }], onRejected: 'return_to_disposition' };
  const runtime = new WorkflowRuntime(fixDefinitionV2, store(), 'fix-gate-downgrade-1', () => 42, () => 'gen', {
    reviewPolicyFor: (kind) => (kind === 'change_plan_review' ? currentPolicy : undefined),
  });
  await bootToDisposition(runtime);
  await runtime.executeNode({ id: 'disposition', worker: bareWorker(() => dispositionOf()) }, {});
  // 降级批准门槛（2→1）：与当前策略不等价 → 拒绝。
  assert.rejects(
    () => runtime.runReview(
      'change_plan_review',
      [{ id: 'change_plan_review', worker: bareWorker(() => cplanOf()) }],
      { mode: 'parallel', requiredApprovals: 1, requireIndependentWorker: true, excludeNodes: ['investigate', 'implement'], reviewers: [{ model: 'inherit' }], onRejected: 'return_to_disposition' },
      { reviewedNodeId: 'disposition', reviewArtifactKind: 'change_plan_review' },
    ),
    (e: unknown) => (e as { code?: string }).code === 'REVIEW_POLICY_MISMATCH',
  );
});

// 24c（SP3 篡改路径）：账本周期被篡改（把两人批准改成一人批准且 passed=true）时，门禁必须按
// “当前有效策略”重算：digest 被换成降级策略摘要 → NOT_BOUND；digest 保持当前策略但在
// requiredApprovals/approvals/passed 上虚增 → NOT_PASSED。
test('fixDefinitionV2：账本周期被篡改时门禁按当前策略重算（降级段落 NOT_BOUND / 虚增通过 NOT_PASSED）', async () => {
  const currentPolicy: ReviewPolicy = { mode: 'parallel', requiredApprovals: 2, requireIndependentWorker: true, excludeNodes: ['investigate', 'implement'], reviewers: [{ model: 'inherit' }], onRejected: 'return_to_disposition' };
  const runtime = new WorkflowRuntime(fixDefinitionV2, store(), 'fix-gate-tamper-1', () => 43, () => 'gen', {
    reviewPolicyFor: (kind) => (kind === 'change_plan_review' ? currentPolicy : undefined),
  });
  await bootToDisposition(runtime);
  const disposition = (await runtime.executeNode({ id: 'disposition', worker: bareWorker(() => dispositionOf()) }, {})).artifact;
  // 合法：两个独立身份按当前策略（2 人批准）通过 → 放行。
  await runtime.runReview(
    'change_plan_review',
    [
      { id: 'change_plan_review', worker: bareWorker(() => cplanOf(), 'cpr-t1') },
      { id: 'change_plan_review', worker: bareWorker(() => cplanOf(), 'cpr-t2') },
    ],
    currentPolicy,
    { reviewedNodeId: 'disposition', reviewArtifactKind: 'change_plan_review' },
  );
  // 篡改 A：把 digest 换成“降级策略（1 人批准）”的摘要（并虚增 approvals=1/passed）——
  // 门禁对照当前策略的摘要，不等价 → NOT_BOUND。
  const downgraded = { mode: 'parallel', requiredApprovals: 1, requireIndependentWorker: true, excludeNodes: ['investigate', 'implement'], reviewers: [{ model: 'inherit' }], onRejected: 'return_to_disposition' };
  (runtime as unknown as { reviewCycles: Array<Record<string, unknown>> }).reviewCycles[0] = {
    ...(runtime as unknown as { reviewCycles: Array<Record<string, unknown>> }).reviewCycles[0],
    policyDigest: serializeReviewPolicy(downgraded),
    requiredApprovals: 1, approvals: 1, passed: true, reviewerWorkerIds: ['cpr-t1'],
  };
  throwsCode(() => runtime.transition('IMPLEMENTING', disposition), 'CHANGE_PLAN_REVIEW_NOT_BOUND');
  assert.equal(runtime.stage, 'DISPOSITION');
  // 篡改 B：digest 保持当前策略，但 requiredApprovals=1 / approvals=1 / passed=true（虚增通过）——
  // 摘要绑定通过，quorum 按当前策略的 2 人重算 → NOT_PASSED（唯一身份也只有 1 个）。
  (runtime as unknown as { reviewCycles: Array<Record<string, unknown>> }).reviewCycles[0] = {
    ...(runtime as unknown as { reviewCycles: Array<Record<string, unknown>> }).reviewCycles[0],
    policyDigest: serializeReviewPolicy(currentPolicy),
    requiredApprovals: 1, approvals: 1, passed: true, reviewerWorkerIds: ['cpr-t1'],
  };
  throwsCode(() => runtime.transition('IMPLEMENTING', disposition), 'CHANGE_PLAN_REVIEW_NOT_PASSED');
  assert.equal(runtime.stage, 'DISPOSITION');
});

// SP3 恢复控制面：账本整体伪造（当前策略摘要 + 虚增 quorum + 手工 cycleId，但产物不支撑）必须在
// restore 阶段 fail-closed——恢复时周期数字必须能被 checkpoint 实际评审 Artifact 支撑。
// 与 24c 的“live 门禁重算”互补：live 门禁拦截篡改，恢复控制面拦截带自我一致伪造摘要的整套替换。
test('fixDefinitionV2：恢复自洽伪造账本（当前摘要 + 单张 Artifact 声称两人批准）→ CHECKPOINT_REVIEW_LEDGER_INCONSISTENT', async () => {
  const currentPolicy: ReviewPolicy = { mode: 'parallel', requiredApprovals: 2, requireIndependentWorker: true, excludeNodes: ['investigate', 'implement'], reviewers: [{ model: 'inherit' }], onRejected: 'return_to_disposition' };
  let saved: Record<string, unknown> | undefined;
  const capStore = { saveCheckpoint: (c: Record<string, unknown>) => { saved = c; }, loadLast: () => saved };
  const runtime = new WorkflowRuntime(fixDefinitionV2, capStore, 'fix-gate-spl-1', () => 44, () => 'gen');
  await bootToDisposition(runtime);
  const disposition = (await runtime.executeNode({ id: 'disposition', worker: bareWorker(() => dispositionOf()) }, {})).artifact;
  await runtime.runReview(
    'change_plan_review',
    [
      { id: 'change_plan_review', worker: bareWorker(() => cplanOf(), 'cpr-s1') },
      { id: 'change_plan_review', worker: bareWorker(() => cplanOf(), 'cpr-s2') },
    ],
    currentPolicy,
    { reviewedNodeId: 'disposition', reviewArtifactKind: 'change_plan_review' },
  );
  runtime.transition('IMPLEMENTING', disposition);
  const written = saved!;
  // 伪造整条账本：手工 cycleId + 当前策略摘要 + approvals=2/passed=true + 两个任意评审者身份，
  // 但 checkpoint.artifacts 只保留一张被盖章为伪造周期 id 的 change_plan_review（无两个独立身份产物）。
  const forgedCycle = {
    cycleId: 'FORGED-CYCLE', reviewNodeId: 'change_plan_review', reviewArtifactKind: 'change_plan_review',
    reviewedNodeId: 'disposition', requiredApprovals: 2, approvals: 2, passed: true,
    reviewerWorkerIds: ['forged-r1', 'forged-r2'], policyDigest: serializeReviewPolicy(currentPolicy),
    dispositionIndexAtCycle: 0, recordedAtIndex: 0,
  };
  const baseArtifacts = written.artifacts as Array<Record<string, unknown>>;
  const kept = baseArtifacts.filter((a) => a.kind !== 'change_plan_review');
  const singleStamped = {
    ...baseArtifacts.filter((a) => a.kind === 'change_plan_review')[0]!,
    reviewCycleId: 'FORGED-CYCLE', reviewedNodeId: 'disposition',
  };
  const forgedArtifacts = [...kept, singleStamped];
  const forgedCheckpoint = {
    ...written, stage: 'DISPOSITION',
    reviewCycles: [forgedCycle],
    artifacts: forgedArtifacts,
  } as unknown as Record<string, unknown>;
  // 恢复控制面 fail-closed：当前策略摘要也对得上，但周期数字（approvals=2/两人评审）无法被
  // 实际 Artifact（单张 change_plan_review）支撑 → CHECKPOINT_REVIEW_LEDGER_INCONSISTENT。
  const restoreStore = new PiSessionRunStore(
    { getEntries: () => [{ customType: 'workflow-run', data: forgedCheckpoint }] }, () => {},
  );
  assert.throws(
    () => WorkflowRuntime.restore(fixDefinitionV2, restoreStore, 'fix-gate-spl-1', {
      reviewPolicyFor: (kind) => (kind === 'change_plan_review' ? currentPolicy : undefined),
    }),
    (e: unknown) => (e as { code?: string }).code === 'CHECKPOINT_REVIEW_LEDGER_INCONSISTENT',
  );
});
