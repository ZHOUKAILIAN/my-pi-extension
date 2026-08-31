import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSubmitArtifact, INVESTIGATE_PROFILE, IMPLEMENT_PROFILE } from '../src/index.ts';
import { fixNodes } from '@pi/workflow-runtime';
test('profiles and artifact schema are capability boundaries', () => { assert(!INVESTIGATE_PROFILE.tools.includes('bash')); assert(!INVESTIGATE_PROFILE.tools.includes('edit')); assert(IMPLEMENT_PROFILE.tools.includes('edit')); assert.throws(() => validateSubmitArtifact({kind: 3}), /artifact.kind/);
  assert.throws(() => validateSubmitArtifact({ kind: 'implementation', artifact: 'patch' }), /implementation.artifact/);
  assert.doesNotThrow(() => validateSubmitArtifact({ kind: 'implementation', artifact: { summary: 'patch', filesChanged: ['a.ts'], candidateRevision: 'rev-1' } })); });
test('new fix artifact kinds pass validation with valid minimal payloads', () => {
  assert.doesNotThrow(() => validateSubmitArtifact({ kind: 'intake', summary: 'save fails with timeout', overview: 'payments 保存超时，影响下单，怀疑网络超时' }));
  assert.doesNotThrow(() => validateSubmitArtifact({ kind: 'intake', summary: 'save fails with timeout', overview: 'payments 保存超时，影响下单', environment: 'prod', scope: 'payments', urgency: 'high' }));
  assert.doesNotThrow(() => validateSubmitArtifact({ kind: 'investigation_review', rootCauseConclusion: 'missing null check', evidenceSufficiency: 'sufficient', gaps: [], conclusion: { status: 'accepted', summary: 'root cause confirmed' } }));
  assert.doesNotThrow(() => validateSubmitArtifact({ kind: 'disposition', dispositionType: 'remediation', requiresRepositoryChange: true, requiresFormalPlanReview: true, minimalScope: 'add one null check', risks: ['regression risk'], verificationTarget: 'original issue', conclusion: { status: 'accepted', summary: 'remediate' } }));
  assert.doesNotThrow(() => validateSubmitArtifact({ kind: 'change_plan_review', rootCauseAlignment: true, changedScope: 'one null check', risks: [], compatibility: [], verification: ['npm test'], rollback: ['git revert'], findings: [{ id: 'f1', summary: 'scope is minimal', severity: 'info', disposition: 'closed' }], conclusion: { status: 'accepted', summary: 'plan approved' } }));
  assert.doesNotThrow(() => validateSubmitArtifact({ kind: 'change_review', reviewedRevision: 'rev-1', prRef: 'pr-123', findings: [], findingDisposition: 'all_closed', conclusion: { status: 'accepted', summary: 'change approved' } }));
});

test('new fix artifact kinds reject invalid fields and enums', () => {
  assert.throws(() => validateSubmitArtifact({ kind: 'intake' }), /intake.summary/);
  assert.throws(() => validateSubmitArtifact({ kind: 'intake', summary: 'x' }), /intake.overview/);
  // 旧 phenomenon-only intake 不再兼容：携带旧 phenomenon 字段即按“已移除，改用 summary/overview”明确拒绝。
  assert.throws(() => validateSubmitArtifact({ kind: 'intake', phenomenon: 'x' }), /intake\.phenomenon is removed; use summary\/overview/);
  // D4/E：新 intake 契约即使带合法 summary/overview，携带旧 phenomenon 字段也一律拒绝（不静默降级）。
  assert.throws(
    () => validateSubmitArtifact({ kind: 'intake', summary: 'x', overview: 'y', phenomenon: '旧现象字段' }),
    /intake\.phenomenon is removed; use summary\/overview/,
  );
  assert.throws(() => validateSubmitArtifact({ kind: 'intake', summary: 'x', overview: 'y', urgency: 'urgent' }), /intake.urgency/);
  assert.throws(() => validateSubmitArtifact({ kind: 'investigation_review', rootCauseConclusion: 'x', evidenceSufficiency: 'maybe', gaps: [], conclusion: { status: 'accepted', summary: 'ok' } }), /evidenceSufficiency/);
  assert.throws(() => validateSubmitArtifact({ kind: 'investigation_review', rootCauseConclusion: 'x', evidenceSufficiency: 'sufficient', gaps: [] }), /conclusion/);
  assert.throws(() => validateSubmitArtifact({ kind: 'disposition', dispositionType: 'delete', requiresRepositoryChange: true, minimalScope: 'x', risks: [], verificationTarget: 'y', conclusion: { status: 'accepted', summary: 'ok' } }), /dispositionType/);
  assert.throws(() => validateSubmitArtifact({ kind: 'disposition', dispositionType: 'remediation', requiresRepositoryChange: 'yes', minimalScope: 'x', risks: [], verificationTarget: 'y', conclusion: { status: 'accepted', summary: 'ok' } }), /requiresRepositoryChange/);
  assert.throws(() => validateSubmitArtifact({ kind: 'change_plan_review', rootCauseAlignment: true, changedScope: 'x', risks: [], compatibility: [], verification: [], rollback: [], findings: 'none', conclusion: { status: 'accepted', summary: 'ok' } }), /findings/);
  assert.throws(() => validateSubmitArtifact({ kind: 'change_review', findings: [{ id: 'f1' }], findingDisposition: 'all_closed', conclusion: { status: 'accepted', summary: 'ok' } }), /findings/);
  assert.throws(() => validateSubmitArtifact({ kind: 'change_review', findings: [{ id: 'f1', summary: 'x' }], findingDisposition: 'partial', conclusion: { status: 'accepted', summary: 'ok' } }), /findingDisposition/);
  assert.throws(() => validateSubmitArtifact({ kind: 'change_review', findings: [{ id: 'f1', summary: 'x', severity: 'fatal' }], findingDisposition: 'open', conclusion: { status: 'rejected', summary: 'ok' } }), /findings/);
});

test('user decision supports approve, request_changes, reject, continue_verification and legacy continue_investigating', () => {
  assert.doesNotThrow(() => validateSubmitArtifact({ kind: 'user_decision', decision: 'approve', requestId: 'req-1', reasonCode: 'fix_verified', candidateRevision: 'rev-1', note: 'looks good' }));
  assert.doesNotThrow(() => validateSubmitArtifact({ kind: 'user_decision', decision: 'request_changes', requestId: 'req-1', reasonCode: 'fix_incomplete' }));
  assert.doesNotThrow(() => validateSubmitArtifact({ kind: 'user_decision', decision: 'reject', requestId: 'req-1', reasonCode: 'missing_external_condition' }));
  assert.doesNotThrow(() => validateSubmitArtifact({ kind: 'user_decision', decision: 'continue_investigating', requestId: 'req-1' }));
  // F：配置类验证失败后的继续验证动作，契约为合法决策值。
  assert.doesNotThrow(() => validateSubmitArtifact({ kind: 'user_decision', decision: 'continue_verification', requestId: 'req-1' }));
  // D3：处置等待（wait_decision / external_action）的人工继续动作，契约为合法决策值；
  // F1：continue_disposition 携带用户处置决定内容（note/reasonCode）是合法决策形状。
  assert.doesNotThrow(() => validateSubmitArtifact({ kind: 'user_decision', decision: 'continue_disposition', requestId: 'req-1' }));
  assert.doesNotThrow(() => validateSubmitArtifact({ kind: 'user_decision', decision: 'continue_disposition', requestId: 'req-1', note: '用户决定按 mitigation 处置', reasonCode: 'mitigation' }));
  // 决策值域与 Stage/Guard 一一对应，枚举外的值一律拒绝。
  assert.throws(
    () => validateSubmitArtifact({ kind: 'user_decision', decision: 'approve_now', requestId: 'req-1' }),
    (e: unknown) => (e as { code?: string }).code === 'INVALID_USER_DECISION',
  );
});

test('verification artifact accepts new optional fields', () => {
  assert.doesNotThrow(() => validateSubmitArtifact({ kind: 'verification', accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1', unverified: ['e2e'], remainingRisk: ['low traffic regression'], checks: { original_issue: true, deep_link: 'skipped' }, schemaVersion: 1, runId: 'run-1', nodeExecutionId: 'ne-1', workerId: 'w-1', producerKind: 'worker', sourceVersion: 'base', conclusion: { status: 'accepted', summary: 'ok' } }));
});

// D4/P1：candidateRevision 按 requiresRepositoryChange 区分——仓库变更路径必须绑定被验证的
// implementation 版本（缺失拒绝）；无仓库变更路径没有 implementation 可比对，允许省略；
// 跨 Artifact 版本一致性由 Runtime/Acceptance 控制面强制。
test('verification candidateRevision is required only on the repository-change path', () => {
  // 仓库变更路径（context.requiresRepositoryChange=true）拒绝缺失版本。
  assert.throws(
    () => validateSubmitArtifact({ kind: 'verification', accepted: true, evidence: ['test:passed'] }, { schemaVersion: 1, runId: 'r', nodeExecutionId: 'n', workerId: 'w', sourceVersion: 's', requiresRepositoryChange: true }),
    (e: unknown) => (e as { code?: string }).code === 'MISSING_VERIFICATION_REVISION',
  );
  // 带 envelope 的仓库变更验证同样必须携带 candidateRevision。
  assert.throws(
    () => validateSubmitArtifact({ kind: 'verification', accepted: true, evidence: ['test:passed'], schemaVersion: 1, runId: 'r', nodeExecutionId: 'n', workerId: 'w', producerKind: 'worker', sourceVersion: 's', unverified: [] }, { schemaVersion: 1, runId: 'r', nodeExecutionId: 'n', workerId: 'w', sourceVersion: 's', requiresRepositoryChange: true }),
    (e: unknown) => (e as { code?: string }).code === 'MISSING_VERIFICATION_REVISION',
  );
  // 无仓库变更路径允许省略 candidateRevision（requiresRepositoryChange=false 与缺省 context 均不拒绝）。
  assert.doesNotThrow(() => validateSubmitArtifact({ kind: 'verification', accepted: true, evidence: ['test:passed'], checks: { original_issue: true } }));
  assert.doesNotThrow(() => validateSubmitArtifact({ kind: 'verification', accepted: true, evidence: ['test:passed'] }, { schemaVersion: 1, runId: 'r', nodeExecutionId: 'n', workerId: 'w', sourceVersion: 's', requiresRepositoryChange: false }));
  // 两条路径都允许携带版本（存在即可）；本层不做跨 Artifact 一致性比对。
  assert.doesNotThrow(() => validateSubmitArtifact({ kind: 'verification', accepted: true, evidence: ['test:passed'], candidateRevision: 'base-v1' }, { schemaVersion: 1, runId: 'r', nodeExecutionId: 'n', workerId: 'w', sourceVersion: 's', requiresRepositoryChange: false }));
  assert.doesNotThrow(() => validateSubmitArtifact({ kind: 'verification', accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1' }, { schemaVersion: 1, runId: 'r', nodeExecutionId: 'n', workerId: 'w', sourceVersion: 's', requiresRepositoryChange: true }));
});

// D4：验证失败必须声明失败类别，契约强制三向路由的事实基础。
test('verification accepted=false requires structured failure under v2 (requiresArtifactConclusion)', () => {
  const v2 = { requiresArtifactConclusion: true };
  // 通过：实现类 / 配置类 / 外部条件类都允许，外部条件类可带 responsibility/resolution。
  assert.doesNotThrow(() => validateSubmitArtifact({ kind: 'verification', accepted: false, evidence: ['test:failed'], candidateRevision: 'rev-1', failure: { kind: 'implementation', reason: '回归测试失败' } }, v2));
  assert.doesNotThrow(() => validateSubmitArtifact({ kind: 'verification', accepted: false, evidence: ['test:failed'], candidateRevision: 'rev-1', failure: { kind: 'configuration', reason: '生产环境配置指向错误实例' } }, v2));
  assert.doesNotThrow(() => validateSubmitArtifact({ kind: 'verification', accepted: false, evidence: ['external:blocked'], candidateRevision: 'rev-1', failure: { kind: 'external_condition', reason: '无生产环境权限', responsibility: '环境所有者', resolution: '提供测试环境凭据' } }, v2));
});

test('v2 verification accepted=false without failure or with invalid failure is rejected (fail closed, no silent phenomenon-style degradation)', () => {
  const v2 = { requiresArtifactConclusion: true };
  // 不做 phenomenon 式静默降级：受控结论工作流下 accepted=false 必须显式说明失败类别（D4 三向路由的事实基础）。
  assert.throws(() => validateSubmitArtifact({ kind: 'verification', accepted: false, evidence: ['test:failed'], candidateRevision: 'rev-1' }, v2), /verification.failure/);
  assert.throws(() => validateSubmitArtifact({ kind: 'verification', accepted: false, evidence: ['test:failed'], candidateRevision: 'rev-1', failure: { reason: 'no kind' } }, v2), /failure.kind/);
  assert.throws(() => validateSubmitArtifact({ kind: 'verification', accepted: false, evidence: ['test:failed'], candidateRevision: 'rev-1', failure: { kind: 'config', reason: 'x' } }, v2), /failure.kind/);
  assert.throws(() => validateSubmitArtifact({ kind: 'verification', accepted: false, evidence: ['test:failed'], candidateRevision: 'rev-1', failure: { kind: 'implementation' } }, v2), /failure.reason/);
  assert.throws(() => validateSubmitArtifact({ kind: 'verification', accepted: false, evidence: ['test:failed'], candidateRevision: 'rev-1', failure: { kind: 'external_condition', reason: 'x', responsibility: '' } }, v2), /responsibility/);
  // accepted=true 不允许携带 failure（自相矛盾）是全局规则：即使无受控结论上下文也拒绝。
  assert.throws(() => validateSubmitArtifact({ kind: 'verification', accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1', failure: { kind: 'implementation', reason: 'x' } }), /failure must be absent/);
});

test('legacy verification accepted=false without structured failure stays contract-legal (no requiresArtifactConclusion context)', () => {
  // 结构化 failure 契约只约束声明了 requiresArtifactConclusion 的受控结论工作流；legacy 定义
  //（裸 Artifact 路径 / 校验上下文未声明）的 accepted=false 由定义自身的 transition/guard 处理
  //（如 legacy fixDefinition 的 VERIFYING→IMPLEMENTING 只要求 accepted=false + 证据）。
  assert.doesNotThrow(() => validateSubmitArtifact({ kind: 'verification', accepted: false, evidence: ['test:failed'], candidateRevision: 'rev-1' }));
  assert.doesNotThrow(() => validateSubmitArtifact({ kind: 'verification', accepted: false, evidence: ['test:failed'] }));
  // 即便上下文非空但未声明受控结论要求，也不强制结构化 failure（legacy 定义经 runNode 无上下文校验）。
  assert.doesNotThrow(() => validateSubmitArtifact({ kind: 'verification', accepted: false, evidence: ['test:failed'], candidateRevision: 'rev-1' }, { schemaVersion: 1, runId: 'r', nodeExecutionId: 'n', workerId: 'w', sourceVersion: 's', requiresRepositoryChange: true }));
});

test('node skills are scoped independently from tools', () => {
  const nodes = fixNodes({ execute: async () => ({ kind: 'investigation', route: 'local_fix', rootCause: 'cause', evidence: ['x'] }) }, { investigate: ['cst-plus'] });
  assert.deepEqual(nodes.investigate.profile?.skills, ['cst-plus']);
  assert.deepEqual(nodes.implement.profile?.skills, []);
  assert(!nodes.investigate.profile?.tools.includes('bash'));
});

// findingDisposition/all_closed 的契约层边界：disposition 枚举值域合法（含 open/缺失），
// 契约不掩盖“缺失/open”——是否通过由 Runtime 硬门禁与 Acceptance 判定（见 workflow-runtime）。
const changeReviewWithFinding = (disposition: string | undefined) => validateSubmitArtifact({
  kind: 'change_review', reviewedRevision: 'rev-1', findings: [{ id: 'f1', summary: 'finding', ...(disposition !== undefined ? { disposition } : {}) }], findingDisposition: 'all_closed', conclusion: { status: 'accepted', summary: 'ok' },
});
test('finding disposition enums are contract-legal as declared; unknown values are rejected', () => {
  assert.doesNotThrow(() => changeReviewWithFinding('closed'));
  assert.doesNotThrow(() => changeReviewWithFinding('accepted_with_note'));
  // open 与缺失（undefined）在契约层是合法声明：契约只校验值域，不在此放行或拒绝；
  // findingDisposition=all_closed 不能在契约层把缺失/open 当作已关闭（由 Runtime 门禁拒绝）。
  assert.doesNotThrow(() => changeReviewWithFinding('open'));
  assert.doesNotThrow(() => changeReviewWithFinding(undefined));
  assert.throws(() => changeReviewWithFinding('done'), /finding/);
});
