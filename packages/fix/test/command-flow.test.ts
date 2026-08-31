import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension from '../src/extension.ts';

// ============================================================
// fix v2 /fix command 流程测试：完整/无仓库变更/评审拒绝回流/BLOCKED 解锁/验证回流。
// worker 执行顺序即 answers 消费顺序，calls() 反映注入 worker 调用次数。
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
const dispositionShape = (requiresRepositoryChange: boolean, dispositionType = 'remediation') => ({
  kind: 'disposition',
  dispositionType,
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
const verificationShape = (opts: { accepted?: boolean; rev?: string; failure?: { kind: 'implementation' | 'configuration' | 'external_condition'; reason: string; responsibility?: string; resolution?: string } } = {}) => ({
  kind: 'verification',
  accepted: opts.accepted ?? true,
  evidence: ['test:unit'],
  candidateRevision: opts.rev ?? 'rev-1',
  checks: verificationChecks,
  remainingRisk: ['无'],
  conclusion: { status: 'accepted', summary: 'verification completed' },
  ...(opts.failure !== undefined ? { failure: opts.failure } : {}),
});

function commandHarness(opts: { answers?: any[]; input?: string; selects?: string[] } = {}) {
  const entries: any[] = [];
  const notifications: string[] = [];
  const workerCalls: { task: unknown; capsule: Record<string, unknown> }[] = [];
  let handler: any;
  let calls = 0;
  let inputAnswer = opts.input ?? '';
  const selects = [...(opts.selects ?? ['通过并接受'])];
  const answers = opts.answers ?? [];
  const pi: any = {
    on: () => {},
    fixWorker: { execute: async (_node: unknown, _task: unknown, capsule: Record<string, unknown>) => { workerCalls.push({ task: _task, capsule }); return answers[calls++]; } },
    appendEntry: (customType: string, data: any) => entries.push({ customType, data }),
    sendMessage: () => {},
    registerCommand: (_name: string, def: any) => { handler = def.handler; },
  };
  const ctx: any = {
    cwd: mkdtempSync(join(tmpdir(), 'fix-test-')),
    hasUI: true,
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
    run: (args: string = '登录后白屏') => handler(args, ctx),
    calls: () => calls,
    entries,
    notifications,
    ctx,
    workerCalls,
    setInput: (value: string) => { inputAnswer = value; },
  };
}

const lastStage = (h: ReturnType<typeof commandHarness>) =>
  h.entries.filter((entry) => entry.customType === 'workflow-run').at(-1).data.stage;

test('仓库变更完整流：9 次调用，产出 fix-report 并 ACCEPTED', async () => {
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
      verificationShape(),
    ],
  });
  await h.run();
  assert.equal(h.calls(), 9);
  const report = h.entries.find((entry) => entry.customType === 'workflow-fix-report');
  assert.ok(report, 'workflow-fix-report missing');
  assert.ok(report.data.report.includes('已解决（验收通过）'));
  assert.ok(report.data.report.includes('- 候选版本：rev-1'));
  assert.equal(lastStage(h), 'ACCEPTED');
});

test('无仓库变更（requiresRepositoryChange:false）跳过实现与评审，直接验收', async () => {
  const h = commandHarness({
    answers: [
      intakeShape,
      investigationShape,
      ireviewShape('accepted'),
      dispositionShape(false),
      verificationShape(),
    ],
  });
  await h.run();
  // 实现实际执行 5 次 worker 调用：intake/investigate/investigation_review/disposition/verify。
  assert.equal(h.calls(), 5);
  assert.equal(lastStage(h), 'ACCEPTED');
});

// 最终报告「状态」按处置类型映射（remediation→已解决；mitigation→已缓解；explanation→无需修改），
// 不得把已缓解/无需修改硬编码成「已解决（验收通过）」；未映射的非常规处置类型（如 change_request）
// fallback 到「未解决」（wait_decision/external_action 被 D3 guard 拦在 WAITING_FOR_USER，无法直达
// ACCEPTED，故 fallback 测试用可直达的 change_request 锚定）。
test('报告状态按处置类型映射：mitigation→已缓解，explanation→无需修改，fallback→未解决（非仓库变更流）', async () => {
  const reportStatusOf = async (dispositionType: string) => {
    const h = commandHarness({
      answers: [
        intakeShape,
        investigationShape,
        ireviewShape('accepted'),
        dispositionShape(false, dispositionType),
        verificationShape(),
      ],
    });
    await h.run();
    assert.equal(lastStage(h), 'ACCEPTED');
    const report = h.entries.find((entry) => entry.customType === 'workflow-fix-report');
    assert.ok(report, `workflow-fix-report missing for ${dispositionType}`);
    return String(report.data.report);
  };
  const mitigationReport = await reportStatusOf('mitigation');
  assert.ok(mitigationReport.includes('- 状态：已缓解（验收通过）'), mitigationReport.split('\n').slice(0, 6).join('\n'));
  assert.ok(!mitigationReport.includes('已解决（验收通过）'));
  const explanationReport = await reportStatusOf('explanation');
  assert.ok(explanationReport.includes('- 状态：无需修改（验收通过）'), explanationReport.split('\n').slice(0, 6).join('\n'));
  assert.ok(!explanationReport.includes('已解决（验收通过）'));
  // fallback：映射表未涵盖的非常规 dispositionType（change_request）到 ACCEPTED 后报告「未解决」。
  const fallbackReport = await reportStatusOf('change_request');
  assert.ok(fallbackReport.includes('- 状态：未解决（验收通过）'), fallbackReport.split('\n').slice(0, 6).join('\n'));
  assert.ok(!fallbackReport.includes('已解决（验收通过）'));
});

// F-4：external_action 完成后验收 → 报告状态「已解决（验收通过）」（外部动作完成且验证证明处置后实际状态）。
test('报告状态映射：external_action 完成→已解决（D3 等待路由后验收）', async () => {
  const h = commandHarness({
    answers: [
      intakeShape,
      investigationShape,
      ireviewShape('accepted'),
      dispositionWaitShape('external_action'),
      verificationShape(),
    ],
    selects: ['继续（外部动作已完成）', '通过并接受'],
    input: '外部动作已完成：权限已由管理员开通',
  });
  await h.run();
  assert.equal(lastStage(h), 'ACCEPTED');
  const report = h.entries.find((entry) => entry.customType === 'workflow-fix-report');
  assert.ok(report, 'workflow-fix-report missing');
  assert.ok(String(report.data.report).includes('- 状态：已解决（验收通过）'));
});

test('评审拒绝回流：investigation_review rejected 后重跑 investigate 再到 ACCEPTED', async () => {
  const h = commandHarness({
    answers: [
      intakeShape,
      investigationShape,
      ireviewShape('rejected'),
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
  await h.run();
  assert.equal(h.calls(), 11);
  assert.equal(lastStage(h), 'ACCEPTED');
});

test('BLOCKED 调查阶段：needs_more_evidence 写 blocker，补充信息解锁后重跑调查', async () => {
  const h = commandHarness({
    answers: [
      intakeShape,
      { kind: 'investigation', route: 'needs_more_evidence', rootCause: 'evidence incomplete', evidence: ['missing'], conclusion: { status: 'blocked', summary: '需要补充证据' } },
      investigationShape,
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
  h.setInput('补充信息');
  await h.run();
  const blocker = h.entries.find((entry) => entry.customType === 'workflow-blocker');
  assert.ok(blocker, 'workflow-blocker missing');
  assert.equal(blocker.data.returnStage, 'INVESTIGATING');
  // 解锁执行 1 次 investigate + 阶段重跑 1 次 investigate。
  assert.equal(h.calls(), 11);
  assert.equal(lastStage(h), 'ACCEPTED');
});

test('BLOCKED 处置阶段：insufficient_evidence 写 blocker，补充信息解锁后按仓库变更走完整流', async () => {
  const h = commandHarness({
    answers: [
      intakeShape,
      investigationShape,
      ireviewShape('accepted'),
      { kind: 'disposition', dispositionType: 'insufficient_evidence', requiresRepositoryChange: false, minimalScope: 'a.ts', risks: [], verificationTarget: 'tests', conclusion: { status: 'blocked', summary: 'insufficient' } },
      dispositionShape(true),
      dispositionShape(true),
      cprShape,
      cprShape,
      implementationShape(),
      creviewShape(),
      verificationShape(),
    ],
  });
  h.setInput('补充信息');
  await h.run();
  const blocker = h.entries.find((entry) => entry.customType === 'workflow-blocker');
  assert.ok(blocker, 'workflow-blocker missing');
  assert.equal(blocker.data.returnStage, 'DISPOSITION');
  // 解锁执行 1 次 disposition + 阶段重跑 1 次（requiresRepositoryChange:true 分支）。
  assert.equal(h.calls(), 11);
  assert.equal(lastStage(h), 'ACCEPTED');
});

test('验证未通过回流：verify#1 accepted:false（实现类失败）→ 重跑 implement/change_review → verify#2 通过 → ACCEPTED', async () => {
  const h = commandHarness({
    answers: [
      intakeShape,
      investigationShape,
      ireviewShape('accepted'),
      dispositionShape(true),
      cprShape,
      cprShape,
      implementationShape('rev-1'),
      creviewShape('rev-1'),
      verificationShape({ accepted: false, rev: 'rev-1', failure: { kind: 'implementation', reason: '原始场景复测失败' } }),
      implementationShape('rev-2'),
      creviewShape('rev-2'),
      verificationShape({ accepted: true, rev: 'rev-2' }),
    ],
  });
  await h.run();
  assert.equal(h.calls(), 12);
  assert.equal(lastStage(h), 'ACCEPTED');
});

test('配置类验证失败（无仓库变更）→ WAITING_FOR_USER 而非 IMPLEMENTING，approve 因验收未满足被拒', async () => {
  const h = commandHarness({
    answers: [
      intakeShape,
      investigationShape,
      ireviewShape('accepted'),
      dispositionShape(false),
      verificationShape({ accepted: false, failure: { kind: 'configuration', reason: '生产环境配置指向错误实例，需用户修改' } }),
    ],
  });
  await h.run();
  // 不回流 IMPLEMENTING：实现 worker 不应被再次调用（calls 保持 5）。
  assert.equal(h.calls(), 5);
  assert.equal(lastStage(h), 'WAITING_FOR_USER');
  const pending = h.entries.find((entry) => entry.customType === 'workflow-decision-pending');
  assert.ok(pending, 'workflow-decision-pending entry missing');
  assert.deepEqual(pending.data.verificationFailure, { kind: 'configuration', reason: '生产环境配置指向错误实例，需用户修改' });
  assert.ok(h.notifications.some((text) => text.includes('验收条件未满足')), `notifications: ${h.notifications.join(' | ')}`);
  assert.ok(!h.notifications.some((text) => text.includes('ACCEPTED')), '配置问题不应被当作验收通过');
});

test('外部条件类验证失败 → BLOCKED（returnStage VERIFYING），补充信息解锁后验证通过 → ACCEPTED', async () => {
  const h = commandHarness({
    answers: [
      intakeShape,
      investigationShape,
      ireviewShape('accepted'),
      dispositionShape(true),
      cprShape,
      cprShape,
      implementationShape('rev-1'),
      creviewShape('rev-1'),
      verificationShape({ accepted: false, failure: { kind: 'external_condition', reason: '无权限访问外呼网关', responsibility: '外部系统负责人', resolution: '开通测试网关临时权限' } }),
      verificationShape(),
      verificationShape(),
    ],
  });
  h.setInput('已开通临时权限');
  await h.run();
  const blocker = h.entries.find((entry) => entry.customType === 'workflow-blocker');
  assert.ok(blocker, 'workflow-blocker missing');
  assert.equal(blocker.data.returnStage, 'VERIFYING');
  // 解锁执行 1 次 verify + 阶段重跑 1 次 verify。
  assert.equal(h.calls(), 11);
  assert.equal(lastStage(h), 'ACCEPTED');
});

test('change_review 通过但未绑定当前 implementation 版本（rev 不匹配）→ 不进入 VERIFYING，暂停 IMPLEMENTING 且不调用 verify worker', async () => {
  const h = commandHarness({
    answers: [
      intakeShape,
      investigationShape,
      ireviewShape('accepted'),
      dispositionShape(true),
      cprShape,
      cprShape,
      implementationShape('rev-1'),
      creviewShape('rev-999'), // 通过的评审却绑定到不存在的版本
    ],
  });
  await h.run();
  // 实现 1 次 + 评审 1 次后即暂停；verify worker 不得被调用。
  assert.equal(h.calls(), 8);
  assert.equal(lastStage(h), 'IMPLEMENTING');
  const failure = h.entries.find((entry) => entry.customType === 'workflow-node-failure');
  assert.ok(failure, 'workflow-node-failure entry missing');
  assert.equal(failure.data.nodeId, 'change_review');
  assert.equal(failure.data.stage, 'IMPLEMENTING');
  assert.equal(failure.data.code, 'CHANGE_REVIEW_NOT_BOUND');
  assert.ok(h.notifications.some((text) => text.includes('CHANGE_REVIEW_NOT_BOUND')), `notifications: ${h.notifications.join(' | ')}`);
  const pending = h.entries.find((entry) => entry.customType === 'workflow-decision-pending');
  assert.equal(pending, undefined, '未绑定评审不得进入人工验收等待');
});
// ---- D3/D5：处置等待（wait_decision / external_action）与正式方案评审安全门 ----

const dispositionWaitShape = (dispositionType: 'wait_decision' | 'external_action', requiresFormalPlanReview?: boolean) => ({
  kind: 'disposition',
  dispositionType,
  requiresRepositoryChange: false,
  minimalScope: '无',
  risks: [],
  verificationTarget: dispositionType === 'wait_decision' ? '用户确认处置方向' : '外部动作完成后复测',
  ...(requiresFormalPlanReview !== undefined ? { requiresFormalPlanReview } : {}),
  conclusion: {
    status: 'accepted',
    summary: dispositionType === 'wait_decision' ? '等待用户处置决定' : '等待外部动作完成',
  },
});

const waitingCheckpoints = (h: ReturnType<typeof commandHarness>) =>
  h.entries
    .filter((entry) => entry.customType === 'workflow-run' && entry.data.stage === 'WAITING_FOR_USER')
    .map((entry) => entry.data.pendingDecisionKind);

test('D3 wait_decision：处置先停 WAITING_FOR_USER（disposition_decision），继续后回 DISPOSITION 重落地再到 ACCEPTED', async () => {
  const h = commandHarness({
    answers: [
      intakeShape,
      investigationShape,
      ireviewShape('accepted'),
      dispositionWaitShape('wait_decision'),
      dispositionShape(false),
      verificationShape(),
    ],
    selects: ['继续（已作出处置决定）', '通过并接受'],
    // F1：continue_disposition 必须携带用户处置决定内容（UI input 收集为 note）。
    input: '用户确认按 remediation 处置，无需仓库变更',
  });
  await h.run();
  assert.equal(h.calls(), 6);
  assert.deepEqual(waitingCheckpoints(h), ['disposition_decision', 'final_acceptance'], '首个等待应为 disposition_decision，终验等待应为 final_acceptance');
  assert.equal(lastStage(h), 'ACCEPTED');
  const report = h.entries.find((entry) => entry.customType === 'workflow-fix-report');
  assert.ok(report, 'workflow-fix-report missing');
});

// F1：continue_disposition 携带的处置决定内容必须被重跑的 disposition worker 读到（瞬态 capsule
// 传递），否则 wait_decision 继续后仍只带原始 problem，处置方向无法落地。
test('F1 wait_decision：continue_disposition 的决定内容传给重跑的 disposition worker（capsule.userDecision）', async () => {
  const h = commandHarness({
    answers: [
      intakeShape,
      investigationShape,
      ireviewShape('accepted'),
      dispositionWaitShape('wait_decision'),
      dispositionShape(false),
      verificationShape(),
    ],
    selects: ['继续（已作出处置决定）', '通过并接受'],
    input: '用户决定按 mitigation 处置：仅文档说明，不做仓库变更',
  });
  await h.run();
  assert.equal(lastStage(h), 'ACCEPTED');
  // disposition worker 执行两次：首次产出 wait_decision（无内容），继续后重跑（携带用户决定）。
  const dispositionCalls = h.workerCalls
    .map((call, index) => ({ index, ...call }))
    .filter((call) => (call.capsule as { nodeExecutionId?: string })?.nodeExecutionId?.includes('.disposition.'));
  assert.equal(dispositionCalls.length, 2, 'disposition worker 应执行两次（等待 + 继续后重跑）');
  const rerun = dispositionCalls.at(-1)!;
  assert.deepEqual(
    (rerun.capsule as { userDecision?: unknown }).userDecision,
    { decision: 'continue_disposition', note: '用户决定按 mitigation 处置：仅文档说明，不做仓库变更' },
    '重跑的 disposition worker 必须读到用户 continue_disposition 的决定内容',
  );
  // 决策记录（decisionRecord）作为 trace 事实保存决定内容。
  const decisionRecord = h.entries
    .filter((entry) => entry.customType === 'workflow-run' && entry.data.decisionRecord?.decision === 'continue_disposition')
    .at(-1)?.data.decisionRecord;
  assert.ok(decisionRecord, 'decisionRecord（continue_disposition）应随 checkpoint 落盘');
  assert.equal(decisionRecord.note, '用户决定按 mitigation 处置：仅文档说明，不做仓库变更');
});

// F1：UI 无输入能力（input 缺省）时不强制 note，继续处置仍可完成（由调用方保证携带内容）。
test('F1 wait_decision：input 不可用时 continue_disposition 不强制 note 仍可继续', async () => {
  const h = commandHarness({
    answers: [
      intakeShape,
      investigationShape,
      ireviewShape('accepted'),
      dispositionWaitShape('wait_decision'),
      dispositionShape(false),
      verificationShape(),
    ],
    selects: ['继续（已作出处置决定）', '通过并接受'],
  });
  // 模拟宿主无 input 能力：替换 ctx.ui.input 为 undefined，collectDecision 跳过 note 收集。
  h.ctx.ui.input = undefined;
  await h.run();
  assert.equal(lastStage(h), 'ACCEPTED');
  // 无 note：重跑的 disposition worker 拿到空 userDecision（decision 标记 + 无内容），不退化为错误输入。
  const rerunCapsule = h.workerCalls
    .map((call) => call.capsule)
    .filter((capsule) => (capsule as { nodeExecutionId?: string })?.nodeExecutionId?.includes('.disposition.'))
    .at(-1) as Record<string, unknown>;
  assert.deepEqual(
    (rerunCapsule as { userDecision?: unknown }).userDecision,
    { decision: 'continue_disposition' },
    'input 不可用时重跑的 disposition worker 仍应收到 continue_disposition 标记（无 note）',
  );
});

test('D3 external_action：处置先停 WAITING_FOR_USER（external_action_completion），继续后无仓库变更回 VERIFYING 复测再到 ACCEPTED', async () => {
  const h = commandHarness({
    answers: [
      intakeShape,
      investigationShape,
      ireviewShape('accepted'),
      dispositionWaitShape('external_action'),
      verificationShape(),
    ],
    selects: ['继续（外部动作已完成）', '通过并接受'],
    input: '外部动作已完成：权限已由管理员开通',
  });
  await h.run();
  // 不回流 IMPLEMENTING：实现 worker 不得被调用（calls=5）。
  assert.equal(h.calls(), 5);
  assert.deepEqual(waitingCheckpoints(h), ['external_action_completion', 'final_acceptance'], '首个等待应为 external_action_completion，终验等待应为 final_acceptance');
  assert.equal(lastStage(h), 'ACCEPTED');
});

test('D5 requiresFormalPlanReview=true：处置后 BLOCKED 并写 blocker，不直进 IMPLEMENTING/VERIFYING', async () => {
  const h = commandHarness({
    answers: [
      intakeShape,
      investigationShape,
      ireviewShape('accepted'),
      dispositionWaitShape('wait_decision', true),
    ],
  });
  await h.run();
  // 只执行 intake/investigate/investigation_review/disposition：不得再调用任何实现或验证 worker。
  assert.equal(h.calls(), 4);
  assert.equal(lastStage(h), 'BLOCKED');
  const blocker = h.entries.find((entry) => entry.customType === 'workflow-blocker');
  assert.ok(blocker, 'workflow-blocker missing');
  assert.ok(blocker.data.reason.includes('正式方案采纳'), `blocker reason: ${blocker.data.reason}`);
  assert.ok(h.notifications.some((text) => text.includes('BLOCKED')), `notifications: ${h.notifications.join(' | ')}`);
});
