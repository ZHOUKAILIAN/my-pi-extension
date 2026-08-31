import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension from '../src/extension.ts';
import { loadEffectivePolicy } from '../src/effective-policy.ts';
import { FIX_SOURCE_VERSION, FIX_REVIEW_POLICIES } from '../src/definition.ts';
import { serializeReviewPolicy } from '@pi/workflow-runtime';

// ============================================================
// fix v2 /fix command 行为测试：人工最终验收（approve/打回）、无 UI 等待、
// 契约错误自动重试、验证契约违规暂停。测试壳复用 command-contract.test.ts。
// ============================================================

const intakeShape = { kind: 'intake', summary: '登录后白屏', overview: '登录后白屏，影响核心链路，怀疑前端渲染异常', conclusion: { status: 'accepted', summary: 'intake recorded' } };
const investigationShape = { kind: 'investigation', route: 'local_fix', rootCause: 'cause', evidence: ['trace'], conclusion: { status: 'accepted', summary: 'cause investigated' } };
const ireviewShape = (status: 'accepted' | 'rejected') => ({
  kind: 'investigation_review',
  rootCauseConclusion: 'cause',
  evidenceSufficiency: 'sufficient',
  gaps: [],
  conclusion: { status, summary: 'ok' },
});
const dispositionShape = (requiresRepositoryChange: boolean) => ({
  kind: 'disposition',
  dispositionType: 'remediation',
  requiresRepositoryChange,
  minimalScope: 'a.ts',
  risks: [],
  verificationTarget: 'tests',
  conclusion: { status: 'accepted', summary: 'plan' },
});
const cprShape = {
  kind: 'change_plan_review',
  rootCauseAlignment: true,
  changedScope: 'a.ts',
  risks: [],
  compatibility: [],
  verification: [],
  rollback: [],
  findings: [],
  conclusion: { status: 'accepted', summary: 'ok' },
};
const implementationShape = (rev = 'rev-1') => ({
  kind: 'implementation',
  artifact: { summary: 'patch', filesChanged: ['a.ts'], candidateRevision: rev },
  conclusion: { status: 'accepted', summary: 'implementation completed' },
});
const creviewShape = (rev = 'rev-1') => ({
  kind: 'change_review',
  reviewedRevision: rev,
  findings: [],
  findingDisposition: 'all_closed',
  conclusion: { status: 'accepted', summary: 'ok' },
});
const verificationChecks = {
  original_issue: true,
  root_cause_cut: true,
  identified_impact_surface: true,
  regression_and_compatibility: true,
};
const verificationShape = (extra: Record<string, unknown> = {}) => ({
  kind: 'verification',
  accepted: true,
  evidence: ['test:unit'],
  candidateRevision: 'rev-1',
  checks: verificationChecks,
  conclusion: { status: 'accepted', summary: 'verification completed' },
  remainingRisk: ['无'],
  ...extra,
});

const fullFlowAnswers = () => [
  intakeShape,
  investigationShape,
  ireviewShape('accepted'),
  dispositionShape(true),
  cprShape,
  cprShape,
  implementationShape(),
  creviewShape(),
  verificationShape(),
];

function commandHarness(opts: { answers?: any[]; input?: string; selects?: string[]; hasUI?: boolean } = {}) {
  const entries: any[] = [];
  const notifications: string[] = [];
  const messages: any[] = [];
  let handler: any;
  let calls = 0;
  let inputAnswer = opts.input ?? '';
  const selects = [...(opts.selects ?? ['通过并接受'])];
  const answers = opts.answers ?? [];
  const pi: any = {
    on: () => {},
    fixWorker: { execute: async () => answers[calls++] },
    appendEntry: (customType: string, data: any) => entries.push({ customType, data }),
    sendMessage: (msg: any) => messages.push(msg),
    registerCommand: (_name: string, def: any) => { handler = def.handler; },
  };
  const ctx: any = {
    cwd: mkdtempSync(join(tmpdir(), 'fix-test-')),
    hasUI: opts.hasUI ?? true,
    thinkingLevel: 'high',
    isProjectTrusted: () => true,
    sessionManager: { getEntries: () => entries },
    ui: {
      notify: (message: string, type?: string) => notifications.push(`${type ?? 'info'}: ${message}`),
      confirm: async () => true,
      input: async () => inputAnswer,
      select: async () => selects.shift(),
    },
  };
  extension(pi);
  return {
    run: (args: string) => handler(args, ctx),
    calls: () => calls,
    entries,
    notifications,
    messages,
    ctx,
  };
}

const workflowRuns = (h: ReturnType<typeof commandHarness>) => h.entries.filter((entry) => entry.customType === 'workflow-run');

test('9 调用后进 WAITING_FOR_USER，approve 决策写出 pending、review 消息并 ACCEPTED', async () => {
  const h = commandHarness({ answers: fullFlowAnswers() });
  await h.run('登录后白屏');
  assert.equal(h.calls(), 9);

  const runId = h.entries.find((entry) => entry.customType === 'workflow-command').data.runId;
  const pending = h.entries.find((entry) => entry.customType === 'workflow-decision-pending');
  assert.ok(pending, 'workflow-decision-pending entry missing');
  assert.equal(pending.data.traceId, runId);
  assert.equal(pending.data.summary, '登录后白屏');
  assert.equal(pending.data.overview, '登录后白屏，影响核心链路，怀疑前端渲染异常');
  assert.equal('phenomenon' in pending.data, false, '原始 problem 不得作为 phenomenon 进入人工摘要');
  assert.equal(pending.data.currentVersion, 'rev-1');
  assert.ok(pending.data.verification.evidence.includes('test:unit'), `evidence: ${JSON.stringify(pending.data.verification.evidence)}`);

  assert.ok(h.messages.some((msg) => msg.customType === 'workflow-review'), 'workflow-review message missing');
  assert.ok(h.notifications.some((text) => text.includes('ACCEPTED')), `notifications: ${h.notifications.join(' | ')}`);
  assert.equal(workflowRuns(h).at(-1).data.stage, 'ACCEPTED');
  // run-start 条目带 workflowVersion/policyDigest；started 标记条目先于它写入，用 find 定位。
  assert.equal([...workflowRuns(h)].find((entry) => entry.data.workflowVersion === 'fix-v2')!.data.policyDigest, loadEffectivePolicy(h.ctx.cwd, { trusted: true }).digest);
});

test('打回（根因判断错误）回流 INVESTIGATING 重跑后 approve → ACCEPTED，共 17 调用', async () => {
  const h = commandHarness({
    selects: ['打回（选择原因）', '根因或影响面判断错误', '通过并接受'],
    answers: [
      ...fullFlowAnswers(),
      investigationShape,
      ireviewShape('accepted'),
      dispositionShape(true),
      cprShape,
      cprShape,
      implementationShape(),
      creviewShape(),
      verificationShape(),
    ],
  });
  await h.run('登录后白屏');
  assert.equal(h.calls(), 17);

  const stages = workflowRuns(h).map((entry) => entry.data.stage);
  const firstWaiting = stages.indexOf('WAITING_FOR_USER');
  assert.ok(firstWaiting !== -1, `no WAITING_FOR_USER in ${stages.join(' -> ')}`);
  const reinvestigating = stages.indexOf('INVESTIGATING', firstWaiting);
  assert.ok(reinvestigating !== -1, `no INVESTIGATING after WAITING_FOR_USER in ${stages.join(' -> ')}`);
  assert.equal(stages.at(-1), 'ACCEPTED');
});

test('无 UI 时停在 WAITING_FOR_USER，不产出 ACCEPTED', async () => {
  const h = commandHarness({ answers: fullFlowAnswers(), hasUI: false });
  await h.run('登录后白屏');
  assert.equal(h.calls(), 9);
  assert.equal(workflowRuns(h).at(-1).data.stage, 'WAITING_FOR_USER');
  assert.ok(h.notifications.some((text) => text.includes('WAITING_FOR_USER')), `notifications: ${h.notifications.join(' | ')}`);
  assert.ok(!h.notifications.some((text) => text.includes('ACCEPTED')), 'unexpected ACCEPTED notification');
});

test('investigation 缺 rootCause 触发契约错误重试，第二个合法则继续并 ACCEPTED', async () => {
  const h = commandHarness({
    answers: [
      intakeShape,
      { kind: 'investigation', route: 'local_fix', evidence: ['trace'] }, // 缺 required rootCause
      investigationShape,
      ireviewShape('accepted'),
      dispositionShape(true),
      cprShape,
      cprShape,
      implementationShape(),
      creviewShape(),
      verificationShape(),
    ],
  });
  await h.run('登录后白屏');
  assert.equal(h.calls(), 10);
  assert.equal(workflowRuns(h).at(-1).data.stage, 'ACCEPTED');
});

test('verify 连续两次违反验证契约 → workflow-node-failure 且停在 VERIFYING', async () => {
  const h = commandHarness({
    answers: [
      intakeShape,
      investigationShape,
      ireviewShape('accepted'),
      dispositionShape(true),
      cprShape,
      cprShape,
      implementationShape(),
      creviewShape(),
      verificationShape({ evidence: ['raw'] }),
      verificationShape({ evidence: ['raw'] }),
    ],
  });
  await h.run('登录后白屏');
  assert.equal(h.calls(), 10);
  const failure = h.entries.find((entry) => entry.customType === 'workflow-node-failure');
  assert.ok(failure, 'workflow-node-failure entry missing');
  assert.equal(failure.data.stage, 'VERIFYING');
  assert.equal(failure.data.nodeId, 'verify');
  // 验证 Guard 的稳定码必须结构化写入失败记录（S2/P3）：证据为非 tool/test/external 来源。
  assert.equal(failure.data.code, 'VERIFICATION_EVIDENCE_INSUFFICIENT');
  assert.ok(h.notifications.some((text) => text.includes('VERIFICATION_EVIDENCE_INSUFFICIENT')), `notifications: ${h.notifications.join(' | ')}`);
  assert.equal(workflowRuns(h).at(-1).data.stage, 'VERIFYING');
  assert.ok(h.notifications.some((text) => text.includes('paused')), `notifications: ${h.notifications.join(' | ')}`);
});

// ============================================================
// /fix review 最终验收命令：待评审 checkpoint 手工构造，验证 approve 版本绑定。
// ============================================================

const nodeIdFor = (kind: string) => {
  // runtime 注册表真实 nodeId（nodeExecutionId 的 node 段）：implement/verify/investigate 等。
  switch (kind) {
    case 'implementation': return 'implement';
    case 'verification': return 'verify';
    case 'investigation': return 'investigate';
    default: return kind;
  }
};

const reviewWaitCheckpoint = (extra: Record<string, unknown> = {}) => {
  const stamp = (artifact: Record<string, unknown>, index: number) => ({
    ...artifact,
    schemaVersion: 1,
    runId: 'fix-r',
    nodeExecutionId: `fix-r.${nodeIdFor(String(artifact.kind))}.${index}`,
    workerId: `worker:${String(artifact.kind)}:${index}`,
    producerKind: 'worker',
    sourceVersion: FIX_SOURCE_VERSION,
    unverified: [],
    // 真实 runReview 在同一 Artifact 上盖章周期绑定（gate/验收按此把评审关联到账本周期）。
    ...(String(artifact.kind) === 'change_plan_review'
      ? { reviewCycleId: 'fix-r.review.4.1', reviewedNodeId: 'disposition' }
      : {}),
  });
  const cplanPolicy = FIX_REVIEW_POLICIES['change_plan_review'];
  return {
    customType: 'workflow-run',
    data: {
      schemaVersion: 1,
      runId: 'fix-r',
      stage: 'WAITING_FOR_USER',
      at: 1,
      id: 'fix-r-1',
      workflowVersion: 'fix-v2',
      policyDigest: loadEffectivePolicy(mkdtempSync(join(tmpdir(), 'fix-test-')), { trusted: true }).digest,
      pendingDecisionRequest: 'req-1',
      candidateRevision: 'rev-1',
      // 真实 checkpoint 携带 runReview 记账周期（change_plan_review 需要账本背书才能通过验收）。
      reviewCycles: [{
        cycleId: 'fix-r.review.4.1',
        reviewNodeId: 'change_plan_review',
        reviewArtifactKind: 'change_plan_review',
        reviewedNodeId: 'disposition',
        requiredApprovals: cplanPolicy.requiredApprovals,
        approvals: 2,
        passed: true,
        reviewerWorkerIds: ['worker:change_plan_review:5', 'worker:change_plan_review:6'],
        policyDigest: serializeReviewPolicy(cplanPolicy),
        dispositionIndexAtCycle: 3,
        // 记账时刻 = 数组实际最后一条周期 Artifact 的下标（cpr 位于下标 4、5）。
        recordedAtIndex: 5,
      }],
      artifacts: [
        stamp({ ...intakeShape, conclusion: { status: 'accepted', summary: 'stamped' } }, 1),
        stamp(investigationShape, 2),
        stamp(ireviewShape('accepted'), 3),
        stamp(dispositionShape(true), 4),
        stamp(cprShape, 5),
        stamp(cprShape, 6),
        stamp({ ...implementationShape(), conclusion: { status: 'accepted', summary: 'stamped' } }, 7),
        stamp(creviewShape(), 8),
        stamp(verificationShape(), 9),
      ],
      ...extra,
    },
  };
};

test('/fix review approve 携带匹配 candidateRevision → ACCEPTED 并产出最终处置报告', async () => {
  const h = commandHarness({ answers: [] });
  h.entries.push(reviewWaitCheckpoint());
  await h.run('review fix-r approve');
  assert.equal(h.calls(), 0, 'review 命令不得触发任何 worker 调用');
  const report = h.entries.find((entry) => entry.customType === 'workflow-fix-report');
  assert.ok(report, 'workflow-fix-report missing');
  assert.ok(report.data.report.includes('- 候选版本：rev-1'), `report: ${report.data.report}`);
  assert.equal(workflowRuns(h).at(-1).data.stage, 'ACCEPTED');
  assert.ok(h.notifications.some((text) => text.includes('ACCEPTED')), `notifications: ${h.notifications.join(' | ')}`);
});

test('/fix review approve 缺 candidateRevision → 决策被拒绝（DECISION_CANDIDATE_REVISION_MISMATCH）且保持待评审', async () => {
  const h = commandHarness({ answers: [] });
  h.entries.push(reviewWaitCheckpoint({ candidateRevision: undefined }));
  await h.run('review fix-r approve');
  assert.equal(h.calls(), 0, 'review 命令不得触发任何 worker 调用');
  assert.ok(
    h.notifications.some((text) => text.includes('决策被拒绝（DECISION_CANDIDATE_REVISION_MISMATCH）')),
    `notifications: ${h.notifications.join(' | ')}`,
  );
  assert.equal(workflowRuns(h).at(-1).data.stage, 'WAITING_FOR_USER', '决策被拒绝不得推进阶段');
  const report = h.entries.find((entry) => entry.customType === 'workflow-fix-report');
  assert.equal(report, undefined, '缺版本拒绝不得产出最终处置报告');
});
// ============================================================
// 本轮 P1 修复补测：/fix review 必须按当前有效策略恢复、continue_verification 不被历史污染。
// ============================================================

// 6. 默认 /fix review 必须传入当前有效 policyDigest：策略变更后旧 checkpoint 被拒绝，
// 决策不落地、不产出报告、阶段保持 WAITING_FOR_USER。
test('/fix review 拒绝旧 policyDigest 的 checkpoint（策略变更后按当前有效策略校验）', async () => {
  const h = commandHarness({ answers: [] });
  h.entries.push(reviewWaitCheckpoint({ policyDigest: 'stale-digest' }));
  await h.run('review fix-r approve');
  assert.equal(h.calls(), 0, 'review 命令不得触发任何 worker 调用');
  assert.ok(
    h.notifications.some((text) => text.includes('决策被拒绝（POLICY_DIGEST_MISMATCH）')),
    `notifications: ${h.notifications.join(' | ')}`,
  );
  assert.equal(workflowRuns(h).at(-1).data.stage, 'WAITING_FOR_USER', '策略变更拒绝不得推进阶段');
  const report = h.entries.find((entry) => entry.customType === 'workflow-fix-report');
  assert.equal(report, undefined, '策略变更拒绝不得产出最终处置报告');
});

// 7. continue_verification 只能依据“当前有效”的 configuration 验证失败：
// 最新验证已通过时即使历史存在配置类失败 Artifact，继续验证动作仍被拒绝。
test('/fix review continue-verification 依据当前有效验证（accepted 时不可用，不被历史配置失败污染）', async () => {
  const h = commandHarness({ answers: [] });
  const stamp = (artifact: Record<string, unknown>, index: number) => ({
    ...artifact,
    schemaVersion: 1,
    runId: 'fix-r',
    nodeExecutionId: `fix-r.${nodeIdFor(String(artifact.kind))}.${index}`,
    workerId: `worker:${String(artifact.kind)}:${index}`,
    producerKind: 'worker',
    sourceVersion: FIX_SOURCE_VERSION,
    unverified: [],
  });
  // artifacts：intake/investigation/investigation_review/disposition(无仓库变更)
  // → 旧配置类失败验证 → 当前验收通过验证（accepted:true）。
  h.entries.push(reviewWaitCheckpoint({
    candidateRevision: 'base-v1',
    // 本现场为无仓库变更（wait_decision）等待：无方案评审，也不需要账本。
    reviewCycles: [],
    artifacts: [
      stamp({ ...intakeShape, conclusion: { status: 'accepted', summary: 'stamped' } }, 1),
      stamp(investigationShape, 2),
      stamp(ireviewShape('accepted'), 3),
      stamp(dispositionShape(false), 4),
      stamp({ kind: 'verification', accepted: false, evidence: ['event:old-config'], candidateRevision: 'base-v1', checks: verificationChecks, remainingRisk: ['无'], failure: { kind: 'configuration', reason: '旧配置失败' }, conclusion: { status: 'rejected', summary: 'configuration failure' } }, 5),
      stamp({ kind: 'verification', accepted: true, evidence: ['test:unit'], candidateRevision: 'base-v1', checks: verificationChecks, remainingRisk: ['无'], conclusion: { status: 'accepted', summary: 'verification completed' } }, 6),
    ],
  }));
  await h.run('review fix-r continue-verification');
  assert.equal(h.calls(), 0, 'review 命令不得触发任何 worker 调用');
  assert.ok(
    h.notifications.some((text) => text.includes('决策被拒绝（CONTINUE_VERIFICATION_NOT_AVAILABLE）')),
    `notifications: ${h.notifications.join(' | ')}`,
  );
  assert.equal(workflowRuns(h).at(-1).data.stage, 'WAITING_FOR_USER', '被拒绝的继续验证不得推进阶段');
});
// ============================================================
// D3：/fix review 处置等待（wait_decision / external_action）——continue-disposition 动作与
// approve 在无验证现场时的 fail-closed。
// ============================================================

const dispositionWaitCheckpoint = (dispositionType: 'wait_decision' | 'external_action'): { customType: string; data: Record<string, unknown> } => {
  const done = reviewWaitCheckpoint({
    candidateRevision: undefined,
    reviewCycles: [],
    pendingDecisionKind: dispositionType === 'wait_decision' ? 'disposition_decision' : 'external_action_completion',
    artifacts: [
      { ...intakeShape, conclusion: { status: 'accepted', summary: 'stamped' }, schemaVersion: 1, runId: 'fix-r', nodeExecutionId: 'fix-r.intake.1', workerId: 'w:intake:1', producerKind: 'worker', sourceVersion: FIX_SOURCE_VERSION, unverified: [] },
      { ...investigationShape, schemaVersion: 1, runId: 'fix-r', nodeExecutionId: 'fix-r.investigate.2', workerId: 'w:investigate:2', producerKind: 'worker', sourceVersion: FIX_SOURCE_VERSION, unverified: [] },
      { ...ireviewShape('accepted'), schemaVersion: 1, runId: 'fix-r', nodeExecutionId: 'fix-r.investigation_review.3', workerId: 'w:investigation_review:3', producerKind: 'worker', sourceVersion: FIX_SOURCE_VERSION, unverified: [] },
      { kind: 'disposition', dispositionType, requiresRepositoryChange: false, minimalScope: '无', risks: [], verificationTarget: dispositionType === 'wait_decision' ? '用户确认' : '外部动作完成后复测', conclusion: { status: 'accepted', summary: 'waiting' }, schemaVersion: 1, runId: 'fix-r', nodeExecutionId: 'fix-r.disposition.4', workerId: 'w:disposition:4', producerKind: 'worker', sourceVersion: FIX_SOURCE_VERSION, unverified: [] },
    ],
  });
  done.data.candidateRevision = undefined;
  return done;
};

test('/fix review continue-disposition（disposition_decision）→ 回到 DISPOSITION 重新落地处置', async () => {
  const h = commandHarness({ answers: [] });
  h.entries.push(dispositionWaitCheckpoint('wait_decision'));
  // F1：CLI 路径的 continue-disposition 必须携带用户处置决定内容（reasonCode 承载，单 token）。
  await h.run('review fix-r continue-disposition 用户决定按mitigation处置');
  assert.equal(h.calls(), 0, 'review 命令不得触发任何 worker 调用');
  assert.equal(workflowRuns(h).at(-1).data.stage, 'DISPOSITION', 'wait_decision 继续后回到 DISPOSITION 重落地处置');
  // 决定内容进入决策记录（trace 事实），供后续 resume 的 DISPOSITION 重跑读回。
  const record = h.entries.filter((entry) => entry.customType === 'workflow-run').at(-1)!.data.decisionRecord;
  assert.equal(record.decision, 'continue_disposition');
  assert.equal(record.reasonCode, '用户决定按mitigation处置');
  const report = h.entries.find((entry) => entry.customType === 'workflow-fix-report');
  assert.equal(report, undefined, '继续处置不是验收，不得产出最终处置报告');
});

test('/fix review continue-disposition 不带处置决定内容 → usage 拒绝且不推进阶段', async () => {
  const h = commandHarness({ answers: [] });
  h.entries.push(dispositionWaitCheckpoint('wait_decision'));
  await h.run('review fix-r continue-disposition');
  assert.equal(h.calls(), 0);
  assert.ok(
    h.notifications.some((text) => text.includes('usage') && text.includes('continue-disposition')),
    `notifications: ${h.notifications.join(' | ')}`,
  );
  assert.equal(workflowRuns(h).at(-1).data.stage, 'WAITING_FOR_USER', '缺内容时不得推进阶段');
});

test('/fix review continue-disposition（external_action_completion）→ 无仓库变更回 VERIFYING', async () => {
  const h = commandHarness({ answers: [] });
  h.entries.push(dispositionWaitCheckpoint('external_action'));
  await h.run('review fix-r continue-disposition 外部动作已完成权限开通');
  assert.equal(h.calls(), 0, 'review 命令不得触发任何 worker 调用');
  assert.equal(workflowRuns(h).at(-1).data.stage, 'VERIFYING', 'external_action 继续后无仓库变更回 VERIFYING 复测');
});

test('/fix review approve 在处置等待上被拒（无验证现场，验收未满足）且保持待评审', async () => {
  const h = commandHarness({ answers: [] });
  h.entries.push(dispositionWaitCheckpoint('wait_decision'));
  await h.run('review fix-r approve');
  assert.equal(h.calls(), 0, 'review 命令不得触发任何 worker 调用');
  assert.ok(
    h.notifications.some((text) => text.includes('验收条件未满足') && text.includes('verification_accepted')),
    `notifications: ${h.notifications.join(' | ')}`,
  );
  assert.equal(workflowRuns(h).at(-1).data.stage, 'WAITING_FOR_USER', '处置等待上 approve 被拒不得推进阶段');
  const report = h.entries.find((entry) => entry.customType === 'workflow-fix-report');
  assert.equal(report, undefined, '被拒的 approve 不得产出最终处置报告');
});
