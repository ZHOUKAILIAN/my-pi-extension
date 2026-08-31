import test from 'node:test';
import assert from 'node:assert/strict';
import type { Artifact, WorkerExecutor } from '@pi/workflow-contracts';
import {
  FIX_WORKFLOW_ID,
  FIX_WORKFLOW_VERSION,
  FIX_REASON_TO_STAGE,
  fixReasonToStage,
  FIX_NODE_IDS,
  FIX_NODE_PROFILES,
  FIX_SPECIAL_NODES,
  FIX_REVIEW_POLICIES,
  FIX_VERIFICATION_REQUIREMENT,
  FIX_ACCEPTANCE,
  fixDefinitionV2,
  buildFixV2Nodes,
  makeReviewerNode,
} from '../src/definition.ts';

// ---- 测试夹具 -------------------------------------------------------------

const intakeArtifact: Artifact = { kind: 'intake', summary: '登录后白屏', overview: '用户登录后页面白屏，影响核心链路，怀疑前端渲染异常' };
const investigationArtifact: Artifact = {
  kind: 'investigation', route: 'local_fix', rootCause: '未初始化状态导致空值访问', evidence: ['log: 空值访问 trace'],
  conclusion: { status: 'accepted', summary: '根因已确认' },
};
const dispositionChange: Artifact = {
  kind: 'disposition',
  dispositionType: 'remediation',
  requiresRepositoryChange: true,
  minimalScope: '仅修复状态初始化',
  risks: [],
  verificationTarget: '原始场景复测',
  conclusion: { status: 'accepted', summary: '处置方案已确认' },
};
const approveDecision: Artifact = { kind: 'user_decision', decision: 'approve', requestId: 'req-1' };
const requestChangesDecision: Artifact = {
  kind: 'user_decision', decision: 'request_changes', requestId: 'req-1', reasonCode: 'fix_incomplete_or_regression',
};

// ---- 1. 原因码 → 阶段映射 --------------------------------------------------

test('FIX_REASON_TO_STAGE 将每个原因码映射到正确回流阶段', () => {
  assert.equal(FIX_REASON_TO_STAGE.root_cause_or_impact, 'INVESTIGATING');
  assert.equal(FIX_REASON_TO_STAGE.fix_incomplete_or_regression, 'IMPLEMENTING');
  assert.equal(FIX_REASON_TO_STAGE.requirement_disposition_error, 'DISPOSITION');
  assert.equal(FIX_REASON_TO_STAGE.missing_external_condition, 'BLOCKED');
});

test('fixReasonToStage 对未知原因码回落 IMPLEMENTING', () => {
  assert.equal(fixReasonToStage('root_cause_or_impact'), 'INVESTIGATING');
  assert.equal(fixReasonToStage('fix_incomplete_or_regression'), 'IMPLEMENTING');
  assert.equal(fixReasonToStage('requirement_disposition_error'), 'DISPOSITION');
  assert.equal(fixReasonToStage('missing_external_condition'), 'BLOCKED');
  assert.equal(fixReasonToStage('unknown_reason'), 'IMPLEMENTING');
  assert.equal(fixReasonToStage(undefined), 'IMPLEMENTING');
  assert.equal(fixReasonToStage(''), 'IMPLEMENTING');
});

// ---- 2. Review 策略不变量 ---------------------------------------------------

test('review 策略满足 quorum、parallel 模式与排除节点不变量', () => {
  for (const [reviewNodeId, policy] of Object.entries(FIX_REVIEW_POLICIES)) {
    assert.ok(policy.reviewers.length >= policy.requiredApprovals, `${reviewNodeId}: reviewers.length 小于 requiredApprovals`);
    assert.equal(policy.mode, 'parallel', `${reviewNodeId}: mode 必须是 parallel`);
    assert.ok(policy.requiredApprovals >= 1, `${reviewNodeId}: requiredApprovals 必须 >= 1`);
    assert.ok(policy.requireIndependentWorker === true, `${reviewNodeId}: 必须要求独立 Worker`);
    assert.ok(!policy.excludeNodes.includes(reviewNodeId), `${reviewNodeId}: excludeNodes 不能包含自身评审节点`);
  }
});

// ---- 3. 验证要求 -------------------------------------------------------------

test('verification 配置强制证据、版本绑定与剩余风险记录', () => {
  assert.deepEqual(FIX_VERIFICATION_REQUIREMENT.requiredChecks, [
    'original_issue', 'root_cause_cut', 'identified_impact_surface', 'regression_and_compatibility',
  ]);
  assert.equal(FIX_VERIFICATION_REQUIREMENT.requireToolOrTestEvidence, true);
  assert.equal(FIX_VERIFICATION_REQUIREMENT.requireCandidateRevisionMatch, true);
  assert.equal(FIX_VERIFICATION_REQUIREMENT.allowUnverified, false);
  assert.equal(FIX_VERIFICATION_REQUIREMENT.requireRemainingRisk, true);
  assert.equal(FIX_VERIFICATION_REQUIREMENT.onRejected, 'return_to_implementation');
});

// ---- 4. 验收清单 -------------------------------------------------------------

test('acceptance 要求人工最终验收与候选版本一致性', () => {
  assert.equal(FIX_ACCEPTANCE.humanFinalApproval, true);
  assert.ok(FIX_ACCEPTANCE.requires.includes('human_final_approval'));
  assert.ok(FIX_ACCEPTANCE.requires.includes('candidate_revision_consistent'));
  assert.ok(FIX_ACCEPTANCE.requires.includes('intake_accepted'));
  // P1：调查自身必须构成可接受事实（与配对评审一起保证证据链），否则不得进入验收与处置。
  assert.ok(FIX_ACCEPTANCE.requires.includes('investigation_accepted'));
  assert.ok(FIX_ACCEPTANCE.requires.includes('investigation_review_accepted'));
  assert.ok(FIX_ACCEPTANCE.repositoryChangeRequires!.includes('change_review_accepted'));
  assert.ok(FIX_ACCEPTANCE.repositoryChangeRequires!.includes('implementation_accepted'));
  assert.ok(FIX_ACCEPTANCE.repositoryChangeRequires!.includes('change_plan_review_accepted'));
});

// ---- 5. guard 抽样 ------------------------------------------------------------

test('fixDefinitionV2.guard 保留普通合法边但拒绝直接进入 ACCEPTED', () => {
  fixDefinitionV2.guard('INTAKE', 'INVESTIGATING', intakeArtifact);
  fixDefinitionV2.guard('DISPOSITION', 'IMPLEMENTING', dispositionChange);
  fixDefinitionV2.guard('INVESTIGATING', 'DISPOSITION', investigationArtifact);
  assert.throws(
    () => fixDefinitionV2.guard('WAITING_FOR_USER', 'ACCEPTED', approveDecision),
    /ACCEPTED_IS_CONTROLLER_ONLY/,
  );
});

test('fixDefinitionV2.guard 拒绝非法边', () => {
  assert.throws(
    () => fixDefinitionV2.guard('INTAKE', 'IMPLEMENTING', intakeArtifact),
    /INVALID_TRANSITION INTAKE->IMPLEMENTING/,
  );
  assert.throws(
    () => fixDefinitionV2.guard('WAITING_FOR_USER', 'ACCEPTED', requestChangesDecision),
    /ACCEPTED_IS_CONTROLLER_ONLY/,
  );
  assert.throws(
    () => fixDefinitionV2.guard('INTAKE', 'INVESTIGATING', investigationArtifact),
    /MISSING_INTAKE/,
  );
  assert.throws(
    () => fixDefinitionV2.guard('ACCEPTED', 'INVESTIGATING', investigationArtifact),
    /INVALID_TRANSITION ACCEPTED->INVESTIGATING/,
  );
});

// P1：进入 DISPOSITION 前调查自身必须是可接受事实（conclusion accepted + route 可行动）。
test('fixDefinitionV2.guard 拒绝 conclusion 被拒的 investigation 进入 DISPOSITION', () => {
  const rejected: Artifact = {
    kind: 'investigation', route: 'local_fix', rootCause: '猜测的根因', evidence: ['log: 空值访问 trace'],
    conclusion: { status: 'rejected', summary: '证据不足，根因未确认' },
  };
  assert.throws(() => fixDefinitionV2.guard('INVESTIGATING', 'DISPOSITION', rejected), /INVESTIGATION_NOT_ACCEPTED/);
  const blocked: Artifact = {
    kind: 'investigation', route: 'local_fix', rootCause: '外部依赖缺失', evidence: ['external: blocked'],
    conclusion: { status: 'blocked', summary: '外部条件缺失' },
  };
  assert.throws(() => fixDefinitionV2.guard('INVESTIGATING', 'DISPOSITION', blocked), /INVESTIGATION_NOT_ACCEPTED/);
});

test('fixDefinitionV2.guard 拒绝 route 不可行动的 investigation 进入 DISPOSITION', () => {
  const needsMoreEvidence: Artifact = {
    kind: 'investigation', route: 'needs_more_evidence', rootCause: '证据不完整', evidence: ['missing'],
    conclusion: { status: 'accepted', summary: '需要补充证据' },
  };
  assert.throws(() => fixDefinitionV2.guard('INVESTIGATING', 'DISPOSITION', needsMoreEvidence), /INVESTIGATION_ROUTE_NOT_ACTIONABLE/);
  // requirement_change / design_change 是可行动的处置路线（进入需求/方案决策）。
  fixDefinitionV2.guard('INVESTIGATING', 'DISPOSITION', { ...investigationArtifact, route: 'requirement_change' });
  fixDefinitionV2.guard('INVESTIGATING', 'DISPOSITION', { ...investigationArtifact, route: 'design_change' });
});

// D4：验证失败三向路由的状态机边界。
test('VERIFYING->IMPLEMENTING 只允许实现类失败，配置/外部条件类失败拒绝回流', () => {
  const failedImplementation: Artifact = { kind: 'verification', accepted: false, evidence: ['test:failed'], candidateRevision: 'rev-1', failure: { kind: 'implementation', reason: '回归失败' } };
  const failedConfig: Artifact = { kind: 'verification', accepted: false, evidence: ['test:failed'], candidateRevision: 'rev-1', failure: { kind: 'configuration', reason: '配置错误' } };
  const failedExternal: Artifact = { kind: 'verification', accepted: false, evidence: ['external:blocked'], candidateRevision: 'rev-1', failure: { kind: 'external_condition', reason: '无权限', responsibility: '环境所有者', resolution: '提供凭据' } };
  fixDefinitionV2.guard('VERIFYING', 'IMPLEMENTING', failedImplementation);
  assert.throws(() => fixDefinitionV2.guard('VERIFYING', 'IMPLEMENTING', failedConfig), /VERIFICATION_FAILURE_NOT_IMPLEMENTATION/);
  assert.throws(() => fixDefinitionV2.guard('VERIFYING', 'IMPLEMENTING', failedExternal), /VERIFICATION_FAILURE_NOT_IMPLEMENTATION/);
});

test('VERIFYING->WAITING_FOR_USER 允许验收通过与配置类失败，拒绝其他失败类别', () => {
  const passedVerification: Artifact = { kind: 'verification', accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1' };
  const failedConfig: Artifact = { kind: 'verification', accepted: false, evidence: ['test:failed'], candidateRevision: 'rev-1', failure: { kind: 'configuration', reason: '配置错误' } };
  const failedImplementation: Artifact = { kind: 'verification', accepted: false, evidence: ['test:failed'], candidateRevision: 'rev-1', failure: { kind: 'implementation', reason: '回归失败' } };
  fixDefinitionV2.guard('VERIFYING', 'WAITING_FOR_USER', passedVerification);
  fixDefinitionV2.guard('VERIFYING', 'WAITING_FOR_USER', failedConfig);
  assert.throws(() => fixDefinitionV2.guard('VERIFYING', 'WAITING_FOR_USER', failedImplementation), /VERIFICATION_NOT_ACCEPTED/);
});

test('VERIFYING->BLOCKED 仍需 guard_rejection 证据', () => {
  fixDefinitionV2.guard('VERIFYING', 'BLOCKED', { kind: 'guard_rejection', error: 'blocked' } as Artifact);
  assert.throws(
    () => fixDefinitionV2.guard('VERIFYING', 'BLOCKED', undefined),
    /MISSING_BLOCKER/,
  );
});

// D3：处置自动等待的状态机边界（需要用户决定 / 外部动作完成的处置先停 WAITING_FOR_USER）。
test('DISPOSITION->WAITING_FOR_USER 只允许 wait_decision / external_action 处置', () => {
  const waitDecision: Artifact = {
    kind: 'disposition', dispositionType: 'wait_decision', requiresRepositoryChange: false, minimalScope: '无', risks: [], verificationTarget: '用户确认处置方向', conclusion: { status: 'accepted', summary: '等待用户处置决定' },
  };
  const externalAction: Artifact = {
    kind: 'disposition', dispositionType: 'external_action', requiresRepositoryChange: false, minimalScope: '无', risks: [], verificationTarget: '外部动作完成后复测', conclusion: { status: 'accepted', summary: '等待外部动作完成' },
  };
  const remediation: Artifact = {
    kind: 'disposition', dispositionType: 'remediation', requiresRepositoryChange: false, minimalScope: 'a.ts', risks: [], verificationTarget: 'tests', conclusion: { status: 'accepted', summary: '常规修复' },
  };
  fixDefinitionV2.guard('DISPOSITION', 'WAITING_FOR_USER', waitDecision);
  fixDefinitionV2.guard('DISPOSITION', 'WAITING_FOR_USER', externalAction);
  assert.throws(() => fixDefinitionV2.guard('DISPOSITION', 'WAITING_FOR_USER', remediation), /NOT_DISPOSITION_WAITING/);
  // B5：声明正式方案评审的处置不得走等待边（先 BLOCKED）。
  assert.throws(
    () => fixDefinitionV2.guard('DISPOSITION', 'WAITING_FOR_USER', { ...waitDecision, requiresFormalPlanReview: true }),
    /FORMAL_PLAN_REVIEW_REQUIRED/,
  );
});

// D3/D5 防御纵深：wait_decision / external_action 与 requiresFormalPlanReview 不得直进 IMPLEMENTING/VERIFYING。
test('DISPOSITION->IMPLEMENTING / ->VERIFYING 拒绝需等待的处置与正式方案评审声明', () => {
  const waitDecision: Artifact = {
    kind: 'disposition', dispositionType: 'wait_decision', requiresRepositoryChange: false, minimalScope: '无', risks: [], verificationTarget: '用户确认', conclusion: { status: 'accepted', summary: '等待用户' },
  };
  const externalAction: Artifact = {
    kind: 'disposition', dispositionType: 'external_action', requiresRepositoryChange: false, minimalScope: '无', risks: [], verificationTarget: '外部完成后复测', conclusion: { status: 'accepted', summary: '等待外部' },
  };
  assert.throws(() => fixDefinitionV2.guard('DISPOSITION', 'VERIFYING', waitDecision), /DISPOSITION_WAITING_REQUIRED/);
  assert.throws(() => fixDefinitionV2.guard('DISPOSITION', 'VERIFYING', externalAction), /DISPOSITION_WAITING_REQUIRED/);
  assert.throws(() => fixDefinitionV2.guard('DISPOSITION', 'IMPLEMENTING', { ...dispositionChange, requiresFormalPlanReview: true }), /FORMAL_PLAN_REVIEW_REQUIRED/);
  assert.throws(() => fixDefinitionV2.guard('DISPOSITION', 'VERIFYING', { ...dispositionChange, requiresRepositoryChange: false, requiresFormalPlanReview: true }), /FORMAL_PLAN_REVIEW_REQUIRED/);
  // 常规处置不受影响（与既有语义一致）。
  fixDefinitionV2.guard('DISPOSITION', 'IMPLEMENTING', dispositionChange);
  fixDefinitionV2.guard('DISPOSITION', 'VERIFYING', { ...dispositionChange, requiresRepositoryChange: false });
});

// D3：continue_disposition 是处置等待的继续出口（回 DISPOSITION 重落地处置）。
test('WAITING_FOR_USER->DISPOSITION 允许 continue_disposition 与需求/处置错误打回', () => {
  const continueDecision: Artifact = { kind: 'user_decision', decision: 'continue_disposition', requestId: 'req-1' };
  const dispositionError: Artifact = { kind: 'user_decision', decision: 'request_changes', requestId: 'req-1', reasonCode: 'requirement_disposition_error' };
  const wrongDecision: Artifact = { kind: 'user_decision', decision: 'request_changes', requestId: 'req-1', reasonCode: 'fix_incomplete_or_regression' };
  fixDefinitionV2.guard('WAITING_FOR_USER', 'DISPOSITION', continueDecision);
  fixDefinitionV2.guard('WAITING_FOR_USER', 'DISPOSITION', dispositionError);
  assert.throws(() => fixDefinitionV2.guard('WAITING_FOR_USER', 'DISPOSITION', wrongDecision), /REASON_NOT_DISPOSITION_ERROR/);
});

// D3：外部动作完成等待的继续出口（无仓库变更回 VERIFYING 验证既有现场）。
test('WAITING_FOR_USER->VERIFYING 允许 continue_disposition 与 continue_verification，拒绝 approve', () => {
  const continueDecision: Artifact = { kind: 'user_decision', decision: 'continue_disposition', requestId: 'req-1' };
  const continueVerification: Artifact = { kind: 'user_decision', decision: 'continue_verification', requestId: 'req-1' };
  const approve: Artifact = { kind: 'user_decision', decision: 'approve', requestId: 'req-1' };
  fixDefinitionV2.guard('WAITING_FOR_USER', 'VERIFYING', continueDecision);
  fixDefinitionV2.guard('WAITING_FOR_USER', 'VERIFYING', continueVerification);
  assert.throws(() => fixDefinitionV2.guard('WAITING_FOR_USER', 'VERIFYING', approve), /NOT_CONTINUE_VERIFICATION/);
});

test('fixDefinitionV2.transition 不公开接受 WAITING_FOR_USER->ACCEPTED', () => {
  // 即使带合法 approve 决策（含候选版本）也不能通过 Definition 公开接口进入 ACCEPTED。
  assert.throws(
    () => fixDefinitionV2.transition('WAITING_FOR_USER', 'ACCEPTED', approveDecision),
    /ACCEPTED_IS_CONTROLLER_ONLY/,
  );
  assert.throws(
    () => fixDefinitionV2.transition('WAITING_FOR_USER', 'ACCEPTED', { ...approveDecision, candidateRevision: 'rev-1' }),
    /ACCEPTED_IS_CONTROLLER_ONLY/,
  );
  // 只有 WorkflowRuntime.decide() 的受控 approve 路径能进入 ACCEPTED（由 runtime 测试覆盖）。
});

// ---- 6. 节点构造 ---------------------------------------------------------------

test('buildFixV2Nodes 生成 5 个纯 worker 节点且工具集符合轮廓', () => {
  const nodes = buildFixV2Nodes({});
  assert.deepEqual(Object.keys(nodes).sort(), ['disposition', 'implement', 'intake', 'investigate', 'verify']);
  assert.ok(!nodes.investigate.profile!.tools.includes('edit'));
  assert.ok(!nodes.investigate.profile!.tools.includes('bash'));
  assert.ok(nodes.implement.profile!.tools.includes('edit'));
  assert.ok(nodes.implement.profile!.tools.includes('write'));
  assert.deepEqual(nodes.implement.profile!.skills, ['tdd']);
  assert.ok(nodes.verify.profile!.tools.includes('submit_artifact'));
});

test('makeReviewerNode 绑定 executor 并复用评审节点轮廓', () => {
  const executor: WorkerExecutor = {
    execute: async () => ({
      kind: 'investigation_review',
      rootCauseConclusion: '根因已确认',
      evidenceSufficiency: 'sufficient',
      gaps: [],
      conclusion: { status: 'accepted', summary: '复核通过' },
    }),
  };
  const node = makeReviewerNode('investigation_review', executor);
  assert.equal(node.id, 'investigation_review');
  assert.equal(node.worker, executor);
  assert.deepEqual(node.profile!.tools, ['read', 'submit_artifact']);
  assert.deepEqual(node.profile!.skills, []);
});

// ---- 7. 轮廓覆盖与评审契约 -------------------------------------------------------

test('FIX_NODE_PROFILES 覆盖全部 8 个 FixNodeId', () => {
  assert.deepEqual([...FIX_NODE_IDS], ['intake', 'investigate', 'investigation_review', 'disposition', 'change_plan_review', 'implement', 'change_review', 'verify']);
  for (const nodeId of FIX_NODE_IDS) {
    assert.ok(FIX_NODE_PROFILES[nodeId], `缺少 ${nodeId} 的节点轮廓`);
    assert.ok(FIX_NODE_PROFILES[nodeId].tools.length > 0, `${nodeId} 工具集不能为空`);
    assert.ok(FIX_NODE_PROFILES[nodeId].defaultSkills !== undefined, `${nodeId} 缺少默认 skills`);
  }
});

test('FIX_SPECIAL_NODES 定义被评审节点到评审节点的契约', () => {
  assert.equal(FIX_SPECIAL_NODES.investigate.nodeId, 'investigation_review');
  assert.equal(FIX_SPECIAL_NODES.investigate.reviewArtifactKind, 'investigation_review');
  assert.equal(FIX_SPECIAL_NODES.disposition.nodeId, 'change_plan_review');
  assert.equal(FIX_SPECIAL_NODES.disposition.reviewArtifactKind, 'change_plan_review');
  assert.equal(FIX_SPECIAL_NODES.implement.nodeId, 'change_review');
  assert.equal(FIX_SPECIAL_NODES.implement.reviewArtifactKind, 'change_review');
});

// ---- 8. 工作流身份 ---------------------------------------------------------------

test('工作流身份为 fix / fix-v2 且初始阶段为 INTAKE', () => {
  assert.equal(FIX_WORKFLOW_ID, 'fix');
  assert.equal(FIX_WORKFLOW_VERSION, 'fix-v2');
  assert.equal(fixDefinitionV2.id, 'fix');
  assert.equal(fixDefinitionV2.version, 'fix-v2');
  assert.equal(fixDefinitionV2.initialStage, 'INTAKE');
  assert.equal(fixDefinitionV2.acceptance, FIX_ACCEPTANCE);
});

// Keep the public exports explicit for callers.
assert.equal(typeof fixDefinitionV2.guard, 'function');
assert.equal(typeof fixDefinitionV2.transition, 'function');
assert.equal(typeof buildFixV2Nodes, 'function');
assert.equal(typeof makeReviewerNode, 'function');