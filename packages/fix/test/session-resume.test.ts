import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension from '../src/extension.ts';
import { loadEffectivePolicy } from '../src/effective-policy.ts';
import { FIX_SOURCE_VERSION } from '../src/definition.ts';

// ============================================================
// fix v2 session resume 行为测试：session_start(resume) 钩子门槛、
// confirm 确认、checkpoint 恢复续跑（INVESTIGATING 起 8 次 worker 调用）、
// WAITING_FOR_USER 缺前置验收保持待确认、untrusted 项目策略回退。
// 测试壳与 Artifact 形状复用 command-behavior.test.ts。
// ============================================================

const intakeShape = { kind: 'intake', summary: '登录后白屏', overview: '登录后白屏，影响核心链路，怀疑前端渲染异常' };
// checkpoint.artifacts 是运行时 executeNode 盖章后的形状（带 conclusion）；旧格式仅 phenomenon 的不完整表单测另行覆盖。
const stampedIntake = { ...intakeShape, conclusion: { status: 'accepted', summary: 'stamped by runtime' }, schemaVersion: 1, runId: 'fix-r', producerKind: 'worker', sourceVersion: FIX_SOURCE_VERSION, nodeExecutionId: 'fix-r.intake.1', workerId: 'worker', unverified: [] };
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
  remainingRisk: ['无'],
  conclusion: { status: 'accepted', summary: 'verification completed' },
  ...extra,
});

// 续跑从 INVESTIGATING 出发跳过 INTAKE：investigate → investigation_review →
// disposition → change_plan_review×2 → implement → change_review → verify = 8 次。
const resumeAnswers = () => [
  investigationShape,
  ireviewShape('accepted'),
  dispositionShape(true),
  cprShape,
  cprShape,
  implementationShape(),
  creviewShape(),
  verificationShape(),
];

function harness(entries: any[], confirm = true, options: { cwd?: string; trusted?: boolean; answers?: any[] } = {}) {
  const cwd = options.cwd ?? mkdtempSync(join(tmpdir(), 'fix-resume-'));
  let onStart: any;
  let calls = 0;
  let confirmCalls = 0;
  const notifications: string[] = [];
  const selects = ['通过并接受'];
  const answers = options.answers ?? resumeAnswers();
  const kinds: string[] = [];
  const pi: any = {
    on: (_event: string, handler: any) => { onStart = handler; },
    fixWorker: { execute: async () => { const shape = answers[calls++]; kinds.push(shape?.kind); return shape; } },
    appendEntry: (customType: string, data: any) => entries.push({ customType, data }),
    registerCommand: () => {},
    sendMessage: () => {},
  };
  const ctx: any = {
    cwd,
    hasUI: true,
    thinkingLevel: 'high',
    isProjectTrusted: () => options.trusted ?? true,
    sessionManager: { getEntries: () => entries },
    ui: {
      confirm: async () => { confirmCalls += 1; return confirm; },
      notify: (message: string, type?: string) => notifications.push(`${type ?? 'info'}: ${message}`),
      select: async () => selects.shift(),
      input: async () => '已补充信息',
    },
  };
  extension(pi);
  return {
    start: (reason: string) => onStart({ reason }, ctx),
    calls: () => calls,
    confirmCalls: () => confirmCalls,
    firstCallKind: () => kinds[0],
    notifications,
    entries,
  };
}

// checkpoint fixture：runId 需带 'fix-' 前缀才能被 latestUncompleted 选中；
// 必须携带 schemaVersion/1、workflowVersion:'fix-v2' 与按恢复上下文计算的 policyDigest，
// 否则 restore 抛 CheckpointRestoreError 或把 run 标记为不完整。
const cp = (stage: string, digest: string, extra: Record<string, unknown> = {}) => ({
  customType: 'workflow-run',
  data: { runId: 'fix-r', schemaVersion: 1, stage, problem: '登录后白屏', at: 1, id: 'fix-r-1', workflowVersion: 'fix-v2', policyDigest: digest, ...extra },
});

const workflowRuns = (h: ReturnType<typeof harness>) => h.entries.filter((entry) => entry.customType === 'workflow-run');

test('仅 Pi session resume（reason=resume）可继续未完成工作流：其余 reason 不执行', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fix-resume-'));
  const digest = loadEffectivePolicy(cwd, { trusted: true }).digest;
  const h = harness([cp('INVESTIGATING', digest)], true, { cwd });
  for (const reason of ['startup', 'reload', 'new', 'fork']) await h.start(reason);
  assert.equal(h.calls(), 0);
  assert.equal(h.confirmCalls(), 0);
});

test('confirm 通过后从 INVESTIGATING 续跑：8 次 worker 调用并最终 ACCEPTED', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fix-resume-'));
  const digest = loadEffectivePolicy(cwd, { trusted: true }).digest;
  const h = harness([cp('INVESTIGATING', digest, { artifacts: [stampedIntake] })], true, { cwd });
  await h.start('resume');
  assert.equal(h.calls(), 8);
  assert.equal(h.confirmCalls(), 1);
  assert.equal(workflowRuns(h).at(-1).data.stage, 'ACCEPTED');
});

test('confirm 拒绝时不执行续跑', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fix-resume-'));
  const digest = loadEffectivePolicy(cwd, { trusted: true }).digest;
  const h = harness([cp('INVESTIGATING', digest)], false, { cwd });
  await h.start('resume');
  assert.equal(h.confirmCalls(), 1);
  assert.equal(h.calls(), 0);
});

test('已 ACCEPTED 的 run 不确认也不执行 worker', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fix-resume-'));
  const digest = loadEffectivePolicy(cwd, { trusted: true }).digest;
  const h = harness([cp('ACCEPTED', digest)], true, { cwd });
  await h.start('resume');
  assert.equal(h.confirmCalls(), 0);
  assert.equal(h.calls(), 0);
});

test('WAITING_FOR_USER 续跑无 artifacts 历史（无验证背书）→ 恢复被拒，不执行 worker', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fix-resume-'));
  const digest = loadEffectivePolicy(cwd, { trusted: true }).digest;
  const h = harness([cp('WAITING_FOR_USER', digest, { pendingDecisionRequest: 'waiting-request', candidateRevision: 'rev-1' })], true, { cwd });
  await h.start('resume');
  assert.equal(h.calls(), 0);
  assert.equal(workflowRuns(h).at(-1).data.stage, 'WAITING_FOR_USER');
  // 无“已接受的验证 + Runtime 决策请求”背书的等待态不得续跑（P2-1）：fail-closed 拒绝，
  // 绝不进入 approve 路径。
  assert.ok(h.notifications.some((text) => text.includes('CHECKPOINT_STATE_INCONSISTENT')), `notifications: ${h.notifications.join(' | ')}`);
});

test('旧格式 intake checkpoint（仅 phenomenon）缺 summary/overview：验收不通过，不静默按新 Intake 通过', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fix-resume-'));
  const digest = loadEffectivePolicy(cwd, { trusted: true }).digest;
  // 旧 checkpoint 的 intake 只有 phenomenon，缺少新契约字段 summary/overview。
  const h = harness([cp('INVESTIGATING', digest, { artifacts: [{ kind: 'intake', phenomenon: '登录后白屏' }] })], true, { cwd });
  await h.start('resume');
  // 续跑完成 8 次 worker 调用但 approve 验收不通过：intake_accepted 要求 summary+overview。
  assert.equal(h.calls(), 8);
  assert.equal(workflowRuns(h).at(-1).data.stage, 'WAITING_FOR_USER');
  assert.ok(h.notifications.some((text) => text.includes('intake_accepted')), `notifications: ${h.notifications.join(' | ')}`);
});

test('untrusted 项目忽略 .pi/workflow.json：模型策略全部回退 runtime-default 后续跑 8 次', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fix-resume-'));
  mkdirSync(join(cwd, '.pi'));
  writeFileSync(join(cwd, '.pi', 'workflow.json'), JSON.stringify({ version: 1, default: 'inherit' }));
  const digest = loadEffectivePolicy(cwd, { trusted: false }).digest;
  const h = harness([cp('INVESTIGATING', digest, { artifacts: [stampedIntake] })], true, { cwd, trusted: false });
  await h.start('resume');
  assert.equal(h.calls(), 8);
  const policies = h.entries.filter((entry) => entry.customType === 'workflow-model-policy');
  assert.ok(policies.length > 0, 'no workflow-model-policy entries');
  assert.ok(policies.every((entry) => entry.data.source === 'runtime-default'), `sources: ${policies.map((e) => e.data.source).join(', ')}`);
});

// ============================================================
// P1 code_reviewer 补测：BLOCKED 跨 session 续跑必须按 checkpoint.returnStage 回现场，
// 不允许默认回滚到 INVESTIGATING（D4 external_condition/证据不足阻塞后应回到阻塞点所在阶段）。
// ============================================================

const blockedCp = (digest: string, extra: Record<string, unknown> = {}) =>
  cp('BLOCKED', digest, { artifacts: [stampedIntake], ...extra });

// 外部条件验证失败前真实参数的现场：intake + 配对 investigation_review + disposition(false) +
// 失败 verification（external_condition），全部带 Worker 信封（评审用独立 workerId）。
const stampEnvelope = (artifact: Record<string, unknown>, nodeId: string, workerId: string) => ({
  ...artifact,
  unverified: [],
  schemaVersion: 1,
  runId: 'fix-r',
  producerKind: 'worker',
  sourceVersion: FIX_SOURCE_VERSION,
  nodeExecutionId: `fix-r.${nodeId}.1`,
  workerId,
});
const verifyingBlockedCp = (digest: string) =>
  cp('BLOCKED', digest, {
    blockedReturnStage: 'VERIFYING',
    artifacts: [
      stampEnvelope({ ...intakeShape, conclusion: { status: 'accepted', summary: 'stamped' } }, 'intake', 'worker'),
      stampEnvelope(investigationShape, 'investigate', 'worker'),
      stampEnvelope(ireviewShape('accepted'), 'investigation_review', 'reviewer'),
      stampEnvelope(dispositionShape(false), 'disposition', 'worker'),
      stampEnvelope(
        { ...verificationShape({ accepted: false, failure: { kind: 'external_condition', reason: '缺少数据库只读权限' } }), conclusion: { status: 'rejected', summary: '外部条件未满足' } },
        'verify',
        'worker',
      ),
    ],
  });

// 外部条件类验证失败 → BLOCKED(returnStage=VERIFYING)：跨 session 续跑首次 dispatch 必须是
// verify（不是 investigate）；解锁 + 循环内重验两次后 approve 到达 ACCEPTED。
test('BLOCKED（external_condition）续跑按 checkpoint 保存的 returnStage 回 VERIFYING，不默认回 INVESTIGATING', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fix-resume-'));
  const digest = loadEffectivePolicy(cwd, { trusted: true }).digest;
  // 解锁 verify + 循环内重验 verify 两次后 approve；不回 investigate。
  const h = harness([verifyingBlockedCp(digest)], true, {
    cwd,
    answers: [verificationShape(), verificationShape()],
  });
  await h.start('resume');
  assert.equal(h.firstCallKind(), 'verification', 'cross-session resume must dispatch verify, not investigate');
  assert.equal(h.calls(), 2, 'unblock verify + loop verify, then approve completes the run');
  assert.equal(workflowRuns(h).at(-1).data.stage, 'ACCEPTED');
  const blockedCheckpoint = h.entries.find((entry) => entry.customType === 'workflow-run' && entry.data.stage === 'BLOCKED');
  assert.equal(blockedCheckpoint?.data.blockedReturnStage, 'VERIFYING');
});

// 无 returnStage 的旧 BLOCKED checkpoint（或调查阶段阻塞）继续默认回 INVESTIGATING：
// 解锁先补 evidence（investigate），再走完整 8 步流（共 9 次调用）。
test('BLOCKED checkpoint 无 returnStage 时续跑默认回 INVESTIGATING（先 investigate 补证据）', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fix-resume-'));
  const digest = loadEffectivePolicy(cwd, { trusted: true }).digest;
  const h = harness([blockedCp(digest)], true, {
    cwd,
    answers: [investigationShape, ...resumeAnswers()],
  });
  await h.start('resume');
  assert.equal(h.firstCallKind(), 'investigation', 'legacy BLOCKED without returnStage resumes at investigate');
  // 解锁 investigate + 从 INVESTIGATING 起的 8 步完整流（investigate→review→disposition→cpr×2→implement→creview→verify）。
  assert.equal(h.calls(), 9);
  assert.equal(workflowRuns(h).at(-1).data.stage, 'ACCEPTED');
});