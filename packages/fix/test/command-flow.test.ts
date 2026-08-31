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
  let handler: any;
  let calls = 0;
  let inputAnswer = opts.input ?? '';
  const selects = [...(opts.selects ?? ['通过并接受'])];
  const answers = opts.answers ?? [];
  const pi: any = {
    on: () => {},
    fixWorker: { execute: async () => answers[calls++] },
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