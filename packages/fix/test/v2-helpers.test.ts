import test from 'node:test';
import assert from 'node:assert/strict';
import type { VerificationArtifact, VerificationRequirement } from '@pi/workflow-contracts';
import type { ReviewContextUI } from '../src/v2-helpers.ts';
import {
  FIX_REVIEW_ACTIONS,
  FIX_REVIEW_REASONS,
  collectDecision,
  guardVerification,
  buildReviewPayload,
  checkVerificationAccepted,
  withGuardCode,
} from '../src/v2-helpers.ts';

// ---- 测试夹具 -------------------------------------------------------------

// 可编程 UI：queue 依次作为 select 的返回值，notices 记录 notify 消息。
class FakeUI implements ReviewContextUI {
  hasUI: boolean;
  notices: string[] = [];
  private queue: (string | undefined)[];

  constructor(queue: (string | undefined)[] = [], hasUI = true) {
    this.queue = queue;
    this.hasUI = hasUI;
  }

  notify(msg: string, _type?: 'info' | 'warning' | 'error'): void {
    this.notices.push(msg);
  }

  async select(_title: string, _options: string[]): Promise<string | undefined> {
    return this.queue.shift();
  }
}

const noUi: ReviewContextUI = {
  hasUI: false,
  notify: () => {
    throw new Error('无 UI 不应调用 notify');
  },
  select: async () => {
    throw new Error('无 UI 不应调用 select');
  },
};

const verificationRequirement: VerificationRequirement = {
  requiredChecks: ['original_issue', 'root_cause_cut'],
  requireToolOrTestEvidence: true,
  requireCandidateRevisionMatch: true,
  allowUnverified: false,
  requireRemainingRisk: true,
  onRejected: 'return_to_implementation',
};

const validVerification: VerificationArtifact = {
  kind: 'verification',
  accepted: true,
  candidateRevision: 'c1',
  evidence: ['tool: 单测通过'],
  checks: { original_issue: true, root_cause_cut: true },
  unverified: [],
  remainingRisk: ['第三方兼容性未纳入回归'],
};

// ---- 1. 常量语义 -----------------------------------------------------------

test('FIX_REVIEW_ACTIONS 与 FIX_REVIEW_REASONS 常量符合语义映射', () => {
  assert.deepEqual(FIX_REVIEW_ACTIONS, {
    '通过并接受': 'approve',
    '打回（选择原因）': 'request-changes',
    '拒绝': 'reject',
    '继续验证（配置已修改）': 'continue-verification',
  });
  assert.deepEqual(FIX_REVIEW_REASONS, {
    '根因或影响面判断错误': 'root_cause_or_impact',
    '修复不完整或引入回归': 'fix_incomplete_or_regression',
    '需求分类或处置方式错误': 'requirement_disposition_error',
    '缺少外部条件': 'missing_external_condition',
  });
});

// ---- 2. collectDecision ---------------------------------------------------

test('collectDecision 无 UI 时直接返回 undefined 且不触发交互', async () => {
  const result = await collectDecision(noUi, { requestId: 'req-1', summary: '请验收' });
  assert.equal(result, undefined);
});

test('collectDecision 选择通过并接受 → approve 且不带 reasonCode', async () => {
  const ui = new FakeUI(['通过并接受']);
  const result = await collectDecision(ui, { requestId: 'req-1', candidateRevision: 'c1', summary: '请最终验收' });
  assert.equal(result?.kind, 'user_decision');
  assert.equal(result?.decision, 'approve');
  assert.equal(result?.requestId, 'req-1');
  assert.equal(result?.candidateRevision, 'c1');
  assert.equal(result?.reasonCode, undefined);
  assert.deepEqual(ui.notices, ['请最终验收']);
});

test('collectDecision 选择拒绝 → reject', async () => {
  const ui = new FakeUI(['拒绝']);
  const result = await collectDecision(ui, { requestId: 'req-1' });
  assert.equal(result?.decision, 'reject');
  assert.equal(result?.reasonCode, undefined);
});

test('collectDecision 打回 + 各原因文案 → request_changes 且映射正确 reasonCode', async () => {
  const cases: [string, string][] = [
    ['根因或影响面判断错误', 'root_cause_or_impact'],
    ['修复不完整或引入回归', 'fix_incomplete_or_regression'],
    ['需求分类或处置方式错误', 'requirement_disposition_error'],
    ['缺少外部条件', 'missing_external_condition'],
  ];
  for (const [reasonLabel, reasonCode] of cases) {
    const ui = new FakeUI(['打回（选择原因）', reasonLabel]);
    const result = await collectDecision(ui, { requestId: 'req-1' });
    assert.equal(result?.decision, 'request_changes', `${reasonLabel} 应映射为 request_changes`);
    assert.equal(result?.reasonCode, reasonCode, `${reasonLabel} 应映射为 ${reasonCode}`);
  }
});

test('collectDecision 任一步取消均返回 undefined', async () => {
  // 动作选择被取消
  const cancelAction = new FakeUI([undefined]);
  assert.equal(await collectDecision(cancelAction, { requestId: 'req-1' }), undefined);
  // 打回后的原因选择被取消
  const cancelReason = new FakeUI(['打回（选择原因）', undefined]);
  assert.equal(await collectDecision(cancelReason, { requestId: 'req-1' }), undefined);
});

// ---- 3. guardVerification ---------------------------------------------------

test('guardVerification 证据不满足（空 evidence）抛 VERIFICATION_EVIDENCE_INSUFFICIENT', () => {
  assert.throws(
    () => guardVerification(verificationRequirement, { ...validVerification, evidence: [] }),
    /VERIFICATION_EVIDENCE_INSUFFICIENT/,
  );
});

test('guardVerification 证据不满足（仅普通字符串或 log 类证据）抛 VERIFICATION_EVIDENCE_INSUFFICIENT', () => {
  assert.throws(
    () => guardVerification(verificationRequirement, { ...validVerification, evidence: ['log: 查看运行日志'] }),
    /VERIFICATION_EVIDENCE_INSUFFICIENT/,
  );
  assert.throws(
    () => guardVerification(verificationRequirement, { ...validVerification, evidence: [{ ref: '日志条目', kind: 'log' }] }),
    /VERIFICATION_EVIDENCE_INSUFFICIENT/,
  );
});

test('guardVerification 对象类 tool/test/external 证据可通过', () => {
  assert.doesNotThrow(() => guardVerification(verificationRequirement, { ...validVerification, evidence: [{ ref: 'e2e 用例', kind: 'test', summary: '回归通过' }] }));
});

test('guardVerification 必检项缺失抛 VERIFICATION_CHECKS_MISSING', () => {
  assert.throws(
    () => guardVerification(verificationRequirement, { ...validVerification, checks: { original_issue: true } }),
    /VERIFICATION_CHECKS_MISSING/,
  );
  assert.throws(
    () => guardVerification(verificationRequirement, { ...validVerification, checks: undefined }),
    /VERIFICATION_CHECKS_MISSING/,
  );
});

test('guardVerification 必检项存在但值为 false 抛 VERIFICATION_CHECKS_NOT_PASSED', () => {
  assert.throws(
    () => guardVerification(verificationRequirement, { ...validVerification, checks: { original_issue: true, root_cause_cut: false } }),
    /VERIFICATION_CHECKS_NOT_PASSED/,
  );
});

test('guardVerification 必检项仅存在但值为非布尔说明（字符串）抛 VERIFICATION_CHECKS_NOT_PASSED', () => {
  assert.throws(
    () => guardVerification(verificationRequirement, { ...validVerification, checks: { original_issue: true, root_cause_cut: '已覆盖原始场景' } }),
    /VERIFICATION_CHECKS_NOT_PASSED/,
  );
});

test('guardVerification 未验证项非空且不允许未验证时抛 VERIFICATION_HAS_UNVERIFIED', () => {
  assert.throws(
    () => guardVerification(verificationRequirement, { ...validVerification, unverified: ['未覆盖的极端场景'] }),
    /VERIFICATION_HAS_UNVERIFIED/,
  );
  // allowUnverified=true 时放行
  assert.doesNotThrow(() => guardVerification({ ...verificationRequirement, allowUnverified: true }, { ...validVerification, unverified: ['未覆盖的极端场景'] }));
});

test('guardVerification 缺少剩余风险且要求记录时抛 VERIFICATION_REMAINING_RISK_MISSING', () => {
  assert.throws(
    () => guardVerification(verificationRequirement, { ...validVerification, remainingRisk: [] }),
    /VERIFICATION_REMAINING_RISK_MISSING/,
  );
  assert.throws(
    () => guardVerification(verificationRequirement, { ...validVerification, remainingRisk: undefined }),
    /VERIFICATION_REMAINING_RISK_MISSING/,
  );
  // requireRemainingRisk=false 时放行
  assert.doesNotThrow(() => guardVerification({ ...verificationRequirement, requireRemainingRisk: false }, { ...validVerification, remainingRisk: [] }));
});

test('guardVerification 全部满足时不抛错', () => {
  assert.doesNotThrow(() => guardVerification(verificationRequirement, validVerification));
});

// D4/P1：candidateRevision 按 requiresRepositoryChange 区分：仓库变更路径必须绑定被验证的
// implementation 版本（缺失或空白拒绝）；无仓库变更路径没有 implementation 可比对，允许省略；
// 未声明路径时不在此拦截，由 Runtime/Acceptance 控制面把关。
test('guardVerification requires candidateRevision only on the repository-change path', () => {
  const noRevision = { ...validVerification, candidateRevision: undefined };
  // 仓库变更路径：缺失或空白版本都拒绝。
  assert.throws(() => guardVerification(verificationRequirement, noRevision, { requiresRepositoryChange: true }), /VERIFICATION_REVISION_MISSING/);
  assert.throws(() => guardVerification(verificationRequirement, { ...validVerification, candidateRevision: '   ' }, { requiresRepositoryChange: true }), /VERIFICATION_REVISION_MISSING/);
  // 无仓库变更路径（显式 false 或未声明路径）允许省略。
  assert.doesNotThrow(() => guardVerification(verificationRequirement, noRevision, { requiresRepositoryChange: false }));
  assert.doesNotThrow(() => guardVerification(verificationRequirement, noRevision));
  // 存在版本时两条路径都通过。
  assert.doesNotThrow(() => guardVerification(verificationRequirement, validVerification, { requiresRepositoryChange: false }));
  assert.doesNotThrow(() => guardVerification(verificationRequirement, validVerification, { requiresRepositoryChange: true }));
});

// ---- 4. buildReviewPayload ---------------------------------------------------

test('buildReviewPayload 字段齐全且值正确', () => {
  const payload = buildReviewPayload('run-1', 'req-1', {
    summary: '登录后白屏',
    overview: '登录后白屏，影响核心链路，怀疑前端渲染异常',
    candidateRevision: 'abc123',
    rootCause: '状态未初始化导致空值访问',
    dispositionSummary: '修复状态初始化逻辑',
    changeSummary: '为状态字段补充初始化默认值',
    filesChanged: ['src/session.ts'],
    evidence: ['tool: 单测通过'],
    unverified: [],
    remainingRisk: ['旧版本数据兼容'],
    verificationFailure: { kind: 'configuration', reason: '环境配置错误' },
    reviewConclusions: [{ status: 'accepted', summary: '复审通过' }],
  });
  assert.equal(payload.traceId, 'run-1');
  assert.equal(payload.requestId, 'req-1');
  // 现象投影自 Intake summary/overview；原始 problem 不进入人工摘要。
  assert.equal(payload.summary, '登录后白屏');
  assert.equal(payload.overview, '登录后白屏，影响核心链路，怀疑前端渲染异常');
  assert.equal('phenomenon' in payload, false, '原始 problem 不得作为 phenomenon 进入人工摘要');
  assert.deepEqual(payload.verificationFailure, { kind: 'configuration', reason: '环境配置错误' });
  assert.equal(payload.rootCause, '状态未初始化导致空值访问');
  assert.equal(payload.disposition, '修复状态初始化逻辑');
  assert.equal(payload.changeSummary, '为状态字段补充初始化默认值');
  assert.deepEqual(payload.filesChanged, ['src/session.ts']);
  assert.deepEqual(payload.verification, { evidence: ['tool: 单测通过'], unverified: [] });
  assert.deepEqual(payload.remainingRisk, ['旧版本数据兼容']);
  assert.equal(payload.currentVersion, 'abc123');
  assert.deepEqual(payload.reviewConclusions, [{ status: 'accepted', summary: '复审通过' }]);
});

test('buildReviewPayload currentVersion 缺省为 no-change 且 traceId===runId', () => {
  const payload = buildReviewPayload('run-2', undefined, { summary: '仅说明性处置，无仓库变更' });
  assert.equal(payload.traceId, 'run-2');
  assert.equal(payload.currentVersion, 'no-change');
  assert.equal('requestId' in payload, false);
  assert.equal(payload.summary, '仅说明性处置，无仓库变更');
  assert.equal('phenomenon' in payload, false, '原始 problem 不得进入人工摘要');
});

// ---- 5. checkVerificationAccepted ---------------------------------------------

test('checkVerificationAccepted 按 accepted 字段判定', () => {
  assert.equal(checkVerificationAccepted({ ...validVerification, accepted: true }), true);
  assert.equal(checkVerificationAccepted({ ...validVerification, accepted: false }), false);
});

// Keep the public exports explicit for callers.
assert.equal(typeof collectDecision, 'function');
assert.equal(typeof guardVerification, 'function');
assert.equal(typeof buildReviewPayload, 'function');
assert.equal(typeof checkVerificationAccepted, 'function');
assert.equal(typeof withGuardCode, 'function');

// round-6 S-4：withGuardCode 只承认 VERIFICATION_ 命名空间前缀（稳定码），其他大写前缀的
// 普通错误不得被误分类成验证码；非 Error 输入用 VERIFICATION_GUARD_FAILED 兜底。
test('withGuardCode promotes only the VERIFICATION_ namespace prefix to a stable code', () => {
  // VERIFICATION_ 前缀 → 结构化码（含下划线/数字，大小写规范）。
  assert.deepEqual(withGuardCode(new Error('VERIFICATION_EVIDENCE_INSUFFICIENT: 证据不足')), {
    code: 'VERIFICATION_EVIDENCE_INSUFFICIENT',
    message: 'VERIFICATION_EVIDENCE_INSUFFICIENT: 证据不足',
  });
  assert.equal(withGuardCode(new Error('VERIFICATION_EV1: 证书过期')).code, 'VERIFICATION_EV1');
  // 其他大写前缀（普通 Error）→ 兜底码，不把自由文本当码。
  assert.deepEqual(withGuardCode(new Error('SOME_OTHER_ERROR: boom')), {
    code: 'VERIFICATION_GUARD_FAILED',
    message: 'SOME_OTHER_ERROR: boom',
  });
  // 裸前缀 `VERIFICATION_:`（无码体）不属于合法码 → 兜底。
  assert.equal(withGuardCode(new Error('VERIFICATION_: x')).code, 'VERIFICATION_GUARD_FAILED');
  assert.equal(withGuardCode(new Error('verification_lower: x')).code, 'VERIFICATION_GUARD_FAILED');
  // 非 Error 输入 → 兜底。
  assert.equal(withGuardCode('VERIFICATION_FOO: str').code, 'VERIFICATION_GUARD_FAILED');
  assert.equal(withGuardCode(undefined).code, 'VERIFICATION_GUARD_FAILED');
});