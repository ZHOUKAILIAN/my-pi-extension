// 等价性基线测试（重构前先行钉住，方案 v2 §6.1）：
// 对 validateSubmitArtifact 的每 kind × 每字段错误码、错误信息文本、多字段同时非法时的
// 抛错顺序全部钉住。字段级检查重构（改为遍历 per-kind 定义表）前后本文件必须全绿，
// 作为「行为等价」的证明。任何差异都必须是显式的方案决策，不允许静默漂移。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateSubmitArtifact,
  validateArtifactEnvelope,
  type ArtifactExecutionContext,
} from '../src/index.ts';

const expectCode = (fn: () => void, code: string, message?: string | RegExp) => {
  assert.throws(fn, (error: unknown) => {
    const contractError = error as { code?: string; name?: string; message?: string };
    if (contractError.name !== 'ArtifactContractError') return false;
    if (contractError.code !== code) return false;
    if (message !== undefined) {
      if (typeof message === 'string') return contractError.message === message;
      return message.test(contractError.message ?? '');
    }
    return true;
  }, `expected error code ${code}${message ? ` with message ${String(message)}` : ''}`);
};

// 各 kind 的合法完整样例（可选字段全携带，覆盖 envelope 之外的完整形状）。
const VALID_SAMPLES: Record<string, Record<string, unknown>> = {
  intake: { kind: 'intake', summary: 'save fails with timeout', overview: 'payments 保存超时，影响下单', environment: 'prod', scope: 'payments', urgency: 'high' },
  investigation: { kind: 'investigation', route: 'local_fix', rootCause: 'missing null check', evidence: ['log:trace-1', { ref: 'tool:read', kind: 'tool', summary: 'read config' }], id: 'inv-1' },
  implementation: { kind: 'implementation', artifact: { summary: 'patch', filesChanged: ['a.ts'], candidateRevision: 'rev-1', prUrl: 'pr-123' } },
  verification_accepted: { kind: 'verification', accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1', unverified: ['e2e'], remainingRisk: ['low'], checks: { original_issue: true } },
  investigation_review: { kind: 'investigation_review', targetArtifactId: 'inv-1', rootCauseConclusion: 'missing null check', evidenceSufficiency: 'sufficient', gaps: ['none'], stopReason: undefined, conclusion: { status: 'accepted', summary: 'root cause confirmed' } },
  disposition: { kind: 'disposition', dispositionType: 'remediation', requiresRepositoryChange: true, requiresFormalPlanReview: true, minimalScope: 'add one null check', risks: ['regression'], verificationTarget: 'original issue', conclusion: { status: 'accepted', summary: 'remediate' } },
  change_plan_review: { kind: 'change_plan_review', targetPlanRevision: 'plan-1', rootCauseAlignment: true, changedScope: 'one null check', risks: [], compatibility: [], verification: ['npm test'], rollback: ['git revert'], findings: [{ id: 'f1', summary: 'scope minimal', severity: 'info', disposition: 'closed' }], conclusion: { status: 'accepted', summary: 'plan approved' } },
  change_review: { kind: 'change_review', reviewedRevision: 'rev-1', prRef: 'pr-123', findings: [], findingDisposition: 'all_closed', conclusion: { status: 'accepted', summary: 'change approved' } },
  guard_rejection: { kind: 'guard_rejection', error: 'guard blocked' },
  user_decision: { kind: 'user_decision', decision: 'approve', requestId: 'req-1', reasonCode: 'fix_verified', candidateRevision: 'rev-1', note: 'ok' },
};

test('baseline: each kind accepts a valid complete sample', () => {
  for (const [name, sample] of Object.entries(VALID_SAMPLES)) {
    assert.doesNotThrow(() => validateSubmitArtifact(sample), `${name} should validate`);
  }
});

test('baseline: invalid kind values', () => {
  expectCode(() => validateSubmitArtifact(undefined), 'INVALID_KIND');
  expectCode(() => validateSubmitArtifact(null), 'INVALID_KIND');
  expectCode(() => validateSubmitArtifact({}), 'INVALID_KIND');
  expectCode(() => validateSubmitArtifact({ kind: 3 }), 'INVALID_KIND', 'artifact.kind must be a non-empty string');
  expectCode(() => validateSubmitArtifact({ kind: 'nope' }), 'UNSUPPORTED_ARTIFACT_KIND', 'unsupported artifact kind: nope');
  // N1：Object.prototype 成员（toString/__proto__ 等）不得命中 `in` 原型链查找，
  // 否则会拿到函数值进入 for...of 抛裸 TypeError，而非结构化 ArtifactContractError。
  expectCode(() => validateSubmitArtifact({ kind: 'toString' }), 'UNSUPPORTED_ARTIFACT_KIND', 'unsupported artifact kind: toString');
  expectCode(() => validateSubmitArtifact({ kind: '__proto__' }), 'UNSUPPORTED_ARTIFACT_KIND', 'unsupported artifact kind: __proto__');
});

test('baseline: guard_rejection error code and message', () => {
  expectCode(() => validateSubmitArtifact({ kind: 'guard_rejection' }), 'MISSING_GUARD_REJECTION_ERROR', 'guard_rejection.error is required');
  expectCode(() => validateSubmitArtifact({ kind: 'guard_rejection', error: '' }), 'MISSING_GUARD_REJECTION_ERROR');
});

test('baseline: investigation field errors and check order (route → rootCause → evidence)', () => {
  const base = { kind: 'investigation' };
  expectCode(() => validateSubmitArtifact({ ...base }), 'INVALID_INVESTIGATION_ROUTE', 'investigation.route is invalid');
  // route 非法时即使 rootCause/evidence 也非法，也先抛 route（固定检查顺序）。
  expectCode(() => validateSubmitArtifact({ ...base, rootCause: '', evidence: [] }), 'INVALID_INVESTIGATION_ROUTE');
  expectCode(() => validateSubmitArtifact({ ...base, route: 'magic_fix' }), 'INVALID_INVESTIGATION_ROUTE');
  expectCode(() => validateSubmitArtifact({ ...base, route: 'local_fix' }), 'MISSING_ROOT_CAUSE', 'investigation.rootCause is required');
  expectCode(() => validateSubmitArtifact({ ...base, route: 'local_fix', rootCause: '  ' }), 'MISSING_ROOT_CAUSE');
  // rootCause 缺失时即使 evidence 也非法，也先抛 rootCause。
  expectCode(() => validateSubmitArtifact({ ...base, route: 'local_fix', evidence: [] }), 'MISSING_ROOT_CAUSE');
  expectCode(() => validateSubmitArtifact({ ...base, route: 'local_fix', rootCause: 'c', evidence: [] }), 'MISSING_INVESTIGATION_EVIDENCE', 'investigation.evidence must contain at least one non-empty item');
  expectCode(() => validateSubmitArtifact({ ...base, route: 'local_fix', rootCause: 'c', evidence: [''] }), 'MISSING_INVESTIGATION_EVIDENCE');
  // evidence 合法项：非空字符串或带 ref 的对象。
  assert.doesNotThrow(() => validateSubmitArtifact({ ...base, route: 'local_fix', rootCause: 'c', evidence: [{ ref: 'log:1' }] }));
});

test('baseline: implementation field errors and check order', () => {
  const base = { kind: 'implementation' };
  expectCode(() => validateSubmitArtifact({ ...base }), 'MISSING_IMPLEMENTATION_DETAILS', 'implementation.artifact is required');
  expectCode(() => validateSubmitArtifact({ ...base, artifact: 'patch' }), 'MISSING_IMPLEMENTATION_DETAILS');
  expectCode(() => validateSubmitArtifact({ ...base, artifact: {} }), 'MISSING_IMPLEMENTATION_SUMMARY', 'implementation.artifact.summary is required');
  expectCode(() => validateSubmitArtifact({ ...base, artifact: { summary: 'x' } }), 'MISSING_FILES_CHANGED', 'implementation.artifact.filesChanged must contain at least one file');
  expectCode(() => validateSubmitArtifact({ ...base, artifact: { summary: 'x', filesChanged: [] } }), 'MISSING_FILES_CHANGED');
  expectCode(() => validateSubmitArtifact({ ...base, artifact: { summary: 'x', filesChanged: [''] } }), 'MISSING_FILES_CHANGED');
  expectCode(() => validateSubmitArtifact({ ...base, artifact: { summary: 'x', filesChanged: ['a.ts'] } }), 'MISSING_CANDIDATE_REVISION', 'implementation.artifact.candidateRevision is required');
  expectCode(() => validateSubmitArtifact({ ...base, artifact: { summary: 'x', filesChanged: ['a.ts'], candidateRevision: 'rev', prUrl: '' } }), 'INVALID_PR_URL', 'implementation.artifact.prUrl must be a non-empty string when provided');
  expectCode(() => validateSubmitArtifact({ ...base, artifact: { summary: 'x', filesChanged: ['a.ts'], candidateRevision: 'rev', prUrl: null } }), 'INVALID_PR_URL');
});

test('baseline: verification field errors and check order (accepted → evidence → revision → failure chain)', () => {
  const base = { kind: 'verification' };
  expectCode(() => validateSubmitArtifact({ ...base }), 'MISSING_VERIFICATION_DECISION', 'verification.accepted must be boolean');
  expectCode(() => validateSubmitArtifact({ ...base, accepted: 'true' }), 'MISSING_VERIFICATION_DECISION');
  expectCode(() => validateSubmitArtifact({ ...base, accepted: null }), 'MISSING_VERIFICATION_DECISION');
  // accepted 非法时即使 evidence 也非法，也先抛 accepted。
  expectCode(() => validateSubmitArtifact({ ...base, evidence: [] }), 'MISSING_VERIFICATION_DECISION');
  expectCode(() => validateSubmitArtifact({ ...base, accepted: true }), 'MISSING_VERIFICATION_EVIDENCE', 'verification.evidence must contain at least one non-empty item');
  expectCode(() => validateSubmitArtifact({ ...base, accepted: true, evidence: [42] }), 'MISSING_VERIFICATION_EVIDENCE');
  // context.requiresRepositoryChange=true 时 candidateRevision 必填。
  const repoChangeContext: ArtifactExecutionContext = { schemaVersion: 1, runId: 'r', nodeExecutionId: 'n', workerId: 'w', sourceVersion: 's', requiresRepositoryChange: true };
  expectCode(() => validateSubmitArtifact({ ...base, accepted: true, evidence: ['test:x'] }, repoChangeContext), 'MISSING_VERIFICATION_REVISION');
  expectCode(() => validateSubmitArtifact({ ...base, accepted: true, evidence: ['test:x'] }, { ...repoChangeContext, requiresArtifactConclusion: true }), 'MISSING_VERIFICATION_REVISION');
  // accepted=false 的结构化 failure 链（v2 上下文）：failure → kind → reason → responsibility → resolution。
  const v2: ArtifactExecutionContext = { schemaVersion: 1, runId: 'r', nodeExecutionId: 'n', workerId: 'w', sourceVersion: 's', requiresArtifactConclusion: true };
  expectCode(() => validateSubmitArtifact({ ...base, accepted: false, evidence: ['test:x'], candidateRevision: 'rev' }, v2), 'MISSING_VERIFICATION_FAILURE', 'verification.failure is required when accepted is false');
  expectCode(() => validateSubmitArtifact({ ...base, accepted: false, evidence: ['test:x'], candidateRevision: 'rev', failure: 'nope' }, v2), 'MISSING_VERIFICATION_FAILURE');
  expectCode(() => validateSubmitArtifact({ ...base, accepted: false, evidence: ['test:x'], candidateRevision: 'rev', failure: { reason: 'x' } }, v2), 'INVALID_VERIFICATION_FAILURE_KIND', 'verification.failure.kind is invalid');
  expectCode(() => validateSubmitArtifact({ ...base, accepted: false, evidence: ['test:x'], candidateRevision: 'rev', failure: { kind: 'config', reason: 'x' } }, v2), 'INVALID_VERIFICATION_FAILURE_KIND');
  expectCode(() => validateSubmitArtifact({ ...base, accepted: false, evidence: ['test:x'], candidateRevision: 'rev', failure: { kind: 'implementation' } }, v2), 'MISSING_VERIFICATION_FAILURE_REASON', 'verification.failure.reason is required');
  expectCode(() => validateSubmitArtifact({ ...base, accepted: false, evidence: ['test:x'], candidateRevision: 'rev', failure: { kind: 'implementation', reason: 'x', responsibility: '' } }, v2), 'INVALID_VERIFICATION_FAILURE_RESPONSIBILITY', 'verification.failure.responsibility must be a non-empty string when provided');
  expectCode(() => validateSubmitArtifact({ ...base, accepted: false, evidence: ['test:x'], candidateRevision: 'rev', failure: { kind: 'implementation', reason: 'x', resolution: '' } }, v2), 'INVALID_VERIFICATION_FAILURE_RESOLUTION', 'verification.failure.resolution must be a non-empty string when provided');
  // legacy 上下文（无 requiresArtifactConclusion）下 accepted=false 无 failure 合法。
  assert.doesNotThrow(() => validateSubmitArtifact({ ...base, accepted: false, evidence: ['test:x'] }));
  // accepted=true 携带 failure 全局拒绝（自相矛盾）。
  expectCode(() => validateSubmitArtifact({ ...base, accepted: true, evidence: ['test:x'], failure: { kind: 'implementation', reason: 'x' } }), 'INVALID_VERIFICATION_FAILURE_ON_ACCEPTED', 'verification.failure must be absent when accepted is true');
});

test('baseline: intake field errors and check order (phenomenon → summary → overview → environment → scope → urgency)', () => {
  const base = { kind: 'intake' };
  expectCode(() => validateSubmitArtifact({ ...base }), 'MISSING_INTAKE_SUMMARY', 'intake.summary is required');
  // phenomenon 携带即拒绝，先于 summary 检查。
  expectCode(() => validateSubmitArtifact({ ...base, phenomenon: 'x' }), 'INVALID_INTAKE_PHENOMENON', 'intake.phenomenon is removed; use summary/overview');
  expectCode(() => validateSubmitArtifact({ ...base, phenomenon: 'x', summary: 's', overview: 'o' }), 'INVALID_INTAKE_PHENOMENON');
  expectCode(() => validateSubmitArtifact({ ...base, summary: 's' }), 'MISSING_INTAKE_OVERVIEW', 'intake.overview is required');
  expectCode(() => validateSubmitArtifact({ ...base, summary: 's', overview: 'o', environment: '' }), 'INVALID_INTAKE_ENVIRONMENT', 'intake.environment must be a non-empty string when provided');
  expectCode(() => validateSubmitArtifact({ ...base, summary: 's', overview: 'o', environment: 'e', scope: '' }), 'INVALID_INTAKE_SCOPE', 'intake.scope must be a non-empty string when provided');
  expectCode(() => validateSubmitArtifact({ ...base, summary: 's', overview: 'o', environment: 'e', scope: 'p', urgency: 'urgent' }), 'INVALID_INTAKE_URGENCY', 'intake.urgency is invalid');
  expectCode(() => validateSubmitArtifact({ ...base, summary: 's', overview: 'o', environment: 'e', scope: 'p', urgency: 3 }), 'INVALID_INTAKE_URGENCY');
});

test('baseline: investigation_review field errors and check order (target → rootCauseConclusion → evidenceSufficiency → gaps → stopReason → conclusion)', () => {
  const base = { kind: 'investigation_review' };
  // targetArtifactId 缺省合法（optional）；只有提供且非法才拒绝。
  expectCode(() => validateSubmitArtifact({ ...base, targetArtifactId: 'inv-1' }), 'MISSING_INVESTIGATION_REVIEW_ROOT_CAUSE_CONCLUSION', 'investigation_review.rootCauseConclusion is required');
  expectCode(() => validateSubmitArtifact({ ...base, targetArtifactId: 'inv-1', rootCauseConclusion: 'c' }), 'INVALID_INVESTIGATION_REVIEW_EVIDENCE_SUFFICIENCY', 'investigation_review.evidenceSufficiency is invalid');
  expectCode(() => validateSubmitArtifact({ ...base, targetArtifactId: 'inv-1', rootCauseConclusion: 'c', evidenceSufficiency: 'sufficient' }), 'INVALID_INVESTIGATION_REVIEW_GAPS', 'investigation_review.gaps must be an array of non-empty strings');
  expectCode(() => validateSubmitArtifact({ ...base, targetArtifactId: 'inv-1', rootCauseConclusion: 'c', evidenceSufficiency: 'sufficient', gaps: [''] }), 'INVALID_INVESTIGATION_REVIEW_GAPS');
  // stopReason 缺省合法；提供空串才拒绝。
  expectCode(() => validateSubmitArtifact({ ...base, rootCauseConclusion: 'c', evidenceSufficiency: 'sufficient', gaps: [], stopReason: '' }), 'INVALID_INVESTIGATION_REVIEW_STOP_REASON', 'investigation_review.stopReason must be a non-empty string when provided');
  expectCode(() => validateSubmitArtifact({ ...base, rootCauseConclusion: 'c', evidenceSufficiency: 'sufficient', gaps: [] }), 'MISSING_ARTIFACT_CONCLUSION', 'artifact.conclusion is required');
  expectCode(() => validateSubmitArtifact({ ...base, rootCauseConclusion: 'c', evidenceSufficiency: 'sufficient', gaps: [], stopReason: 'stop' }), 'MISSING_ARTIFACT_CONCLUSION', 'artifact.conclusion is required');
  expectCode(() => validateSubmitArtifact({ ...base, rootCauseConclusion: 'c', evidenceSufficiency: 'sufficient', gaps: [], stopReason: 'stop', conclusion: { status: 'maybe', summary: '' } }), 'INVALID_ARTIFACT_CONCLUSION', 'artifact.conclusion must contain a valid status and summary');
  // targetArtifactId 提供但非法：提供即拒绝。
  expectCode(() => validateSubmitArtifact({ ...base, rootCauseConclusion: 'c', evidenceSufficiency: 'sufficient', gaps: [], conclusion: { status: 'accepted', summary: 'ok' }, targetArtifactId: '' }), 'INVALID_INVESTIGATION_REVIEW_TARGET', 'investigation_review.targetArtifactId must be a non-empty string when provided');
});

test('baseline: disposition field errors and check order (type → repoChange → formalPlanReview → minimalScope → risks → verificationTarget → conclusion)', () => {
  const base = { kind: 'disposition' };
  expectCode(() => validateSubmitArtifact({ ...base }), 'INVALID_DISPOSITION_TYPE', 'disposition.dispositionType is invalid');
  expectCode(() => validateSubmitArtifact({ ...base, dispositionType: 'delete' }), 'INVALID_DISPOSITION_TYPE');
  expectCode(() => validateSubmitArtifact({ ...base, dispositionType: 'remediation' }), 'INVALID_DISPOSITION_REQUIRES_REPOSITORY_CHANGE', 'disposition.requiresRepositoryChange must be boolean');
  expectCode(() => validateSubmitArtifact({ ...base, dispositionType: 'remediation', requiresRepositoryChange: 'yes' }), 'INVALID_DISPOSITION_REQUIRES_REPOSITORY_CHANGE');
  expectCode(() => validateSubmitArtifact({ ...base, dispositionType: 'remediation', requiresRepositoryChange: true, requiresFormalPlanReview: 'yes' }), 'INVALID_DISPOSITION_REQUIRES_FORMAL_PLAN_REVIEW', 'disposition.requiresFormalPlanReview must be boolean when provided');
  expectCode(() => validateSubmitArtifact({ ...base, dispositionType: 'remediation', requiresRepositoryChange: true }), 'MISSING_DISPOSITION_MINIMAL_SCOPE', 'disposition.minimalScope is required');
  expectCode(() => validateSubmitArtifact({ ...base, dispositionType: 'remediation', requiresRepositoryChange: true, minimalScope: 'x', risks: 'none' }), 'INVALID_DISPOSITION_RISKS', 'disposition.risks must be an array of non-empty strings');
  expectCode(() => validateSubmitArtifact({ ...base, dispositionType: 'remediation', requiresRepositoryChange: true, minimalScope: 'x', risks: [''] }), 'INVALID_DISPOSITION_RISKS');
  expectCode(() => validateSubmitArtifact({ ...base, dispositionType: 'remediation', requiresRepositoryChange: true, minimalScope: 'x', risks: [] }), 'MISSING_DISPOSITION_VERIFICATION_TARGET', 'disposition.verificationTarget is required');
  expectCode(() => validateSubmitArtifact({ ...base, dispositionType: 'remediation', requiresRepositoryChange: true, minimalScope: 'x', risks: [], verificationTarget: 'y' }), 'MISSING_ARTIFACT_CONCLUSION');
});

test('baseline: change_plan_review field errors and check order (target → rootCauseAlignment → changedScope → risks → compatibility → verification → rollback → findings → conclusion)', () => {
  const base = { kind: 'change_plan_review' };
  // targetPlanRevision 缺省合法（optional）；本次故障的错误码在第二个检查位。
  expectCode(() => validateSubmitArtifact({ ...base }), 'INVALID_CHANGE_PLAN_REVIEW_ROOT_CAUSE_ALIGNMENT', 'change_plan_review.rootCauseAlignment must be boolean');
  expectCode(() => validateSubmitArtifact({ ...base, rootCauseAlignment: 'true' }), 'INVALID_CHANGE_PLAN_REVIEW_ROOT_CAUSE_ALIGNMENT');
  expectCode(() => validateSubmitArtifact({ ...base, targetPlanRevision: 'p', rootCauseAlignment: 'true' }), 'INVALID_CHANGE_PLAN_REVIEW_ROOT_CAUSE_ALIGNMENT');
  expectCode(() => validateSubmitArtifact({ ...base, targetPlanRevision: 'p', rootCauseAlignment: null }), 'INVALID_CHANGE_PLAN_REVIEW_ROOT_CAUSE_ALIGNMENT');
  expectCode(() => validateSubmitArtifact({ ...base, targetPlanRevision: 'p', rootCauseAlignment: 1 }), 'INVALID_CHANGE_PLAN_REVIEW_ROOT_CAUSE_ALIGNMENT');
  expectCode(() => validateSubmitArtifact({ ...base, targetPlanRevision: 'p', rootCauseAlignment: true }), 'MISSING_CHANGE_PLAN_REVIEW_CHANGED_SCOPE', 'change_plan_review.changedScope is required');
  expectCode(() => validateSubmitArtifact({ ...base, targetPlanRevision: 'p', rootCauseAlignment: true, changedScope: 'x', risks: 'none' }), 'INVALID_CHANGE_PLAN_REVIEW_RISKS', 'change_plan_review.risks must be an array of non-empty strings');
  expectCode(() => validateSubmitArtifact({ ...base, targetPlanRevision: 'p', rootCauseAlignment: true, changedScope: 'x', risks: [] }), 'INVALID_CHANGE_PLAN_REVIEW_COMPATIBILITY', 'change_plan_review.compatibility must be an array of non-empty strings');
  expectCode(() => validateSubmitArtifact({ ...base, targetPlanRevision: 'p', rootCauseAlignment: true, changedScope: 'x', risks: [], compatibility: [] }), 'INVALID_CHANGE_PLAN_REVIEW_VERIFICATION', 'change_plan_review.verification must be an array of non-empty strings');
  expectCode(() => validateSubmitArtifact({ ...base, targetPlanRevision: 'p', rootCauseAlignment: true, changedScope: 'x', risks: [], compatibility: [], verification: [] }), 'INVALID_CHANGE_PLAN_REVIEW_ROLLBACK', 'change_plan_review.rollback must be an array of non-empty strings');
  expectCode(() => validateSubmitArtifact({ ...base, targetPlanRevision: 'p', rootCauseAlignment: true, changedScope: 'x', risks: [], compatibility: [], verification: [], rollback: [] }), 'INVALID_CHANGE_PLAN_REVIEW_FINDINGS', 'change_plan_review.findings must be an array of valid findings');
  expectCode(() => validateSubmitArtifact({ ...base, targetPlanRevision: 'p', rootCauseAlignment: true, changedScope: 'x', risks: [], compatibility: [], verification: [], rollback: [], findings: 'none' }), 'INVALID_CHANGE_PLAN_REVIEW_FINDINGS');
  expectCode(() => validateSubmitArtifact({ ...base, targetPlanRevision: 'p', rootCauseAlignment: true, changedScope: 'x', risks: [], compatibility: [], verification: [], rollback: [], findings: [{ id: 'f1' }] }), 'INVALID_CHANGE_PLAN_REVIEW_FINDINGS');
  expectCode(() => validateSubmitArtifact({ ...base, targetPlanRevision: 'p', rootCauseAlignment: true, changedScope: 'x', risks: [], compatibility: [], verification: [], rollback: [], findings: [{ id: 'f1', summary: 's', severity: 'fatal' }] }), 'INVALID_CHANGE_PLAN_REVIEW_FINDINGS');
  expectCode(() => validateSubmitArtifact({ ...base, targetPlanRevision: 'p', rootCauseAlignment: true, changedScope: 'x', risks: [], compatibility: [], verification: [], rollback: [], findings: [{ id: 'f1', summary: 's', disposition: 'done' }] }), 'INVALID_CHANGE_PLAN_REVIEW_FINDINGS');
  expectCode(() => validateSubmitArtifact({ ...base, targetPlanRevision: 'p', rootCauseAlignment: true, changedScope: 'x', risks: [], compatibility: [], verification: [], rollback: [], findings: [] }), 'MISSING_ARTIFACT_CONCLUSION');
  // finding.check 提供时必须非空字符串。
  expectCode(() => validateSubmitArtifact({ ...base, targetPlanRevision: 'p', rootCauseAlignment: true, changedScope: 'x', risks: [], compatibility: [], verification: [], rollback: [], findings: [{ id: 'f1', summary: 's', check: '' }], conclusion: { status: 'accepted', summary: 'ok' } }), 'INVALID_CHANGE_PLAN_REVIEW_FINDINGS');
});

test('baseline: change_review field errors and check order (revision → prRef → findings → findingDisposition → conclusion)', () => {
  const base = { kind: 'change_review' };
  // reviewedRevision / prRef 缺省合法（optional）。
  expectCode(() => validateSubmitArtifact({ ...base }), 'INVALID_CHANGE_REVIEW_FINDINGS', 'change_review.findings must be an array of valid findings');
  expectCode(() => validateSubmitArtifact({ ...base, prRef: '' }), 'INVALID_CHANGE_REVIEW_PR_REF', 'change_review.prRef must be a non-empty string when provided');
  expectCode(() => validateSubmitArtifact({ ...base, reviewedRevision: 'rev-1' }), 'INVALID_CHANGE_REVIEW_FINDINGS', 'change_review.findings must be an array of valid findings');
  expectCode(() => validateSubmitArtifact({ ...base, reviewedRevision: 'rev-1', findings: [{ id: 'f1' }] }), 'INVALID_CHANGE_REVIEW_FINDINGS');
  expectCode(() => validateSubmitArtifact({ ...base, reviewedRevision: 'rev-1', findings: [] }), 'INVALID_CHANGE_REVIEW_FINDING_DISPOSITION', 'change_review.findingDisposition is invalid');
  expectCode(() => validateSubmitArtifact({ ...base, reviewedRevision: 'rev-1', findings: [], findingDisposition: 'partial' }), 'INVALID_CHANGE_REVIEW_FINDING_DISPOSITION');
  expectCode(() => validateSubmitArtifact({ ...base, reviewedRevision: 'rev-1', findings: [], findingDisposition: 'all_closed' }), 'MISSING_ARTIFACT_CONCLUSION');
});

test('baseline: user_decision field errors and check order (decision → requestId → producerKind)', () => {
  const base = { kind: 'user_decision' };
  expectCode(() => validateSubmitArtifact({ ...base }), 'INVALID_USER_DECISION');
  expectCode(() => validateSubmitArtifact({ ...base, decision: 'approve' }), 'MISSING_USER_DECISION_REQUEST_ID', 'user_decision.requestId is required');
  // producerKind 是信封字段：携带后先过信封校验（worker 信封需 nodeExecutionId/workerId），再进入 user_decision 分支。
  expectCode(() => validateSubmitArtifact({ kind: 'user_decision', decision: 'approve', requestId: 'r', schemaVersion: 1, runId: 'r', sourceVersion: 's', nodeExecutionId: 'r.n.1', workerId: 'w', unverified: [], producerKind: 'worker' }), 'INVALID_USER_DECISION_PRODUCER_KIND', 'user_decision.producerKind must be user_decision');
  // producerKind 缺省合法（不拒绝）。
  assert.doesNotThrow(() => validateSubmitArtifact({ ...base, decision: 'approve', requestId: 'r' }));
  assert.doesNotThrow(() => validateSubmitArtifact({ ...base, decision: 'approve', requestId: 'r', schemaVersion: 1, runId: 'r', sourceVersion: 's', unverified: [], producerKind: 'user_decision' }));
});

test('baseline: top-level conclusion field is checked before kind-specific errors', () => {
  // conclusion 存在但非法：先于 kind 字段级检查抛 INVALID_ARTIFACT_CONCLUSION。
  expectCode(
    () => validateSubmitArtifact({ kind: 'investigation', route: 'bad_route', conclusion: { status: 'nope' } }),
    'INVALID_ARTIFACT_CONCLUSION',
    'artifact.conclusion must contain a valid status and summary',
  );
  // conclusion 合法时不影响 kind 检查。
  expectCode(
    () => validateSubmitArtifact({ kind: 'investigation', route: 'bad_route', conclusion: { status: 'accepted', summary: 'ok' } }),
    'INVALID_INVESTIGATION_ROUTE',
  );
});

test('baseline: envelope errors surfaced through submit path (conditional on envelope fields)', () => {
  const envelope = { schemaVersion: 1, runId: 'r', producerKind: 'worker', sourceVersion: 's', nodeExecutionId: 'r.n.1', workerId: 'w', unverified: [] };
  expectCode(() => validateSubmitArtifact({ kind: 'investigation', ...envelope, schemaVersion: 2 }), 'UNSUPPORTED_ARTIFACT_SCHEMA_VERSION', 'artifact.schemaVersion must be 1');
  expectCode(() => validateSubmitArtifact({ kind: 'investigation', ...envelope, runId: undefined }), 'MISSING_ARTIFACT_RUN_ID', 'artifact.runId is required');
  expectCode(() => validateSubmitArtifact({ kind: 'investigation', ...envelope, producerKind: 'agent' }), 'INVALID_ARTIFACT_PRODUCER_KIND', 'artifact.producerKind is invalid');
  expectCode(() => validateSubmitArtifact({ kind: 'investigation', ...envelope, sourceVersion: undefined }), 'MISSING_ARTIFACT_SOURCE_VERSION', 'artifact.sourceVersion is required');
  expectCode(() => validateSubmitArtifact({ kind: 'investigation', ...envelope, unverified: 'none' }), 'INVALID_ARTIFACT_UNVERIFIED', 'artifact.unverified must be an array of non-empty strings');
  expectCode(() => validateSubmitArtifact({ kind: 'investigation', ...envelope, unverified: [''] }), 'INVALID_ARTIFACT_UNVERIFIED');
  expectCode(() => validateSubmitArtifact({ kind: 'investigation', ...envelope, evidence: [] }), 'MISSING_ARTIFACT_EVIDENCE', 'artifact.evidence must contain at least one evidence reference');
  expectCode(() => validateSubmitArtifact({ kind: 'investigation', ...envelope, conclusion: { status: 'nope' } }), 'INVALID_ARTIFACT_CONCLUSION');
  // 信封检查先于 kind 字段检查：非法 envelope + 非法 route → 先抛 envelope 错误。
  expectCode(() => validateSubmitArtifact({ kind: 'investigation', ...envelope, schemaVersion: 2, route: 'bad' }), 'UNSUPPORTED_ARTIFACT_SCHEMA_VERSION');
});

test('baseline: envelope worker provenance errors', () => {
  const envelope = { schemaVersion: 1, runId: 'r', producerKind: 'worker', sourceVersion: 's', nodeExecutionId: 'r.n.1', workerId: 'w', unverified: [] };
  expectCode(() => validateSubmitArtifact({ kind: 'investigation', ...envelope, nodeExecutionId: undefined }), 'MISSING_ARTIFACT_NODE_EXECUTION_ID', 'worker artifact.nodeExecutionId is required');
  expectCode(() => validateSubmitArtifact({ kind: 'investigation', ...envelope, workerId: undefined }), 'MISSING_ARTIFACT_WORKER_ID', 'worker artifact.workerId is required');
  expectCode(() => validateSubmitArtifact({ kind: 'investigation', ...envelope, producerKind: 'controller' }), 'INVALID_NON_WORKER_PROVENANCE', 'only worker artifacts may identify nodeExecutionId or workerId');
});

test('baseline: envelope context-mismatch errors', () => {
  const envelope = { schemaVersion: 1, runId: 'r', producerKind: 'worker', sourceVersion: 's', nodeExecutionId: 'r.n.1', workerId: 'w', unverified: [] };
  const context: ArtifactExecutionContext = { schemaVersion: 1, runId: 'r', nodeExecutionId: 'r.n.1', workerId: 'w', sourceVersion: 's' };
  expectCode(() => validateSubmitArtifact({ kind: 'investigation', ...envelope, producerKind: 'user_decision', nodeExecutionId: undefined, workerId: undefined }, context), 'INVALID_ARTIFACT_PRODUCER_FOR_WORKER_SUBMISSION', 'workers may submit only producerKind worker artifacts');
  expectCode(() => validateSubmitArtifact({ kind: 'investigation', ...envelope, runId: 'other' }, context), 'ARTIFACT_RUN_ID_MISMATCH', 'artifact.runId does not match the current run');
  expectCode(() => validateSubmitArtifact({ kind: 'investigation', ...envelope, nodeExecutionId: 'r.other.1' }, context), 'ARTIFACT_NODE_EXECUTION_ID_MISMATCH', 'artifact.nodeExecutionId does not match the current node execution');
  expectCode(() => validateSubmitArtifact({ kind: 'investigation', ...envelope, workerId: 'other' }, context), 'ARTIFACT_WORKER_ID_MISMATCH', 'artifact.workerId does not match the current worker');
  expectCode(() => validateSubmitArtifact({ kind: 'investigation', ...envelope, sourceVersion: 'other' }, context), 'ARTIFACT_SOURCE_VERSION_MISMATCH', 'artifact.sourceVersion does not match the current source version');
  // v2 工作流要求真实 worker conclusion。
  const v2: ArtifactExecutionContext = { ...context, requiresArtifactConclusion: true };
  expectCode(() => validateSubmitArtifact({ kind: 'investigation', route: 'local_fix', rootCause: 'c', evidence: ['x'], ...envelope }, v2), 'MISSING_ARTIFACT_CONCLUSION', 'worker artifact.conclusion is required for this workflow');
  // 信封 evidence 为空数组也是违规声明。
  expectCode(() => validateSubmitArtifact({ kind: 'investigation', route: 'local_fix', rootCause: 'c', evidence: ['x'], conclusion: { status: 'accepted', summary: 'ok' }, ...envelope, evidence: [] }), 'MISSING_ARTIFACT_EVIDENCE');
  // 仓库变更路径的信封 verification 缺 candidateRevision。
  const repoChangeContext: ArtifactExecutionContext = { ...context, requiresRepositoryChange: true };
  expectCode(() => validateSubmitArtifact({ kind: 'verification', accepted: true, evidence: ['test:x'], ...envelope }, repoChangeContext), 'MISSING_VERIFICATION_REVISION');
});

test('baseline: validateArtifactEnvelope direct object guard', () => {
  expectCode(() => validateArtifactEnvelope('not-an-object'), 'INVALID_ARTIFACT_ENVELOPE', 'artifact envelope must be an object');
});
