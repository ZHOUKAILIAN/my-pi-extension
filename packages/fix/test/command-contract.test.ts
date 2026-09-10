import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension from '../src/extension.ts';
import { loadEffectivePolicy } from '../src/effective-policy.ts';
import { FIX_NODE_IDS } from '../src/definition.ts';

// ============================================================
// fix v2 /fix command 契约测试：命令路由、审计载荷、checkpoint 顺序、验证契约重试。
// 测试壳：注入单 worker 顺序消费 answers；appendEntry 收集 audit 条目。
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
    run: (args: string) => handler(args, ctx),
    calls: () => calls,
    entries,
    notifications,
    ctx,
    setInput: (value: string) => { inputAnswer = value; },
  };
}

const workflowRuns = (h: ReturnType<typeof commandHarness>) => h.entries.filter((entry) => entry.customType === 'workflow-run');

test('空问题只显示 usage，不起新 run 也不调用 worker', async () => {
  const h = commandHarness({ answers: fullFlowAnswers() });
  await h.run('');
  assert.equal(h.calls(), 0);
  assert.equal(h.entries.filter((entry) => entry.customType === 'workflow-command').length, 0);
  assert.ok(h.notifications.some((text) => text.includes('usage')), `notifications: ${h.notifications.join(' | ')}`);
});

test('完整 9 调用流程写出 start 审计、INTAKE checkpoint 与 8 节点 model-policy', async () => {
  const h = commandHarness({ answers: fullFlowAnswers() });
  await h.run('登录后白屏');
  assert.equal(h.calls(), 9);

  const start = h.entries.find((entry) => entry.customType === 'workflow-command');
  assert.ok(start, 'workflow-command entry missing');
  assert.equal(start.data.operation, 'start');
  assert.ok(typeof start.data.runId === 'string' && start.data.runId.length > 0);

  // run-start 条目带 workflowVersion/policyDigest，started 标记条目只带 started:true；
  // 取 run-start 条目校验定义与策略信封。
  const firstRun = [...workflowRuns(h)].find((entry) => entry.data.workflowVersion === 'fix-v2')!;
  assert.equal(firstRun.data.stage, 'INTAKE');
  assert.equal(firstRun.data.workflowVersion, 'fix-v2');
  assert.equal(firstRun.data.policyDigest, loadEffectivePolicy(h.ctx.cwd, { trusted: true }).digest);

  const modelPolicyNodeIds = h.entries
    .filter((entry) => entry.customType === 'workflow-model-policy')
    .map((entry) => entry.data.nodeId);
  assert.deepEqual([...new Set(modelPolicyNodeIds)].sort(), [...FIX_NODE_IDS].sort());
});

test('checkpoint stage 序列覆盖 8 阶段主流程', async () => {
  const h = commandHarness({ answers: fullFlowAnswers() });
  await h.run('登录后白屏');
  // 启动标记（run_started 一次性语义的落盘）先于业务 checkpoint 写入，因此在 INTAKE 阶段会
  // 出现两条 workflow-run 条目：run-start 条目与 started 标记条目。业务阶段序列从 INVESTIGATING 起。
  const stages = workflowRuns(h).map((entry) => entry.data.stage);
  // Reviewer participant checkpoints are intentionally emitted within the
  // current stage so a crash can resume the next participant. Collapse those
  // same-stage progress records for the lifecycle assertion.
  const stageTransitions = stages.filter((stage, index) => index === 0 || stage !== stages[index - 1]);
  assert.deepEqual(stageTransitions, ['INTAKE', 'INVESTIGATING', 'DISPOSITION', 'IMPLEMENTING', 'VERIFYING', 'WAITING_FOR_USER', 'ACCEPTED']);
});

test('/fix review 无待评审 run 时只 notify，不起新 run', async () => {
  const h = commandHarness({ answers: fullFlowAnswers() });
  await h.run('review 任意token');
  assert.equal(h.calls(), 0);
  assert.equal(h.entries.filter((entry) => entry.customType === 'workflow-command').length, 0);
  assert.ok(h.notifications.some((text) => text.includes('no pending fix review')), `notifications: ${h.notifications.join(' | ')}`);
});

test('验证契约不满足时自动重试一次 verify，重试通过后 ACCEPTED', async () => {
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
      verificationShape({ evidence: ['raw-evidence'] }),
      verificationShape(),
    ],
  });
  await h.run('登录后白屏');
  assert.equal(h.calls(), 10);
  assert.equal(workflowRuns(h).at(-1).data.stage, 'ACCEPTED');
});