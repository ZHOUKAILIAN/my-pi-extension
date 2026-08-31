import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowRuntime, PiSessionRunStore, serializeReviewPolicy, type Artifact, type FixAuditEvent, type NodeDefinition, type WorkerExecutor, type WorkflowDefinition } from '../src/index.ts';
import { FIX_REVIEW_POLICIES } from '../../fix/src/definition.ts';

// 错误码在 error.code 上（message 是自然语言），断言用函数校验器匹配 code。
const throwsCode = (fn: () => unknown, code: string) => assert.throws(fn, (e: unknown) => (e as { code?: string }).code === code);
const rejectsCode = (fn: () => Promise<unknown>, code: string) => assert.rejects(fn, (e: unknown) => (e as { code?: string }).code === code);

// 内存 worker：纯内存直测 runtime，不经过 SDK。
const bareWorker = (execute: () => unknown, workerId?: string): WorkerExecutor => ({ workerId, execute: async () => execute() as Artifact });

// 内存 entry + PiSessionRunStore：checkpoint 与 audit 都在内存可见。
function makeStore() {
  const entries: { customType: string; data: Record<string, unknown> }[] = [];
  const store = new PiSessionRunStore(
    { getEntries: () => entries },
    (type: string, data: unknown) => entries.push({ customType: type, data: data as Record<string, unknown> }),
  );
  return { entries, store };
}

// 最近一个 checkpoint 携带的 pendingDecisionRequest，即 decide 必须匹配的 requestId。
function pendingRequest(entries: { customType: string; data: Record<string, unknown> }[]): string {
  const requestId = entries.at(-1)?.data?.pendingDecisionRequest;
  assert.ok(typeof requestId === 'string' && requestId.length > 0, 'checkpoint must carry pendingDecisionRequest');
  return requestId;
}

function makeDefinition(overrides?: Partial<WorkflowDefinition>): WorkflowDefinition {
  return {
    id: 'test',
    initialStage: 'INTAKE',
    version: 'v1',
    sourceVersion: 'def-src-v1',
    decision: 'user',
    acceptance: {
      requires: ['intake_accepted', 'verification_accepted', 'human_final_approval'],
      repositoryChangeRequires: ['implementation_accepted', 'change_review_accepted', 'candidate_revision_consistent'],
    },
    guard(from, to, artifact) {
      // v2 语义：WAITING_FOR_USER→ACCEPTED 只能由有效的 approve 决策触发；其余宽泛允许。
      // approval 前置（verify accepted）由调用方按流程保证，guard 只做状态机越权边界。
      if (from === 'WAITING_FOR_USER' && to === 'ACCEPTED') {
        if (!artifact || artifact.kind !== 'user_decision' || artifact.decision !== 'approve') throw Error('invalid approval decision');
      }
    },
    transition(from, to, artifact) {
      this.guard(from, to, artifact);
      return to;
    },
    ...overrides,
  };
}

const sink = (events: FixAuditEvent[]) => ({ append: (event: FixAuditEvent) => events.push(event) });
const emptyStore = () => ({ saveCheckpoint() {}, loadLast() { return undefined; } });

// 1. executeNode 盖章 + 记录
test('executeNode stamps a bare intake with provenance and records run events', async () => {
  const events: FixAuditEvent[] = [];
  const { entries, store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-1', () => 1000, () => 'id', { auditSink: sink(events) });
  const node: NodeDefinition = { id: 'intake', worker: bareWorker(() => ({ kind: 'intake', summary: '白屏', overview: '用户反馈打开页面白屏，怀疑前端渲染异常' })) };
  const { artifact, execution } = await runtime.executeNode(node, { phenomenon: '白屏' });
  assert.ok(execution.nodeExecutionId.length > 0);
  assert.equal(execution.workerId, 'worker'); // 未声明 workerId 时的默认值
  assert.equal(execution.attempt, 1);
  assert.equal(artifact.schemaVersion, 1);
  assert.equal(artifact.runId, 'run-1');
  assert.equal(artifact.producerKind, 'worker');
  // 定义声明 sourceVersion（def-src-v1）是默认盖章来源；显式 opts.sourceVersion 可覆盖。
  assert.equal(artifact.sourceVersion, 'def-src-v1');
  assert.equal(artifact.workerId, 'worker');
  assert.equal(runtime.stage, 'INTAKE'); // executeNode 不做流转，仅收 artifact
  assert.ok(runtime.getArtifacts().some((item) => item.kind === 'intake'));
  // executeNode 不写业务 checkpoint，但首个 Node 执行时会补写一条最小“启动标记”
  // （started:true，无 stage 语义/业务字段），保证 run_started 对同一 runId 只产生一次：
  // 首个 Node 即使 Worker 提交前失败，恢复后也不会对已启动的 run 再次发启动事件。
  assert.equal(entries.length, 1);
  assert.equal(entries[0].data.started, true);
  assert.equal(entries[0].data.stage, 'INTAKE');
  assert.equal(entries[0].data.artifacts, undefined);
  const types = events.map((event) => event.eventType);
  assert.equal(types.filter((type) => type === 'run_started').length, 1);
  assert.equal(types.filter((type) => type === 'artifact_submitted').length, 1);
});

// 2. executeNode 信封绑定拒绝
test('executeNode rejects a worker envelope bound to another run and audits artifact_rejected', async () => {
  const events: FixAuditEvent[] = [];
  const runtime = new WorkflowRuntime(makeDefinition(), emptyStore(), 'run-1', () => 1, () => 'id', { auditSink: sink(events) });
  const bogusEnvelope = {
    kind: 'investigation', route: 'local_fix', rootCause: 'c', evidence: ['t'],
    schemaVersion: 1, runId: 'other-run', producerKind: 'worker', sourceVersion: 'baseline',
    unverified: [], nodeExecutionId: 'x', workerId: 'w', conclusion: { status: 'accepted', summary: 's' },
  };
  const node: NodeDefinition = { id: 'investigate', worker: bareWorker(() => bogusEnvelope) };
  await rejectsCode(() => runtime.executeNode(node, {}), 'ARTIFACT_RUN_ID_MISMATCH');
  assert.equal(runtime.getArtifacts().length, 0); // 被拒 artifact 不入库
  const rejected = events.filter((event) => event.eventType === 'artifact_rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]!.payload.code, 'ARTIFACT_RUN_ID_MISMATCH');
  assert.equal(rejected[0]!.payload.nodeId, 'investigate');
});

// 3. runReview 法定通过
test('runReview passes with required quorum of independent reviewers', async () => {
  const events: FixAuditEvent[] = [];
  const { store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-1', () => 100, () => 'id', { auditSink: sink(events) });
  const investigate: NodeDefinition = {
    id: 'investigate',
    worker: bareWorker(() => ({ kind: 'investigation', route: 'local_fix', rootCause: 'cause', evidence: ['trace'] })),
  };
  await runtime.executeNode(investigate, {});
  const reviewer: NodeDefinition = {
    id: 'reviewer',
    worker: bareWorker(() => ({ kind: 'investigation_review', rootCauseConclusion: 'root cause confirmed', evidenceSufficiency: 'sufficient', gaps: [], conclusion: { status: 'accepted', summary: 'review passed' } }), 'reviewer-a'),
  };
  const result = await runtime.runReview(
    'review-node',
    [reviewer],
    { reviewers: [{ model: 'inherit' }], mode: 'parallel', requiredApprovals: 1, requireIndependentWorker: true, excludeNodes: ['investigate'], onRejected: 'return_to_investigation' },
    { reviewedNodeId: 'investigate', reviewArtifactKind: 'investigation_review' },
  );
  assert.equal(result.passed, true);
  assert.equal(result.approvals, 1);
  assert.equal(result.requiredApprovals, 1);
  assert.ok(result.reviewCycleId.length > 0);
  assert.deepEqual(result.reviewerWorkerIds, ['reviewer-a']);
  assert.ok(events.some((event) => event.eventType === 'investigation_review_completed'));
});

// 4. runReview 独立性违反
test('runReview rejects a reviewer whose worker already executed the reviewed node', async () => {
  const { store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-1', () => 1, () => 'id');
  const investigate: NodeDefinition = {
    id: 'investigate',
    worker: bareWorker(() => ({ kind: 'investigation', route: 'local_fix', rootCause: 'cause', evidence: ['trace'] }), 'main-worker'),
  };
  await runtime.executeNode(investigate, {});
  const dependent: NodeDefinition = {
    id: 'reviewer',
    worker: bareWorker(() => ({ kind: 'investigation_review', rootCauseConclusion: 'same as author', evidenceSufficiency: 'sufficient', gaps: [], conclusion: { status: 'accepted', summary: 'self review' } }), 'main-worker'),
  };
  await rejectsCode(
    () => runtime.runReview(
      'review-node',
      [dependent],
      { reviewers: [{ model: 'inherit' }], mode: 'parallel', requiredApprovals: 1, requireIndependentWorker: true, excludeNodes: ['investigate'], onRejected: 'return_to_investigation' },
      { reviewedNodeId: 'investigate', reviewArtifactKind: 'investigation_review' },
    ),
    'REVIEWER_NOT_INDEPENDENT',
  );
});

// 5. runReview quorum 不足 / 部分通过
test('runReview enforces quorum and reports partial approval as not passed', async () => {
  const { store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-1', () => 1, () => 'id');
  const investigate: NodeDefinition = {
    id: 'investigate',
    worker: bareWorker(() => ({ kind: 'investigation', route: 'local_fix', rootCause: 'cause', evidence: ['trace'] })),
  };
  await runtime.executeNode(investigate, {});
  const policy = { reviewers: [{ model: 'inherit' }], mode: 'parallel' as const, requiredApprovals: 2, requireIndependentWorker: true, excludeNodes: ['investigate'], onRejected: 'return_to_investigation' };
  const singleReviewer: NodeDefinition = {
    id: 'reviewer-a',
    worker: bareWorker(() => ({ kind: 'investigation_review', rootCauseConclusion: 'x', evidenceSufficiency: 'sufficient', gaps: [], conclusion: { status: 'accepted', summary: 'ok' } })),
  };
  await rejectsCode(
    () => runtime.runReview('review-node', [singleReviewer], policy, { reviewedNodeId: 'investigate', reviewArtifactKind: 'investigation_review' }),
    'REVIEWER_COUNT_BELOW_QUORUM',
  );
  const accepted: NodeDefinition = {
    id: 'reviewer-b',
    worker: bareWorker(() => ({ kind: 'investigation_review', rootCauseConclusion: 'x', evidenceSufficiency: 'sufficient', gaps: [], conclusion: { status: 'accepted', summary: 'ok' } }), 'reviewer-b'),
  };
  const rejected: NodeDefinition = {
    id: 'reviewer-c',
    worker: bareWorker(() => ({ kind: 'investigation_review', rootCauseConclusion: 'x', evidenceSufficiency: 'insufficient', gaps: ['needs more evidence'], conclusion: { status: 'rejected', summary: 'insufficient evidence' } }), 'reviewer-c'),
  };
  const result = await runtime.runReview('review-node', [accepted, rejected], policy, { reviewedNodeId: 'investigate', reviewArtifactKind: 'investigation_review' });
  assert.equal(result.approvals, 1);
  assert.equal(result.passed, false);
});

// 5b. runReview 独立性：requireIndependentWorker=true 时评审者必须声明 workerId
// 且不得与被评审节点同 worker（即使 policy.excludeNodes 未覆盖该节点）。
test('runReview requires a workerId on reviewers under requireIndependentWorker', async () => {
  const { store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-5b', () => 1, () => 'id');
  const investigate: NodeDefinition = {
    id: 'investigate',
    worker: bareWorker(() => ({ kind: 'investigation', route: 'local_fix', rootCause: 'cause', evidence: ['trace'] }), 'main-worker'),
  };
  await runtime.executeNode(investigate, {});
  const anonymous: NodeDefinition = {
    id: 'reviewer',
    worker: bareWorker(() => ({ kind: 'investigation_review', rootCauseConclusion: 'x', evidenceSufficiency: 'sufficient', gaps: [], conclusion: { status: 'accepted', summary: 'ok' } })),
  };
  await rejectsCode(
    () => runtime.runReview(
      'review-node',
      [anonymous],
      { reviewers: [{ model: 'inherit' }], mode: 'parallel', requiredApprovals: 1, requireIndependentWorker: true, excludeNodes: [], onRejected: 'return_to_investigation' },
      { reviewedNodeId: 'investigate', reviewArtifactKind: 'investigation_review' },
    ),
    'REVIEWER_WORKER_ID_REQUIRED',
  );
});

// 5c. 评审者不得与被评审节点同 worker：exclusion 直接覆盖 reviewedNodeId 已执行的 worker，
// 不依赖 policy.excludeNodes 是否列出该节点。
test('runReview rejects a reviewer reusing the reviewed node worker even without excludeNodes coverage', async () => {
  const { store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-5c', () => 1, () => 'id');
  const investigate: NodeDefinition = {
    id: 'investigate',
    worker: bareWorker(() => ({ kind: 'investigation', route: 'local_fix', rootCause: 'cause', evidence: ['trace'] }), 'main-worker'),
  };
  await runtime.executeNode(investigate, {});
  const dependent: NodeDefinition = {
    id: 'reviewer',
    worker: bareWorker(() => ({ kind: 'investigation_review', rootCauseConclusion: 'self', evidenceSufficiency: 'sufficient', gaps: [], conclusion: { status: 'accepted', summary: 'self review' } }), 'main-worker'),
  };
  await rejectsCode(
    () => runtime.runReview(
      'review-node',
      [dependent],
      { reviewers: [{ model: 'inherit' }], mode: 'parallel', requiredApprovals: 1, requireIndependentWorker: true, excludeNodes: [], onRejected: 'return_to_investigation' },
      { reviewedNodeId: 'investigate', reviewArtifactKind: 'investigation_review' },
    ),
    'REVIEWER_NOT_INDEPENDENT',
  );
});

// 5d. C：评审硬性通过条件——investigation_review 必须 evidenceSufficiency=sufficient；
// change_plan_review 必须 rootCauseAlignment=true；change_review 必须 all_closed 且无 open finding。
test('runReview enforces kind-specific hard pass conditions on accepted conclusions', async () => {
  const { store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-5d', () => 1, () => 'id');
  // investigation_review：结论 accepted 但证据不足 → 不计为通过。
  const insufficient: NodeDefinition = {
    id: 'reviewer-a',
    worker: bareWorker(() => ({ kind: 'investigation_review', rootCauseConclusion: 'x', evidenceSufficiency: 'insufficient', gaps: ['缺复现'], conclusion: { status: 'accepted', summary: '结论已接受' } }), 'reviewer-a'),
  };
  const a = await runtime.runReview(
    'review-node',
    [insufficient],
    { reviewers: [{ model: 'inherit' }], mode: 'parallel', requiredApprovals: 1, requireIndependentWorker: true, excludeNodes: ['investigate'], onRejected: 'return_to_investigation' },
    { reviewedNodeId: 'investigate', reviewArtifactKind: 'investigation_review' },
  );
  assert.equal(a.approvals, 0);
  assert.equal(a.passed, false);

  // change_plan_review：结论 accepted 但 rootCauseAlignment=false → 不计为通过。
  const misaligned: NodeDefinition = {
    id: 'reviewer-b',
    worker: bareWorker(() => ({ kind: 'change_plan_review', rootCauseAlignment: false, changedScope: 'x', risks: [], compatibility: [], verification: [], rollback: [], findings: [], conclusion: { status: 'accepted', summary: '对齐有问题但仍接受' } }), 'reviewer-b'),
  };
  const plan = await runtime.runReview(
    'review-node',
    [misaligned],
    { reviewers: [{ model: 'inherit' }], mode: 'parallel', requiredApprovals: 1, requireIndependentWorker: true, excludeNodes: ['implement'], onRejected: 'return_to_implementation' },
    { reviewedNodeId: 'change-plan', reviewArtifactKind: 'change_plan_review' },
  );
  assert.equal(plan.approvals, 0);
  assert.equal(plan.passed, false);

  // change_review：findingDisposition=all_closed 但存在 open finding → 不计为通过。
  const openFinding: NodeDefinition = {
    id: 'reviewer-c',
    worker: bareWorker(() => ({ kind: 'change_review', reviewedRevision: 'rev-1', findings: [{ id: 'f1', summary: '残留问题', severity: 'warning', disposition: 'open' }], findingDisposition: 'all_closed', conclusion: { status: 'accepted', summary: '结论已接受' } }), 'reviewer-c'),
  };
  const change = await runtime.runReview(
    'review-node',
    [openFinding],
    { reviewers: [{ model: 'inherit' }], mode: 'parallel', requiredApprovals: 1, requireIndependentWorker: true, excludeNodes: ['implement'], onRejected: 'return_to_implementation' },
    { reviewedNodeId: 'implement', reviewArtifactKind: 'change_review' },
  );
  assert.equal(change.approvals, 0);
  assert.equal(change.passed, false);
});

// 5e. C：policy.requiredChecks 全部满足才算通过；未知检查名不满足（fail-closed）。
test('runReview enforces policy.requiredChecks and fails closed on unknown checks', async () => {
  const { store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-5e', () => 1, () => 'id');
  const reviewer: NodeDefinition = {
    id: 'reviewer-a',
    worker: bareWorker(() => ({ kind: 'change_plan_review', rootCauseAlignment: true, changedScope: '仅补充一处空值判断', risks: [], compatibility: [], verification: ['tool: 单测'], rollback: ['git revert'], findings: [], conclusion: { status: 'accepted', summary: 'ok' } }), 'reviewer-a'),
  };
  const basePolicy = { reviewers: [{ model: 'inherit' }], mode: 'parallel' as const, requiredApprovals: 1, requireIndependentWorker: true, excludeNodes: ['implement'], onRejected: 'return_to_implementation' };
  // 全部已知检查名都满足时通过。
  const ok = await runtime.runReview(
    'review-node',
    [reviewer],
    { ...basePolicy, requiredChecks: ['root_cause_alignment', 'minimal_scope', 'risk_and_compatibility', 'verification_plan', 'rollback_plan'] },
    { reviewedNodeId: 'change-plan', reviewArtifactKind: 'change_plan_review' },
  );
  assert.equal(ok.approvals, 1);
  assert.equal(ok.passed, true);
  // 未知检查名无法由 Artifact 证明 → 不计为通过（fail-closed）。
  const unknown = await runtime.runReview(
    'review-node',
    [reviewer],
    { ...basePolicy, requiredChecks: ['does_not_exist_check'] },
    { reviewedNodeId: 'change-plan', reviewArtifactKind: 'change_plan_review' },
  );
  assert.equal(unknown.approvals, 0);
  assert.equal(unknown.passed, false);
});
test('assertCandidateRevisionConsistent rejects revision skew between implementation and change_review', async () => {
  const { store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-1', () => 1, () => 'id');
  await runtime.executeNode(
    { id: 'implement', worker: bareWorker(() => ({ kind: 'implementation', artifact: { summary: 'fix', filesChanged: ['a.ts'], candidateRevision: 'rev-1' } })) },
    {},
  );
  await runtime.executeNode(
    { id: 'change-review', worker: bareWorker(() => ({ kind: 'change_review', reviewedRevision: 'rev-2', findings: [], findingDisposition: 'all_closed', conclusion: { status: 'accepted', summary: 'ok' } })) },
    {},
  );
  throwsCode(() => runtime.assertCandidateRevisionConsistent(runtime.getArtifacts()), 'CANDIDATE_REVISION_MISMATCH');
});

test('assertCandidateRevisionConsistent accepts matching implementation and verification revisions', async () => {
  const { store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-1', () => 1, () => 'id');
  await runtime.executeNode(
    { id: 'implement', worker: bareWorker(() => ({ kind: 'implementation', artifact: { summary: 'fix', filesChanged: ['a.ts'], candidateRevision: 'rev-1' } })) },
    {},
  );
  await runtime.executeNode(
    { id: 'verify', worker: bareWorker(() => ({ kind: 'verification', accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1' })) },
    {},
  );
  assert.doesNotThrow(() => runtime.assertCandidateRevisionConsistent(runtime.getArtifacts()));
});

// 7. decide approve
// D4/A：approve 由 decide 内部强制 Evaluation；候选版本必须与 run 当前 candidateRevision 匹配。
test('decide approves a pending WAITING_FOR_USER run after verification', async () => {
  const events: FixAuditEvent[] = [];
  const { entries, store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-7', () => 7, () => 'gen', { auditSink: sink(events) });
  await runtime.executeNode({ id: 'intake', worker: bareWorker(() => ({ kind: 'intake', summary: '白屏', overview: '登录后白屏' })) }, {});
  const verify = await runtime.executeNode(
    { id: 'verify', worker: bareWorker(() => ({ kind: 'verification', accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1' })) },
    {},
  );
  runtime.transition('WAITING_FOR_USER', verify.artifact);
  assert.equal(runtime.stage, 'WAITING_FOR_USER');
  const requestId = pendingRequest(entries);
  const result = runtime.decide({ kind: 'user_decision', decision: 'approve', requestId });
  assert.equal(result.outcome, 'accepted');
  assert.equal(runtime.stage, 'ACCEPTED');
  const types = events.map((event) => event.eventType);
  assert.ok(types.includes('human_review_decided'));
  assert.ok(types.includes('run_accepted'));
  // approve 不产生返工事件。
  assert.ok(!types.includes('run_rework'));
  assert.ok(!types.includes('run_reopened'));
});

// A：approve 不能绕过 Acceptance——内部求值失败时抛 APPROVAL_ACCEPTANCE_NOT_MET，run 保持 WAITING_FOR_USER。
test('decide refuses approve when acceptance is not satisfied (no direct-call bypass)', async () => {
  const { entries, store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-7b', () => 7, () => 'gen');
  const verify = await runtime.executeNode(
    { id: 'verify', worker: bareWorker(() => ({ kind: 'verification', accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1' })) },
    {},
  );
  runtime.transition('WAITING_FOR_USER', verify.artifact);
  const requestId = pendingRequest(entries);
  // 缺少 intake（intake_accepted 未满足），即使带验收前置参数也不能直接进入 ACCEPTED。
  throwsCode(() => runtime.decide({ kind: 'user_decision', decision: 'approve', requestId }), 'APPROVAL_ACCEPTANCE_NOT_MET');
  assert.equal(runtime.stage, 'WAITING_FOR_USER');
  assert.ok(!runtime.getArtifacts().some((a) => a.kind === 'user_decision' && a.decision === 'approve'));
});

// D4：approve 决策必须携带与 run 当前 candidateRevision 匹配的候选版本。
test('decide enforces candidateRevision match on approve', async () => {
  const { entries, store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-7c', () => 7, () => 'gen');
  await runtime.executeNode({ id: 'intake', worker: bareWorker(() => ({ kind: 'intake', summary: '白屏', overview: '登录后白屏' })) }, {});
  await runtime.executeNode({ id: 'implement', worker: bareWorker(() => ({ kind: 'implementation', artifact: { summary: 'fix', filesChanged: ['a.ts'], candidateRevision: 'rev-1' } })) }, {});
  const verify = await runtime.executeNode(
    { id: 'verify', worker: bareWorker(() => ({ kind: 'verification', accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1' })) },
    {},
  );
  runtime.transition('WAITING_FOR_USER', verify.artifact);
  assert.equal(runtime.stage, 'WAITING_FOR_USER');
  const requestId = pendingRequest(entries);
  // approve 决策缺失候选版本（run 已产生 rev-1）→ 拒绝并保持 WAITING_FOR_USER。
  throwsCode(
    () => runtime.decide({ kind: 'user_decision', decision: 'approve', requestId }),
    'DECISION_CANDIDATE_REVISION_MISMATCH',
  );
  assert.equal(runtime.stage, 'WAITING_FOR_USER');
  // 决策声明了与 run 当前候选版本不一致的版本 → 拒绝并保持 WAITING_FOR_USER。
  throwsCode(
    () => runtime.decide({ kind: 'user_decision', decision: 'approve', requestId, candidateRevision: 'rev-999' }),
    'DECISION_CANDIDATE_REVISION_MISMATCH',
  );
  assert.equal(runtime.stage, 'WAITING_FOR_USER');
  // 决策声明匹配 run 当前候选版本 → approve 通过。
  const result = runtime.decide({ kind: 'user_decision', decision: 'approve', requestId, candidateRevision: 'rev-1' });
  assert.equal(result.outcome, 'accepted');
  assert.equal(runtime.stage, 'ACCEPTED');
});

// 8. decide request_changes 映射
test('decide maps request_changes reasonCode to INVESTIGATING and reopens the run', async () => {
  const events: FixAuditEvent[] = [];
  const { entries, store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-8', () => 8, () => 'gen', { auditSink: sink(events) });
  const verify = await runtime.executeNode(
    { id: 'verify', worker: bareWorker(() => ({ kind: 'verification', accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1' })) },
    {},
  );
  runtime.transition('WAITING_FOR_USER', verify.artifact);
  const requestId = pendingRequest(entries);
  const result = runtime.decide(
    { kind: 'user_decision', decision: 'request_changes', requestId, reasonCode: 'root_cause_or_impact' },
    { reasonToStage: (reasonCode?: string) => (reasonCode === 'root_cause_or_impact' ? 'INVESTIGATING' : 'IMPLEMENTING') },
  );
  assert.equal(result.outcome, 'reopened');
  assert.equal(result.toStage, 'INVESTIGATING');
  assert.equal(runtime.stage, 'INVESTIGATING');
  // 返工回流发 run_rework（返工语义），不得误发 run_reopened（后验收 reopen 语义，源自归档评审草案、待 D6 专项 L1 回写）。
  assert.ok(events.some((event) => event.eventType === 'run_rework'));
  assert.ok(!events.some((event) => event.eventType === 'run_reopened'));
});

// 9. decide reject
test('decide reject blocks the run', async () => {
  const events: FixAuditEvent[] = [];
  const { entries, store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-9', () => 9, () => 'gen', { auditSink: sink(events) });
  const verify = await runtime.executeNode(
    { id: 'verify', worker: bareWorker(() => ({ kind: 'verification', accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1' })) },
    {},
  );
  runtime.transition('WAITING_FOR_USER', verify.artifact);
  const requestId = pendingRequest(entries);
  const result = runtime.decide({ kind: 'user_decision', decision: 'reject', requestId, reasonCode: 'missing_external_condition' });
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.toStage, 'BLOCKED');
  assert.equal(runtime.stage, 'BLOCKED');
  // reject 是返工/阻塞回流，发 run_rework；不得误发 run_reopened（后验收 reopen 语义，源自归档评审草案、待 D6 专项 L1 回写）。
  const types = events.map((event) => event.eventType);
  assert.ok(types.includes('human_review_decided'));
  assert.ok(types.includes('run_rework'));
  assert.ok(!types.includes('run_reopened'));
});

// 9b. F：配置类验证失败进入 WAITING_FOR_USER 后，continue_verification 只能回 VERIFYING。
test('decide continue_verification reopens only a configuration-wait run to VERIFYING', async () => {
  const events: FixAuditEvent[] = [];
  const { entries, store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-9b', () => 9, () => 'gen', { auditSink: sink(events) });
  const failed = await runtime.executeNode(
    { id: 'verify', worker: bareWorker(() => ({ kind: 'verification', accepted: false, evidence: ['event:user-service-timeout'], candidateRevision: 'rev-1', failure: { kind: 'configuration', reason: '环境 DNS 配置错误' } })) },
    {},
  );
  runtime.transition('WAITING_FOR_USER', failed.artifact);
  assert.equal(runtime.stage, 'WAITING_FOR_USER');
  const requestId = pendingRequest(entries);
  const result = runtime.decide({ kind: 'user_decision', decision: 'continue_verification', requestId });
  assert.equal(result.outcome, 'reopened');
  assert.equal(result.toStage, 'VERIFYING');
  assert.equal(runtime.stage, 'VERIFYING');
  const types = events.map((event) => event.eventType);
  assert.ok(types.includes('human_review_decided'));
  // 配置类验证失败的继续验证也是返工回流：run_rework，不得误发 run_reopened。
  assert.ok(types.includes('run_rework'));
  assert.ok(!types.includes('run_reopened'));
  assert.ok(!types.includes('run_accepted'));
});

// F：continue_verification 只能用于配置类验证失败；最终验收等待（verification accepted）不允许。
test('decide refuses continue_verification outside a configuration-wait run', async () => {
  const { entries, store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-9c', () => 9, () => 'gen');
  const verify = await runtime.executeNode(
    { id: 'verify', worker: bareWorker(() => ({ kind: 'verification', accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1' })) },
    {},
  );
  runtime.transition('WAITING_FOR_USER', verify.artifact);
  const requestId = pendingRequest(entries);
  // 不能代替 approve 直接放行；run 必须保持 WAITING_FOR_USER。
  throwsCode(() => runtime.decide({ kind: 'user_decision', decision: 'continue_verification', requestId }), 'CONTINUE_VERIFICATION_NOT_AVAILABLE');
  assert.equal(runtime.stage, 'WAITING_FOR_USER');
});
// 9c. D3：continue_disposition 只消费处置等待（wait_decision → disposition_decision），路由回 DISPOSITION
//（重新执行处置，把用户决定作为补充输入）。
test('decide continue_disposition reopens a disposition_decision wait back to DISPOSITION', async () => {
  const events: FixAuditEvent[] = [];
  const { entries, store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-9d', () => 9, () => 'gen', { auditSink: sink(events) });
  await runtime.executeNode({ id: 'intake', worker: bareWorker(() => ({ kind: 'intake', summary: '白屏', overview: '登录后白屏' })) }, {});
  const disposition = await runtime.executeNode(
    { id: 'disposition', worker: bareWorker(() => ({ kind: 'disposition', dispositionType: 'wait_decision', requiresRepositoryChange: false, minimalScope: '无', risks: [], verificationTarget: '用户确认', conclusion: { status: 'accepted', summary: '等待用户处置决定' } })) },
    {},
  );
  runtime.setPendingDecisionKind('disposition_decision');
  runtime.transition('WAITING_FOR_USER', disposition.artifact);
  assert.equal(runtime.stage, 'WAITING_FOR_USER');
  const requestId = pendingRequest(entries);
  const result = runtime.decide({ kind: 'user_decision', decision: 'continue_disposition', requestId });
  assert.equal(result.outcome, 'reopened');
  assert.equal(result.toStage, 'DISPOSITION');
  assert.equal(runtime.stage, 'DISPOSITION');
  const types = events.map((event) => event.eventType);
  assert.ok(types.includes('human_review_decided'));
  // 处置决定继续同样是返工回流：run_rework，不得误发 run_reopened。
  assert.ok(types.includes('run_rework'));
  assert.ok(!types.includes('run_reopened'));
  assert.ok(!types.includes('run_accepted'));
});

// D3：external_action_completion 的继续路由——无仓库变更回 VERIFYING（外部动作已完成、已补证据，
// 复测既有现场）；声明仓库变更的处置回 DISPOSITION（走常规 repo-change 流程）。
test('decide continue_disposition routes external_action_completion to VERIFYING when no repo change is required', async () => {
  const { entries, store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-9e', () => 9, () => 'gen');
  const disposition = await runtime.executeNode(
    { id: 'disposition', worker: bareWorker(() => ({ kind: 'disposition', dispositionType: 'external_action', requiresRepositoryChange: false, minimalScope: '无', risks: [], verificationTarget: '外部动作完成后复测', conclusion: { status: 'accepted', summary: '等待外部动作完成' } })) },
    {},
  );
  runtime.setPendingDecisionKind('external_action_completion');
  runtime.transition('WAITING_FOR_USER', disposition.artifact);
  const requestId = pendingRequest(entries);
  const result = runtime.decide({ kind: 'user_decision', decision: 'continue_disposition', requestId });
  assert.equal(result.outcome, 'reopened');
  assert.equal(result.toStage, 'VERIFYING');
  assert.equal(runtime.stage, 'VERIFYING');
});

test('decide continue_disposition routes external_action_completion to DISPOSITION when a repo change is required', async () => {
  const { entries, store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-9f', () => 9, () => 'gen');
  const disposition = await runtime.executeNode(
    { id: 'disposition', worker: bareWorker(() => ({ kind: 'disposition', dispositionType: 'external_action', requiresRepositoryChange: true, minimalScope: 'a.ts', risks: [], verificationTarget: '外部动作完成后复测', conclusion: { status: 'accepted', summary: '等待外部动作完成' } })) },
    {},
  );
  runtime.setPendingDecisionKind('external_action_completion');
  runtime.transition('WAITING_FOR_USER', disposition.artifact);
  const requestId = pendingRequest(entries);
  const result = runtime.decide({ kind: 'user_decision', decision: 'continue_disposition', requestId });
  assert.equal(result.outcome, 'reopened');
  assert.equal(result.toStage, 'DISPOSITION');
  assert.equal(runtime.stage, 'DISPOSITION');
});

// D3：continue_disposition 不能用于最终验收等待（verification accepted）：无处置等待事实即 fail-closed。
test('decide refuses continue_disposition outside a disposition wait', async () => {
  const { entries, store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-9g', () => 9, () => 'gen');
  const verify = await runtime.executeNode(
    { id: 'verify', worker: bareWorker(() => ({ kind: 'verification', accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1' })) },
    {},
  );
  runtime.transition('WAITING_FOR_USER', verify.artifact);
  const requestId = pendingRequest(entries);
  throwsCode(() => runtime.decide({ kind: 'user_decision', decision: 'continue_disposition', requestId }), 'CONTINUE_DISPOSITION_NOT_AVAILABLE');
  assert.equal(runtime.stage, 'WAITING_FOR_USER');
});

// D3：pendingDecisionKind 随 checkpoint 落盘并随非等待转移清除（不残留到下一次等待），restore 恢复。
test('pendingDecisionKind persists on the WAITING checkpoint, clears on non-waiting transitions, and restores', async () => {
  const { entries, store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-9h', () => 9, () => 'gen');
  const disposition = await runtime.executeNode(
    { id: 'disposition', worker: bareWorker(() => ({ kind: 'disposition', dispositionType: 'wait_decision', requiresRepositoryChange: false, minimalScope: '无', risks: [], verificationTarget: '用户确认', conclusion: { status: 'accepted', summary: '等待用户处置决定' } })) },
    {},
  );
  runtime.setPendingDecisionKind('disposition_decision');
  runtime.transition('WAITING_FOR_USER', disposition.artifact);
  assert.equal(entries.at(-1)!.data.pendingDecisionKind, 'disposition_decision', 'checkpoint must persist pendingDecisionKind');
  // 恢复：阶段与等待种类都要可用（/resume 依赖）。
  const restored = WorkflowRuntime.restore(makeDefinition(), store, 'run-9h');
  assert.equal(restored.stage, 'WAITING_FOR_USER');
  assert.equal(restored.getPendingDecisionKind(), 'disposition_decision');
  // 继续后转出 WAITING：等待种类清除，不残留到后续 checkpoint。
  const requestId = pendingRequest(entries);
  restored.decide({ kind: 'user_decision', decision: 'continue_disposition', requestId });
  assert.equal(restored.getPendingDecisionKind(), undefined);
  assert.equal(entries.at(-1)!.data.pendingDecisionKind, undefined, 'non-waiting checkpoint must not carry a stale kind');
});

// D3：restore 对未知 pendingDecisionKind fail-closed（不静默按其它语义续跑）。
test('restore fails closed on an unknown pendingDecisionKind', async () => {
  const { entries, store } = makeStore();
  entries.push({ customType: 'workflow-run', data: {
    runId: 'run-9i', schemaVersion: 1, stage: 'WAITING_FOR_USER', at: 1, id: 'c-9i', workflowVersion: 'v1', policyDigest: 'd1',
    pendingDecisionRequest: 'req-9i', pendingDecisionKind: 'bogus_kind',
    artifacts: [
      { kind: 'verification', accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1', unverified: [], schemaVersion: 1, runId: 'run-9i', producerKind: 'worker', sourceVersion: 'def-src-v1', nodeExecutionId: 'run-9i.verify.1', workerId: 'w' },
    ],
  } });
  throwsCode(() => WorkflowRuntime.restore(makeDefinition(), store, 'run-9i'), 'CHECKPOINT_STATE_INCONSISTENT');
});

// D3：restore 接受 disposition 支撑的 WAITING 现场（无验证 artifact，wait_decision 处置 + 决策请求），
// /resume 可以继续消费处置等待；这与“无验证现场不得伪造 approve 等待”的 fail-closed 相互独立。
test('restore accepts a disposition-backed WAITING_FOR_USER checkpoint (wait_decision)', async () => {
  const { entries, store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-9j', () => 9, () => 'gen');
  await runtime.executeNode({ id: 'intake', worker: bareWorker(() => ({ kind: 'intake', summary: '白屏', overview: '登录后白屏' })) }, {});
  const disposition = await runtime.executeNode(
    { id: 'disposition', worker: bareWorker(() => ({ kind: 'disposition', dispositionType: 'wait_decision', requiresRepositoryChange: false, minimalScope: '无', risks: [], verificationTarget: '用户确认', conclusion: { status: 'accepted', summary: '等待用户处置决定' } })) },
    {},
  );
  runtime.setPendingDecisionKind('disposition_decision');
  runtime.transition('WAITING_FOR_USER', disposition.artifact);
  const restored = WorkflowRuntime.restore(makeDefinition(), store, 'run-9j');
  assert.equal(restored.stage, 'WAITING_FOR_USER');
  assert.equal(restored.getPendingDecisionKind(), 'disposition_decision');
  // 恢复后的 continue_disposition 仍可正常消费（requestId 绑定校验在 decide 内）。
  const requestId = pendingRequest(entries);
  const result = restored.decide({ kind: 'user_decision', decision: 'continue_disposition', requestId });
  assert.equal(result.outcome, 'reopened');
  assert.equal(result.toStage, 'DISPOSITION');
});

test('decide guards against non-waiting stage and mismatched requestId', async () => {
  const { entries, store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-10', () => 10, () => 'gen');
  throwsCode(() => runtime.decide({ kind: 'user_decision', decision: 'approve', requestId: 'whatever' }), 'DECISION_NOT_IN_WAITING_STAGE');
  const verify = await runtime.executeNode(
    { id: 'verify', worker: bareWorker(() => ({ kind: 'verification', accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1' })) },
    {},
  );
  runtime.transition('WAITING_FOR_USER', verify.artifact);
  const requestId = pendingRequest(entries);
  throwsCode(() => runtime.decide({ kind: 'user_decision', decision: 'approve', requestId: 'wrong-request' }), 'DECISION_REQUEST_ID_MISMATCH');
  assert.equal(runtime.stage, 'WAITING_FOR_USER'); // 校验失败不消费 pending 决策
});

// 11. evaluateAcceptance
test('evaluateAcceptance passes when all markers are satisfied', async () => {
  const { store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-11', () => 11, () => 'gen');
  await runtime.executeNode({ id: 'intake', worker: bareWorker(() => ({ kind: 'intake', summary: '白屏', overview: '登录后白屏' })) }, {});
  await runtime.executeNode(
    { id: 'verify', worker: bareWorker(() => ({ kind: 'verification', accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1' })) },
    {},
  );
  assert.deepEqual(runtime.evaluateAcceptance({ userDecision: { kind: 'user_decision', decision: 'approve', requestId: 'req-11' } }), { passed: true, missing: [] });
});

test('evaluateAcceptance reports missing verification marker', async () => {
  const runtime = new WorkflowRuntime(makeDefinition(), emptyStore(), 'run-11b', () => 1, () => 'id');
  await runtime.executeNode({ id: 'intake', worker: bareWorker(() => ({ kind: 'intake', summary: '白屏', overview: '登录后白屏' })) }, {});
  const result = runtime.evaluateAcceptance({ userDecision: { kind: 'user_decision', decision: 'approve', requestId: 'req' } });
  assert.equal(result.passed, false);
  assert.ok(result.missing.includes('verification_accepted'));
});

test('evaluateAcceptance treats old phenomenon-only intake as incomplete (intake_accepted missing)', async () => {
  const runtime = new WorkflowRuntime(makeDefinition(), emptyStore(), 'run-11d', () => 1, () => 'id');
  // 直接构造旧格式 intake artifact 绕过 executeNode 校验，模拟恢复的旧 checkpoint。
  (runtime as any).artifacts = [{ kind: 'intake', phenomenon: '白屏' }];
  await runtime.executeNode(
    { id: 'verify', worker: bareWorker(() => ({ kind: 'verification', accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1' })) },
    {},
  );
  const result = runtime.evaluateAcceptance({ userDecision: { kind: 'user_decision', decision: 'approve', requestId: 'req' } });
  assert.equal(result.passed, false, '旧 phenomenon-only intake 不得被当作已验收');
  assert.ok(result.missing.includes('intake_accepted'));
});

test('evaluateAcceptance requires repository markers when repository change is needed', async () => {
  const runtime = new WorkflowRuntime(makeDefinition(), emptyStore(), 'run-11c', () => 1, () => 'id');
  await runtime.executeNode({ id: 'intake', worker: bareWorker(() => ({ kind: 'intake', summary: '白屏', overview: '登录后白屏' })) }, {});
  await runtime.executeNode(
    { id: 'verify', worker: bareWorker(() => ({ kind: 'verification', accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1' })) },
    {},
  );
  const result = runtime.evaluateAcceptance({
    userDecision: { kind: 'user_decision', decision: 'approve', requestId: 'req' },
    requiresRepositoryChange: true,
  });
  assert.equal(result.passed, false);
  assert.ok(result.missing.includes('implementation_accepted'));
  assert.ok(result.missing.includes('change_review_accepted'));
});

// 11f. D4：仓库变更路径下 change_review 缺少 reviewedRevision 则 change_review_accepted 不满足。
test('evaluateAcceptance requires reviewedRevision on change_review under repository change', async () => {
  const runtime = new WorkflowRuntime(makeDefinition(), emptyStore(), 'run-11f', () => 1, () => 'id');
  await runtime.executeNode({ id: 'intake', worker: bareWorker(() => ({ kind: 'intake', summary: '白屏', overview: '登录后白屏' })) }, {});
  await runtime.executeNode({ id: 'implement', worker: bareWorker(() => ({ kind: 'implementation', artifact: { summary: 'fix', filesChanged: ['a.ts'], candidateRevision: 'rev-1' } })) }, {});
  await runtime.executeNode(
    { id: 'verify', worker: bareWorker(() => ({ kind: 'verification', accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1' })) },
    {},
  );
  // 仓库变更路径（requiresRepositoryChange=true）：change_review 缺失 reviewedRevision → 不满足。
  await runtime.executeNode(
    { id: 'change-review', worker: bareWorker(() => ({ kind: 'change_review', findings: [], findingDisposition: 'all_closed', conclusion: { status: 'accepted', summary: 'ok' } })) },
    {},
  );
  const missing = runtime.evaluateAcceptance({ userDecision: { kind: 'user_decision', decision: 'approve', requestId: 'req' }, requiresRepositoryChange: true });
  assert.equal(missing.passed, false);
  assert.ok(missing.missing.includes('change_review_accepted'));

  // 同一条 change_review 补充 reviewedRevision 后满足仓库变更标记。
  (runtime as any).artifacts = (runtime as any).artifacts.map((a: Artifact) =>
    a.kind === 'change_review' ? { ...a, reviewedRevision: 'rev-1' } : a,
  );
  const satisfied = runtime.evaluateAcceptance({ userDecision: { kind: 'user_decision', decision: 'approve', requestId: 'req' }, requiresRepositoryChange: true });
  assert.equal(satisfied.passed, true);
});

// 12. checkpoint/restore 门禁
test('restore enforces workflowVersion and policyDigest gates with legacy fallback', async () => {
  const { entries, store } = makeStore();
  const definition = makeDefinition();
  const runtime = new WorkflowRuntime(definition, store, 'run-12', () => 12, () => 'gen', { definitionVersion: 'v1', policyDigest: 'd1' });
  const intake = await runtime.executeNode({ id: 'intake', worker: bareWorker(() => ({ kind: 'intake', summary: '白屏', overview: '登录后白屏' })) }, {});
  runtime.transition('INVESTIGATING', intake.artifact); // checkpoint 由 transition 写入扩展字段
  const checkpoint = entries.at(-1)!.data;
  assert.equal(checkpoint.workflowVersion, 'v1');
  assert.equal(checkpoint.policyDigest, 'd1');
  assert.equal(checkpoint.stage, 'INVESTIGATING');
  throwsCode(() => WorkflowRuntime.restore(definition, store, 'run-12', { expectedWorkflowVersion: 'v2' }), 'WORKFLOW_VERSION_MISMATCH');
  throwsCode(() => WorkflowRuntime.restore(definition, store, 'run-12', { expectedPolicyDigest: 'd2' }), 'POLICY_DIGEST_MISMATCH');
  const restored = WorkflowRuntime.restore(definition, store, 'run-12'); // 无 opts：legacy 兼容
  assert.equal(restored.stage, 'INVESTIGATING');
  assert.ok(restored.getArtifacts().some((item) => item.kind === 'intake'));
});

// 13. audit sink
test('audit sink events carry identity, stage and the run_started sequence', async () => {
  const events: FixAuditEvent[] = [];
  const runtime = new WorkflowRuntime(makeDefinition(), emptyStore(), 'run-13', () => 13, () => 'gen', { auditSink: sink(events) });
  await runtime.executeNode({ id: 'intake', worker: bareWorker(() => ({ kind: 'intake', summary: '白屏', overview: '登录后白屏' })) }, {});
  assert.deepEqual(events.map((event) => event.eventType), ['run_started', 'artifact_submitted']);
  for (const event of events) {
    assert.ok(event.eventId.length > 0);
    assert.ok(event.occurredAt.length > 0);
    assert.equal(event.stage, 'INTAKE');
    assert.equal(event.runId, 'run-13');
  }
});

// 11g. fail-closed：未知 acceptance marker 不能被跳过
test('evaluateAcceptance fails closed on unknown acceptance markers', async () => {
  const runtime = new WorkflowRuntime(
    makeDefinition({ acceptance: { requires: ['intake_accepted', 'mystery_marker'], repositoryChangeRequires: ['implementation_accepted'] } }),
    emptyStore(), 'run-11g', () => 1, () => 'gen',
  );
  await runtime.executeNode({ id: 'intake', worker: bareWorker(() => ({ kind: 'intake', summary: '白屏', overview: '登录后白屏' })) }, {});
  const result = runtime.evaluateAcceptance({ userDecision: { kind: 'user_decision', decision: 'approve', requestId: 'req' } });
  assert.equal(result.passed, false);
  assert.ok(result.missing.includes('mystery_marker'), `missing: ${result.missing.join(', ')}`);
  assert.ok(!result.missing.includes('intake_accepted'));
  const withRepo = runtime.evaluateAcceptance({ userDecision: { kind: 'user_decision', decision: 'approve', requestId: 'req' }, requiresRepositoryChange: true });
  assert.equal(withRepo.passed, false);
  assert.ok(withRepo.missing.includes('implementation_accepted'), `missing: ${withRepo.missing.join(', ')}`);
});

// 11h. marker 只凭 kind 存在不能通过：conclusion rejected 的 investigation/disposition/implementation 不计为验收
test('evaluateAcceptance requires accepted conclusions on business markers', async () => {
  const runtime = new WorkflowRuntime(
    makeDefinition({
      acceptance: {
        requires: ['intake_accepted', 'investigation_accepted', 'disposition_accepted', 'verification_accepted', 'human_final_approval'],
        repositoryChangeRequires: ['implementation_accepted', 'change_review_accepted'],
      },
    }),
    emptyStore(), 'run-11h', () => 1, () => 'gen',
  );
  await runtime.executeNode({ id: 'intake', worker: bareWorker(() => ({ kind: 'intake', summary: '白屏', overview: '登录后白屏' })) }, {});
  // conclusion rejected 但 route/evidence 合规：不能只凭 kind 存在通过 investigation_accepted。
  await runtime.executeNode({ id: 'investigate', worker: bareWorker(() => ({ kind: 'investigation', route: 'local_fix', rootCause: 'cause', evidence: ['trace'], conclusion: { status: 'rejected', summary: 'rejected' } })) }, {});
  const investigation = runtime.evaluateAcceptance({ userDecision: { kind: 'user_decision', decision: 'approve', requestId: 'req' } });
  assert.equal(investigation.passed, false);
  assert.ok(investigation.missing.includes('investigation_accepted'), `missing: ${investigation.missing.join(', ')}`);
  // disposition / implementation 同样：conclusion rejected → 不满足相应 marker。
  await runtime.executeNode({ id: 'disposition', worker: bareWorker(() => ({ kind: 'disposition', dispositionType: 'remediation', requiresRepositoryChange: true, minimalScope: 'a.ts', risks: [], verificationTarget: 'tests', conclusion: { status: 'rejected', summary: 'rejected' } })) }, {});
  await runtime.executeNode({ id: 'implement', worker: bareWorker(() => ({ kind: 'implementation', artifact: { summary: 'fix', filesChanged: ['a.ts'], candidateRevision: 'rev-1' }, conclusion: { status: 'rejected', summary: 'rejected' } })) }, {});
  await runtime.executeNode({ id: 'verify', worker: bareWorker(() => ({ kind: 'verification', accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1' })) }, {});
  const repo = runtime.evaluateAcceptance({ userDecision: { kind: 'user_decision', decision: 'approve', requestId: 'req' }, requiresRepositoryChange: true });
  assert.equal(repo.passed, false);
  assert.ok(repo.missing.includes('disposition_accepted'), `missing: ${repo.missing.join(', ')}`);
  assert.ok(repo.missing.includes('implementation_accepted'), `missing: ${repo.missing.join(', ')}`);
});

// 11i. change_review 硬条件：open finding 或 reviewedRevision 与 implementation 不一致都不能通过
test('evaluateAcceptance rejects change_review with open findings or mismatched revision', async () => {
  const { store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-11i', () => 11, () => 'gen');
  await runtime.executeNode({ id: 'intake', worker: bareWorker(() => ({ kind: 'intake', summary: '白屏', overview: '登录后白屏' })) }, {});
  await runtime.executeNode({ id: 'implement', worker: bareWorker(() => ({ kind: 'implementation', artifact: { summary: 'fix', filesChanged: ['a.ts'], candidateRevision: 'rev-1' } })) }, {});
  await runtime.executeNode({ id: 'verify', worker: bareWorker(() => ({ kind: 'verification', accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1' })) }, {});
  await runtime.executeNode({ id: 'change-review', worker: bareWorker(() => ({ kind: 'change_review', reviewedRevision: 'rev-1', findings: [{ id: 'f1', summary: '残留问题', disposition: 'open' }], findingDisposition: 'all_closed', conclusion: { status: 'accepted', summary: 'ok' } })) }, {});
  const openFinding = runtime.evaluateAcceptance({ userDecision: { kind: 'user_decision', decision: 'approve', requestId: 'req' }, requiresRepositoryChange: true });
  assert.equal(openFinding.passed, false);
  assert.ok(openFinding.missing.includes('change_review_accepted'), `missing: ${openFinding.missing.join(', ')}`);
  // 版本不一致：reviewedRevision≠implementation candidateRevision → 不满足。
  (runtime as any).artifacts = (runtime as any).artifacts.map((a: Artifact) =>
    a.kind === 'change_review' ? { ...a, reviewedRevision: 'rev-2', findings: [] } : a,
  );
  const mismatched = runtime.evaluateAcceptance({ userDecision: { kind: 'user_decision', decision: 'approve', requestId: 'req' }, requiresRepositoryChange: true });
  assert.equal(mismatched.passed, false);
  assert.ok(mismatched.missing.includes('change_review_accepted'), `missing: ${mismatched.missing.join(', ')}`);
  // 版本一致且无 open finding → 通过。
  (runtime as any).artifacts = (runtime as any).artifacts.map((a: Artifact) =>
    a.kind === 'change_review' ? { ...a, reviewedRevision: 'rev-1', findings: [] } : a,
  );
  const satisfied = runtime.evaluateAcceptance({ userDecision: { kind: 'user_decision', decision: 'approve', requestId: 'req' }, requiresRepositoryChange: true });
  assert.equal(satisfied.passed, true);
});

// 11j. “当前有效 Artifact”：最新的 change_review 有 open finding 时，旧的已通过 review 不能凑数
test('evaluateAcceptance uses the current change_review, not a stale accepted one', async () => {
  const { store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-11j', () => 11, () => 'gen');
  await runtime.executeNode({ id: 'intake', worker: bareWorker(() => ({ kind: 'intake', summary: '白屏', overview: '登录后白屏' })) }, {});
  await runtime.executeNode({ id: 'implement', worker: bareWorker(() => ({ kind: 'implementation', artifact: { summary: 'fix', filesChanged: ['a.ts'], candidateRevision: 'rev-1' } })) }, {});
  await runtime.executeNode({ id: 'verify', worker: bareWorker(() => ({ kind: 'verification', accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1' })) }, {});
  const review = (findings: { id: string; summary: string; disposition: 'open' | 'closed' }[]) => ({
    kind: 'change_review',
    reviewedRevision: 'rev-1',
    findings,
    findingDisposition: 'all_closed',
    conclusion: { status: 'accepted', summary: 'ok' },
  });
  // 先入库一个通过的 change_review，再提交带 open finding 的最新 change_review。
  await runtime.executeNode({ id: 'change-review', worker: bareWorker(() => review([])) }, {});
  await runtime.executeNode({ id: 'change-review', worker: bareWorker(() => review([{ id: 'f2', summary: '新发现 open', disposition: 'open' }])) }, {});
  const result = runtime.evaluateAcceptance({ userDecision: { kind: 'user_decision', decision: 'approve', requestId: 'req' }, requiresRepositoryChange: true });
  assert.equal(result.passed, false);
  assert.ok(result.missing.includes('change_review_accepted'), `missing: ${result.missing.join(', ')}`);
});

// 7d. decide approve 不能通过调用方传入的 acceptance 结果绕过验证
test('decide approve ignores caller-supplied acceptance opts', async () => {
  const events: FixAuditEvent[] = [];
  const { entries, store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-7d', () => 7, () => 'gen', { auditSink: sink(events) });
  const verify = await runtime.executeNode({ id: 'verify', worker: bareWorker(() => ({ kind: 'verification', accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1' })) }, {});
  runtime.transition('WAITING_FOR_USER', verify.artifact);
  const requestId = pendingRequest(entries);
  // 调用方谎报 acceptance.passed=true，但 runtime 缺 intake → 仍拒绝（fail-closed）且不写 run_accepted。
  throwsCode(
    () => runtime.decide({ kind: 'user_decision', decision: 'approve', requestId }, { acceptance: { passed: true, missing: [] } }),
    'APPROVAL_ACCEPTANCE_NOT_MET',
  );
  assert.equal(runtime.stage, 'WAITING_FOR_USER');
  assert.ok(!events.some((event) => event.eventType === 'run_accepted'));
  assert.ok(runtime.getArtifacts().every((artifact) => artifact.kind !== 'user_decision'));
});

// 5f. 公共 transition() 不能直接进入 ACCEPTED：ACCEPTED 只允许 decide/controller 内部路径进入
test('public transition() cannot enter ACCEPTED outside the controller accept path', () => {
  const runtime = new WorkflowRuntime(makeDefinition(), emptyStore(), 'run-5f', () => 1, () => 'id');
  throwsCode(
    () => runtime.transition('ACCEPTED', { kind: 'user_decision', decision: 'approve', requestId: 'req' }),
    'ACCEPTED_TRANSITION_NOT_PERMITTED',
  );
  assert.equal(runtime.stage, 'INTAKE');
});

// 5g. 公共 transition() 没有可伪造的内部标记：即使验收全满足、阶段已到 WAITING_FOR_USER，
// 也无法绕过 pending request / approve 校验进入 ACCEPTED；唯一合法入口是 decide() 的 approve 路径。
test('public transition() cannot bypass WAITING_FOR_USER/pending/approve into ACCEPTED (only decide can complete)', async () => {
  const { entries, store } = makeStore();
  const ready = new WorkflowRuntime(makeDefinition(), store, 'run-5g', () => 5, () => 'gen');
  await ready.executeNode({ id: 'intake', worker: bareWorker(() => ({ kind: 'intake', summary: '白屏', overview: '登录后白屏' })) }, {});
  await ready.executeNode({ id: 'implement', worker: bareWorker(() => ({ kind: 'implementation', artifact: { summary: 'fix', filesChanged: ['a.ts'], candidateRevision: 'rev-1' } })) }, {});
  const verify = await ready.executeNode({ id: 'verify', worker: bareWorker(() => ({ kind: 'verification', accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1' })) }, {});
  ready.transition('WAITING_FOR_USER', verify.artifact);
  const requestId = pendingRequest(entries);
  // 验收已满足且阶段是 WAITING_FOR_USER：直接调用 transition 仍一律被拒（不存在可伪造的 internal 参数）。
  throwsCode(
    () => ready.transition('ACCEPTED', { kind: 'user_decision', decision: 'approve', requestId, candidateRevision: 'rev-1' }),
    'ACCEPTED_TRANSITION_NOT_PERMITTED',
  );
  assert.equal(ready.stage, 'WAITING_FOR_USER');
  assert.equal(entries.at(-1)!.data.stage, 'WAITING_FOR_USER');
  // 唯一合法入口是 decide()：approve 还必须匹配 pending requestId 与 run 候选版本。
  throwsCode(
    () => ready.decide({ kind: 'user_decision', decision: 'approve', requestId: 'wrong-req', candidateRevision: 'rev-1' }),
    'DECISION_REQUEST_ID_MISMATCH',
  );
  const result = ready.decide({ kind: 'user_decision', decision: 'approve', requestId, candidateRevision: 'rev-1' });
  assert.equal(result.outcome, 'accepted');
  assert.equal(ready.stage, 'ACCEPTED');
});

// 12b. restore 在 checkpoint 缺 candidateRevision 时从 implementation artifact 恢复
test('restore recovers candidateRevision from implementation artifact when checkpoint lacks it', () => {
  const stamp = (kind: string, extra: Record<string, unknown>) => ({ kind, conclusion: { status: 'accepted', summary: 'stamped by runtime' }, ...extra });
  const intake = stamp('intake', { summary: '白屏', overview: '登录后白屏' });
  const implementation = stamp('implementation', { artifact: { summary: 'fix', filesChanged: ['a.ts'], candidateRevision: 'rev-1' } });
  const verification = stamp('verification', { accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1' });
  const entries = [{
    customType: 'workflow-run',
    data: { runId: 'run-12b', stage: 'WAITING_FOR_USER', at: 1, id: 'c-12b', pendingDecisionRequest: 'req-12b', artifacts: [intake, implementation, verification] },
  }];
  const store = new PiSessionRunStore({ getEntries: () => entries }, () => {});
  const restored = WorkflowRuntime.restore(makeDefinition(), store, 'run-12b');
  assert.equal(restored.runCandidateRevision, 'rev-1');
  // 决策缺版本 → 版本绑定校验拒绝（恢复后的候选版本不丢）。
  throwsCode(() => restored.decide({ kind: 'user_decision', decision: 'approve', requestId: 'req-12b' }), 'DECISION_CANDIDATE_REVISION_MISMATCH');
  // 决策携带恢复出的版本 → 通过并进入 ACCEPTED。
  const result = restored.decide({ kind: 'user_decision', decision: 'approve', requestId: 'req-12b', candidateRevision: 'rev-1' });
  assert.equal(result.outcome, 'accepted');
  assert.equal(restored.stage, 'ACCEPTED');
});

// 13c. approve 决策的版本/原因进入 checkpoint（决策 Artifact 持久化前的最小审计事实）
test('approve writes decision reference and candidate revision into checkpoint', async () => {
  const { entries, store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-13c', () => 13, () => 'gen');
  await runtime.executeNode({ id: 'intake', worker: bareWorker(() => ({ kind: 'intake', summary: '白屏', overview: '登录后白屏' })) }, {});
  await runtime.executeNode({ id: 'implement', worker: bareWorker(() => ({ kind: 'implementation', artifact: { summary: 'fix', filesChanged: ['a.ts'], candidateRevision: 'rev-1' } })) }, {});
  const verify = await runtime.executeNode({ id: 'verify', worker: bareWorker(() => ({ kind: 'verification', accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1' })) }, {});
  runtime.transition('WAITING_FOR_USER', verify.artifact);
  const requestId = pendingRequest(entries);
  runtime.decide({ kind: 'user_decision', decision: 'approve', requestId, candidateRevision: 'rev-1' });
  const last = entries.at(-1)!.data;
  assert.equal(last.stage, 'ACCEPTED');
  assert.equal(last.decisionReference, requestId);
  assert.equal(last.decisionKind, 'approve');
  assert.equal(last.decisionCandidateRevision, 'rev-1');
  assert.equal(last.candidateRevision, 'rev-1');
});

// 13d. request_changes 决策的原因进入 checkpoint
test('request_changes writes decision reasonCode into checkpoint', async () => {
  const { entries, store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-13d', () => 13, () => 'gen');
  const verify = await runtime.executeNode({ id: 'verify', worker: bareWorker(() => ({ kind: 'verification', accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1' })) }, {});
  runtime.transition('WAITING_FOR_USER', verify.artifact);
  const requestId = pendingRequest(entries);
  runtime.decide(
    { kind: 'user_decision', decision: 'request_changes', requestId, reasonCode: 'root_cause_or_impact' },
    { reasonToStage: (reasonCode?: string) => (reasonCode === 'root_cause_or_impact' ? 'INVESTIGATING' : 'IMPLEMENTING') },
  );
  const last = entries.at(-1)!.data;
  assert.equal(last.stage, 'INVESTIGATING');
  assert.equal(last.decisionReference, requestId);
  assert.equal(last.decisionReasonCode, 'root_cause_or_impact');
});

// 5r. 验证通过只进入 WAITING_FOR_USER，runNode 不再提供自动 ACCEPTED 路径（受控终局态）。
test('runNode verification accepted leads to WAITING_FOR_USER, not ACCEPTED (no auto-accept path)', async () => {
  const { entries, store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-5r', () => 5, () => 'gen');
  await runtime.executeNode({ id: 'intake', worker: bareWorker(() => ({ kind: 'intake', summary: '白屏', overview: '登录后白屏' })) }, {});
  runtime.transition('IMPLEMENTING', { kind: 'implementation', artifact: { summary: 'fix', filesChanged: ['a.ts'], candidateRevision: 'rev-1' } });
  // 定义声明了 change_review_accepted：进入 VERIFYING 前必须有绑定当前 implementation 版本的 change_review。
  await runtime.executeNode({ id: 'change-review', worker: bareWorker(() => ({ kind: 'change_review', reviewedRevision: 'rev-1', findings: [], findingDisposition: 'all_closed', conclusion: { status: 'accepted', summary: 'ok' } })) }, {});
  runtime.transition('VERIFYING', runtime.getArtifacts().filter((a) => a.kind === 'implementation').at(-1)!);
  await runtime.runNode({ id: 'verify', worker: bareWorker(() => ({ kind: 'verification', accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1' })) }, {});
  // 验证通过→等待人工验收；ACCEPTED 只能由 decide() approve 进入。
  assert.equal(runtime.stage, 'WAITING_FOR_USER');
  const requestId = pendingRequest(entries);
  assert.ok(typeof requestId === 'string' && requestId.length > 0);
  assert.ok(!runtime.getArtifacts().some((a) => a.kind === 'user_decision'));
  // 无仓库变更（latest disposition 缺省 false）、验收满足时 approve 进入 ACCEPTED。
  const result = runtime.decide({ kind: 'user_decision', decision: 'approve', requestId, candidateRevision: 'rev-1' });
  assert.equal(result.outcome, 'accepted');
  assert.equal(runtime.stage, 'ACCEPTED');
});

// 6v. evaluateAcceptance 的 verification_accepted 强制 Verification Contract 硬门禁
//（与 Fix guardVerification 语义一致：checks 每项必须 === true；结论若带则必须是 accepted）。
test('evaluateAcceptance verification_accepted enforces the Verification Contract hard gates', () => {
  const hardDefinition = () => makeDefinition({
    acceptance: {
      requires: ['intake_accepted', 'verification_accepted', 'human_final_approval'],
      verification: {
        requiredChecks: ['original_issue', 'root_cause_cut'],
        requireToolOrTestEvidence: true,
        requireCandidateRevisionMatch: true,
        allowUnverified: false,
        requireRemainingRisk: true,
        onRejected: 'return_to_implementation',
      },
    },
  });
  const goodIntake = { kind: 'intake', summary: '白屏', overview: '登录后白屏', conclusion: { status: 'accepted', summary: 'ok' } };
  const evaluate = (verification: Record<string, unknown>) => {
    const runtime = new WorkflowRuntime(hardDefinition(), emptyStore(), 'run-6v', () => 6, () => 'gen');
    runtime.restoreArtifacts([goodIntake as Artifact, verification as Artifact]);
    return runtime.evaluateAcceptance({ userDecision: { kind: 'user_decision', decision: 'approve', requestId: 'req' }, requiresRepositoryChange: false });
  };
  const allChecksTrue = { original_issue: true, root_cause_cut: true };
  // 带 implementation 的变体：用于仓库变更路径缺版本、以及无仓库变更路径下“声明版本不得与已有 implementation 矛盾”的校验。
  const evaluateImpl = (verification: Record<string, unknown>, requiresRepositoryChange = false) => {
    const runtime = new WorkflowRuntime(hardDefinition(), emptyStore(), 'run-6v-impl', () => 6, () => 'gen');
    runtime.restoreArtifacts([
      goodIntake as Artifact,
      { kind: 'implementation', artifact: { summary: 'fix', filesChanged: ['a.ts'], candidateRevision: 'rev-1' } } as Artifact,
      verification as Artifact,
    ]);
    return runtime.evaluateAcceptance({ userDecision: { kind: 'user_decision', decision: 'approve', requestId: 'req' }, requiresRepositoryChange });
  };
  // 全满足 → 通过。candidateRevision 仓库变更路径必填；无仓库变更路径可省略（存在即可）。
  const ok = evaluate({ kind: 'verification', accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1', checks: allChecksTrue, unverified: [], remainingRisk: ['无'] });
  assert.equal(ok.passed, true);
  // accepted=false → 不通过（契约要求 accepted=false 必带结构化 failure，此处在验收层仍拒绝）。
  const notAccepted = evaluate({ kind: 'verification', accepted: false, evidence: ['test:passed'], candidateRevision: 'rev-1', checks: allChecksTrue, unverified: [], remainingRisk: ['无'], failure: { kind: 'implementation', reason: '回归失败' } });
  assert.ok(notAccepted.missing.includes('verification_accepted'));
  // 无仓库变更路径允许省略 candidateRevision：没有 implementation 可比对，不凭空要求版本。
  const noRevisionOk = evaluate({ kind: 'verification', accepted: true, evidence: ['test:passed'], checks: allChecksTrue, unverified: [], remainingRisk: ['无'] });
  assert.equal(noRevisionOk.passed, true, '无仓库变更路径缺 candidateRevision 不得阻塞 verification_accepted');
  // 仓库变更路径缺 candidateRevision → 不通过（必须绑定被验证的 implementation 版本）。
  const repoNoRevision = evaluateImpl({ kind: 'verification', accepted: true, evidence: ['test:passed'], checks: allChecksTrue, unverified: [], remainingRisk: ['无'] }, true);
  assert.ok(repoNoRevision.missing.includes('verification_accepted'));
  // 无仓库变更路径声明了与已有 implementation 矛盾的版本 → 不通过（fail-closed）。
  const staleRevision = evaluateImpl({ kind: 'verification', accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-9', checks: allChecksTrue, unverified: [], remainingRisk: ['无'] });
  assert.ok(staleRevision.missing.includes('verification_accepted'));
  // 无仓库变更路径声明与 implementation 一致的版本 → 通过。
  const alignedRevision = evaluateImpl({ kind: 'verification', accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1', checks: allChecksTrue, unverified: [], remainingRisk: ['无'] });
  assert.equal(alignedRevision.passed, true);
  // 结论信封 rejected 但 accepted=true → 不通过。
  const rejectedConclusion = evaluate({ kind: 'verification', accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1', checks: allChecksTrue, unverified: [], remainingRisk: ['无'], conclusion: { status: 'rejected', summary: 'rejected by reviewer' } });
  assert.ok(rejectedConclusion.missing.includes('verification_accepted'));
  // 必检项缺失 → 不通过（存在不等于通过）。
  const missingCheck = evaluate({ kind: 'verification', accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1', checks: { original_issue: true }, unverified: [], remainingRisk: ['无'] });
  assert.ok(missingCheck.missing.includes('verification_accepted'));
  // 必检项存在但值为 false → 不通过。
  const falseCheck = evaluate({ kind: 'verification', accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1', checks: { original_issue: true, root_cause_cut: false }, unverified: [], remainingRisk: ['无'] });
  assert.ok(falseCheck.missing.includes('verification_accepted'));
  // 缺少 tool/test/external 证据 → 不通过。
  const weakEvidence = evaluate({ kind: 'verification', accepted: true, evidence: ['log: 查看运行日志'], candidateRevision: 'rev-1', checks: allChecksTrue, unverified: [], remainingRisk: ['无'] });
  assert.ok(weakEvidence.missing.includes('verification_accepted'));
  // 存在未验证项（allowUnverified=false）→ 不通过。
  const hasUnverified = evaluate({ kind: 'verification', accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1', checks: allChecksTrue, unverified: ['极端场景未覆盖'], remainingRisk: ['无'] });
  assert.ok(hasUnverified.missing.includes('verification_accepted'));
  // requireRemainingRisk → remainingRisk 为空 → 不通过。
  const noRisk = evaluate({ kind: 'verification', accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1', checks: allChecksTrue, unverified: [], remainingRisk: [] });
  assert.ok(noRisk.missing.includes('verification_accepted'));
});

// 4d. requiresRepositoryChange 取“最新”disposition：旧 false 不得覆盖新 true（repositoryChangeRequires 不得被绕过）。
test('decide uses the latest disposition: old false / new true forces repository-change markers; reversed order does not', async () => {
  const runWithDispositions = async (runId: string, first: boolean, second: boolean) => {
    const { entries, store } = makeStore();
    const runtime = new WorkflowRuntime(makeDefinition(), store, runId, () => runId.length, () => 'gen');
    await runtime.executeNode({ id: 'intake', worker: bareWorker(() => ({ kind: 'intake', summary: '白屏', overview: '登录后白屏' })) }, {});
    await runtime.executeNode({ id: 'disposition', worker: bareWorker(() => ({ kind: 'disposition', requiresRepositoryChange: first, dispositionType: 'remediation', minimalScope: 'a.ts', risks: [], verificationTarget: 'tests', conclusion: { status: 'accepted', summary: 'first' } })) }, {});
    await runtime.executeNode({ id: 'disposition', worker: bareWorker(() => ({ kind: 'disposition', requiresRepositoryChange: second, dispositionType: 'remediation', minimalScope: 'a.ts', risks: [], verificationTarget: 'tests', conclusion: { status: 'accepted', summary: 'second' } })) }, {});
    const verify = await runtime.executeNode({ id: 'verify', worker: bareWorker(() => ({ kind: 'verification', accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1' })) }, {});
    runtime.transition('WAITING_FOR_USER', verify.artifact);
    return { runtime, entries, requestId: pendingRequest(entries) };
  };

  // 旧 false / 新 true：按最新处置强制仓库变更标记组，approve 被拒（不能因旧 false 绕过）。
  const { runtime: repo, requestId: repoReq } = await runWithDispositions('run-4d', false, true);
  assert.equal(repo.dispositionRequiresRepositoryChange(), true);
  throwsCode(
    () => repo.decide({ kind: 'user_decision', decision: 'approve', requestId: repoReq, candidateRevision: 'rev-1' }),
    'APPROVAL_ACCEPTANCE_NOT_MET',
  );
  assert.equal(repo.stage, 'WAITING_FOR_USER');

  // 旧 true / 新 false：按最新处置不要求仓库变更标记组，验收通过 → ACCEPTED。
  const { runtime: noRepo, requestId: noRepoReq } = await runWithDispositions('run-4e', true, false);
  assert.equal(noRepo.dispositionRequiresRepositoryChange(), false);
  const result = noRepo.decide({ kind: 'user_decision', decision: 'approve', requestId: noRepoReq, candidateRevision: 'rev-1' });
  assert.equal(result.outcome, 'accepted');
  assert.equal(noRepo.stage, 'ACCEPTED');
});

// 5c. change_review 在仓库变更路径必须绑定当前 implementation 的 candidateRevision（缺/不一致不得通过）。
test('changeReviewBindsImplementation binds reviewedRevision to the current implementation candidateRevision on repo-change path', async () => {
  const { store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-5c', () => 5, () => 'gen');
  // 无仓库变更路径：不凭空要求绑定。
  assert.equal(runtime.changeReviewBindsImplementation(false), true);
  // 仓库变更路径但无 change_review → false（缺失不得通过）。
  assert.equal(runtime.changeReviewBindsImplementation(true), false);
  await runtime.executeNode({ id: 'implement', worker: bareWorker(() => ({ kind: 'implementation', artifact: { summary: 'fix', filesChanged: ['a.ts'], candidateRevision: 'rev-1' } })) }, {});
  // 仓库变更路径有 implementation 但缺 change_review → false。
  assert.equal(runtime.changeReviewBindsImplementation(true), false);
  await runtime.executeNode({ id: 'review', worker: bareWorker(() => ({ kind: 'change_review', reviewedRevision: 'rev-2', findings: [], findingDisposition: 'all_closed', conclusion: { status: 'accepted', summary: 'mismatched revision' } })) }, {});
  // reviewedRevision 与 implementation candidateRevision 不一致 → false。
  assert.equal(runtime.changeReviewBindsImplementation(true), false);
  await runtime.executeNode({ id: 'review', worker: bareWorker(() => ({ kind: 'change_review', reviewedRevision: 'rev-1', findings: [], findingDisposition: 'all_closed', conclusion: { status: 'accepted', summary: 'bound revision' } })) }, {});
  // reviewedRevision 一致 → true。
  assert.equal(runtime.changeReviewBindsImplementation(true), true);
});

// 5x. change_review_accepted 在仓库变更路径同样强制版本绑定（缺失即不满足 marker）。
test('evaluateAcceptance change_review_accepted fails on the repo-change path when reviewedRevision is missing or mismatched', async () => {
  const { store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-5x', () => 5, () => 'gen');
  await runtime.executeNode({ id: 'implement', worker: bareWorker(() => ({ kind: 'implementation', artifact: { summary: 'fix', filesChanged: ['a.ts'], candidateRevision: 'rev-1' } })) }, {});
  await runtime.executeNode({ id: 'review', worker: bareWorker(() => ({ kind: 'change_review', findings: [], findingDisposition: 'all_closed', conclusion: { status: 'accepted', summary: 'no reviewedRevision' } })) }, {});
  const missing = runtime.evaluateAcceptance({ requiresRepositoryChange: true });
  assert.ok(missing.missing.includes('change_review_accepted'));
  await runtime.executeNode({ id: 'review', worker: bareWorker(() => ({ kind: 'change_review', reviewedRevision: 'rev-999', findings: [], findingDisposition: 'all_closed', conclusion: { status: 'accepted', summary: 'mismatch' } })) }, {});
  const mismatched = runtime.evaluateAcceptance({ requiresRepositoryChange: true });
  assert.ok(mismatched.missing.includes('change_review_accepted'));
  await runtime.executeNode({ id: 'review', worker: bareWorker(() => ({ kind: 'change_review', reviewedRevision: 'rev-1', findings: [], findingDisposition: 'all_closed', conclusion: { status: 'accepted', summary: 'match' } })) }, {});
  const matched = runtime.evaluateAcceptance({ requiresRepositoryChange: true });
  assert.ok(!matched.missing.includes('change_review_accepted'));
});
// ============================================================
// 本轮 P1 修复补测：版本绑定在 Runtime 控制面生效、conclusion 不伪造、
// restore 交叉校验、continue_verification 不被历史 Artifact 污染。
// ============================================================

// 3. 仓库变更版本绑定必须在 Runtime 控制面进入 VERIFYING 前生效：
// 缺 change_review 或 reviewedRevision 与 implementation 不一致都不得进入 VERIFYING。
test('transition to VERIFYING requires change_review bound to the implementation revision (runtime control plane)', async () => {
  const { entries, store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-3v', () => 3, () => 'gen');
  const disposition = (await runtime.executeNode({ id: 'disposition', worker: bareWorker(() => ({ kind: 'disposition', dispositionType: 'remediation', requiresRepositoryChange: true, minimalScope: 'a.ts', risks: [], verificationTarget: 'tests', conclusion: { status: 'accepted', summary: 'plan' } })) }, {})).artifact;
  // 仓库变更处置路径必须经过配对 change_plan_review（Runtime 硬门禁）才能进入 IMPLEMENTING：
  // 评审必须由 runReview 记账周期产出（直传 executeNode 的 cplan 没有账本周期，不得放行）。
  await runtime.runReview(
    'change_plan_review',
    [{ id: 'change_plan_review', worker: bareWorker(() => ({ kind: 'change_plan_review', rootCauseAlignment: true, changedScope: 'a.ts', risks: [], compatibility: [], verification: [], rollback: [], findings: [], conclusion: { status: 'accepted', summary: 'plan review passed' } }), 'cplan-reviewer') }],
    { reviewers: [{ model: 'inherit' }], mode: 'parallel', requiredApprovals: 1, requireIndependentWorker: true, excludeNodes: ['disposition'], onRejected: 'return_to_disposition' },
    { reviewedNodeId: 'disposition', reviewArtifactKind: 'change_plan_review' },
  );
  runtime.transition('IMPLEMENTING', disposition);
  const impl = await runtime.executeNode(
    { id: 'implement', worker: bareWorker(() => ({ kind: 'implementation', artifact: { summary: 'fix', filesChanged: ['a.ts'], candidateRevision: 'rev-1' } })) },
    {},
  );
  // 缺 change_review：不得进入 VERIFYING（不能只靠 Extension 手工检查）。
  throwsCode(() => runtime.transition('VERIFYING', impl.artifact), 'CHANGE_REVIEW_NOT_BOUND');
  assert.equal(runtime.stage, 'IMPLEMENTING');
  // change_review 已存在但绑定错误版本：同样不得进入 VERIFYING。
  await runtime.executeNode(
    { id: 'change-review', worker: bareWorker(() => ({ kind: 'change_review', reviewedRevision: 'rev-999', findings: [], findingDisposition: 'all_closed', conclusion: { status: 'accepted', summary: 'mismatched' } })) },
    {},
  );
  throwsCode(() => runtime.transition('VERIFYING', impl.artifact), 'CHANGE_REVIEW_NOT_BOUND');
  assert.equal(runtime.stage, 'IMPLEMENTING');
  // 绑定当前 implementation 版本后允许进入 VERIFYING。
  await runtime.executeNode(
    { id: 'change-review', worker: bareWorker(() => ({ kind: 'change_review', reviewedRevision: 'rev-1', findings: [], findingDisposition: 'all_closed', conclusion: { status: 'accepted', summary: 'bound' } })) },
    {},
  );
  runtime.transition('VERIFYING', impl.artifact);
  assert.equal(runtime.stage, 'VERIFYING');
});

// 4. Runtime 不得给缺少真实 conclusion 的 Artifact 自动注入 accepted：
// v2 定义下 worker 产出缺 conclusion 的验证 Artifact 直接被拒，不入库、记 artifact_rejected。
test('executeNode rejects artifacts without a real conclusion under requiresArtifactConclusion (no auto-injected accepted)', async () => {
  const events: FixAuditEvent[] = [];
  const runtime = new WorkflowRuntime(makeDefinition({ requiresArtifactConclusion: true }), emptyStore(), 'run-4c', () => 4, () => 'gen', { auditSink: sink(events) });
  // accepted=true 但缺 conclusion：业务结论未给出，Runtime 不伪造。
  await rejectsCode(
    () => runtime.executeNode({ id: 'verify', worker: bareWorker(() => ({ kind: 'verification', accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1' })) }, {}),
    'MISSING_ARTIFACT_CONCLUSION',
  );
  assert.equal(runtime.getArtifacts().length, 0, '被拒 artifact 不得入库');
  const rejected = events.filter((event) => event.eventType === 'artifact_rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]!.payload.code, 'MISSING_ARTIFACT_CONCLUSION');
  assert.equal(rejected[0]!.payload.nodeId, 'verify');
});

// 4b. 同规则对 investigation 同样生效：缺 conclusion 不静默按 accepted 处理。
test('executeNode rejects investigation without conclusion under v2 (no runtime-injected accepted)', async () => {
  const runtime = new WorkflowRuntime(makeDefinition({ requiresArtifactConclusion: true }), emptyStore(), 'run-4i', () => 4, () => 'gen');
  await rejectsCode(
    () => runtime.executeNode({ id: 'investigate', worker: bareWorker(() => ({ kind: 'investigation', route: 'local_fix', rootCause: 'cause', evidence: ['trace'] })) }, {}),
    'MISSING_ARTIFACT_CONCLUSION',
  );
});

// 5. restore 对 checkpoint artifacts 做合同/版本交叉校验：
// 合同违规的 malformed artifact 拒绝恢复。
test('restore rejects malformed checkpoint artifacts (contract violation)', () => {
  const entries = [{ customType: 'workflow-run', data: { runId: 'run-5m', schemaVersion: 1, stage: 'VERIFYING', at: 1, id: 'c-malformed', artifacts: [{ kind: 'verification', accepted: 'no', evidence: ['test:failed'], candidateRevision: 'rev-1' }] } }];
  const store = new PiSessionRunStore({ getEntries: () => entries }, () => {});
  throwsCode(() => WorkflowRuntime.restore(makeDefinition(), store, 'run-5m'), 'INVALID_CHECKPOINT_ARTIFACT');
});

// 5b. 仓库变更路径的 checkpoint artifacts 版本不一致（implementation/change_review/verification）拒绝恢复。
test('restore rejects repository-change checkpoints whose artifacts bind inconsistent revisions', () => {
  const stamp = (kind: string, extra: Record<string, unknown>) => ({ kind, conclusion: { status: 'accepted', summary: 'stamped' }, ...extra });
  const entries = [{ customType: 'workflow-run', data: {
    runId: 'run-5r2', schemaVersion: 1, stage: 'WAITING_FOR_USER', at: 1, id: 'c-skew', pendingDecisionRequest: 'req-5r2',
    artifacts: [
      stamp('disposition', { dispositionType: 'remediation', requiresRepositoryChange: true, minimalScope: 'a.ts', risks: [], verificationTarget: 't' }),
      stamp('implementation', { artifact: { summary: 'fix', filesChanged: ['a.ts'], candidateRevision: 'rev-1' } }),
      stamp('change_review', { reviewedRevision: 'rev-2', findings: [], findingDisposition: 'all_closed' }),
      stamp('verification', { accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-2' }),
    ],
  } }];
  const store = new PiSessionRunStore({ getEntries: () => entries }, () => {});
  throwsCode(() => WorkflowRuntime.restore(makeDefinition(), store, 'run-5r2'), 'CANDIDATE_REVISION_MISMATCH');
});

// 5c. 缺关键 workflow/policy/schema 元数据的旧 checkpoint 可兼容读取，但标记不完整，
// 不能参与 v2 Acceptance（approve 必须失败）。
test('restore marks legacy checkpoints incomplete so they cannot pass v2 acceptance', () => {
  const { entries, store } = makeStore();
  // 旧 checkpoint：无 schemaVersion/workflowVersion/policyDigest，仍可读取。
  entries.push({ customType: 'workflow-run', data: { runId: 'run-5l', stage: 'WAITING_FOR_USER', at: 1, id: 'c-legacy', pendingDecisionRequest: 'legacy-req' } });
  const restored = WorkflowRuntime.restore(makeDefinition({ requiresArtifactConclusion: true }), store, 'run-5l', { expectedWorkflowVersion: 'v1', expectedPolicyDigest: 'd1' });
  assert.equal(restored.stage, 'WAITING_FOR_USER');
  // 缺关键元数据 → checkpointIncomplete → decide approve 被拒（checkpoint_complete 未满足）。
  throwsCode(
    () => restored.decide({ kind: 'user_decision', decision: 'approve', requestId: 'legacy-req' }),
    'APPROVAL_ACCEPTANCE_NOT_MET',
  );
  assert.equal(restored.stage, 'WAITING_FOR_USER');
});

// 7. continue_verification 只能依据“当前有效”的 verification failure.kind=configuration，
// 历史配置失败 Artifact 不得污染新的验收等待（最新验证为 accepted 时不可用）。
test('continue_verification uses the current valid verification, not a stale configuration failure', async () => {
  const { entries, store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-7p', () => 7, () => 'gen');
  // 历史配置类失败先入库。
  await runtime.executeNode(
    { id: 'verify', worker: bareWorker(() => ({ kind: 'verification', accepted: false, evidence: ['event:old-config'], candidateRevision: 'rev-1', failure: { kind: 'configuration', reason: '旧配置失败' } })) },
    {},
  );
  // 当前有效的验证为验收通过。
  const passed = await runtime.executeNode(
    { id: 'verify', worker: bareWorker(() => ({ kind: 'verification', accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1' })) },
    {},
  );
  runtime.transition('WAITING_FOR_USER', passed.artifact);
  const requestId = pendingRequest(entries);
  // 不被历史配置失败污染：continue_verification 不可用。
  throwsCode(() => runtime.decide({ kind: 'user_decision', decision: 'continue_verification', requestId }), 'CONTINUE_VERIFICATION_NOT_AVAILABLE');
  assert.equal(runtime.stage, 'WAITING_FOR_USER');
});

// ============================================================
// Runtime Review 门禁补测：
// 1) bare Worker Artifact 的 unverified 保留 + allowUnverified=false 验收拒绝；
// 2) findingDisposition=all_closed 不能掩盖缺失/非正式 disposition；
// 3) Investigation Review 必须绑定当前 investigation（id 匹配或成对产生）；
// 4) 具备 Fix 评审语义的 Definition 不能通过裸 runNode()/transition() 绕过 Review 门禁。
// ============================================================

// 具备 Fix-v2 评审语义的测试定义：acceptance 声明 investigation_review_accepted /
// change_review_accepted（与 fixDefinitionV2 的语义一致，但不跨包依赖 fix 包）。
const fixSemanticsDefinition = () => makeDefinition({
  acceptance: {
    requires: ['intake_accepted', 'investigation_review_accepted', 'verification_accepted', 'human_final_approval'],
    repositoryChangeRequires: ['change_review_accepted'],
  },
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

// 1a. executeNode 对 bare Artifact 不得无条件写 unverified: [] 覆盖 worker 提交的值。
test('executeNode preserves worker-supplied unverified on bare artifacts', async () => {
  const runtime = new WorkflowRuntime(makeDefinition(), emptyStore(), 'run-uv1', () => 1, () => 'gen');
  const { artifact } = await runtime.executeNode(
    { id: 'verify', worker: bareWorker(() => ({ kind: 'verification', accepted: true, evidence: ['test:passed'], unverified: ['极端场景未覆盖'] })) },
    {},
  );
  assert.deepEqual((artifact as { unverified?: string[] }).unverified, ['极端场景未覆盖'], 'worker 显式提交的 unverified 必须保留');
  // 缺省时仍补空数组（信封合同要求 unverified 为数组）。
  const runtime2 = new WorkflowRuntime(makeDefinition(), emptyStore(), 'run-uv2', () => 1, () => 'gen');
  const bare = await runtime2.executeNode(
    { id: 'verify', worker: bareWorker(() => ({ kind: 'verification', accepted: true, evidence: ['test:passed'] })) },
    {},
  );
  assert.deepEqual((bare.artifact as { unverified?: string[] }).unverified, []);
});

// 1b. bare verification 带显式非空 unverified 时，allowUnverified=false 的 Verification Acceptance 必须失败。
test('acceptance fails a verification with explicit unverified when allowUnverified=false (bare artifact path)', async () => {
  const definition = () => makeDefinition({
    acceptance: {
      requires: ['intake_accepted', 'verification_accepted', 'human_final_approval'],
      verification: {
        requiredChecks: ['original_issue'],
        requireToolOrTestEvidence: true,
        requireCandidateRevisionMatch: false,
        allowUnverified: false,
        requireRemainingRisk: false,
        onRejected: 'return_to_implementation',
      },
    },
  });
  // bare Artifact 路径：unverified 由 executeNode 原样保留。
  const runtime = new WorkflowRuntime(definition(), emptyStore(), 'run-uv3', () => 3, () => 'gen');
  await runtime.executeNode({ id: 'intake', worker: bareWorker(() => ({ kind: 'intake', summary: '白屏', overview: '登录后白屏' })) }, {});
  await runtime.executeNode(
    { id: 'verify', worker: bareWorker(() => ({ kind: 'verification', accepted: true, evidence: ['test:passed'], checks: { original_issue: true }, unverified: ['极端场景未覆盖'] })) },
    {},
  );
  const rejected = runtime.evaluateAcceptance({ userDecision: { kind: 'user_decision', decision: 'approve', requestId: 'req' } });
  assert.equal(rejected.passed, false);
  assert.ok(rejected.missing.includes('verification_accepted'), `missing: ${rejected.missing.join(', ')}`);
  // 同一契约下无 unverified 的验证通过。
  await runtime.executeNode(
    { id: 'verify', worker: bareWorker(() => ({ kind: 'verification', accepted: true, evidence: ['test:passed'], checks: { original_issue: true } })) },
    {},
  );
  const accepted = runtime.evaluateAcceptance({ userDecision: { kind: 'user_decision', decision: 'approve', requestId: 'req' } });
  assert.ok(!accepted.missing.includes('verification_accepted'), `missing: ${accepted.missing.join(', ')}`);
});

// 2a. findingDisposition=all_closed 不能掩盖缺少正式 disposition 的 finding：runReview 不计通过。
test('runReview does not count a change_review whose findings lack a formal disposition', async () => {
  const { store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-fd1', () => 1, () => 'id');
  const reviewer: NodeDefinition = {
    id: 'reviewer-a',
    worker: bareWorker(() => ({ kind: 'change_review', reviewedRevision: 'rev-1', findings: [{ id: 'f1', summary: '缺少处置结论的 finding' }], findingDisposition: 'all_closed', conclusion: { status: 'accepted', summary: 'ok' } }), 'reviewer-a'),
  };
  const result = await runtime.runReview(
    'review-node',
    [reviewer],
    { reviewers: [{ model: 'inherit' }], mode: 'parallel', requiredApprovals: 1, requireIndependentWorker: true, excludeNodes: ['implement'], onRejected: 'return_to_implementation' },
    { reviewedNodeId: 'implement', reviewArtifactKind: 'change_review' },
  );
  assert.equal(result.approvals, 0);
  assert.equal(result.passed, false);
  // open 与 accepted_with_note 之外的非法值同样不计通过。
  const openReviewer: NodeDefinition = {
    id: 'reviewer-b',
    worker: bareWorker(() => ({ kind: 'change_review', reviewedRevision: 'rev-1', findings: [{ id: 'f1', summary: '未处理', disposition: 'open' }], findingDisposition: 'all_closed', conclusion: { status: 'accepted', summary: 'ok' } }), 'reviewer-b'),
  };
  const openResult = await runtime.runReview(
    'review-node',
    [openReviewer],
    { reviewers: [{ model: 'inherit' }], mode: 'parallel', requiredApprovals: 1, requireIndependentWorker: true, excludeNodes: ['implement'], onRejected: 'return_to_implementation' },
    { reviewedNodeId: 'implement', reviewArtifactKind: 'change_review' },
  );
  assert.equal(openResult.passed, false);
});

// 2b. 同一规则在 Runtime 控制面：IMPLEMENTING -> VERIFYING 抛 CHANGE_REVIEW_NOT_PASSED；
// acceptance 的 change_review_accepted 同样不通过。
test('runtime hard gate and acceptance reject change_review findings without a formal disposition', async () => {
  const runtime = new WorkflowRuntime(fixSemanticsDefinition(), emptyStore(), 'run-fd2', () => 2, () => 'gen');
  await runtime.executeNode({ id: 'implement', worker: bareWorker(() => ({ kind: 'implementation', artifact: { summary: 'fix', filesChanged: ['a.ts'], candidateRevision: 'rev-1' } })) }, {});
  runtime.transition('IMPLEMENTING', runtime.getArtifacts().at(-1)!);
  // finding 缺 disposition：进入 VERIFYING 被拒（CHANGE_REVIEW_NOT_PASSED）。
  await runtime.executeNode({ id: 'change-review', worker: bareWorker(() => creviewOf({ findings: [{ id: 'f1', summary: '缺少处置结论' }] })) }, {});
  throwsCode(() => runtime.transition('VERIFYING', { kind: 'implementation', artifact: { summary: 'fix', filesChanged: ['a.ts'], candidateRevision: 'rev-1' } }), 'CHANGE_REVIEW_NOT_PASSED');
  assert.ok(runtime.evaluateAcceptance({ requiresRepositoryChange: true }).missing.includes('change_review_accepted'));
  // finding disposition=open：同样被拒。
  await runtime.executeNode({ id: 'change-review', worker: bareWorker(() => creviewOf({ findings: [{ id: 'f1', summary: '未处理', disposition: 'open' }] })) }, {});
  throwsCode(() => runtime.transition('VERIFYING', { kind: 'implementation', artifact: { summary: 'fix', filesChanged: ['a.ts'], candidateRevision: 'rev-1' } }), 'CHANGE_REVIEW_NOT_PASSED');
  // disposition=accepted_with_note：允许进入 VERIFYING（使用已归档的当前 implementation）。
  await runtime.executeNode({ id: 'change-review', worker: bareWorker(() => creviewOf({ findings: [{ id: 'f1', summary: '备注后接受', disposition: 'accepted_with_note' }] })) }, {});
  runtime.transition('VERIFYING', runtime.getArtifacts().filter((a) => a.kind === 'implementation').at(-1)!);
  assert.equal(runtime.stage, 'VERIFYING');
});

// 3a. Investigation Review 必须绑定当前 investigation：复用旧 investigation 的 stale review 不得离开 INVESTIGATING。
test('investigation review gate rejects a stale review produced before the current investigation', async () => {
  const runtime = new WorkflowRuntime(fixSemanticsDefinition(), emptyStore(), 'run-ir1', () => 3, () => 'gen');
  await runtime.executeNode({ id: 'investigate', worker: bareWorker(() => investigationOf()) }, {});
  runtime.transition('INVESTIGATING', runtime.getArtifacts().at(-1)!);
  await runtime.executeNode({ id: 'investigation_review', worker: bareWorker(() => ireviewOf()) }, {});
  await runtime.executeNode({ id: 'investigate', worker: bareWorker(() => investigationOf({ rootCause: 'new cause' })) }, {});
  // 新 investigation 尚未走 transition 归位：先 INVESTIGATING（重开调查），再尝试离开。
  // 当前 investigation 之后没有新 review：INVESTIGATING -> DISPOSITION 必须被拒。
  const current = runtime.getArtifacts().filter((a) => a.kind === 'investigation').at(-1)!;
  throwsCode(() => runtime.transition('DISPOSITION', current), 'INVESTIGATION_REVIEW_NOT_BOUND');
  assert.equal(runtime.stage, 'INVESTIGATING');
  // Acceptance 也不认 stale review。
  assert.ok(runtime.evaluateAcceptance({}).missing.includes('investigation_review_accepted'));
  // 补交与当前 investigation 成对的 review 后放行。
  await runtime.executeNode({ id: 'investigation_review', worker: bareWorker(() => ireviewOf({ rootCauseConclusion: 'new cause confirmed' })) }, {});
  runtime.transition('DISPOSITION', current);
  assert.equal(runtime.stage, 'DISPOSITION');
});

// 3b. 当前 investigation 有 id 时，review.targetArtifactId 必须显式匹配；
// review 声明了 target 而当前 investigation 无 id 同样视为 stale。
test('investigation review gate requires targetArtifactId to match the current investigation id', async () => {
  const runtime = new WorkflowRuntime(fixSemanticsDefinition(), emptyStore(), 'run-ir2', () => 4, () => 'gen');
  await runtime.executeNode({ id: 'investigate', worker: bareWorker(() => investigationOf({ id: 'inv-2' })) }, {});
  runtime.transition('INVESTIGATING', runtime.getArtifacts().at(-1)!);
  // target 指向旧 investigation → 拒绝。
  await runtime.executeNode({ id: 'investigation_review', worker: bareWorker(() => ireviewOf({ targetArtifactId: 'inv-1' })) }, {});
  const investigation = runtime.getArtifacts().filter((a) => a.kind === 'investigation').at(-1)!;
  throwsCode(() => runtime.transition('DISPOSITION', investigation), 'INVESTIGATION_REVIEW_NOT_BOUND');
  // investigation 有 id 但 review 未声明 target → 无法证明匹配，fail-closed。
  await runtime.executeNode({ id: 'investigation_review', worker: bareWorker(() => ireviewOf()) }, {});
  throwsCode(() => runtime.transition('DISPOSITION', investigation), 'INVESTIGATION_REVIEW_NOT_BOUND');
  // target 显式匹配当前 investigation id → 放行。
  await runtime.executeNode({ id: 'investigation_review', worker: bareWorker(() => ireviewOf({ targetArtifactId: 'inv-2' })) }, {});
  runtime.transition('DISPOSITION', investigation);
  assert.equal(runtime.stage, 'DISPOSITION');
  // investigation 无 id 时保留成对产生路径：review 晚于 investigation 即配对。
  const runtime2 = new WorkflowRuntime(fixSemanticsDefinition(), emptyStore(), 'run-ir3', () => 5, () => 'gen');
  await runtime2.executeNode({ id: 'investigate', worker: bareWorker(() => investigationOf()) }, {});
  await runtime2.executeNode({ id: 'investigation_review', worker: bareWorker(() => ireviewOf()) }, {});
  assert.equal(runtime2.investigationReviewBindsCurrentInvestigation(), true);
  const noIdInvestigation = runtime2.getArtifacts().filter((a) => a.kind === 'investigation').at(-1)!;
  runtime2.transition('DISPOSITION', noIdInvestigation);
  assert.equal(runtime2.stage, 'DISPOSITION');
});

// 4. 具备 Fix 评审语义的 Definition 不能通过裸 runNode 绕过 investigation_review：
// INVESTIGATING 下直接提交 local_fix investigation 不得进入 IMPLEMENTING。
test('runNode cannot bypass the investigation review gate under Fix review semantics', async () => {
  const { store } = makeStore();
  const runtime = new WorkflowRuntime(fixSemanticsDefinition(), store, 'run-bp1', () => 6, () => 'gen');
  await runtime.executeNode({ id: 'intake', worker: bareWorker(() => ({ kind: 'intake', summary: '白屏', overview: '登录后白屏' })) }, {});
  runtime.transition('INVESTIGATING', runtime.getArtifacts().at(-1)!);
  await rejectsCode(
    () => runtime.runNode({ id: 'investigate', worker: bareWorker(() => investigationOf()) }, {}),
    'INVESTIGATION_REVIEW_NOT_BOUND',
  );
  assert.equal(runtime.stage, 'INVESTIGATING');
  // runNode 拒绝后未归档 investigation；补走 executeNode + 配对评审后 transition 放行到 DISPOSITION。
  const investigation = (await runtime.executeNode({ id: 'investigate', worker: bareWorker(() => investigationOf()) }, {})).artifact;
  await runtime.executeNode({ id: 'investigation_review', worker: bareWorker(() => ireviewOf()) }, {});
  runtime.transition('DISPOSITION', investigation);
  assert.equal(runtime.stage, 'DISPOSITION');
});

// 4b. 具备 Fix 评审语义且无 disposition 时，IMPLEMENTING -> VERIFYING 仍要求当前有效、
// 通过、all_closed 且版本绑定的 change_review；无仓库变更（无 implementation）不凭空要求 candidate revision。
test('change review gate applies without a disposition under Fix review semantics (no revision required without implementation)', async () => {
  const runtime = new WorkflowRuntime(fixSemanticsDefinition(), emptyStore(), 'run-bp2', () => 7, () => 'gen');
  // 无 implementation（无仓库变更）：change_review 通过即可进入 VERIFYING，不凭空要求 reviewedRevision 匹配。
  runtime.transition('IMPLEMENTING');
  await runtime.executeNode({ id: 'change-review', worker: bareWorker(() => creviewOf({ reviewedRevision: undefined })) }, {});
  runtime.transition('VERIFYING');
  assert.equal(runtime.stage, 'VERIFYING');
  // transition 直接携带未归档的 fresh implementation 时同样视为当前候选：review 必须绑定其版本，
  // 未绑定（含 reviewedRevision 缺失）不得放行（公共 runNode 路径的 fail-closed 行为）。
  const runtimeF = new WorkflowRuntime(fixSemanticsDefinition(), emptyStore(), 'run-bp2f', () => 12, () => 'gen');
  runtimeF.transition('IMPLEMENTING');
  await runtimeF.executeNode({ id: 'change-review', worker: bareWorker(() => creviewOf({ reviewedRevision: undefined })) }, {});
  throwsCode(
    () => runtimeF.transition('VERIFYING', { kind: 'implementation', artifact: { summary: 'fix', filesChanged: ['a.ts'], candidateRevision: 'rev-1' } }),
    'CHANGE_REVIEW_NOT_BOUND',
  );
  // 有 implementation 时必须绑定其版本：不一致拒绝。
  const runtime2 = new WorkflowRuntime(fixSemanticsDefinition(), emptyStore(), 'run-bp3', () => 8, () => 'gen');
  await runtime2.executeNode({ id: 'implement', worker: bareWorker(() => ({ kind: 'implementation', artifact: { summary: 'fix', filesChanged: ['a.ts'], candidateRevision: 'rev-1' } })) }, {});
  runtime2.transition('IMPLEMENTING', runtime2.getArtifacts().at(-1)!);
  await runtime2.executeNode({ id: 'change-review', worker: bareWorker(() => creviewOf({ reviewedRevision: 'rev-9' })) }, {});
  throwsCode(() => runtime2.transition('VERIFYING', runtime2.getArtifacts().filter((a) => a.kind === 'implementation').at(-1)!), 'CHANGE_REVIEW_NOT_BOUND');
  assert.equal(runtime2.stage, 'IMPLEMENTING');
  await runtime2.executeNode({ id: 'change-review', worker: bareWorker(() => creviewOf()) }, {});
  runtime2.transition('VERIFYING', runtime2.getArtifacts().filter((a) => a.kind === 'implementation').at(-1)!);
  assert.equal(runtime2.stage, 'VERIFYING');
});

// ============================================================
// 本轮 code_reviewer P1 补测：fresh artifact 不能被旧同 kind Review 放行。
// ============================================================

// 4c. investigation_review 的 targetArtifactId 可被重复声明/伪造：即使 id 显式匹配，
// 产生于当前 investigation 之前的旧 review 也不得放行 fresh investigation（产生周期对应）。
test('investigation review gate rejects a stale review whose targetArtifactId matches a re-declared investigation id', async () => {
  const runtime = new WorkflowRuntime(fixSemanticsDefinition(), emptyStore(), 'run-ir4', () => 9, () => 'gen');
  await runtime.executeNode({ id: 'investigate', worker: bareWorker(() => investigationOf({ id: 'inv-1' })) }, {});
  runtime.transition('INVESTIGATING', runtime.getArtifacts().at(-1)!);
  await runtime.executeNode({ id: 'investigation_review', worker: bareWorker(() => ireviewOf({ targetArtifactId: 'inv-1' })) }, {});
  // 重开调查：fresh investigation 重复声明同一 id（同名 id 可伪造，不构成配对证明）。
  await runtime.executeNode({ id: 'investigate', worker: bareWorker(() => investigationOf({ id: 'inv-1', rootCause: 'fresh cycle' })) }, {});
  const fresh = runtime.getArtifacts().filter((a) => a.kind === 'investigation').at(-1)!;
  // 旧 review 产生于当前 investigation 之前：即使 targetArtifactId 匹配也必须拒绝。
  throwsCode(() => runtime.transition('DISPOSITION', fresh), 'INVESTIGATION_REVIEW_NOT_BOUND');
  assert.equal(runtime.stage, 'INVESTIGATING');
  assert.ok(runtime.evaluateAcceptance({}).missing.includes('investigation_review_accepted'));
  // 补交晚于当前 investigation 的新 review（id 显式匹配）后放行。
  await runtime.executeNode({ id: 'investigation_review', worker: bareWorker(() => ireviewOf({ targetArtifactId: 'inv-1', rootCauseConclusion: 'fresh cycle confirmed' })) }, {});
  runtime.transition('DISPOSITION', fresh);
  assert.equal(runtime.stage, 'DISPOSITION');
});

// 2c. fresh implementation 不能被旧同 kind change_review 放行：验证失败回流后重交
// 同 candidateRevision 的实现，旧 review 虽版本匹配但产生于其之前，transition/runNode 均必须拒绝。
test('a fresh implementation with the same candidateRevision is not released by an older change_review (transition + runNode)', async () => {
  const implOf = () => ({ kind: 'implementation', artifact: { summary: 'fix', filesChanged: ['a.ts'], candidateRevision: 'rev-1' } });
  const runtime = new WorkflowRuntime(fixSemanticsDefinition(), emptyStore(), 'run-fr1', () => 10, () => 'gen');
  await runtime.executeNode({ id: 'implement', worker: bareWorker(() => implOf()) }, {});
  runtime.transition('IMPLEMENTING', runtime.getArtifacts().at(-1)!);
  await runtime.executeNode({ id: 'change-review', worker: bareWorker(() => creviewOf()) }, {});
  runtime.transition('VERIFYING', runtime.getArtifacts().filter((a) => a.kind === 'implementation').at(-1)!);
  // 验证失败回流 IMPLEMENTING，重交同版本 fresh implementation。
  runtime.transition('IMPLEMENTING');
  await runtime.executeNode({ id: 'implement', worker: bareWorker(() => implOf()) }, {});
  const freshImpl = runtime.getArtifacts().filter((a) => a.kind === 'implementation').at(-1)!;
  // 旧 change_review 版本匹配但产生于 fresh implementation 之前：transition 必须拒绝。
  throwsCode(() => runtime.transition('VERIFYING', freshImpl), 'CHANGE_REVIEW_NOT_BOUND');
  assert.equal(runtime.stage, 'IMPLEMENTING');
  // Acceptance 同样不认旧 review（仓库变更路径）。
  assert.ok(runtime.evaluateAcceptance({ requiresRepositoryChange: true }).missing.includes('change_review_accepted'));
  // 公共 runNode 入口同样被拒（不能绕过 Runtime 门禁）。
  await rejectsCode(
    () => runtime.runNode({ id: 'implement', worker: bareWorker(() => implOf()) }, {}),
    'CHANGE_REVIEW_NOT_BOUND',
  );
  assert.equal(runtime.stage, 'IMPLEMENTING');
  // 重新评审（晚于 fresh implementation 产生）后放行。
  await runtime.executeNode({ id: 'change-review', worker: bareWorker(() => creviewOf({ conclusion: { status: 'accepted', summary: 're-reviewed fresh candidate' } })) }, {});
  runtime.transition('VERIFYING', freshImpl);
  assert.equal(runtime.stage, 'VERIFYING');
});

// ============================================================
// 本轮 P1 code_reviewer 补测：
//  1) ACCEPTED checkpoint 恢复 fail-closed（缺任一验收事实都拒绝恢复）；
//  2) runNode 在 requiresArtifactConclusion 定义下走 executeNode 控制面（盖章 provenance，不放行裸 Artifact）；
//  3) runNode VERIFYING 验证失败三向路由（configuration→WAITING_FOR_USER、external_condition→BLOCKED、
//     implementation→IMPLEMENTING）；
//  4) restore 拒绝 controller 伪造业务 Artifact 冒充 worker provenance。
// ============================================================

// 1) ACCEPTED checkpoint 是不可信/伪造的高风险态：runtime 写出的完整 checkpoint 才可恢复，
// 缺 schema/版本/策略/决策引用/产物中任意一项都必须 fail-closed，防止 continueRun 误发验收报告。
test('restore rejects ACCEPTED checkpoints missing any required acceptance fact (ACCEPTED_CHECKPOINT_INCOMPLETE)', () => {
  const completeStampedArtifacts: Artifact[] = [
    {
      kind: 'intake', summary: '白屏', overview: '登录后白屏', unverified: [],
      schemaVersion: 1, runId: 'run-ac', producerKind: 'worker', sourceVersion: 'def-src-v1',
      nodeExecutionId: 'run-ac.intake.1', workerId: 'worker', conclusion: { status: 'accepted', summary: 'ok' },
    },
  ];
  // 同一份业务 Artifact 换成伪造来源字符串（与顶层自洽但 ≠ 定义声明）——伪造方“字符串自洽”不是来源事实。
  const baselineStampedArtifacts: Artifact[] = completeStampedArtifacts.map((a) => ({ ...a, sourceVersion: 'baseline' }));
  // forge 基底 = 字段齐备、记录 shape 正确的“近似合法”checkpoint；每个 case 只破坏一个事实。
  const fakeRecord = { recordId: 'dec:run-ac:1', decision: 'approve', requestId: 'req-1', producerKind: 'user_decision', producer: 'user', producerName: '用户', source: 'runtime:decide' };
  const forged = (overrides: Record<string, unknown>) => ({
    runId: 'run-ac', stage: 'ACCEPTED', at: 1, id: 'c-ac-fake', schemaVersion: 1, sourceVersion: 'def-src-v1',
    decisionRecord: fakeRecord, ...overrides,
  });
  const cases: Array<{ label: string; checkpoint: Record<string, unknown> }> = [
    { label: 'missing decisionReference', checkpoint: forged({ schemaVersion: 1, workflowVersion: 'v1', policyDigest: 'd1', decisionKind: 'approve', decisionReference: undefined, pendingDecisionRequest: 'req-1', artifacts: completeStampedArtifacts }) },
    { label: 'blank decisionReference', checkpoint: forged({ schemaVersion: 1, workflowVersion: 'v1', policyDigest: 'd1', decisionKind: 'approve', decisionReference: '   ', pendingDecisionRequest: 'req-1', artifacts: completeStampedArtifacts }) },
    { label: 'empty decisionReference', checkpoint: forged({ schemaVersion: 1, workflowVersion: 'v1', policyDigest: 'd1', decisionKind: 'approve', decisionReference: '', pendingDecisionRequest: 'req-1', artifacts: completeStampedArtifacts }) },
    { label: 'missing workflowVersion', checkpoint: forged({ schemaVersion: 1, policyDigest: 'd1', decisionReference: 'req-1', decisionKind: 'approve', pendingDecisionRequest: 'req-1', artifacts: completeStampedArtifacts }) },
    { label: 'missing policyDigest', checkpoint: forged({ schemaVersion: 1, workflowVersion: 'v1', decisionReference: 'req-1', decisionKind: 'approve', pendingDecisionRequest: 'req-1', artifacts: completeStampedArtifacts }) },
    { label: 'missing schemaVersion', checkpoint: forged({ schemaVersion: undefined, workflowVersion: 'v1', policyDigest: 'd1', decisionReference: 'req-1', decisionKind: 'approve', pendingDecisionRequest: 'req-1', artifacts: completeStampedArtifacts }) },
    { label: 'marked incomplete', checkpoint: forged({ schemaVersion: 1, workflowVersion: 'v1', policyDigest: 'd1', decisionReference: 'req-1', decisionKind: 'approve', pendingDecisionRequest: 'req-1', artifacts: completeStampedArtifacts, incomplete: true }) },
    { label: 'empty artifacts', checkpoint: forged({ schemaVersion: 1, workflowVersion: 'v1', policyDigest: 'd1', decisionReference: 'req-1', decisionKind: 'approve', pendingDecisionRequest: 'req-1', artifacts: [] }) },
    { label: 'bare forged ACCEPTED', checkpoint: forged({}) },
    // 无真实 approve 事实：错误种类（request_changes）/ 缺失 decisionKind 都不是可验证的人工 approve。
    { label: 'decision kind is not approve', checkpoint: forged({ schemaVersion: 1, workflowVersion: 'v1', policyDigest: 'd1', decisionReference: 'req-1', decisionKind: 'request_changes', pendingDecisionRequest: 'req-1', artifacts: completeStampedArtifacts }) },
    { label: 'missing decision kind', checkpoint: forged({ schemaVersion: 1, workflowVersion: 'v1', policyDigest: 'd1', decisionReference: 'req-1', pendingDecisionRequest: 'req-1', artifacts: completeStampedArtifacts }) },
    // approve 必须绑定该 run 的待决请求：runtime 写出的 checkpoint 在 approve 生效时校验
    // requestId===pendingDecision 并写 pendingDecisionRequest；缺失或与 decisionReference 不一致
    // 都说明该 approve 不是本 Run 决策记录的产物（unbound requestId 不是可验证的人工 approve）。
    { label: 'missing pending decision request (unbound requestId)', checkpoint: forged({ schemaVersion: 1, workflowVersion: 'v1', policyDigest: 'd1', decisionReference: 'req-1', decisionKind: 'approve', pendingDecisionRequest: undefined, artifacts: completeStampedArtifacts }) },
    { label: 'pending decision request does not match decisionReference', checkpoint: forged({ schemaVersion: 1, workflowVersion: 'v1', policyDigest: 'd1', decisionReference: 'req-1', decisionKind: 'approve', pendingDecisionRequest: 'other-request', artifacts: completeStampedArtifacts }) },
    // 决策记录是 Runtime decide() 的产物证明：平铺字段齐全但无 decisionRecord → 不可信（可手填）。
    { label: 'flat fields complete but missing decisionRecord', checkpoint: forged({ schemaVersion: 1, workflowVersion: 'v1', policyDigest: 'd1', decisionReference: 'req-1', decisionKind: 'approve', pendingDecisionRequest: 'req-1', decisionRecord: undefined, artifacts: completeStampedArtifacts }) },
    // decisionRecord 必须由 Runtime 盖章（producer user_decision + source runtime:decide）：伪造来源不是验收事实。
    { label: 'decisionRecord forged producerKind', checkpoint: forged({ schemaVersion: 1, workflowVersion: 'v1', policyDigest: 'd1', decisionReference: 'req-1', decisionKind: 'approve', pendingDecisionRequest: 'req-1', decisionRecord: { ...fakeRecord, producerKind: 'controller' }, artifacts: completeStampedArtifacts }) },
    { label: 'decisionRecord forged source', checkpoint: forged({ schemaVersion: 1, workflowVersion: 'v1', policyDigest: 'd1', decisionReference: 'req-1', decisionKind: 'approve', pendingDecisionRequest: 'req-1', decisionRecord: { ...fakeRecord, source: 'runtime:forged' }, artifacts: completeStampedArtifacts }) },
    { label: 'decisionRecord unbound to decisionReference', checkpoint: forged({ schemaVersion: 1, workflowVersion: 'v1', policyDigest: 'd1', decisionReference: 'req-1', decisionKind: 'approve', pendingDecisionRequest: 'req-1', decisionRecord: { ...fakeRecord, requestId: 'req-other' }, artifacts: completeStampedArtifacts }) },
    // 顶层 + artifact 用同一自洽伪造字符串（'baseline'，≠ 定义声明 'def-src-v1'）：自洽 ≠ 可验证来源。
    { label: 'forged top-level sourceVersion (self-consistent but ≠ declared)', checkpoint: forged({ schemaVersion: 1, workflowVersion: 'v1', policyDigest: 'd1', decisionReference: 'req-1', decisionKind: 'approve', pendingDecisionRequest: 'req-1', sourceVersion: 'baseline', artifacts: baselineStampedArtifacts }) },
    // 定义未声明 sourceVersion（unbound）时顶层来源无权威可校验 → 同样 fail-closed。
    { label: 'definition without declared sourceVersion', checkpoint: forged({ schemaVersion: 1, workflowVersion: 'v1', policyDigest: 'd1', decisionReference: 'req-1', decisionKind: 'approve', pendingDecisionRequest: 'req-1', artifacts: completeStampedArtifacts }) },
  ];
  for (const c of cases) {
    const store = new PiSessionRunStore({ getEntries: () => [{ customType: 'workflow-run', data: c.checkpoint }] }, () => {});
    const definition = c.label === 'definition without declared sourceVersion' ? makeDefinition({ sourceVersion: undefined }) : makeDefinition();
    assert.throws(
      () => WorkflowRuntime.restore(definition, store, 'run-ac'),
      (e: unknown) => { if ((e as { code?: string }).code !== 'ACCEPTED_CHECKPOINT_INCOMPLETE') throw new Error(`[${c.label}] got code ${(e as { code?: string }).code}`); return true; },
    );
  }
});

// 1b. 手工拼齐全部平铺字段（decisionReference/pendingDecisionRequest/sourceVersion/完整 artifacts）
// 但无 Runtime 盖章的 decisionRecord → 不可信：平铺字段可手填，decisionRecord 是 Runtime decide()
// 的产物证明，缺它即 ACCEPTED_CHECKPOINT_INCOMPLETE（完整平铺字段本身不是通过路径）。
test('restore rejects a flat-field-complete ACCEPTED checkpoint without a Runtime decision record', () => {
  const stampedIntake: Artifact = {
    kind: 'intake', summary: '白屏', overview: '登录后白屏', unverified: [],
    schemaVersion: 1, runId: 'run-ac2', producerKind: 'worker', sourceVersion: 'def-src-v1',
    nodeExecutionId: 'run-ac2.intake.1', workerId: 'worker', conclusion: { status: 'accepted', summary: 'ok' },
  };
  const stampedVerification: Artifact = {
    kind: 'verification', accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1', unverified: [],
    schemaVersion: 1, runId: 'run-ac2', producerKind: 'worker', sourceVersion: 'def-src-v1',
    nodeExecutionId: 'run-ac2.verify.1', workerId: 'worker', conclusion: { status: 'accepted', summary: 'ok' },
  };
  const checkpoint = {
    runId: 'run-ac2', schemaVersion: 1, stage: 'ACCEPTED', at: 1, id: 'c-ac2',
    workflowVersion: 'v1', policyDigest: 'd1', decisionReference: 'req-approve', decisionKind: 'approve',
    pendingDecisionRequest: 'req-approve', sourceVersion: 'def-src-v1',
    artifacts: [stampedIntake, stampedVerification],
  };
  const store = new PiSessionRunStore({ getEntries: () => [{ customType: 'workflow-run', data: checkpoint }] }, () => {});
  throwsCode(() => WorkflowRuntime.restore(makeDefinition(), store, 'run-ac2'), 'ACCEPTED_CHECKPOINT_INCOMPLETE');
});

// 1c. ACCEPTED 恢复除了字段检查还要重放全部验收事实：字段齐全但验收事实不全的伪造 checkpoint（如
// 只有 intake、无验收通过 verification）不得通过恢复（ACCEPTED_ACCEPTANCE_NOT_MET），继续守卫
// “已解决（验收通过）”只能由真实可复算的验收事实产生。
test('restore re-validates full acceptance facts on ACCEPTED: missing verification rejected (ACCEPTED_ACCEPTANCE_NOT_MET)', () => {
  const stampedIntake: Artifact = {
    kind: 'intake', summary: '白屏', overview: '登录后白屏', unverified: [],
    schemaVersion: 1, runId: 'run-ac3', producerKind: 'worker', sourceVersion: 'def-src-v1',
    nodeExecutionId: 'run-ac3.intake.1', workerId: 'worker', conclusion: { status: 'accepted', summary: 'ok' },
  };
  // Runtime decide() 盖章归档的 approve 决策 Artifact（背书 decisionRecord）。
  const decisionStamped = {
    kind: 'user_decision', decision: 'approve', requestId: 'req-approve',
    schemaVersion: 1, runId: 'run-ac3', producerKind: 'user_decision', producer: 'user', producerName: '用户',
    sourceVersion: 'def-src-v1', id: 'run-ac3.user_decision.1', unverified: [],
  };
  const checkpoint = {
    runId: 'run-ac3', schemaVersion: 1, stage: 'ACCEPTED', at: 1, id: 'c-ac3',
    workflowVersion: 'v1', policyDigest: 'd1', decisionReference: 'req-approve', decisionKind: 'approve',
    pendingDecisionRequest: 'req-approve', sourceVersion: 'def-src-v1',
    decisionRecord: { recordId: 'dec:run-ac3:1', decision: 'approve', requestId: 'req-approve', producerKind: 'user_decision', producer: 'user', producerName: '用户', source: 'runtime:decide' },
    artifacts: [stampedIntake, decisionStamped],
  };
  const store = new PiSessionRunStore({ getEntries: () => [{ customType: 'workflow-run', data: checkpoint }] }, () => {});
  throwsCode(() => WorkflowRuntime.restore(makeDefinition(), store, 'run-ac3'), 'ACCEPTED_ACCEPTANCE_NOT_MET');
});

// 1d. ACCEPTED 恢复的 approve 决策必须绑定 run 候选版本：run 已产生候选版本（仓库变更路径）时，
// 缺 decisionCandidateRevision 或版本不一致都不是可验证的验收事实（ACCEPTED_ACCEPTANCE_NOT_MET）；
// 完整匹配时正常恢复。
test('restore requires approve decision candidateRevision to bind the run candidate revision', () => {
  const NODE_ID_BY_KIND: Record<string, string> = {
    intake: 'intake', investigation: 'investigate', investigation_review: 'investigation_review', disposition: 'disposition',
    change_plan_review: 'change_plan_review', implementation: 'implement', change_review: 'change_review', verification: 'verify',
  };
  const stamp = (kind: string, extra: Record<string, unknown>) => ({
    kind, unverified: [], schemaVersion: 1, runId: 'run-ac4', producerKind: 'worker', sourceVersion: 'def-src-v1',
    nodeExecutionId: `run-ac4.${NODE_ID_BY_KIND[kind] ?? kind}.1`, workerId: 'worker', conclusion: { status: 'accepted', summary: 'ok' }, ...extra,
  });
  const completeRepoCheckpoint = (decisionRevision: string | undefined, topLevelCandidateRevision: boolean) => ({
    runId: 'run-ac4', schemaVersion: 1, stage: 'ACCEPTED', at: 1, id: 'c-ac4',
    workflowVersion: 'v1', policyDigest: 'd1', decisionReference: 'req-approve', decisionKind: 'approve', pendingDecisionRequest: 'req-approve', sourceVersion: 'def-src-v1',
    // decisionRecord 由 Runtime decide() 盖章；candidateRevision 绑定与平铺 decisionCandidateRevision 同步。
    decisionRecord: { recordId: 'dec:run-ac4:1', decision: 'approve', requestId: 'req-approve', producerKind: 'user_decision', producer: 'user', producerName: '用户', source: 'runtime:decide', ...(decisionRevision !== undefined ? { candidateRevision: decisionRevision } : {}) },
    ...(topLevelCandidateRevision ? { candidateRevision: 'rev-1' } : {}),
    ...(decisionRevision !== undefined ? { decisionCandidateRevision: decisionRevision } : {}),
    artifacts: [
      stamp('intake', { summary: '白屏', overview: '登录后白屏' }),
      stamp('disposition', { dispositionType: 'remediation', requiresRepositoryChange: true, minimalScope: 'a.ts', risks: [], verificationTarget: 'tests' }),
      stamp('implementation', { artifact: { summary: 'fix', filesChanged: ['a.ts'], candidateRevision: 'rev-1' } }),
      stamp('change_review', { reviewedRevision: 'rev-1', findings: [], findingDisposition: 'all_closed', workerId: 'reviewer' }),
      stamp('verification', { accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1' }),
      // Runtime decide() 盖章归档的 approve 决策 Artifact（背书 decisionRecord，版本与 record 同步）。
      { kind: 'user_decision', decision: 'approve', requestId: 'req-approve', schemaVersion: 1, runId: 'run-ac4', producerKind: 'user_decision', producer: 'user', producerName: '用户', unverified: [], sourceVersion: 'def-src-v1', id: 'run-ac4.user_decision.1', ...(decisionRevision !== undefined ? { candidateRevision: decisionRevision } : {}) },
    ],
  });
  const storeFor = (checkpoint: Record<string, unknown>) => new PiSessionRunStore({ getEntries: () => [{ customType: 'workflow-run', data: checkpoint }] }, () => {});
  // approve 缺 decisionCandidateRevision：仓库变更路径下视为验收事实不完整。
  throwsCode(() => WorkflowRuntime.restore(makeDefinition(), storeFor(completeRepoCheckpoint(undefined, true)), 'run-ac4'), 'ACCEPTED_ACCEPTANCE_NOT_MET');
  // 即使顶层 candidateRevision 字段缺失，恢复时会从 implementation Artifact 恢复出当前候选版本：
  // approve 仍必须绑定该版本（版本 bind 是验收事实，不因字段位置被绕过）。
  throwsCode(() => WorkflowRuntime.restore(makeDefinition(), storeFor(completeRepoCheckpoint(undefined, false)), 'run-ac4'), 'ACCEPTED_ACCEPTANCE_NOT_MET');
  // approve 绑定了错误的版本：同样拒绝。
  throwsCode(() => WorkflowRuntime.restore(makeDefinition(), storeFor(completeRepoCheckpoint('rev-9', true)), 'run-ac4'), 'ACCEPTED_ACCEPTANCE_NOT_MET');
  throwsCode(() => WorkflowRuntime.restore(makeDefinition(), storeFor(completeRepoCheckpoint('rev-9', false)), 'run-ac4'), 'ACCEPTED_ACCEPTANCE_NOT_MET');
  // 版本匹配（真实 runtime 写出的形状）→ 正常恢复。
  const restored = WorkflowRuntime.restore(makeDefinition(), storeFor(completeRepoCheckpoint('rev-1', true)), 'run-ac4');
  assert.equal(restored.stage, 'ACCEPTED');
  assert.equal(restored.runCandidateRevision, 'rev-1');
  const restoredLegacy = WorkflowRuntime.restore(makeDefinition(), storeFor(completeRepoCheckpoint('rev-1', false)), 'run-ac4');
  assert.equal(restoredLegacy.stage, 'ACCEPTED');
  assert.equal(restoredLegacy.runCandidateRevision, 'rev-1');
});

// 1e. approve 的 requestId 必须与 Run 决策记录的待决请求绑定：缺失或两者不一致都说明该 approve
// 不是本 Run decide() 决策记录的产物（unbound requestId 不是可验证的验收事实），fail-closed。
test('restore rejects ACCEPTED checkpoints whose approve decision is not bound to the run pending request', () => {
  const stampedIntake: Artifact = {
    kind: 'intake', summary: '白屏', overview: '登录后白屏', unverified: [],
    schemaVersion: 1, runId: 'run-ac5', producerKind: 'worker', sourceVersion: 'def-src-v1',
    nodeExecutionId: 'run-ac5.intake.1', workerId: 'worker', conclusion: { status: 'accepted', summary: 'ok' },
  };
  const withPending = (pendingDecisionRequest: string | undefined) => ({
    runId: 'run-ac5', schemaVersion: 1, stage: 'ACCEPTED', at: 1, id: 'c-ac5',
    workflowVersion: 'v1', policyDigest: 'd1', decisionReference: 'req-approve', decisionKind: 'approve', sourceVersion: 'def-src-v1',
    decisionRecord: { recordId: 'dec:run-ac5:1', decision: 'approve', requestId: 'req-approve', producerKind: 'user_decision', producer: 'user', producerName: '用户', source: 'runtime:decide' },
    ...(pendingDecisionRequest !== undefined ? { pendingDecisionRequest } : {}),
    artifacts: [stampedIntake],
  });
  const storeFor = (checkpoint: Record<string, unknown>) => new PiSessionRunStore({ getEntries: () => [{ customType: 'workflow-run', data: checkpoint }] }, () => {});
  // 缺失待决请求：approve 无法绑定 Run 决策记录。
  throwsCode(() => WorkflowRuntime.restore(makeDefinition(), storeFor(withPending(undefined)), 'run-ac5'), 'ACCEPTED_CHECKPOINT_INCOMPLETE');
  // 待决请求与 approve 引用不一致（unbound requestId）：不是 runtime 决策记录的产物。
  throwsCode(() => WorkflowRuntime.restore(makeDefinition(), storeFor(withPending('req-other')), 'run-ac5'), 'ACCEPTED_CHECKPOINT_INCOMPLETE');
});

// 1f. checkpoint 顶层 sourceVersion 缺省时不得静默填 baseline/任意字符串：从 artifact 一致来源推导
// 统一值，并进入恢复后 runtime 的来源控制面（后续 executeNode 盖章一致）；混合来源无法证明单一产生
// 来源 → fail-closed；顶层定义但与 artifact 不一致 → fail-closed。
test('restore derives the checkpoint sourceVersion from consistent artifact sourceVersions when top-level is missing', async () => {
  const stamp = (kind: string, nodeId: string, extra: Record<string, unknown>) => ({
    kind, conclusion: { status: 'accepted', summary: 'stamped' }, schemaVersion: 1, runId: 'run-sv', producerKind: 'worker',
    unverified: [], sourceVersion: 'golden', nodeExecutionId: `run-sv.${nodeId}.1`, workerId: 'worker', ...extra,
  });
  const entries = [{ customType: 'workflow-run', data: {
    runId: 'run-sv', schemaVersion: 1, stage: 'VERIFYING', at: 1, id: 'c-sv',
    artifacts: [
      stamp('intake', 'intake', { summary: '白屏', overview: '登录后白屏' }),
      stamp('implementation', 'implement', { artifact: { summary: 'fix', filesChanged: ['a.ts'], candidateRevision: 'rev-1' } }),
      stamp('verification', 'verify', { accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1' }),
    ],
  } }];
  const store = new PiSessionRunStore({ getEntries: () => entries }, () => {});
  const restored = WorkflowRuntime.restore(makeDefinition(), store, 'run-sv');
  // 顶层缺省 + artifact 来源一致（'golden'）→ 推导为该来源，不填 baseline。
  assert.ok(restored.getArtifacts().every((a) => (a as { sourceVersion?: string }).sourceVersion === 'golden'));
  // 推导值进入来源控制面：后续 executeNode 的上下文使用同一来源。
  let capsuleSource: string | undefined;
  const readingWorker: WorkerExecutor = {
    execute: async (_node: unknown, _task: unknown, capsule: { sourceVersion?: string }) => {
      capsuleSource = capsule.sourceVersion;
      return { kind: 'verification', accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1' } as Artifact;
    },
  };
  await restored.executeNode({ id: 'verify', worker: readingWorker }, {});
  assert.equal(capsuleSource, 'golden');
});

test('restore rejects checkpoints mixing artifact sourceVersions without a top-level sourceVersion (ARTIFACT_SOURCE_VERSION_MISMATCH)', () => {
  const stamp = (kind: string, sourceVersion: string, extra: Record<string, unknown>) => ({
    kind, conclusion: { status: 'accepted', summary: 'stamped' }, schemaVersion: 1, runId: 'run-svm', producerKind: 'worker',
    unverified: [], sourceVersion, nodeExecutionId: `run-svm.${kind}.1`, workerId: 'worker', ...extra,
  });
  const entries = [{ customType: 'workflow-run', data: {
    runId: 'run-svm', schemaVersion: 1, stage: 'VERIFYING', at: 1, id: 'c-svm',
    artifacts: [
      stamp('intake', 'golden', { summary: '白屏', overview: '登录后白屏' }),
      stamp('verify', 'patch-v2', { accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1' }),
    ],
  } }];
  const store = new PiSessionRunStore({ getEntries: () => entries }, () => {});
  throwsCode(() => WorkflowRuntime.restore(makeDefinition(), store, 'run-svm'), 'ARTIFACT_SOURCE_VERSION_MISMATCH');
});

test('restore rejects a top-level sourceVersion inconsistent with any artifact sourceVersion (ARTIFACT_SOURCE_VERSION_MISMATCH)', () => {
  const stamp = (kind: string, extra: Record<string, unknown>) => ({
    kind, conclusion: { status: 'accepted', summary: 'stamped' }, schemaVersion: 1, runId: 'run-sv2', producerKind: 'worker',
    unverified: [], sourceVersion: 'golden', nodeExecutionId: `run-sv2.${kind}.1`, workerId: 'worker', ...extra,
  });
  const entries = [{ customType: 'workflow-run', data: {
    runId: 'run-sv2', schemaVersion: 1, stage: 'VERIFYING', at: 1, id: 'c-sv2', sourceVersion: 'baseline',
    artifacts: [stamp('intake', { summary: '白屏', overview: '登录后白屏' })],
  } }];
  const store = new PiSessionRunStore({ getEntries: () => entries }, () => {});
  throwsCode(() => WorkflowRuntime.restore(makeDefinition(), store, 'run-sv2'), 'ARTIFACT_SOURCE_VERSION_MISMATCH');
});

// 2) public/legacy runNode() 在 requiresArtifactConclusion 定义下不得把裸 Worker Artifact 直接当业务事实：
// 必须走 executeNode 同一信封/绑定控制面，由 Runtime 以自身身份盖章 provenance。
test('runNode on a requiresArtifactConclusion definition routes through the executeNode control plane (runtime-stamped provenance, no bare artifact)', async () => {
  const { store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition({ requiresArtifactConclusion: true }), store, 'run-rn2', () => 2, () => 'gen');
  await runtime.executeNode(
    { id: 'intake', worker: bareWorker(() => ({ kind: 'intake', summary: '白屏', overview: '登录后白屏', conclusion: { status: 'accepted', summary: 'ok' } })) }, {},
  );
  runtime.transition('INVESTIGATING', runtime.getArtifacts().at(-1)!);
  await runtime.runNode(
    { id: 'investigate', worker: bareWorker(() => ({ kind: 'investigation', route: 'local_fix', rootCause: 'cause', evidence: ['trace'], conclusion: { status: 'accepted', summary: 'inv' } })) }, {},
  );
  assert.equal(runtime.stage, 'IMPLEMENTING');
  const stamped = runtime.getArtifacts().filter((a) => a.kind === 'investigation').at(-1) as Record<string, unknown>;
  // 进入 run 的 investigation 必须带完整 worker 信封：裸产出（缺 runId/nodeExecutionId/workerId/sourceVersion）不得原样落入 run。
  assert.equal(stamped.schemaVersion, 1);
  assert.equal(stamped.runId, 'run-rn2');
  assert.equal(stamped.producerKind, 'worker');
  assert.ok(typeof stamped.nodeExecutionId === 'string' && String(stamped.nodeExecutionId).startsWith('run-rn2.'), 'nodeExecutionId must be bound to this run');
  assert.ok(typeof stamped.workerId === 'string' && String(stamped.workerId).length > 0);
  assert.ok(typeof stamped.sourceVersion === 'string' && String(stamped.sourceVersion).length > 0);
  assert.ok(!runtime.getArtifacts().some((a) => a.kind === 'investigation' && a !== stamped), 'no bare unstamped investigation in run');
});

// 2b. 调用方提供的 envelope 若绑定到其他 run（或伪造 provenance），runNode 同样必须 fail-closed。
test('runNode under requiresArtifactConclusion fails closed on a worker envelope bound to another run', async () => {
  const { store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition({ requiresArtifactConclusion: true }), store, 'run-rn3', () => 3, () => 'gen');
  const bogusEnvelope = {
    kind: 'investigation', route: 'local_fix', rootCause: 'c', evidence: ['t'], schemaVersion: 1,
    runId: 'other-run', producerKind: 'worker', sourceVersion: 'baseline', unverified: [],
    nodeExecutionId: 'ran-other', workerId: 'w', conclusion: { status: 'accepted', summary: 's' },
  };
  await rejectsCode(
    () => runtime.runNode({ id: 'investigate', worker: bareWorker(() => bogusEnvelope) }, {}),
    'ARTIFACT_RUN_ID_MISMATCH',
  );
  assert.equal(runtime.stage, 'INTAKE');
  assert.equal(runtime.getArtifacts().length, 0);
});

// 3) D4 三向路由：accepted=false 不再一律回 IMPLEMENTING。
test('runNode VERIFYING routes verification failures three ways (configuration→WAITING_FOR_USER, external_condition→BLOCKED, implementation→IMPLEMENTING)', async () => {
  // 无 change_review 评审语义的定义，便于直接进入 VERIFYING 验证 runNode 路由本身。
  const routedDefinition = () => makeDefinition({
    acceptance: { requires: ['intake_accepted', 'verification_accepted', 'human_final_approval'] },
  });
  const verifyNode = (failure: { kind: 'configuration' | 'external_condition' | 'implementation'; reason: string }) => ({
    id: 'verify',
    worker: bareWorker(() => ({
      kind: 'verification', accepted: false, evidence: ['test:回归失败'], candidateRevision: 'rev-1',
      failure, conclusion: { status: 'rejected', summary: '验证未通过' },
    })),
  });
  const mkVerifying = () => {
    const { entries, store } = makeStore();
    const runtime = new WorkflowRuntime(routedDefinition(), store, 'run-rr1', () => 1, () => 'gen');
    runtime.transition('IMPLEMENTING');
    runtime.transition('VERIFYING');
    return { runtime, entries };
  };
  // configuration：等待用户修改配置（continue_verification 回 VERIFYING，不回流实现）。
  const { runtime: configTask, entries } = mkVerifying();
  await configTask.runNode(verifyNode({ kind: 'configuration', reason: '环境变量未配置' }), {});
  assert.equal(configTask.stage, 'WAITING_FOR_USER');
  assert.equal(configTask.isPendingConfigurationWait(), true);
  const requestId = pendingRequest(entries);
  const reopened = configTask.decide({ kind: 'user_decision', decision: 'continue_verification', requestId });
  assert.equal(reopened.outcome, 'reopened');
  assert.equal(reopened.toStage, 'VERIFYING');
  assert.equal(configTask.stage, 'VERIFYING');
  // external_condition：权限/环境/外部依赖缺失 → BLOCKED，不回流实现，不产生待决策。
  const { runtime: externalTask } = mkVerifying();
  await externalTask.runNode(verifyNode({ kind: 'external_condition', reason: '缺少数据库只读权限' }), {});
  assert.equal(externalTask.stage, 'BLOCKED');
  assert.ok(externalTask.getArtifacts().some((a) => a.kind === 'guard_rejection'));
  // implementation（默认）：回流实现，允许下一轮实现与验证。
  const { runtime: implTask } = mkVerifying();
  await implTask.runNode(verifyNode({ kind: 'implementation', reason: '登录流程缺异常兜底' }), {});
  assert.equal(implTask.stage, 'IMPLEMENTING');
});

// 4) restore 必须拒绝 controller（或用户）伪造的业务 Artifact 冒充 worker 产出。
// 业务事实只能由 worker 信封携带；controller 只能产出独立控制记录（user_decision 等）。
test('restore rejects controller-produced business artifacts impersonating worker provenance (INVALID_CHECKPOINT_PROVENANCE)', () => {
  const forgedControllerCheckpoint = (kind: string, business: Record<string, unknown>) => ({
    runId: 'run-pc', schemaVersion: 1, stage: 'WAITING_FOR_USER', at: 1, id: 'c-pc', pendingDecisionRequest: 'req-pc', workflowVersion: 'v1', policyDigest: 'd1',
    artifacts: [{
      kind, schemaVersion: 1, runId: 'run-pc', producerKind: 'controller', sourceVersion: 'baseline', unverified: [], conclusion: { status: 'accepted', summary: 'controller-forged' }, ...business,
    }],
  });
  const storeFor = (checkpoint: Record<string, unknown>) => new PiSessionRunStore({ getEntries: () => [{ customType: 'workflow-run', data: checkpoint }] }, () => {});
  // controller 伪造的“验收通过”verification。
  throwsCode(
    () => WorkflowRuntime.restore(makeDefinition(), storeFor(forgedControllerCheckpoint('verification', { accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1' })), 'run-pc'),
    'INVALID_CHECKPOINT_PROVENANCE',
  );
  // controller 伪造 intake。
  throwsCode(
    () => WorkflowRuntime.restore(makeDefinition(), storeFor(forgedControllerCheckpoint('intake', { summary: '白屏', overview: '登录后白屏' })), 'run-pc'),
    'INVALID_CHECKPOINT_PROVENANCE',
  );
  // worker 信封但 nodeExecutionId 不以 runId 为前缀：Node/Worker 绑定违规，同样拒绝。
  throwsCode(
    () => WorkflowRuntime.restore(makeDefinition(), storeFor({
      runId: 'run-pc', schemaVersion: 1, stage: 'WAITING_FOR_USER', at: 1, id: 'c-pc2', pendingDecisionRequest: 'req-pc', workflowVersion: 'v1', policyDigest: 'd1',
      artifacts: [{
        kind: 'intake', summary: '白屏', overview: '登录后白屏', schemaVersion: 1, runId: 'run-pc', producerKind: 'worker', sourceVersion: 'baseline',
        nodeExecutionId: 'other-run.intake.1', workerId: 'w', unverified: [], conclusion: { status: 'accepted', summary: 'ok' },
      }],
    }), 'run-pc'),
    'INVALID_CHECKPOINT_PROVENANCE',
  );
});

// 3b. external_condition → BLOCKED 必须把解除目标阶段（VERIFYING）写入 checkpoint，跨 session
// restore 时继续回现场（getBlockedReturnStage=VERIFYING），而不是默认回滚到 INVESTIGATING。
test('external_condition BLOCKED persists blockedReturnStage(VERIFYING) into the checkpoint and across restore', async () => {
  const routedDefinition = () => makeDefinition({ acceptance: { requires: ['intake_accepted', 'verification_accepted', 'human_final_approval'] } });
  const { entries, store } = makeStore();
  const runtime = new WorkflowRuntime(routedDefinition(), store, 'run-br1', () => 1, () => 'gen');
  runtime.transition('IMPLEMENTING');
  runtime.transition('VERIFYING');
  await runtime.runNode(
    { id: 'verify', worker: bareWorker(() => ({ kind: 'verification', accepted: false, evidence: ['test:阻塞'], candidateRevision: 'rev-1', failure: { kind: 'external_condition', reason: '缺少数据库只读权限' }, conclusion: { status: 'rejected', summary: 'failed' } })) },
    {},
  );
  assert.equal(runtime.stage, 'BLOCKED');
  const blockedCheckpoint = entries.at(-1)!.data as Record<string, unknown>;
  assert.equal(blockedCheckpoint.blockedReturnStage, 'VERIFYING');
  // 跨 session 恢复：BLOCKED checkpoint 恢复出 returnStage，而不是默认回 INVESTIGATING。
  const restored = WorkflowRuntime.restore(routedDefinition(), new PiSessionRunStore({ getEntries: () => entries }, () => {}), 'run-br1');
  assert.equal(restored.stage, 'BLOCKED');
  assert.equal(restored.getBlockedReturnStage(), 'VERIFYING');
});

// 4b. restore 除 runId 前缀/run 绑定外，还必须校验 nodeExecutionId 的 node 段与 Artifact kind 的
// 必要关联：以合法 run 前缀包装“错误的执行记录”（如 investigate 记录冒充验收通过）必须拒绝。
test('restore rejects worker artifacts whose nodeExecutionId node cannot produce the claimed kind (INVALID_CHECKPOINT_PROVENANCE)', () => {
  const checkpoint = {
    runId: 'run-nb', schemaVersion: 1, stage: 'WAITING_FOR_USER', at: 1, id: 'c-nb', pendingDecisionRequest: 'req-nb', workflowVersion: 'v1', policyDigest: 'd1',
    artifacts: [{
      kind: 'verification', accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1', schemaVersion: 1, runId: 'run-nb', producerKind: 'worker', sourceVersion: 'baseline',
      nodeExecutionId: 'run-nb.investigate.1', workerId: 'w', unverified: [], conclusion: { status: 'accepted', summary: 'stamped' },
    }],
  };
  const store = new PiSessionRunStore({ getEntries: () => [{ customType: 'workflow-run', data: checkpoint }] }, () => {});
  throwsCode(() => WorkflowRuntime.restore(makeDefinition(), store, 'run-nb'), 'INVALID_CHECKPOINT_PROVENANCE');
});

// 4c. 评审 Artifact 必须由独立 worker 产出：与被评审产物共享同一 workerId 的“自我评审”伪造
// （checkpoint 声称已完成评审但 reviewer 与被评审者同源）必须拒绝；独立 workerId 保持可恢复。
test('restore rejects review artifacts sharing the reviewed nodes worker identity; independent reviews stay recoverable', () => {
  const stamp = (kind: string, nodeId: string, workerId: string, business: Record<string, unknown>) => ({
    kind, ...business, schemaVersion: 1, runId: 'run-nr', producerKind: 'worker', sourceVersion: 'baseline',
    nodeExecutionId: `run-nr.${nodeId}.1`, workerId, unverified: [], conclusion: { status: 'accepted', summary: 'stamped' },
  });
  const checkpointWith = (artifacts: Record<string, unknown>[]) => ({
    runId: 'run-nr', schemaVersion: 1, stage: 'WAITING_FOR_USER', at: 1, id: 'c-nr', pendingDecisionRequest: 'req-nr', workflowVersion: 'v1', policyDigest: 'd1', artifacts,
  });
  const storeFor = (checkpoint: Record<string, unknown>) => new PiSessionRunStore({ getEntries: () => [{ customType: 'workflow-run', data: checkpoint }] }, () => {});
  // 自我评审：investigation 与紧随其后的 investigation_review 共享同一 workerId。
  throwsCode(
    () => WorkflowRuntime.restore(makeDefinition(), storeFor(checkpointWith([
      stamp('investigation', 'investigate', 'w', { route: 'local_fix', rootCause: 'cause', evidence: ['trace'] }),
      stamp('investigation_review', 'investigation_review', 'w', { rootCauseConclusion: 'cause', evidenceSufficiency: 'sufficient', gaps: [] }),
      stamp('verification', 'verify', 'w', { accepted: true, evidence: ['test:passed'] }),
    ])), 'run-nr'),
    'INVALID_CHECKPOINT_PROVENANCE',
  );
  // 独立 workerId 的评审保持可恢复（workerId 不必等于被评审者）。
  const independent = WorkflowRuntime.restore(makeDefinition(), storeFor(checkpointWith([
    stamp('investigation', 'investigate', 'w', { route: 'local_fix', rootCause: 'cause', evidence: ['trace'] }),
    stamp('investigation_review', 'investigation_review', 'reviewer', { rootCauseConclusion: 'cause', evidenceSufficiency: 'sufficient', gaps: [] }),
    stamp('verification', 'verify', 'w', { accepted: true, evidence: ['test:passed'] }),
  ])), 'run-nr');
  assert.equal(independent.stage, 'WAITING_FOR_USER');
});

// 21a. 真实 decide() 写出的 ACCEPTED checkpoint 恢复：决策记录链 + 绑定来源 + 验收重算
test('restore accepts a real decide-written ACCEPTED checkpoint (decision record chain + runtime-bound sourceVersion)', async () => {
  const { entries, store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-acreal', () => 21, () => 'gen', {
    definitionVersion: 'v1', policyDigest: 'd1',
  });
  await runtime.executeNode({ id: 'intake', worker: bareWorker(() => ({ kind: 'intake', summary: '白屏', overview: '登录后白屏' })) }, {});
  runtime.transition('INVESTIGATING');
  const disposition = (await runtime.executeNode({ id: 'disposition', worker: bareWorker(() => ({ kind: 'disposition', dispositionType: 'wait_decision', requiresRepositoryChange: false, minimalScope: 'config', risks: [], verificationTarget: 'tests', conclusion: { status: 'accepted', summary: 'no repo change' } })) }, {})).artifact;
  runtime.transition('DISPOSITION', disposition);
  const verification = (await runtime.executeNode({ id: 'verify', worker: bareWorker(() => ({ kind: 'verification', accepted: true, evidence: ['test:passed'] })) }, {})).artifact;
  runtime.transition('WAITING_FOR_USER', verification);
  const requestId = pendingRequest(entries);
  runtime.decide({ kind: 'user_decision', decision: 'approve', requestId });
  assert.equal(runtime.stage, 'ACCEPTED');
  // 真实 checkpoint 携带完整决策记录链 + 顶层 sourceVersion（可验证的产生来源）。
  const written = entries.at(-1)!.data;
  assert.equal(written.decisionKind, 'approve');
  assert.equal(written.decisionReference, requestId);
  assert.equal(written.pendingDecisionRequest, requestId);
  assert.equal(written.sourceVersion, 'def-src-v1');
  // 决策记录是 Runtime decide() 盖章的产物证明：带 producer 来源 + 绑定待决请求 + 候选版本。
  assert.equal(written.decisionRecord.producerKind, 'user_decision');
  assert.equal(written.decisionRecord.producer, 'user');
  assert.equal(written.decisionRecord.source, 'runtime:decide');
  assert.equal(written.decisionRecord.requestId, requestId);
  const restored = WorkflowRuntime.restore(makeDefinition(), store, 'run-acreal', { expectedWorkflowVersion: 'v1', expectedPolicyDigest: 'd1' });
  assert.equal(restored.stage, 'ACCEPTED');
  assert.equal(restored.sourceVersion, 'def-src-v1');
  // 决策 Artifact 由 Runtime decide() 盖章归档（背书 decisionRecord），恢复计数含该 approve 事实。
  assert.equal(restored.getArtifacts().length, 4);
  const approvalBacking = restored.getArtifacts().filter((artifact) => artifact.kind === 'user_decision');
  assert.equal(approvalBacking.length, 1);
  assert.equal(approvalBacking[0]!.producerKind, 'user_decision');
  assert.equal(approvalBacking[0]!.producer, 'user');
  assert.equal(approvalBacking[0]!.requestId, requestId);
});

// 21a-2. live 来源绑定（纵深防御）：运行中的 runtime 来源被篡改（≠ 定义声明）时，同一个调用内的
// approve 在进入 ACCEPTED 前被拒绝（ACCEPTED_SOURCE_VERSION_MISMATCH），不再产出任何验收态。
// 这覆盖“伪造来源的非终局 checkpoint 恢复后直接 approve”的最终防线（外层伪造已被验收账本要求拦下）。
test('live approve from a tampered runtime source is rejected at ACCEPTED entry (ACCEPTED_SOURCE_VERSION_MISMATCH)', async () => {
  const { entries, store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-acsrc', () => 21, () => 'gen', {
    definitionVersion: 'v1', policyDigest: 'd1',
  });
  await runtime.executeNode({ id: 'intake', worker: bareWorker(() => ({ kind: 'intake', summary: '白屏', overview: '登录后白屏' })) }, {});
  runtime.transition('INVESTIGATING');
  const disposition = (await runtime.executeNode({ id: 'disposition', worker: bareWorker(() => ({ kind: 'disposition', dispositionType: 'wait_decision', requiresRepositoryChange: false, minimalScope: 'config', risks: [], verificationTarget: 'tests', conclusion: { status: 'accepted', summary: 'no repo change' } })) }, {})).artifact;
  runtime.transition('DISPOSITION', disposition);
  const verification = (await runtime.executeNode({ id: 'verify', worker: bareWorker(() => ({ kind: 'verification', accepted: true, evidence: ['test:passed'] })) }, {})).artifact;
  runtime.transition('WAITING_FOR_USER', verification);
  const requestId = pendingRequest(entries);
  // 模拟恢复现场被篡改来源（或错误恢复）后，在同一 run 里直接 approve。
  runtime.sourceVersion = 'fake-src';
  throwsCode(
    () => runtime.decide({ kind: 'user_decision', decision: 'approve', requestId }),
    'ACCEPTED_SOURCE_VERSION_MISMATCH',
  );
  // 拒绝发生在进入 ACCEPTED 之前：stage 仍为 WAITING_FOR_USER，没有把伪造来源写成已验收。
  assert.equal(runtime.stage, 'WAITING_FOR_USER');
  const last = entries.at(-1)!;
  assert.notEqual(last.data.stage, 'ACCEPTED');
});

// 21b. 篡改真实 decide 写出的 ACCEPTED checkpoint：决策记录链是验收来源证明，任何一环缺失 → fail-closed
test('restore rejects a tampered real ACCEPTED checkpoint (decision record chain is the approve provenance)', async () => {
  const { entries, store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-actamper', () => 21, () => 'gen', {
    definitionVersion: 'v1', policyDigest: 'd1',
  });
  await runtime.executeNode({ id: 'intake', worker: bareWorker(() => ({ kind: 'intake', summary: '白屏', overview: '登录后白屏' })) }, {});
  runtime.transition('INVESTIGATING');
  const disposition = (await runtime.executeNode({ id: 'disposition', worker: bareWorker(() => ({ kind: 'disposition', dispositionType: 'wait_decision', requiresRepositoryChange: false, minimalScope: 'config', risks: [], verificationTarget: 'tests', conclusion: { status: 'accepted', summary: 'no repo change' } })) }, {})).artifact;
  runtime.transition('DISPOSITION', disposition);
  const verification = (await runtime.executeNode({ id: 'verify', worker: bareWorker(() => ({ kind: 'verification', accepted: true, evidence: ['test:passed'] })) }, {})).artifact;
  runtime.transition('WAITING_FOR_USER', verification);
  const requestId = pendingRequest(entries);
  runtime.decide({ kind: 'user_decision', decision: 'approve', requestId });
  const written = entries.at(-1)!.data;
  const restoreData = (data: Record<string, unknown>) => new PiSessionRunStore(
    { getEntries: () => [{ customType: 'workflow-run', data }] }, () => {},
  );
  // 决策种类被篡改（approve → deny）：不是可验证的人工 approve 事实。
  throwsCode(
    () => WorkflowRuntime.restore(makeDefinition(), restoreData({ ...written, decisionKind: 'deny' }), 'run-actamper'),
    'ACCEPTED_CHECKPOINT_INCOMPLETE',
  );
  // 决策记录未配对（pendingDecisionRequest 丢失）→ 不是本 Run 决策记录的产物。
  throwsCode(
    () => WorkflowRuntime.restore(makeDefinition(), restoreData({ ...written, pendingDecisionRequest: undefined }), 'run-actamper'),
    'ACCEPTED_CHECKPOINT_INCOMPLETE',
  );
  // 决策记录引用丢失。
  throwsCode(
    () => WorkflowRuntime.restore(makeDefinition(), restoreData({ ...written, decisionReference: undefined }), 'run-actamper'),
    'ACCEPTED_CHECKPOINT_INCOMPLETE',
  );
  // 决策记录本身被移除：平铺字段再齐全也不是可验证的 approve 事实（decisionRecord 是产物证明）。
  throwsCode(
    () => WorkflowRuntime.restore(makeDefinition(), restoreData({ ...written, decisionRecord: undefined }), 'run-actamper'),
    'ACCEPTED_CHECKPOINT_INCOMPLETE',
  );
  // 决策记录来源被伪造（runtime:decide → 其他字符串）：不是 Runtime decide() 的产物。
  throwsCode(
    () => WorkflowRuntime.restore(makeDefinition(), restoreData({ ...written, decisionRecord: { ...written.decisionRecord, source: 'runtime:forged' } }), 'run-actamper'),
    'ACCEPTED_CHECKPOINT_INCOMPLETE',
  );
});

// 21c. v2 ACCEPTED 恢复的来源必须绑定定义声明（definition.sourceVersion）：
// (a) 定义未声明来源（unbound）或 checkpoint 无顶层来源 → fail-closed；
// (b) 顶层 + artifact 用同一自洽伪造字符串但 ≠ 定义声明 → fail-closed（自洽字符串不是可验证来源事实，
// 伪造方必须猜中定义声明的值，且仍要过决策记录与验收重算）。
test('restore rejects v2 ACCEPTED whose source is unbound or forged (must equal the definition-declared sourceVersion)', async () => {
  const stampedIntake: Artifact = {
    schemaVersion: 1, runId: 'run-unbound', producerKind: 'worker', sourceVersion: 'baseline',
    nodeExecutionId: 'run-unbound.intake.1', workerId: 'w', kind: 'intake',
    conclusion: { status: 'accepted', summary: 'ok' }, summary: '白屏', overview: '登录后白屏',
  };
  const stampedVerification: Artifact = {
    schemaVersion: 1, runId: 'run-unbound', producerKind: 'worker', sourceVersion: 'baseline',
    nodeExecutionId: 'run-unbound.verify.1', workerId: 'w', kind: 'verification',
    conclusion: { status: 'accepted', summary: 'ok' }, accepted: true, evidence: ['test:passed'],
  };
  const base = {
    runId: 'run-unbound', schemaVersion: 1, stage: 'ACCEPTED', at: 1, id: 'c-unbound',
    workflowVersion: 'v1', policyDigest: 'd1', decisionReference: 'req-unbound', decisionKind: 'approve', pendingDecisionRequest: 'req-unbound',
    decisionRecord: { recordId: 'dec:run-unbound:1', decision: 'approve', requestId: 'req-unbound', producerKind: 'user_decision', producer: 'user', producerName: '用户', source: 'runtime:decide' },
  };
  // (a) 无顶层 sourceVersion（仅 artifact fallback 盖章）→ unbound，fail-closed。
  throwsCode(
    () => WorkflowRuntime.restore(makeDefinition(), new PiSessionRunStore({ getEntries: () => [{ customType: 'workflow-run', data: { ...base, artifacts: [stampedIntake, stampedVerification] } }] }, () => {}), 'run-unbound'),
    'ACCEPTED_CHECKPOINT_INCOMPLETE',
  );
  // (b) 定义未声明 sourceVersion（unbound 权威）→ 顶层来源无校验基准，fail-closed。
  throwsCode(
    () => WorkflowRuntime.restore(makeDefinition({ sourceVersion: undefined }), new PiSessionRunStore({ getEntries: () => [{ customType: 'workflow-run', data: { ...base, sourceVersion: 'baseline', artifacts: [stampedIntake, stampedVerification] } }] }, () => {}), 'run-unbound'),
    'ACCEPTED_CHECKPOINT_INCOMPLETE',
  );
});

// 走到 DISPOSITION 阶段的最小流程（makeDefinition 的 acceptance 不声明 investigation marker，
// 无需 investigation_review；受控终局门禁在 DISPOSITION→IMPLEMENTING 才真正生效）。
const bootToDisposition = async (runtime: WorkflowRuntime) => {
  await runtime.executeNode({ id: 'intake', worker: bareWorker(() => ({ kind: 'intake', summary: '白屏', overview: '登录后白屏' })) }, {});
  runtime.transition('INVESTIGATING', runtime.getArtifacts().at(-1)!);
  const investigation = (await runtime.executeNode({ id: 'investigate', worker: bareWorker(() => ({ kind: 'investigation', route: 'local_fix', rootCause: 'cause', evidence: ['trace'] })) }, {})).artifact;
  runtime.transition('DISPOSITION', investigation);
};

// 21d. executeNode/transition 直传伪造 change_plan_review（无 runReview 账本周期）不能离开 DISPOSITION → IMPLEMENTING
test('direct-forged change_plan_review cannot leave DISPOSITION to IMPLEMENTING (gate requires a runReview cycle)', async () => {
  const { store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-cprd', () => 21, () => 'gen');
  await bootToDisposition(runtime);
  const disposition = (await runtime.executeNode({ id: 'disposition', worker: bareWorker(() => ({ kind: 'disposition', dispositionType: 'remediation', requiresRepositoryChange: true, minimalScope: 'a.ts', risks: [], verificationTarget: 'tests', conclusion: { status: 'accepted', summary: 'plan' } })) }, {})).artifact;
  const forged = (await runtime.executeNode({ id: 'change_plan_review', worker: bareWorker(() => ({ kind: 'change_plan_review', rootCauseAlignment: true, changedScope: 'a.ts', risks: [], compatibility: [], verification: [], rollback: [], findings: [], conclusion: { status: 'accepted', summary: 'forged' } })) }, {})).artifact;
  // 直接用伪造评审 transition：内容齐全但没有任何 runReview 账本周期 → NOT_BOUND（fail-closed）。
  throwsCode(() => runtime.transition('IMPLEMENTING', forged), 'CHANGE_PLAN_REVIEW_NOT_BOUND');
  // 再直传一份伪造评审 + 已归档处置也不能绕过账本绑定。
  const forged2 = (await runtime.executeNode({ id: 'change_plan_review', worker: bareWorker(() => ({ kind: 'change_plan_review', rootCauseAlignment: true, changedScope: 'a.ts', risks: [], compatibility: [], verification: [], rollback: [], findings: [], conclusion: { status: 'accepted', summary: 'forged-2' } })) }, {})).artifact;
  throwsCode(() => runtime.transition('IMPLEMENTING', disposition), 'CHANGE_PLAN_REVIEW_NOT_BOUND');
  assert.equal(runtime.stage, 'DISPOSITION');
  // runNode 公共入口同样不能放行：DISPOSITION 下 runNode 提交 cplan 没有合法路由（不允许归档后放行）。
  await assert.rejects(
    () => runtime.runNode({ id: 'change_plan_review', worker: bareWorker(() => ({ kind: 'change_plan_review', rootCauseAlignment: true, changedScope: 'a.ts', risks: [], compatibility: [], verification: [], rollback: [], findings: [], conclusion: { status: 'accepted', summary: 'runNode-forged' } }), 'cpr-rn') }, {}),
    /invalid artifact change_plan_review for stage DISPOSITION/,
  );
  assert.equal(runtime.stage, 'DISPOSITION');
});

// 21e. 账本周期存在的 runReview 才能放行：未达 quorum/含拒绝票 → NOT_PASSED；通过 → 放行
test('runReview cycle gates DISPOSITION→IMPLEMENTING: not-passed review blocks, passed review allows', async () => {
  const { store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-cprq', () => 21, () => 'gen');
  await bootToDisposition(runtime);
  const disposition = (await runtime.executeNode({ id: 'disposition', worker: bareWorker(() => ({ kind: 'disposition', dispositionType: 'remediation', requiresRepositoryChange: true, minimalScope: 'a.ts', risks: [], verificationTarget: 'tests', conclusion: { status: 'accepted', summary: 'plan' } })) }, {})).artifact;
  const reviewShape = (accepted: boolean) => ({
    kind: 'change_plan_review', rootCauseAlignment: true, changedScope: 'a.ts', risks: [], compatibility: [],
    verification: [], rollback: [], findings: [], conclusion: { status: accepted ? 'accepted' : 'rejected', summary: 'r' },
  });
  // 两名评审者中一人拒绝：周期记账（approvals=1 < requiredApprovals=2），最新 cplan 未通过 → NOT_PASSED。
  const rejected = await runtime.runReview(
    'change_plan_review',
    [{ id: 'change_plan_review', worker: bareWorker(() => reviewShape(true), 'cpr-r1') },
     { id: 'change_plan_review', worker: bareWorker(() => reviewShape(false), 'cpr-r2') }],
    { reviewers: [{ model: 'inherit' }, { model: 'inherit' }], mode: 'parallel' as const, requiredApprovals: 2, requireIndependentWorker: true, excludeNodes: ['disposition'], onRejected: 'return_to_disposition' },
    { reviewedNodeId: 'disposition', reviewArtifactKind: 'change_plan_review' },
  );
  assert.equal(rejected.passed, false);
  throwsCode(() => runtime.transition('IMPLEMENTING', disposition), 'CHANGE_PLAN_REVIEW_NOT_PASSED');
  // 两名评审者都通过 → 周期达标，放行 IMPLEMENTING。
  const passed = await runtime.runReview(
    'change_plan_review',
    [{ id: 'change_plan_review', worker: bareWorker(() => reviewShape(true), 'cpr-r3') },
     { id: 'change_plan_review', worker: bareWorker(() => reviewShape(true), 'cpr-r4') }],
    { reviewers: [{ model: 'inherit' }, { model: 'inherit' }], mode: 'parallel' as const, requiredApprovals: 2, requireIndependentWorker: true, excludeNodes: ['disposition'], onRejected: 'return_to_disposition' },
    { reviewedNodeId: 'disposition', reviewArtifactKind: 'change_plan_review' },
  );
  assert.equal(passed.passed, true);
  runtime.transition('IMPLEMENTING', disposition);
  assert.equal(runtime.stage, 'IMPLEMENTING');
});

// 21f. 周期账本与处置配对：重开处置后旧周期的 change_plan_review 不放行；新作战周期放行
test('re-disposition invalidates the previous change_plan_review cycle (disposition pairing in the ledger)', async () => {
  const { store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-cprp', () => 21, () => 'gen');
  await bootToDisposition(runtime);
  const plan = (summary: string) => ({ kind: 'disposition', dispositionType: 'remediation', requiresRepositoryChange: true, minimalScope: 'a.ts', risks: [], verificationTarget: 'tests', conclusion: { status: 'accepted', summary } });
  const policy = { reviewers: [{ model: 'inherit' }], mode: 'parallel' as const, requiredApprovals: 1, requireIndependentWorker: true, excludeNodes: [], onRejected: 'return_to_disposition' };
  const first = (await runtime.executeNode({ id: 'disposition', worker: bareWorker(() => plan('plan-1')) }, {})).artifact;
  await runtime.runReview(
    'change_plan_review',
    [{ id: 'change_plan_review', worker: bareWorker(() => ({ kind: 'change_plan_review', rootCauseAlignment: true, changedScope: 'a.ts', risks: [], compatibility: [], verification: [], rollback: [], findings: [], conclusion: { status: 'accepted', summary: 'plan-1' } }), 'cpr-p1') }],
    policy, { reviewedNodeId: 'disposition', reviewArtifactKind: 'change_plan_review' },
  );
  // 重开处置（同 run 第二次处置）→ 旧周期的 cplan 时序上早于新处置 → 不构成新处置的评审。
  const second = (await runtime.executeNode({ id: 'disposition', worker: bareWorker(() => plan('plan-2')) }, {})).artifact;
  throwsCode(() => runtime.transition('IMPLEMENTING', second), 'CHANGE_PLAN_REVIEW_NOT_BOUND');
  // 新处置配套新周期 → 放行。
  await runtime.runReview(
    'change_plan_review',
    [{ id: 'change_plan_review', worker: bareWorker(() => ({ kind: 'change_plan_review', rootCauseAlignment: true, changedScope: 'a.ts', risks: [], compatibility: [], verification: [], rollback: [], findings: [], conclusion: { status: 'accepted', summary: 'plan-2' } }), 'cpr-p2') }],
    policy, { reviewedNodeId: 'disposition', reviewArtifactKind: 'change_plan_review' },
  );
  runtime.transition('IMPLEMENTING', second);
  assert.equal(runtime.stage, 'IMPLEMENTING');
});

// 21g. 账本周期跨 checkpoint 恢复后仍作为门禁依据：篡改账本（approvals/独立评审者数少于 quorum）
// 的 checkpoint 恢复后 DISPOSITION→IMPLEMENTING 必须 NOT_PASSED。
test('restored ledger quorum is enforced: passing artifacts with a tampered sub-quorum cycle cannot leave DISPOSITION', async () => {
  const { entries, store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-cyc', () => 21, () => 'gen');
  await bootToDisposition(runtime);
  const disposition = (await runtime.executeNode({ id: 'disposition', worker: bareWorker(() => ({ kind: 'disposition', dispositionType: 'remediation', requiresRepositoryChange: true, minimalScope: 'a.ts', risks: [], verificationTarget: 'tests', conclusion: { status: 'accepted', summary: 'plan' } })) }, {})).artifact;
  await runtime.runReview(
    'change_plan_review',
    [{ id: 'change_plan_review', worker: bareWorker(() => ({ kind: 'change_plan_review', rootCauseAlignment: true, changedScope: 'a.ts', risks: [], compatibility: [], verification: [], rollback: [], findings: [], conclusion: { status: 'accepted', summary: 'ok' } }), 'cpr-c1') }],
    { reviewers: [{ model: 'inherit' }], mode: 'parallel' as const, requiredApprovals: 1, requireIndependentWorker: true, excludeNodes: [], onRejected: 'return_to_disposition' },
    { reviewedNodeId: 'disposition', reviewArtifactKind: 'change_plan_review' },
  );
  runtime.transition('IMPLEMENTING', disposition);
  const written = entries.at(-1)!.data;
  assert.equal(written.stage, 'IMPLEMENTING');
  // 篡改账本：把通过的周期改成未达 quorum（approvals=1 但 requiredApprovals=2，评审者来源只剩 1 人）。
  const tampered = {
    ...written, stage: 'DISPOSITION',
    reviewCycles: (written.reviewCycles as unknown[]).map((record) => ({
      ...record as Record<string, unknown>, approvals: 1, requiredApprovals: 2, reviewerWorkerIds: ['cpr-c1'], passed: false,
    })),
  };
  const storeFor = (data: Record<string, unknown>) => new PiSessionRunStore(
    { getEntries: () => [{ customType: 'workflow-run', data }] }, () => {},
  );
  // 先证明原样（未篡改）的账本恢复后可以放行 → 门禁确实吃账本。
  const honest = WorkflowRuntime.restore(makeDefinition(), storeFor(written), 'run-cyc');
  assert.equal(honest.stage, 'IMPLEMENTING');
  // 篡改版恢复后（stage DISPOSITION + 合格内容 cplan）→ NOT_PASSED（周期 quorum 是门禁依据）。
  const restored = WorkflowRuntime.restore(makeDefinition(), storeFor(tampered), 'run-cyc');
  const cplan = restored.getArtifacts().filter((a) => a.kind === 'change_plan_review').at(-1);
  throwsCode(() => restored.transition('IMPLEMENTING', cplan), 'CHANGE_PLAN_REVIEW_NOT_PASSED');
  assert.equal(restored.stage, 'DISPOSITION');
});

// S1 影子评审节点：runReview 记账在影子节点（change_plan_review_shadow，已知 kind 表外 → 命名层
// 不拦截），但门禁的语义节点控制面按 NODE_KIND_BY_NODE_ID 判定周期节点必须等于规定义上的
// change_plan_review —— 影子周期不得放行 DISPOSITION → IMPLEMENTING。
test('shadow review node cycle cannot leave DISPOSITION to IMPLEMENTING (gate requires change_plan_review node)', async () => {
  const { store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-shadow', () => 21, () => 'gen');
  await bootToDisposition(runtime);
  const disposition = (await runtime.executeNode({ id: 'disposition', worker: bareWorker(() => ({ kind: 'disposition', dispositionType: 'remediation', requiresRepositoryChange: true, minimalScope: 'a.ts', risks: [], verificationTarget: 'tests', conclusion: { status: 'accepted', summary: 'plan' } })) }, {})).artifact;
  await runtime.runReview(
    'change_plan_review_shadow',
    [
      { id: 'change_plan_review_shadow', worker: bareWorker(() => ({ kind: 'change_plan_review', rootCauseAlignment: true, changedScope: 'a.ts', risks: [], compatibility: [], verification: [], rollback: [], findings: [], conclusion: { status: 'accepted', summary: 'ok' } }), 'shadow-r1') },
      { id: 'change_plan_review_shadow', worker: bareWorker(() => ({ kind: 'change_plan_review', rootCauseAlignment: true, changedScope: 'a.ts', risks: [], compatibility: [], verification: [], rollback: [], findings: [], conclusion: { status: 'accepted', summary: 'ok' } }), 'shadow-r2') },
    ],
    { reviewers: [{ model: 'inherit' }], mode: 'parallel' as const, requiredApprovals: 2, requireIndependentWorker: true, excludeNodes: [], onRejected: 'return_to_disposition' },
    { reviewedNodeId: 'disposition', reviewArtifactKind: 'change_plan_review' },
  );
  // 内容与 quorum 都齐（两人独立评审产物已归档），但周期节点是影子节点 → 语义节点绑定失败。
  throwsCode(() => runtime.transition('IMPLEMENTING', disposition), 'CHANGE_PLAN_REVIEW_NOT_BOUND');
  assert.equal(runtime.stage, 'DISPOSITION');
  // 对照：同来源在正式 change_plan_review 节点记账则放行 —— 门禁确实按节点身份判定，而不是
  // 按“有账本周期”放行。
  await runtime.runReview(
    'change_plan_review',
    [
      { id: 'change_plan_review', worker: bareWorker(() => ({ kind: 'change_plan_review', rootCauseAlignment: true, changedScope: 'a.ts', risks: [], compatibility: [], verification: [], rollback: [], findings: [], conclusion: { status: 'accepted', summary: 'ok' } }), 'real-r1') },
      { id: 'change_plan_review', worker: bareWorker(() => ({ kind: 'change_plan_review', rootCauseAlignment: true, changedScope: 'a.ts', risks: [], compatibility: [], verification: [], rollback: [], findings: [], conclusion: { status: 'accepted', summary: 'ok' } }), 'real-r2') },
    ],
    { reviewers: [{ model: 'inherit' }], mode: 'parallel' as const, requiredApprovals: 2, requireIndependentWorker: true, excludeNodes: [], onRejected: 'return_to_disposition' },
    { reviewedNodeId: 'disposition', reviewArtifactKind: 'change_plan_review' },
  );
  runtime.transition('IMPLEMENTING', disposition);
  assert.equal(runtime.stage, 'IMPLEMENTING');
});

// 22. S5：runReview 的审计事件类型必须反映真实评审种类——investigation_review / change_plan_review /
// change_review 不得混入 investigation_review_completed。
test('runReview audit events classify the review kind（change_plan_review_completed）', async () => {
  const { store } = makeStore();
  const audit: Array<{ eventType: string }> = [];
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-etype', () => 22, () => 'gen', {
    auditSink: { append: (event) => { audit.push({ eventType: event.eventType }); } },
  });
  await bootToDisposition(runtime);
  await runtime.executeNode({ id: 'disposition', worker: bareWorker(() => ({ kind: 'disposition', dispositionType: 'remediation', requiresRepositoryChange: true, minimalScope: 'a.ts', risks: [], verificationTarget: 'tests', conclusion: { status: 'accepted', summary: 'plan' } })) }, {});
  await runtime.runReview(
    'change_plan_review',
    [{ id: 'change_plan_review', worker: bareWorker(() => ({ kind: 'change_plan_review', rootCauseAlignment: true, changedScope: 'a.ts', risks: [], compatibility: [], verification: [], rollback: [], findings: [], conclusion: { status: 'accepted', summary: 'ok' } }), 'cpr-e1') }],
    { reviewers: [{ model: 'inherit' }], mode: 'parallel' as const, requiredApprovals: 1, requireIndependentWorker: true, excludeNodes: ['disposition'], onRejected: 'return_to_disposition' },
    { reviewedNodeId: 'disposition', reviewArtifactKind: 'change_plan_review' },
  );
  assert.ok(audit.some((event) => event.eventType === 'change_plan_review_completed'), `audit: ${audit.map((event) => event.eventType).join(', ')}`);
  // 三类评审事件各自明确：本调用只做了 change_plan_review，不允许出现 investigation 的默认兜底类型。
  assert.ok(!audit.some((event) => event.eventType === 'investigation_review_completed'), `misclassification: ${audit.map((event) => event.eventType).join(', ')}`);
});

// 23. S2b/S7：checkpoint 账本不是“跳过伪记录”的软列表——任何一条形状非法的周期记录都让恢复失败。
test('restore fails closed on a malformed review cycle record (no silent filter)', () => {
  const { entries, store } = makeStore();
  entries.push({ customType: 'workflow-run', data: { runId: 'run-mal', schemaVersion: 1, stage: 'DISPOSITION', at: 1, id: 'c-mal', workflowVersion: 'v1', policyDigest: 'd1', reviewCycles: [{ cycleId: 'fix-mal.review.1.1' }] } });
  throwsCode(() => WorkflowRuntime.restore(makeDefinition(), store, 'run-mal'), 'CHECKPOINT_REVIEW_LEDGER_INCONSISTENT');
});

// 24. P2-1 bound：受控终局定义的 WAITING_FOR_USER 恢复必须有“已接受的验证（或配置类失败）+ Runtime
// 决策请求”背书——顶着空业务现场伪造的等待态不得续跑。
test('restore rejects a forged WAITING_FOR_USER checkpoint without a verification-backed wait', () => {
  const { entries, store } = makeStore();
  entries.push({ customType: 'workflow-run', data: {
    runId: 'run-wf', schemaVersion: 1, stage: 'WAITING_FOR_USER', at: 1, id: 'c-wf', workflowVersion: 'v1', policyDigest: 'd1',
    pendingDecisionRequest: 'req-forged',
    artifacts: [
      { kind: 'intake', summary: '白屏', unverified: [], schemaVersion: 1, runId: 'run-wf', producerKind: 'worker', sourceVersion: 'def-src-v1', nodeExecutionId: 'run-wf.intake.1', workerId: 'w', overview: '登录后白屏' },
      { kind: 'verification', accepted: false, evidence: ['evt:forged'], failure: { kind: 'implementation', reason: 'x' }, unverified: [], schemaVersion: 1, runId: 'run-wf', producerKind: 'worker', sourceVersion: 'def-src-v1', nodeExecutionId: 'run-wf.verify.1', workerId: 'w' },
    ],
  } });
  // 验证被拒（implementation 类失败）不构成合法人工等待 → fail-closed。
  throwsCode(() => WorkflowRuntime.restore(makeDefinition(), store, 'run-wf'), 'CHECKPOINT_STATE_INCONSISTENT');
});

// 24b. F2：restore 交叉校验 pendingDecisionKind 与 disposition 等待事实——最新 disposition 声明
// wait_decision/external_action 时，pendingDecisionKind 必须对应 disposition_decision/
// external_action_completion（精确配对），否则 fail-closed；缺字段（legacy）沿用推导回退。
// 防止 resume 后按错误等待种类渲染（如把 external_action 等待渲染成“等待处置决定”）。
const dispositionWaitRestoreCheckpoint = (opts: {
  dispositionType: 'wait_decision' | 'external_action';
  pendingDecisionKind?: string;
  extraArtifacts?: Record<string, unknown>[];
}) => ({
  customType: 'workflow-run',
  data: {
    runId: 'run-f2', schemaVersion: 1, stage: 'WAITING_FOR_USER', at: 1, id: 'c-f2', workflowVersion: 'v1', policyDigest: 'd1',
    pendingDecisionRequest: 'req-f2',
    ...(opts.pendingDecisionKind !== undefined ? { pendingDecisionKind: opts.pendingDecisionKind } : {}),
    artifacts: [
      { kind: 'disposition', dispositionType: opts.dispositionType, requiresRepositoryChange: false, minimalScope: 'config', risks: [], verificationTarget: '用户确认', conclusion: { status: 'accepted', summary: 'waiting' }, unverified: [], schemaVersion: 1, runId: 'run-f2', producerKind: 'worker', sourceVersion: 'def-src-v1', nodeExecutionId: 'run-f2.disposition.1', workerId: 'w' },
      ...(opts.extraArtifacts ?? []),
    ],
  },
});

// F2-1：处置等待 + 不配对的 pendingDecisionKind（final_acceptance / 另一处置种类）→ fail-closed。
test('restore rejects a disposition wait whose pendingDecisionKind does not pair with the disposition type', () => {
  for (const [dispositionType, badKind] of [
    ['wait_decision', 'final_acceptance'],
    ['wait_decision', 'external_action_completion'],
    ['external_action', 'disposition_decision'],
    ['external_action', 'configuration_wait'],
  ] as const) {
    const { entries, store } = makeStore();
    entries.push(dispositionWaitRestoreCheckpoint({ dispositionType, pendingDecisionKind: badKind }));
    throwsCode(
      () => WorkflowRuntime.restore(makeDefinition(), store, 'run-f2'),
      'CHECKPOINT_STATE_INCONSISTENT',
      `${dispositionType} + ${badKind} 应 fail-closed`,
    );
  }
});

// F2-2：处置等待 + 历史验证 Artifact 并存时，等待事实以最新 disposition 为准（配对种类即接受）——
// 防止旧验证现场掩盖 disposition 等待的配对校验。
test('restore accepts a disposition wait paired with the right kind even with a stale verification artifact', () => {
  const { entries, store } = makeStore();
  entries.push(dispositionWaitRestoreCheckpoint({
    dispositionType: 'wait_decision',
    pendingDecisionKind: 'disposition_decision',
    extraArtifacts: [
      { kind: 'verification', accepted: true, evidence: ['test:passed'], unverified: [], schemaVersion: 1, runId: 'run-f2', producerKind: 'worker', sourceVersion: 'def-src-v1', nodeExecutionId: 'run-f2.verify.2', workerId: 'w', conclusion: { status: 'accepted', summary: 'ok' } },
    ],
  }));
  // 最新 disposition 是 wait_decision（处置等待现场仍存在），kind 配对正确 → 接受；
  // 反向场景（无处置等待 + disposition_decision 种类）在 F2-3 覆盖。
  assert.equal(WorkflowRuntime.restore(makeDefinition(), store, 'run-f2').stage, 'WAITING_FOR_USER');
});

// F2-3：种类声明了处置等待但现场无任何处置等待（纯验证等待）→ fail-closed（resume 会按错误种类渲染）。
test('restore rejects a disposition kind declared on a pure verification wait', () => {
  const { entries, store } = makeStore();
  entries.push({ customType: 'workflow-run', data: {
    runId: 'run-f2v', schemaVersion: 1, stage: 'WAITING_FOR_USER', at: 1, id: 'c-f2v', workflowVersion: 'v1', policyDigest: 'd1',
    pendingDecisionRequest: 'req-f2v', pendingDecisionKind: 'disposition_decision',
    artifacts: [
      { kind: 'verification', accepted: true, evidence: ['test:passed'], unverified: [], schemaVersion: 1, runId: 'run-f2v', producerKind: 'worker', sourceVersion: 'def-src-v1', nodeExecutionId: 'run-f2v.verify.1', workerId: 'w', conclusion: { status: 'accepted', summary: 'ok' } },
    ],
  } });
  throwsCode(() => WorkflowRuntime.restore(makeDefinition(), store, 'run-f2v'), 'CHECKPOINT_STATE_INCONSISTENT');
});

// F2-4：legacy checkpoint（处置等待但缺 pendingDecisionKind）沿用推导回退——接受恢复、kind 保持
// undefined，不被误拒（“缺字段 legacy 回退”不回归）。
test('restore accepts a legacy disposition wait without pendingDecisionKind (kind stays undefined)', () => {
  const { entries, store } = makeStore();
  entries.push(dispositionWaitRestoreCheckpoint({ dispositionType: 'wait_decision' }));
  const restored = WorkflowRuntime.restore(makeDefinition(), store, 'run-f2');
  assert.equal(restored.stage, 'WAITING_FOR_USER');
  assert.equal(restored.getPendingDecisionKind(), undefined, 'legacy 缺字段回退推导，不虚构等待种类');
});

// F2-5：合法处置等待（配对种类）不误拒——wait_decision/external_action 各配对应种类均恢复。
test('restore accepts a disposition wait with the matching pendingDecisionKind', () => {
  for (const [dispositionType, kind] of [
    ['wait_decision', 'disposition_decision'],
    ['external_action', 'external_action_completion'],
  ] as const) {
    const { entries, store } = makeStore();
    entries.push(dispositionWaitRestoreCheckpoint({ dispositionType, pendingDecisionKind: kind }));
    const restored = WorkflowRuntime.restore(makeDefinition(), store, 'run-f2');
    assert.equal(restored.stage, 'WAITING_FOR_USER', `${dispositionType} + ${kind} 不得被误拒`);
    assert.equal(restored.getPendingDecisionKind(), kind);
  }
});

// F2b：验证等待的 pendingDecisionKind 必须与验证现场配对——final_acceptance ↔ 已接受验证、
// configuration_wait ↔ 配置类失败验证（accepted=false + failure.kind=configuration）。
// 配对不合法（accepted=true 却声明 configuration_wait 或反之）的伪造/损坏 checkpoint fail-closed；
// legacy 缺字段沿用推导回退（F2-4 已覆盖），合法配对不误拒。
const verificationWaitRestoreCheckpoint = (opts: {
  accepted: boolean;
  failureKind?: 'configuration' | 'implementation';
  pendingDecisionKind?: string;
}) => ({
  customType: 'workflow-run',
  data: {
    runId: 'run-f2v', schemaVersion: 1, stage: 'WAITING_FOR_USER', at: 1, id: 'c-f2v', workflowVersion: 'v1', policyDigest: 'd1',
    pendingDecisionRequest: 'req-f2v',
    ...(opts.pendingDecisionKind !== undefined ? { pendingDecisionKind: opts.pendingDecisionKind } : {}),
    artifacts: [
      {
        kind: 'verification', accepted: opts.accepted, evidence: ['test:passed'], unverified: [], schemaVersion: 1, runId: 'run-f2v',
        producerKind: 'worker', sourceVersion: 'def-src-v1', nodeExecutionId: 'run-f2v.verify.1', workerId: 'w',
        ...(opts.accepted === false ? { failure: { kind: opts.failureKind ?? 'configuration', reason: '配置问题' } } : {}),
        ...(opts.accepted ? { conclusion: { status: 'accepted', summary: 'ok' } } : { conclusion: { status: 'rejected', summary: 'failed' } }),
      },
    ],
  },
});

// F2b-1：final_acceptance + 已接受验证 → 接受恢复（合法等待不误拒）。
test('restore accepts final_acceptance paired with an accepted verification', () => {
  const { entries, store } = makeStore();
  entries.push(verificationWaitRestoreCheckpoint({ accepted: true, pendingDecisionKind: 'final_acceptance' }));
  assert.equal(WorkflowRuntime.restore(makeDefinition(), store, 'run-f2v').stage, 'WAITING_FOR_USER');
  assert.equal(WorkflowRuntime.restore(makeDefinition(), store, 'run-f2v').getPendingDecisionKind(), 'final_acceptance');
});

// F2b-2：final_acceptance + 配置类失败验证 → fail-closed（验证现场与等待种类不配对）。
test('restore rejects final_acceptance declared on a configuration-failed verification', () => {
  const { entries, store } = makeStore();
  entries.push(verificationWaitRestoreCheckpoint({ accepted: false, failureKind: 'configuration', pendingDecisionKind: 'final_acceptance' }));
  throwsCode(() => WorkflowRuntime.restore(makeDefinition(), store, 'run-f2v'), 'CHECKPOINT_STATE_INCONSISTENT');
});

// F2b-3：configuration_wait + 已接受验证（accepted=true 却声明配置等待）→ fail-closed。
test('restore rejects configuration_wait declared on an accepted verification', () => {
  const { entries, store } = makeStore();
  entries.push(verificationWaitRestoreCheckpoint({ accepted: true, pendingDecisionKind: 'configuration_wait' }));
  throwsCode(() => WorkflowRuntime.restore(makeDefinition(), store, 'run-f2v'), 'CHECKPOINT_STATE_INCONSISTENT');
});

// F2b-4：configuration_wait + 配置类失败验证 → 接受恢复（合法配置等待不误拒）。
test('restore accepts configuration_wait paired with a configuration-failed verification', () => {
  const { entries, store } = makeStore();
  entries.push(verificationWaitRestoreCheckpoint({ accepted: false, failureKind: 'configuration', pendingDecisionKind: 'configuration_wait' }));
  const restored = WorkflowRuntime.restore(makeDefinition(), store, 'run-f2v');
  assert.equal(restored.stage, 'WAITING_FOR_USER');
  assert.equal(restored.getPendingDecisionKind(), 'configuration_wait');
});

// F1：continue_disposition 决策记录（decisionRecord）必须保存用户决定内容（note/reasonCode），
// 作为 trace 事实（完整 UserDecision Artifact 持久化仍为延后专项）。
test('decide continue_disposition persists note/reasonCode in the decisionRecord', async () => {
  const { entries, store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-f1rec', () => 21, () => 'gen', { definitionVersion: 'v1', policyDigest: 'd1' });
  const disposition = await runtime.executeNode(
    { id: 'disposition', worker: bareWorker(() => ({ kind: 'disposition', dispositionType: 'wait_decision', requiresRepositoryChange: false, minimalScope: '无', risks: [], verificationTarget: '用户确认', conclusion: { status: 'accepted', summary: '等待用户处置决定' } })) },
    {},
  );
  runtime.setPendingDecisionKind('disposition_decision');
  runtime.transition('WAITING_FOR_USER', disposition.artifact);
  const requestId = pendingRequest(entries);
  const result = runtime.decide({ kind: 'user_decision', decision: 'continue_disposition', requestId, note: '用户决定按 mitigation 处置', reasonCode: 'mitigation' });
  assert.equal(result.outcome, 'reopened');
  assert.equal(result.toStage, 'DISPOSITION');
  const written = entries.at(-1)!.data;
  assert.equal(written.decisionRecord.decision, 'continue_disposition');
  assert.equal(written.decisionRecord.note, '用户决定按 mitigation 处置', 'decisionRecord 必须保存 note（trace 事实）');
  assert.equal(written.decisionRecord.reasonCode, 'mitigation', 'decisionRecord 必须保存 reasonCode（trace 事实）');
  assert.equal(written.decisionReasonCode, 'mitigation', '平铺 decisionReasonCode 同步保存');
});

// S3/F1：isDecisionRecord 值域与 DecisionRecord 类型同步（含 continue_disposition）后，ACCEPTED
// 恢复仍只认 approve 决策记录——continue_disposition 记录即使形状合法也不构成验收（approve 门禁
// 不被新值域削弱）；带 note/reasonCode 的合法 approve 记录不因新字段被拒。
test('ACCEPTED restore still requires an approve decision record (continue_disposition never passes)', async () => {
  const { entries, store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-s3', () => 21, () => 'gen', { definitionVersion: 'v1', policyDigest: 'd1' });
  await runtime.executeNode({ id: 'intake', worker: bareWorker(() => ({ kind: 'intake', summary: '白屏', overview: '登录后白屏' })) }, {});
  runtime.transition('INVESTIGATING');
  const disposition = (await runtime.executeNode({ id: 'disposition', worker: bareWorker(() => ({ kind: 'disposition', dispositionType: 'wait_decision', requiresRepositoryChange: false, minimalScope: 'config', risks: [], verificationTarget: 'tests', conclusion: { status: 'accepted', summary: 'no repo change' } })) }, {})).artifact;
  runtime.transition('DISPOSITION', disposition);
  const verification = (await runtime.executeNode({ id: 'verify', worker: bareWorker(() => ({ kind: 'verification', accepted: true, evidence: ['test:passed'] })) }, {})).artifact;
  runtime.transition('WAITING_FOR_USER', verification);
  const requestId = pendingRequest(entries);
  runtime.decide({ kind: 'user_decision', decision: 'approve', requestId, note: '批准备注', reasonCode: 'accept' });
  assert.equal(runtime.stage, 'ACCEPTED');
  const written = entries.at(-1)!.data;
  // 合法 approve 记录携带 note/reasonCode 不破坏 ACCEPTED 恢复。
  assert.equal(written.decisionRecord.note, '批准备注');
  assert.equal(written.decisionRecord.reasonCode, 'accept');
  assert.equal(WorkflowRuntime.restore(makeDefinition(), store, 'run-s3', { expectedWorkflowVersion: 'v1', expectedPolicyDigest: 'd1' }).stage, 'ACCEPTED');
  // 把决策记录换成 continue_disposition（形状合法、含决定内容）→ 仍不是可验证的 approve 验收事实。
  const tamperedStore = new PiSessionRunStore(
    { getEntries: () => [{ customType: 'workflow-run', data: { ...written, decisionRecord: { ...written.decisionRecord, decision: 'continue_disposition', note: '用户决定继续', reasonCode: undefined } } }] },
    () => {},
  );
  throwsCode(
    () => WorkflowRuntime.restore(makeDefinition(), tamperedStore, 'run-s3', { expectedWorkflowVersion: 'v1', expectedPolicyDigest: 'd1' }),
    'ACCEPTED_CHECKPOINT_INCOMPLETE',
  );
});

// 25. P2-2：决策 Artifact 声明了与 decisionRecord/平铺字段不同的候选版本 → ACCEPTED 验收不成立。
test('restore rejects ACCEPTED when the approve artifact binds a different candidate revision than the record', () => {
  const { entries, store } = makeStore();
  const stamp = (kind: string, nodeId: string, extra: Record<string, unknown>) => ({
    kind, unverified: [], schemaVersion: 1, runId: 'run-p22', producerKind: 'worker', sourceVersion: 'def-src-v1',
    nodeExecutionId: `run-p22.${nodeId}.1`, workerId: 'worker', ...extra,
  });
  entries.push({ customType: 'workflow-run', data: {
    runId: 'run-p22', schemaVersion: 1, stage: 'ACCEPTED', at: 1, id: 'c-p22', workflowVersion: 'v1', policyDigest: 'd1',
    decisionReference: 'req-approve', decisionKind: 'approve', pendingDecisionRequest: 'req-approve', sourceVersion: 'def-src-v1',
    candidateRevision: 'rev-1', decisionCandidateRevision: 'rev-1',
    decisionRecord: { recordId: 'dec:run-p22:1', decision: 'approve', requestId: 'req-approve', producerKind: 'user_decision', producer: 'user', producerName: '用户', source: 'runtime:decide', candidateRevision: 'rev-1' },
    artifacts: [
      stamp('intake', 'intake', { summary: '白屏', overview: '登录后白屏' }),
      stamp('disposition', 'disposition', { dispositionType: 'remediation', requiresRepositoryChange: true, minimalScope: 'a.ts', risks: [], verificationTarget: 'tests' }),
      stamp('implementation', 'implement', { artifact: { summary: 'fix', filesChanged: ['a.ts'], candidateRevision: 'rev-1' } }),
      stamp('change_review', 'change_review', { reviewedRevision: 'rev-1', findings: [], findingDisposition: 'all_closed' }),
      stamp('verification', 'verify', { accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1' }),
      { kind: 'user_decision', decision: 'approve', requestId: 'req-approve', candidateRevision: 'rev-9', schemaVersion: 1, runId: 'run-p22', producerKind: 'user_decision', producer: 'user', producerName: '用户', unverified: [], sourceVersion: 'def-src-v1', id: 'run-p22.user_decision.1' },
    ],
  } });
  throwsCode(() => WorkflowRuntime.restore(makeDefinition(), store, 'run-p22'), 'ACCEPTED_ACCEPTANCE_NOT_MET');
});

// 26. S1/P1 round-4：恢复必须重建 Node→Worker 身份映射——恢复历史作者后，同 worker 新发起
// 的评审仍必须被独立性守卫拒绝（否则恢复即绕过 requireIndependentWorker）。
test('restored artifacts rebuild nodeWorkerIds: same-author re-review after restore is still rejected', () => {
  const { entries, store } = makeStore();
  entries.push({ customType: 'workflow-run', data: {
    runId: 'run-idm', schemaVersion: 1, stage: 'DISPOSITION', at: 1, id: 'c-idm', workflowVersion: 'v1', policyDigest: 'd1',
    artifacts: [
      { kind: 'intake', summary: '白屏', overview: '登录后白屏', unverified: [], schemaVersion: 1, runId: 'run-idm', producerKind: 'worker', sourceVersion: 'baseline', nodeExecutionId: 'run-idm.intake.1', workerId: 'wI', conclusion: { status: 'accepted', summary: 'stamped' } },
      { kind: 'investigation', route: 'local_fix', rootCause: 'cause', evidence: ['trace'], unverified: [], schemaVersion: 1, runId: 'run-idm', producerKind: 'worker', sourceVersion: 'baseline', nodeExecutionId: 'run-idm.investigate.1', workerId: 'author', conclusion: { status: 'accepted', summary: 'stamped' } },
    ],
  } });
  const runtime = WorkflowRuntime.restore(makeDefinition(), store, 'run-idm');
  // 恢复后 nodeWorkerIds['investigate'] 必须包含历史作者 'author'。
  return assert.rejects(
    runtime.runReview(
      'investigation_review',
      [{ id: 'investigation_review', worker: bareWorker(() => ({ kind: 'investigation_review', rootCauseConclusion: 'cause', evidenceSufficiency: 'sufficient', gaps: [], conclusion: { status: 'accepted', summary: 'ok' } }), 'author') }],
      { reviewers: [{ model: 'inherit' }], mode: 'parallel' as const, requiredApprovals: 1, requireIndependentWorker: true, excludeNodes: ['investigate'], onRejected: 'return_to_disposition' as const },
      { reviewedNodeId: 'investigate', reviewArtifactKind: 'investigation_review' },
    ),
    (e: unknown) => (e as { code?: string }).code === 'REVIEWER_NOT_INDEPENDENT',
  );
});

// 27. S4/P4：run_started 是“Runtime 创建新 runId”的一次性事件——恢复同一 runId 后第一个
// Node 不得重复产生启动事件（同一 runId 的审计流只能有一次 run_started）。
test('restore does not re-emit run_started for the same runId', async () => {
  const events: string[] = [];
  const { entries, store } = makeStore();
  // Runtime A：创建 run、执行第一个 Node，产生 run_started。
  const a = new WorkflowRuntime(makeDefinition(), store, 'run-rs', () => 1, () => 'gen', {
    auditSink: { append: (event: FixAuditEvent) => events.push(event.eventType) },
  });
  await a.executeNode({ id: 'intake', worker: bareWorker(() => ({ kind: 'intake', summary: '白屏', overview: '登录后白屏' }), 'wI') }, {});
  entries.push({ customType: 'workflow-run', data: {
    runId: 'run-rs', schemaVersion: 1, stage: 'INVESTIGATING', at: 1, id: 'c-rs', workflowVersion: 'v1', policyDigest: 'd1',
    artifacts: [
      { kind: 'intake', summary: '白屏', overview: '登录后白屏', unverified: [], schemaVersion: 1, runId: 'run-rs', producerKind: 'worker', sourceVersion: 'baseline', nodeExecutionId: 'run-rs.intake.1', workerId: 'wI', conclusion: { status: 'accepted', summary: 'stamped' } },
    ],
  } });
  // Runtime B：恢复同一 runId 后执行下一个 Node，不得再次产生 run_started。
  const b = WorkflowRuntime.restore(makeDefinition(), store, 'run-rs');
  await b.executeNode({ id: 'investigate', worker: bareWorker(() => ({ kind: 'investigation', route: 'local_fix', rootCause: 'cause', evidence: ['trace'] }), 'wA') }, {});
  assert.equal(events.filter((event) => event === 'run_started').length, 1, `expected exactly one run_started, got: ${events.join(', ')}`);
});

// 28. Shape 完整性（round-4 Spec P2）：账本周期所有必填字段都被校验——缺 reviewNodeId / 缺
// recordedAtIndex / approvals 为负数或 NaN 的一根记录都让恢复 fail-closed。
test('restore fails closed when a cycle record misses required shape fields or holds non-finite counts', () => {
  const base = { runId: 'run-sh', schemaVersion: 1, stage: 'DISPOSITION', at: 1, id: 'c-sh', workflowVersion: 'v1', policyDigest: 'd1' };
  const storeFor = (reviewCycles: unknown[]) => new PiSessionRunStore(
    { getEntries: () => [{ customType: 'workflow-run', data: { ...base, reviewCycles } }] },
    () => {},
  );
  const full = { cycleId: 'run-sh.review.1.1', reviewNodeId: 'change_plan_review', reviewArtifactKind: 'change_plan_review', reviewedNodeId: 'disposition', requiredApprovals: 2, approvals: 2, passed: true, reviewerWorkerIds: ['a', 'b'], policyDigest: 'd1', dispositionIndexAtCycle: -1, recordedAtIndex: 5 };
  // 缺 reviewNodeId（节点身份必填）。
  const { reviewNodeId: _r, ...missingNode } = full;
  throwsCode(() => WorkflowRuntime.restore(makeDefinition(), storeFor([missingNode]), 'run-sh'), 'CHECKPOINT_REVIEW_LEDGER_INCONSISTENT');
  // 缺 recordedAtIndex（记账时刻必填）。
  const { recordedAtIndex: _i, ...missingIndex } = full;
  throwsCode(() => WorkflowRuntime.restore(makeDefinition(), storeFor([missingIndex]), 'run-sh'), 'CHECKPOINT_REVIEW_LEDGER_INCONSISTENT');
  // 负数 approvals 不是合法计数。
  throwsCode(() => WorkflowRuntime.restore(makeDefinition(), storeFor([{ ...full, approvals: -1 }]), 'run-sh'), 'CHECKPOINT_REVIEW_LEDGER_INCONSISTENT');
  // NaN 不是合法计数。
  throwsCode(() => WorkflowRuntime.restore(makeDefinition(), storeFor([{ ...full, requiredApprovals: Number.NaN }]), 'run-sh'), 'CHECKPOINT_REVIEW_LEDGER_INCONSISTENT');
  // 完整合法记录（无 reviewPolicyFor 时不推导数字）保持可恢复。
  const ok = WorkflowRuntime.restore(makeDefinition(), storeFor([full]), 'run-sh');
  assert.equal(ok.stage, 'DISPOSITION');
});

// 29. S1/parse 统一：nodeExecutionId 的 node 段解析只有一条严格规则（`${runId}.<node>.<ts>`，
// 无额外段）。恢复校验与 collectNodeWorkerIds 必须共用（否则多段 executionId 通过恢复校验但
// 不登记进 nodeWorkerIds，同一作者在恢复后可自评绕过独立性）。多段/缺段/空段一律 fail-closed。
test('restore fails closed on unparseable worker nodeExecutionId (extra segments cannot slip past)', () => {
  const storeFor = (artifacts: unknown[]) => new PiSessionRunStore(
    { getEntries: () => [{ customType: 'workflow-run', data: { runId: 'run-px', schemaVersion: 1, stage: 'DISPOSITION', at: 1, id: 'c-px', workflowVersion: 'v1', policyDigest: 'd1', artifacts } }] },
    () => {},
  );
  // 多段：run-px.investigate.1.extra 在旧实现下能通过恢复校验（node = 'investigate'）但 skipped
  // 出 nodeWorkerIds['investigate']，同一作者恢复后可以自评。严格规则直接拒绝整个 checkpoint。
  throwsCode(() => WorkflowRuntime.restore(makeDefinition(), storeFor([
    { kind: 'investigation', route: 'local_fix', rootCause: 'cause', evidence: ['trace'], unverified: [], schemaVersion: 1, runId: 'run-px', producerKind: 'worker', sourceVersion: 'baseline', nodeExecutionId: 'run-px.investigate.1.extra', workerId: 'author', conclusion: { status: 'accepted', summary: 'stamped' } },
  ]), 'run-px'), 'INVALID_CHECKPOINT_PROVENANCE');
  // 缺段（node 或 ts 为空）同样 fail-closed。
  throwsCode(() => WorkflowRuntime.restore(makeDefinition(), storeFor([
    { kind: 'investigation', route: 'local_fix', rootCause: 'cause', evidence: ['trace'], unverified: [], schemaVersion: 1, runId: 'run-px', producerKind: 'worker', sourceVersion: 'baseline', nodeExecutionId: 'run-px..1', workerId: 'author', conclusion: { status: 'accepted', summary: 'stamped' } },
  ]), 'run-px'), 'INVALID_CHECKPOINT_PROVENANCE');
  // 合法 worker artifact 恢复不受影响。
  const ok = WorkflowRuntime.restore(makeDefinition(), storeFor([
    { kind: 'intake', summary: '白屏', overview: '登录后白屏', unverified: [], schemaVersion: 1, runId: 'run-px', producerKind: 'worker', sourceVersion: 'baseline', nodeExecutionId: 'run-px.intake.1', workerId: 'wI', conclusion: { status: 'accepted', summary: 'stamped' } },
  ]), 'run-px');
  assert.equal(ok.stage, 'DISPOSITION');
});

// 30. S2/started 标记：首个 Node 即使 Worker 提交前失败（0 Artifact），恢复后也不能对同一 runId
// 重复发出 run_started；无标记且确未启动的 run 恢复后仍允许首次启动事件。
test('restore honors the persisted started marker: no run_started re-emission even with zero artifacts', async () => {
  // (a) started:true + 0 Artifact → 已启动，恢复后执行下一个 Node 不再发启动事件。
  const { entries, store } = makeStore();
  const events: string[] = [];
  entries.push({ customType: 'workflow-run', data: { runId: 'run-st0', schemaVersion: 1, stage: 'INTAKE', at: 1, id: 'c-st0', workflowVersion: 'v1', policyDigest: 'd1', started: true } });
  const b = WorkflowRuntime.restore(makeDefinition(), store, 'run-st0', { auditSink: { append: (event: FixAuditEvent) => events.push(event.eventType) } });
  await b.executeNode({ id: 'investigate', worker: bareWorker(() => ({ kind: 'investigation', route: 'local_fix', rootCause: 'cause', evidence: ['trace'] }), 'wA') }, { phenomenon: '白屏' });
  assert.equal(events.filter((event) => event === 'run_started').length, 0, `no run_started re-emission expected: ${events.join(', ')}`);
  // (b) 无 started 且无 Artifact → 确未启动，恢复后首次执行仍发出 run_started（旧 checkpoint 兼容）。
  const { entries: entries2, store: store2 } = makeStore();
  const events2: string[] = [];
  entries2.push({ customType: 'workflow-run', data: { runId: 'run-st1', schemaVersion: 1, stage: 'INTAKE', at: 1, id: 'c-st1', workflowVersion: 'v1', policyDigest: 'd1' } });
  const c = WorkflowRuntime.restore(makeDefinition(), store2, 'run-st1', { auditSink: { append: (event: FixAuditEvent) => events2.push(event.eventType) } });
  await c.executeNode({ id: 'investigate', worker: bareWorker(() => ({ kind: 'investigation', route: 'local_fix', rootCause: 'cause', evidence: ['trace'] }), 'wA') }, { phenomenon: '白屏' });
  assert.equal(events2.filter((event) => event === 'run_started').length, 1, `expected exactly one run_started: ${events2.join(', ')}`);
});

// 31. S3/身份绑定：账本只绑“人数”不行——评审者身份集合必须与周期 Artifact 的真实 workerId 集合
// 一致（同一人数但换了一伙人仍是伪造）。该事实与策略无关，configured（恢复即拒绝）与
// unconfigured（门禁时拒绝）两条路径都强制。
test('forged reviewer identity set (same count) is rejected by restore and by the gate', async () => {
  // configured 恢复路径：恢复控制面直接拒绝（LEDGER_INCONSISTENT）。
  const revPolicy = FIX_REVIEW_POLICIES['change_plan_review'];
  const baseArtifacts = [
    { kind: 'intake', summary: '白屏', overview: '登录后白屏', unverified: [], schemaVersion: 1, runId: 'run-cfg', producerKind: 'worker', sourceVersion: 'baseline', nodeExecutionId: 'run-cfg.intake.1', workerId: 'wI', conclusion: { status: 'accepted', summary: 'stamped' } },
    { kind: 'investigation', route: 'local_fix', rootCause: 'cause', evidence: ['trace'], unverified: [], schemaVersion: 1, runId: 'run-cfg', producerKind: 'worker', sourceVersion: 'baseline', nodeExecutionId: 'run-cfg.investigate.1', workerId: 'author', conclusion: { status: 'accepted', summary: 'stamped' } },
    { kind: 'disposition', dispositionType: 'remediation', requiresRepositoryChange: true, minimalScope: 'a.ts', risks: [], verificationTarget: 'tests', unverified: [], conclusion: { status: 'accepted', summary: 'plan' }, schemaVersion: 1, runId: 'run-cfg', producerKind: 'worker', sourceVersion: 'baseline', nodeExecutionId: 'run-cfg.disposition.1', workerId: 'wD' },
    { kind: 'change_plan_review', rootCauseAlignment: true, changedScope: 'a.ts', risks: [], compatibility: [], verification: [], rollback: [], findings: [], unverified: [], conclusion: { status: 'accepted', summary: 'ok1' }, schemaVersion: 1, runId: 'run-cfg', producerKind: 'worker', sourceVersion: 'baseline', nodeExecutionId: 'run-cfg.change_plan_review.1', workerId: 'r1', reviewCycleId: 'run-cfg.review.1.1', reviewedNodeId: 'disposition' },
    { kind: 'change_plan_review', rootCauseAlignment: true, changedScope: 'a.ts', risks: [], compatibility: [], verification: [], rollback: [], findings: [], unverified: [], conclusion: { status: 'accepted', summary: 'ok2' }, schemaVersion: 1, runId: 'run-cfg', producerKind: 'worker', sourceVersion: 'baseline', nodeExecutionId: 'run-cfg.change_plan_review.2', workerId: 'r2', reviewCycleId: 'run-cfg.review.1.1', reviewedNodeId: 'disposition' },
  ];
  const cycle = {
    cycleId: 'run-cfg.review.1.1', reviewNodeId: 'change_plan_review', reviewArtifactKind: 'change_plan_review', reviewedNodeId: 'disposition',
    requiredApprovals: revPolicy.requiredApprovals, approvals: 2, passed: true, reviewerWorkerIds: ['r1', 'r2'],
    policyDigest: serializeReviewPolicy(revPolicy), dispositionIndexAtCycle: 2, recordedAtIndex: 4,
  };
  const storeFor = (reviewCycles: unknown[]) => new PiSessionRunStore(
    { getEntries: () => [{ customType: 'workflow-run', data: { runId: 'run-cfg', schemaVersion: 1, stage: 'DISPOSITION', at: 1, id: 'c-cfg', workflowVersion: 'v1', policyDigest: 'd1', artifacts: baseArtifacts, reviewCycles } }] },
    () => {},
  );
  const restoreWith = (reviewCycles: unknown[]) => WorkflowRuntime.restore(makeDefinition(), storeFor(reviewCycles), 'run-cfg', { reviewPolicyFor: () => revPolicy });
  assert.equal(restoreWith([cycle]).stage, 'DISPOSITION'); // 原样可恢复
  throwsCode(() => restoreWith([{ ...cycle, reviewerWorkerIds: ['r1', 'r3'] }]), 'CHECKPOINT_REVIEW_LEDGER_INCONSISTENT');
  throwsCode(() => restoreWith([{ ...cycle, reviewerWorkerIds: ['r3', 'r4'] }]), 'CHECKPOINT_REVIEW_LEDGER_INCONSISTENT');
  // 换人 + recordedAtIndex 越界同样拒绝。
  throwsCode(() => restoreWith([{ ...cycle, reviewerWorkerIds: ['r1', 'r2'], recordedAtIndex: 500 }]), 'CHECKPOINT_REVIEW_LEDGER_INCONSISTENT');
  // unconfigured 恢复路径（无 resolver）：restore 形状通过，但门禁（DISPOSITION→IMPLEMENTING）
  // 用与策略无关的“账本事实支撑”拒绝（身份集合 / recordedAtIndex 不匹配）。
  const { entries, store } = makeStore();
  const runtime = new WorkflowRuntime(makeDefinition(), store, 'run-cyc2', () => 21, () => 'gen');
  await bootToDisposition(runtime);
  const disposition = (await runtime.executeNode({ id: 'disposition', worker: bareWorker(() => ({ kind: 'disposition', dispositionType: 'remediation', requiresRepositoryChange: true, minimalScope: 'a.ts', risks: [], verificationTarget: 'tests', conclusion: { status: 'accepted', summary: 'plan' } })) }, {})).artifact;
  await runtime.runReview(
    'change_plan_review',
    [
      { id: 'change_plan_review', worker: bareWorker(() => ({ kind: 'change_plan_review', rootCauseAlignment: true, changedScope: 'a.ts', risks: [], compatibility: [], verification: [], rollback: [], findings: [], conclusion: { status: 'accepted', summary: 'ok' } }), 'cpr-c2') },
      { id: 'change_plan_review', worker: bareWorker(() => ({ kind: 'change_plan_review', rootCauseAlignment: true, changedScope: 'a.ts', risks: [], compatibility: [], verification: [], rollback: [], findings: [], conclusion: { status: 'accepted', summary: 'ok2' } }), 'cpr-c3') },
    ],
    { reviewers: [{ model: 'inherit' }, { model: 'inherit' }], mode: 'parallel' as const, requiredApprovals: 2, requireIndependentWorker: false, excludeNodes: [], onRejected: 'return_to_disposition' },
    { reviewedNodeId: 'disposition', reviewArtifactKind: 'change_plan_review' },
  );
  // 过渡到 IMPLEMENTING 才会把含 reviewCycles 账本的 checkpoint 落盘（gate 校验周期后再记账）。
  runtime.transition('IMPLEMENTING', disposition);
  const written = entries.at(-1)!.data;
  const tamperIdentity = { ...written, stage: 'DISPOSITION' as const, reviewCycles: (written.reviewCycles as unknown[]).map((record) => ({ ...record as Record<string, unknown>, reviewerWorkerIds: ['x', 'y'] })) };
  const restoredTampered = WorkflowRuntime.restore(makeDefinition(), new PiSessionRunStore({ getEntries: () => [{ customType: 'workflow-run', data: tamperIdentity }] }, () => {}), 'run-cyc2');
  const cplan = restoredTampered.getArtifacts().filter((a) => a.kind === 'change_plan_review').at(-1);
  throwsCode(() => restoredTampered.transition('IMPLEMENTING', cplan), 'CHANGE_PLAN_REVIEW_NOT_PASSED');
  const tamperIndex = { ...written, reviewCycles: (written.reviewCycles as unknown[]).map((record) => ({ ...record as Record<string, unknown>, recordedAtIndex: 999 })), stage: 'DISPOSITION' };
  const restoredIndex = WorkflowRuntime.restore(makeDefinition(), new PiSessionRunStore({ getEntries: () => [{ customType: 'workflow-run', data: tamperIndex }] }, () => {}), 'run-cyc2');
  throwsCode(() => restoredIndex.transition('IMPLEMENTING', restoredIndex.getArtifacts().filter((a) => a.kind === 'change_plan_review').at(-1)), 'CHANGE_PLAN_REVIEW_NOT_PASSED');
});

// 32. round-6 P1-1：started 标记必须携带版本/策略/来源上下文——通用 Runtime 首 Worker 在提交前
// 失败（0 Artifact）后 rescue 恢复保持完整可完成，能一路上到 ACCEPTED（缺上下文会被标记
// checkpointIncomplete 或 ACCEPTED_SOURCE_VERSION_MISMATCH，验收永远无法通过）。
// 注意：本测试用通用 makeDefinition 验证 Runtime 最小标记救援路径；Fix 生产主循环的恢复接线
// （多阶段节点）由 session-resume.test.ts / accepted-restore.test.ts 覆盖。
test('started marker carries version/policy/source context: generic first-worker-failure rescue reaches ACCEPTED', async () => {
  const { entries, store } = makeStore();
  const definition = makeDefinition({ requiresArtifactConclusion: true });
  // run-start checkpoint（fix 入口写入：workflowVersion + policyDigest）。
  entries.push({ customType: 'workflow-run', data: {
    runId: 'run-st2', schemaVersion: 1, stage: 'INTAKE', at: 1, id: 'c-st2-ini', workflowVersion: 'v1', policyDigest: 'd1',
  } });
  const restoreSt = () => WorkflowRuntime.restore(definition, store, 'run-st2', { expectedWorkflowVersion: 'v1', expectedPolicyDigest: 'd1' });
  const r1 = restoreSt();
  // 真实 executeNode：首个 Node 的 Worker 在提交前失败（抛错，0 Artifact，无过渡 checkpoint）。
  await assert.rejects(
    () => r1.executeNode({ id: 'intake', worker: { execute: async () => { throw new Error('transient'); } } }, {}),
    /transient/,
  );
  // 此刻最后一条 checkpoint 是 started 标记，且带版本/策略/来源上下文（不破坏完整性）。
  const marker = entries.at(-1)!.data;
  assert.equal(marker.started, true);
  assert.equal(marker.stage, 'INTAKE');
  assert.equal(marker.workflowVersion, 'v1');
  assert.equal(marker.policyDigest, 'd1');
  assert.equal(marker.sourceVersion, 'def-src-v1');
  assert.equal(marker.artifacts, undefined);
  // rescue：恢复 started 标记 checkpoint → 0 Artifact 但完整性/来源上下文可继续。
  const r2 = restoreSt();
  assert.equal(r2.stage, 'INTAKE');
  assert.equal(r2.getArtifacts().length, 0);
  // 恢复后续跑：重试 intake → 验证通过 → approve（requiresArtifactConclusion 下 checkpoint_complete
  // 与来源绑定都必须满足才能进入 ACCEPTED）。
  await r2.executeNode({ id: 'intake', worker: bareWorker(() => ({ kind: 'intake', summary: '白屏', overview: '登录后白屏', conclusion: { status: 'accepted', summary: 'ok' } })) }, {});
  const verify = (await r2.executeNode({ id: 'verify', worker: bareWorker(() => ({ kind: 'verification', accepted: true, evidence: ['test:passed'], conclusion: { status: 'accepted', summary: 'verified' } })) }, {})).artifact;
  r2.transition('WAITING_FOR_USER', verify);
  const requestId = pendingRequest(entries);
  const result = r2.decide({ kind: 'user_decision', decision: 'approve', requestId });
  assert.equal(result.outcome, 'accepted');
  assert.equal(r2.stage, 'ACCEPTED');
});

// 33. round-6 P2-1：cycleId 是账本↔Artifact 的唯一绑定键——checkpoint 中重复 cycleId
// （两条同 id 的完整记录）让反向查找的解释取决于记录顺序，一律 fail-closed。
test('restore fails closed on duplicate reviewCycleId (cycle identity must be unique per run)', () => {
  const full = { cycleId: 'run-dup.review.1.1', reviewNodeId: 'change_plan_review', reviewArtifactKind: 'change_plan_review', reviewedNodeId: 'disposition', requiredApprovals: 2, approvals: 2, passed: true, reviewerWorkerIds: ['a', 'b'], policyDigest: 'd1', dispositionIndexAtCycle: -1, recordedAtIndex: 5 };
  const storeFor = (reviewCycles: unknown[]) => new PiSessionRunStore(
    { getEntries: () => [{ customType: 'workflow-run', data: { runId: 'run-dup', schemaVersion: 1, stage: 'DISPOSITION', at: 1, id: 'c-dup', workflowVersion: 'v1', policyDigest: 'd1', reviewCycles } }] },
    () => {},
  );
  // 两条完全合法但同 id 的记录 → 拒绝（不再静默接受第一条/最后一条）。
  throwsCode(() => WorkflowRuntime.restore(makeDefinition(), storeFor([full, { ...full }]), 'run-dup'), 'CHECKPOINT_REVIEW_LEDGER_INCONSISTENT');
  // 一条记录（唯一 id）保持可恢复。
  const ok = WorkflowRuntime.restore(makeDefinition(), storeFor([full]), 'run-dup');
  assert.equal(ok.stage, 'DISPOSITION');
});

// 34. round-7：定义声明 version 时它就是恢复的默认期望版本——调用方未显式传
// expectedWorkflowVersion 也不能接受错误版本；definition.version 未声明则保持 unbound（向后兼容）。
test('restore default-binds workflowVersion from the definition when it declares one', () => {
  const storeFor = (workflowVersion: string | undefined) => new PiSessionRunStore(
    { getEntries: () => [{ customType: 'workflow-run', data: { runId: 'run-db', schemaVersion: 1, stage: 'INTAKE', at: 1, id: 'c-db', workflowVersion, policyDigest: 'd1' } }] },
    () => {},
  );
  // 定义声明 v1（makeDefinition version），checkpoint 写 v9 → 即使调用方未传 expected 也拒绝。
  throwsCode(() => WorkflowRuntime.restore(makeDefinition(), storeFor('v9'), 'run-db'), 'WORKFLOW_VERSION_MISMATCH');
  // 定义未声明 version → unbound：checkpoint 自带任意版本仍可恢复（兼容路径）。
  const noVersion: WorkflowDefinition = { ...makeDefinition(), version: undefined };
  assert.equal(WorkflowRuntime.restore(noVersion, storeFor('whatever-v2'), 'run-db').stage, 'INTAKE');
});
