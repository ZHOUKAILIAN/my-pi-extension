import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiSessionRunStore } from '@pi/workflow-runtime';
import { prepareRun, continueRun, handleFixCommand, type FixHost } from '../src/extension-v2.ts';
import { loadEffectivePolicy } from '../src/effective-policy.ts';
import { FIX_SOURCE_VERSION } from '../src/definition.ts';

// ============================================================
// ACCEPTED checkpoint 恢复 fail-closed 的 Extension 级测试：
// - 伪造/不完整的 ACCEPTED checkpoint（无 Runtime 决策记录、来源未绑定等）在 continueRun 恢复阶段
//   失败关闭，返回 'paused' 且不得产出“已解决/验收通过”报告；
// - runtime 真实写出的完整 ACCEPTED checkpoint（handleFixCommand 真实链路 + decide 盖章决策记录）
//   可正常恢复（continueRun 回放）并再次产出最终处置报告。
// v2 受控终局下 approve 验收事实 = 定义声明来源（FIX_SOURCE_VERSION）+ Runtime 盖章的
// decisionRecord（decisionRecord 是产物证明，平铺字段可手填但不足以构成验收事实）。
// ============================================================

const stampedBase = {
  schemaVersion: 1, runId: 'fix-ac', producerKind: 'worker', sourceVersion: FIX_SOURCE_VERSION,
};
const intakeStamped = {
  kind: 'intake', summary: '登录后白屏', overview: '登录后白屏，影响核心链路，怀疑前端渲染异常', unverified: [],
  ...stampedBase, nodeExecutionId: 'fix-ac.intake.1', workerId: 'worker', conclusion: { status: 'accepted', summary: 'stamped by runtime' },
};
const investigationStamped = {
  kind: 'investigation', route: 'local_fix', rootCause: 'cause', evidence: ['trace'], id: 'inv-ac-1', unverified: [],
  ...stampedBase, nodeExecutionId: 'fix-ac.investigate.1', workerId: 'worker', conclusion: { status: 'accepted', summary: 'cause investigated' },
};
const investigationReviewStamped = {
  kind: 'investigation_review', rootCauseConclusion: 'cause', evidenceSufficiency: 'sufficient', gaps: [], targetArtifactId: 'inv-ac-1', unverified: [],
  ...stampedBase, nodeExecutionId: 'fix-ac.investigation_review.1', workerId: 'reviewer', conclusion: { status: 'accepted', summary: 'review passed' },
};
const dispositionStamped = (requiresRepositoryChange: boolean) => ({
  kind: 'disposition', dispositionType: 'remediation', requiresRepositoryChange, minimalScope: 'a.ts', risks: [], verificationTarget: 'tests', unverified: [],
  ...stampedBase, nodeExecutionId: 'fix-ac.disposition.1', workerId: 'worker', conclusion: { status: 'accepted', summary: 'plan' },
});
const changePlanReviewStamped = {
  kind: 'change_plan_review', rootCauseAlignment: true, changedScope: 'a.ts', risks: [], compatibility: [], verification: [], rollback: [], findings: [], unverified: [],
  ...stampedBase, nodeExecutionId: 'fix-ac.change_plan_review.1', workerId: 'reviewer', conclusion: { status: 'accepted', summary: 'plan review passed' },
};
const implementationStamped = {
  kind: 'implementation', artifact: { summary: 'fix', filesChanged: ['a.ts'], candidateRevision: 'rev-1' }, unverified: [],
  ...stampedBase, nodeExecutionId: 'fix-ac.implement.1', workerId: 'worker', conclusion: { status: 'accepted', summary: 'implemented' },
};
const changeReviewStamped = {
  kind: 'change_review', reviewedRevision: 'rev-1', findings: [], findingDisposition: 'all_closed', unverified: [],
  ...stampedBase, nodeExecutionId: 'fix-ac.change_review.1', workerId: 'reviewer', conclusion: { status: 'accepted', summary: 'change review passed' },
};
const verificationStamped = {
  kind: 'verification', accepted: true, evidence: ['test:unit'], candidateRevision: 'rev-1', unverified: [], remainingRisk: ['无'],
  checks: { original_issue: true, root_cause_cut: true, identified_impact_surface: true, regression_and_compatibility: true },
  ...stampedBase, nodeExecutionId: 'fix-ac.verify.1', workerId: 'worker', conclusion: { status: 'accepted', summary: 'verified' },
};
// Runtime decide() 盖章归档的 approve 决策 Artifact（背书 decisionRecord，producer='user'）。
const decisionStamped = {
  kind: 'user_decision', decision: 'approve', requestId: 'req-approve',
  schemaVersion: 1, runId: 'fix-ac', producerKind: 'user_decision', producer: 'user', producerName: '用户',
  sourceVersion: FIX_SOURCE_VERSION, id: 'fix-ac.user_decision.1', unverified: [],
};
// fallback 盖章副本（'baseline'）：专门用于“仅 artifact fallback 盖章不是可验证来源”负例。
const baselineStamped = (kind: string, extra: Record<string, unknown>) => ({
  schemaVersion: 1, runId: 'fix-ac', producerKind: 'worker', sourceVersion: 'baseline', kind, unverified: [],
  ...extra,
});

function makeEnv() {
  const entries: any[] = [];
  const notifications: string[] = [];
  const cwd = mkdtempSync(join(tmpdir(), 'fix-ac-'));
  const host: FixHost = {
    trace: () => {},
    setWorkflowStatus: () => {},
    clearWorkflowWorking: () => {},
    appendEntry: (type, data) => entries.push({ customType: type, data }),
    sendMessage: () => {},
  };
  const ctx: any = {
    cwd,
    hasUI: true,
    thinkingLevel: 'high',
    isProjectTrusted: () => true,
    model: { provider: 'injected', id: 'fixWorker' },
    ui: { notify: (message: string, type?: string) => notifications.push(`${type ?? 'info'}: ${message}`) },
  };
  const pi: any = {
    fixWorker: { workerId: 'injected:accepted', execute: async () => { throw new Error('worker must not run for an ACCEPTED checkpoint'); } },
    appendEntry: (type: string, data: unknown) => entries.push({ customType: type, data }),
    sendMessage: () => {},
  };
  return { entries, notifications, cwd, host, ctx, pi };
}

test('伪造的 ACCEPTED checkpoint（缺人工 approve 决策事实）在恢复阶段失败关闭：返回 paused 且不发验收报告', async () => {
  const { entries, notifications, cwd, host, ctx, pi } = makeEnv();
  const digest = loadEffectivePolicy(cwd, { trusted: true }).digest;
  // 伪造验收态：字段看似齐全，但缺 decisionReference（人工 approve 决策事实）且 artifacts 不完整。
  entries.push({
    customType: 'workflow-run',
    data: {
      runId: 'fix-ac', schemaVersion: 1, stage: 'ACCEPTED', problem: '登录后白屏', at: 1, id: 'fix-ac-1',
      workflowVersion: 'fix-v2', policyDigest: digest,
      artifacts: [intakeStamped],
    },
  });
  const store = new PiSessionRunStore({ getEntries: () => entries }, (type, data) => entries.push({ customType: type, data }));
  const prepared = prepareRun(ctx, host, pi.fixWorker);
  const result = await continueRun(ctx, store, 'fix-ac', '登录后白屏', prepared, host, { injected: pi.fixWorker });
  assert.equal(result, 'paused');
  // 不得把伪造验收态当作“已解决/验收通过”：
  assert.ok(!entries.some((entry) => entry.customType === 'workflow-fix-report'), 'forged ACCEPTED checkpoint must not emit an acceptance report');
  assert.ok(notifications.some((text) => text.includes('ACCEPTED_CHECKPOINT_INCOMPLETE')), `notifications: ${notifications.join(' | ')}`);
});

test('字段齐全但验收事实不完整的伪造 ACCEPTED checkpoint（缺 investigation 与配对评审）→ 拒绝恢复且不发验收报告', async () => {
  const { entries, notifications, cwd, host, ctx, pi } = makeEnv();
  const digest = loadEffectivePolicy(cwd, { trusted: true }).digest;
  // 伪造方把平铺字段（decisionReference/decisionKind/pendingDecisionRequest/sourceVersion）与
  // decisionRecord shape 全部填齐，但验收事实不完整：只有 intake/disposition/verification，
  // 没有任何 investigation 与配对 investigation_review（无人类调查、无评审 marker），
  // 不应被当作“已解决（验收通过）”。字段齐 ≠ 决策记录是 runtime:decide 的真实产物。
  entries.push({
    customType: 'workflow-run',
    data: {
      runId: 'fix-ac', schemaVersion: 1, stage: 'ACCEPTED', problem: '登录后白屏', at: 2, id: 'fix-ac-2',
      workflowVersion: 'fix-v2', policyDigest: digest, decisionReference: 'req-approve', decisionKind: 'approve', pendingDecisionRequest: 'req-approve', sourceVersion: FIX_SOURCE_VERSION,
      decisionRecord: { recordId: 'dec:fix-ac:1', decision: 'approve', requestId: 'req-approve', producerKind: 'user_decision', producer: 'user', producerName: '用户', source: 'runtime:decide' },
      artifacts: [intakeStamped, dispositionStamped(false), verificationStamped, decisionStamped],
    },
  });
  const store = new PiSessionRunStore({ getEntries: () => entries }, (type, data) => entries.push({ customType: type, data }));
  const prepared = prepareRun(ctx, host, pi.fixWorker);
  const result = await continueRun(ctx, store, 'fix-ac', '登录后白屏', prepared, host, { injected: pi.fixWorker });
  assert.equal(result, 'paused');
  assert.ok(!entries.some((entry) => entry.customType === 'workflow-fix-report'), 'field-complete forged ACCEPTED must not emit an acceptance report');
  assert.ok(notifications.some((text) => text.includes('ACCEPTED_ACCEPTANCE_NOT_MET')), `notifications: ${notifications.join(' | ')}`);
});

// 真实链路（与 command-flow 的 9 次调用形状一致）：继续由 handleFixCommand 驱动完整
// 仓库变更流到 ACCEPTED——checkpoint 由 Runtime 真实写出（含定义声明来源 + decide 盖章
// decisionRecord），随后用全新 continueRun 回放该 ACCEPTED checkpoint 以产出最终处置报告。
function driveAcceptedRun() {
  const entries: any[] = [];
  const notifications: string[] = [];
  const cwd = mkdtempSync(join(tmpdir(), 'fix-ac-'));
  const host: FixHost = {
    trace: () => {},
    setWorkflowStatus: () => {},
    clearWorkflowWorking: () => {},
    appendEntry: (type, data) => entries.push({ customType: type, data }),
    sendMessage: () => {},
  };
  const answers = [
    { kind: 'intake', summary: '登录后白屏', overview: '登录后白屏，影响核心链路，怀疑前端渲染异常', conclusion: { status: 'accepted', summary: 'intake recorded' } },
    { kind: 'investigation', route: 'local_fix', rootCause: 'cause', evidence: ['trace'], conclusion: { status: 'accepted', summary: 'cause investigated' } },
    { kind: 'investigation_review', rootCauseConclusion: 'cause', evidenceSufficiency: 'sufficient', gaps: [], conclusion: { status: 'accepted', summary: 'ok' } },
    { kind: 'disposition', dispositionType: 'remediation', requiresRepositoryChange: true, minimalScope: 'a.ts', risks: [], verificationTarget: '登录流程', conclusion: { status: 'accepted', summary: 'plan' } },
    { kind: 'change_plan_review', rootCauseAlignment: true, changedScope: 'a.ts', risks: [], compatibility: [], verification: [], rollback: [], findings: [], conclusion: { status: 'accepted', summary: 'ok' } },
    { kind: 'change_plan_review', rootCauseAlignment: true, changedScope: 'a.ts', risks: [], compatibility: [], verification: [], rollback: [], findings: [], conclusion: { status: 'accepted', summary: 'ok' } },
    { kind: 'implementation', artifact: { summary: 'patch', filesChanged: ['a.ts'], candidateRevision: 'rev-1' }, conclusion: { status: 'accepted', summary: 'implemented' } },
    { kind: 'change_review', reviewedRevision: 'rev-1', findings: [], findingDisposition: 'all_closed', conclusion: { status: 'accepted', summary: 'ok' } },
    { kind: 'verification', accepted: true, evidence: ['test:unit'], candidateRevision: 'rev-1', checks: { original_issue: true, root_cause_cut: true, identified_impact_surface: true, regression_and_compatibility: true }, remainingRisk: ['无'], conclusion: { status: 'accepted', summary: 'verified' } },
  ];
  let calls = 0;
  const fixWorker = { workerId: 'injected:accepted', execute: async () => answers[calls++] };
  const ctx: any = {
    cwd,
    hasUI: true,
    thinkingLevel: 'high',
    isProjectTrusted: () => true,
    sessionManager: { getEntries: () => entries },
    model: { provider: 'injected', id: 'fixWorker' },
    ui: {
      notify: (message: string, type?: string) => notifications.push(`${type ?? 'info'}: ${message}`),
      confirm: async () => true,
      input: async () => '',
      select: async () => '通过并接受',
    },
  };
  return { entries, notifications, cwd, host, ctx, fixWorker, calls: () => calls };
}

test('runtime 真实写出的完整 ACCEPTED checkpoint（含配对评审与人工 approve）恢复后产出最终处置报告', async () => {
  const env = driveAcceptedRun();
  const store = new PiSessionRunStore({ getEntries: () => env.entries }, (type, data) => env.entries.push({ customType: type, data }));
  await handleFixCommand(env.ctx, '登录后白屏', { store, host: env.host, injected: env.fixWorker });
  assert.equal(env.calls(), 9);
  const checkpoints = env.entries.filter((entry) => entry.customType === 'workflow-run');
  const acceptedCheckpoint = checkpoints.at(-1)!.data;
  assert.equal(acceptedCheckpoint.stage, 'ACCEPTED');
  assert.equal(acceptedCheckpoint.sourceVersion, FIX_SOURCE_VERSION);
  assert.equal(acceptedCheckpoint.decisionRecord.source, 'runtime:decide');
  assert.equal(acceptedCheckpoint.decisionRecord.producerKind, 'user_decision');
  assert.equal(acceptedCheckpoint.decisionRecord.decision, 'approve');
  assert.equal(acceptedCheckpoint.decisionRecord.requestId, acceptedCheckpoint.decisionReference);
  const runId = acceptedCheckpoint.runId;
  // 回放（全新 continueRun）：恢复该真实 ACCEPTED checkpoint 并再次产出最终处置报告。
  // 回放期间不得执行任何 worker（验收态已完成，不重跑工作节点）。
  const entriesBefore = env.entries.length;
  const prepared = prepareRun(env.ctx, env.host, env.fixWorker);
  const replayWorker = { workerId: 'injected:replay', execute: async () => { throw new Error('worker must not run when replaying an ACCEPTED checkpoint'); } };
  const replayStore = new PiSessionRunStore({ getEntries: () => env.entries }, (type, data) => env.entries.push({ customType: type, data }));
  const result = await continueRun(env.ctx, replayStore, runId, '登录后白屏', prepared, env.host, { injected: replayWorker });
  assert.equal(result, 'accepted');
  const report = env.entries.slice(entriesBefore).find((entry) => entry.customType === 'workflow-fix-report');
  assert.ok(report, 'workflow-fix-report missing for a real ACCEPTED checkpoint replay');
  assert.ok(report.data.report.includes('已解决（验收通过）'));
  assert.ok(env.notifications.some((text) => text.includes('ACCEPTED')), `notifications: ${env.notifications.join(' | ')}`);
});

test('业务 Artifact 齐全但无真实 approve 决策事实（无 decisionRecord 或非 approve）→ 不恢复不发报告', async () => {
  const { entries, notifications, cwd, host, ctx, pi } = makeEnv();
  const digest = loadEffectivePolicy(cwd, { trusted: true }).digest;
  // 本次轮次的测试物理隔离：每条用例单独 store；函数化生成 checkpoint 便于复用同一份完整业务 Artifact。
  const fullAcceptedArtifacts = [intakeStamped, investigationStamped, investigationReviewStamped, dispositionStamped(false), verificationStamped];
  const runCases: Array<{ label: string; decisionKind?: string; decisionRecord?: unknown }> = [
    { label: 'decision kind is request_changes (非 approve)', decisionKind: 'request_changes' },
    { label: 'decision kind missing（无任何决策事实）', decisionKind: undefined },
    // 平铺字段全部齐全但无 Runtime 决策记录：平铺字段可手填，不构成可验证的 approve 事实。
    { label: 'flat fields complete but decisionRecord missing', decisionRecord: undefined },
  ];
  for (let at = 4; at <= 6; at += 1) {
    const runCase = runCases[at - 4];
    const storeEntries: any[] = [{
      customType: 'workflow-run',
      data: {
        runId: 'fix-ac', schemaVersion: 1, stage: 'ACCEPTED', problem: '登录后白屏', at, id: `fix-ac-${at}`,
        workflowVersion: 'fix-v2', policyDigest: digest, decisionReference: 'req-approve',
        ...(runCase.decisionKind !== undefined ? { decisionKind: runCase.decisionKind } : {}),
        ...(runCase.decisionRecord !== undefined ? { decisionRecord: runCase.decisionRecord } : {}),
        pendingDecisionRequest: 'req-approve', sourceVersion: FIX_SOURCE_VERSION,
        artifacts: fullAcceptedArtifacts,
      },
    }];
    const store = new PiSessionRunStore({ getEntries: () => storeEntries }, (type, data) => storeEntries.push({ customType: type, data }));
    const prepared = prepareRun(ctx, host, pi.fixWorker);
    const result = await continueRun(ctx, store, 'fix-ac', '登录后白屏', prepared, host, { injected: pi.fixWorker });
    assert.equal(result, 'paused', runCase.label);
    assert.ok(!storeEntries.some((entry) => entry.customType === 'workflow-fix-report'), `${runCase.label}: no acceptance report expected`);
    assert.ok(notifications.some((text) => text.includes('ACCEPTED_CHECKPOINT_INCOMPLETE')), `${runCase.label}: notifications: ${notifications.join(' | ')}`);
  }
});

test('approve 决策事实缺 candidateRevision（仓库变更完整 checkpoint）→ ACCEPTED_ACCEPTANCE_NOT_MET 且不发报告', async () => {
  const { entries, notifications, cwd, host, ctx, pi } = makeEnv();
  const digest = loadEffectivePolicy(cwd, { trusted: true }).digest;
  // 完整仓库变更验收态：全部业务 Artifact 齐全、字段齐备、决策记录存在，但 approve 决策没有绑定
  // run 候选版本（record 与平铺字段都缺 decisionCandidateRevision）——版本 bind 也是验收事实。
  entries.push({
    customType: 'workflow-run',
    data: {
      runId: 'fix-ac', schemaVersion: 1, stage: 'ACCEPTED', problem: '登录后白屏', at: 7, id: 'fix-ac-7',
      workflowVersion: 'fix-v2', policyDigest: digest, decisionReference: 'req-approve', decisionKind: 'approve',
      candidateRevision: 'rev-1', pendingDecisionRequest: 'req-approve', sourceVersion: FIX_SOURCE_VERSION,
      decisionRecord: { recordId: 'dec:fix-ac:7', decision: 'approve', requestId: 'req-approve', producerKind: 'user_decision', producer: 'user', producerName: '用户', source: 'runtime:decide' },
      artifacts: [
        intakeStamped, investigationStamped, investigationReviewStamped, dispositionStamped(true),
        changePlanReviewStamped, implementationStamped, changeReviewStamped, verificationStamped, decisionStamped,
      ],
    },
  });
  const store = new PiSessionRunStore({ getEntries: () => entries }, (type, data) => entries.push({ customType: type, data }));
  const prepared = prepareRun(ctx, host, pi.fixWorker);
  const result = await continueRun(ctx, store, 'fix-ac', '登录后白屏', prepared, host, { injected: pi.fixWorker });
  assert.equal(result, 'paused');
  assert.ok(!entries.some((entry) => entry.customType === 'workflow-fix-report'), 'approve without candidateRevision must not emit an acceptance report');
  assert.ok(notifications.some((text) => text.includes('ACCEPTED_ACCEPTANCE_NOT_MET')), `notifications: ${notifications.join(' | ')}`);
});

test('验收事实齐全但来源未绑定定义声明（仅 artifact fallback 盖章 / 自洽伪造字符串）→ ACCEPTED_CHECKPOINT_INCOMPLETE 且不发报告', async () => {
  const { entries, notifications, cwd, host, ctx, pi } = makeEnv();
  const digest = loadEffectivePolicy(cwd, { trusted: true }).digest;
  // v2 ACCEPTED 恢复的来源必须等于定义声明的 sourceVersion（FIX_SOURCE_VERSION）：
  // (a) 顶层缺失（即使全部 artifact 带一致 fallback 'baseline' 盖章）→ unbound，fail-closed；
  // (b) 顶层 + artifact 自洽使用伪造字符串（'fake-src'）且决策记录齐全 → 不是定义声明，fail-closed。
  const baselineArtifacts = [
    baselineStamped('intake', { summary: '登录后白屏', overview: '登录后白屏', nodeExecutionId: 'fix-ac.intake.1', workerId: 'worker', conclusion: { status: 'accepted', summary: 'stamped' } }),
    baselineStamped('investigation', { route: 'local_fix', rootCause: 'cause', evidence: [], id: 'inv-ac-1', nodeExecutionId: 'fix-ac.investigate.1', workerId: 'worker', conclusion: { status: 'accepted', summary: 'stamped' } }),
    baselineStamped('investigation_review', { rootCauseConclusion: 'cause', evidenceSufficiency: 'sufficient', gaps: [], targetArtifactId: 'inv-ac-1', nodeExecutionId: 'fix-ac.investigation_review.1', workerId: 'reviewer', conclusion: { status: 'accepted', summary: 'stamped' } }),
    baselineStamped('disposition', { dispositionType: 'remediation', requiresRepositoryChange: false, minimalScope: 'a.ts', risks: [], verificationTarget: 'tests', nodeExecutionId: 'fix-ac.disposition.1', workerId: 'worker', conclusion: { status: 'accepted', summary: 'stamped' } }),
    baselineStamped('verification', { accepted: true, evidence: ['test:unit'], candidateRevision: 'rev-1', nodeExecutionId: 'fix-ac.verify.1', workerId: 'worker', conclusion: { status: 'accepted', summary: 'stamped' } }),
  ];
  const record = { recordId: 'dec:fix-ac:1', decision: 'approve', requestId: 'req-approve', producerKind: 'user_decision', producer: 'user', producerName: '用户', source: 'runtime:decide' };
  const negativeCases: Array<{ label: string; sourceVersion?: string }> = [
    { label: '顶层来源缺失（仅 fallback 盖章）', sourceVersion: undefined },
    { label: '顶层 + artifact 自洽伪造字符串（≠ 定义声明）', sourceVersion: 'fake-src' },
  ];
  for (let at = 8; at <= 9; at += 1) {
    const runCase = negativeCases[at - 8];
    const storeEntries: any[] = [{
      customType: 'workflow-run',
      data: {
        runId: 'fix-ac', schemaVersion: 1, stage: 'ACCEPTED', problem: '登录后白屏', at, id: `fix-ac-${at}`,
        workflowVersion: 'fix-v2', policyDigest: digest, decisionReference: 'req-approve', decisionKind: 'approve',
        pendingDecisionRequest: 'req-approve', decisionRecord: record,
        ...(runCase.sourceVersion !== undefined ? { sourceVersion: runCase.sourceVersion } : {}),
        artifacts: runCase.sourceVersion === 'fake-src'
          ? baselineArtifacts.map((a) => ({ ...a, sourceVersion: 'fake-src' }))
          : baselineArtifacts,
      },
    }];
    const store = new PiSessionRunStore({ getEntries: () => storeEntries }, (type, data) => storeEntries.push({ customType: type, data }));
    const prepared = prepareRun(ctx, host, pi.fixWorker);
    const result = await continueRun(ctx, store, 'fix-ac', '登录后白屏', prepared, host, { injected: pi.fixWorker });
    assert.equal(result, 'paused', runCase.label);
    assert.ok(!storeEntries.some((entry) => entry.customType === 'workflow-fix-report'), `${runCase.label}: no acceptance report expected`);
    assert.ok(notifications.some((text) => text.includes('ACCEPTED_CHECKPOINT_INCOMPLETE')), `${runCase.label}: notifications: ${notifications.join(' | ')}`);
  }
});
test('伪造非终局 checkpoint（自洽 fake 来源 + 无 Runtime 账本）续跑 approve → 验收被拒，不产验收报告', async () => {
  const { entries, notifications, cwd, host, ctx, pi } = makeEnv();
  const digest = loadEffectivePolicy(cwd, { trusted: true }).digest;
  const ctxWithSelect: any = { ...ctx, ui: {
    notify: ctx.ui.notify,
    select: async () => '通过并接受',
  } };
  // 伪造方构造一个 WAITING_FOR_USER checkpoint：顶层与全部 Artifact 自洽地使用 'fake-src'（≠ 定义
  // 声明 FIX_SOURCE_VERSION），业务事实齐全、pendingDecisionRequest 就位。但业务 Artifact 没有
  // Runtime 评审账本背书（change_plan_review_accepted 现在要求记账周期），验收在 approve 前被拒：
  // 不允许“伪造来源/伪造账本的非终局 checkpoint 续跑后在同一个调用里直接产出 ACCEPTED 并发报告”。
  const fakeArtifacts = [
    { ...intakeStamped, sourceVersion: 'fake-src' },
    { ...investigationStamped, sourceVersion: 'fake-src' },
    { ...investigationReviewStamped, sourceVersion: 'fake-src' },
    { ...dispositionStamped(true), sourceVersion: 'fake-src' },
    { ...changePlanReviewStamped, sourceVersion: 'fake-src' },
    { ...implementationStamped, sourceVersion: 'fake-src' },
    { ...changeReviewStamped, sourceVersion: 'fake-src' },
    { ...verificationStamped, sourceVersion: 'fake-src' },
  ];
  entries.push({
    customType: 'workflow-run',
    data: {
      runId: 'fix-ac', schemaVersion: 1, stage: 'WAITING_FOR_USER', problem: '登录后白屏', at: 10, id: 'fix-ac-10',
      workflowVersion: 'fix-v2', policyDigest: digest, pendingDecisionRequest: 'req-approve', sourceVersion: 'fake-src',
      artifacts: fakeArtifacts,
    },
  });
  const store = new PiSessionRunStore({ getEntries: () => entries }, (type, data) => entries.push({ customType: type, data }));
  const prepared = prepareRun(ctxWithSelect, host, pi.fixWorker);
  const result = await continueRun(ctxWithSelect, store, 'fix-ac', '登录后白屏', prepared, host, { injected: pi.fixWorker });
  assert.equal(result, 'waiting');
  assert.ok(!entries.some((entry) => entry.customType === 'workflow-fix-report'), 'fake-source live approve must not produce an acceptance report');
  // 无 Runtime 记账周期：验收条件未满足，停留在待确认；不产任何“已解决”结论。
  assert.ok(notifications.some((text) => text.includes('验收条件未满足') && text.includes('change_plan_review_accepted')), `notifications: ${notifications.join(' | ')}`);
});
