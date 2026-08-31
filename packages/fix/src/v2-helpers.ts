import type { EvidenceItem, UserDecisionArtifact, VerificationArtifact, VerificationRequirement } from '@pi/workflow-contracts';
import type { FixReasonCode } from './definition.ts';

// ============================================================
// fix v2 运行时辅助工具（独立纯函数模块，无内部状态）
//
// 供上层（Controller / UI 适配层 / Worker）复用：
// - 人工最终验收的 UI 交互与 user_decision Artifact 构造（collectDecision）
// - 验证契约（VerificationRequirement）与验证 Artifact 的守卫校验（guardVerification）
// - 评审/验收摘要载荷构造（buildReviewPayload）
// - 验证通过状态判定（checkVerificationAccepted，与 guardVerification 配合区分
//   “验证未通过回流”与“验证契约不满足”两种失败语义）
// ============================================================

// 人工最终验收的动作选项：UI 文案 → user_decision.decision。
// 注意 action 值使用连字符（'request-changes'），Artifact 契约使用下划线（'request_changes'），
// 由 collectDecision 在构造 Artifact 时完成映射。
// '继续验证（配置已修改）' 仅用于配置类验证失败后的 WAITING_FOR_USER：只回 VERIFYING，
// 不能代替 approve 或回流 IMPLEMENTING。
export const FIX_REVIEW_ACTIONS: Record<string, 'approve' | 'request-changes' | 'reject' | 'continue-verification' | 'continue-disposition'> = {
  '通过并接受': 'approve',
  '打回（选择原因）': 'request-changes',
  '拒绝': 'reject',
  '继续验证（配置已修改）': 'continue-verification',
  // D3：处置自动等待（wait_decision / external_action）的继续出口，同一 'continue-disposition'
  // 动作值（Artifact decision 为 continue_disposition），由 Runtime 按等待种类路由回 DISPOSITION 或 VERIFYING。
  '继续（已作出处置决定）': 'continue-disposition',
  '继续（外部动作已完成）': 'continue-disposition',
};

// 打回原因选项：UI 文案 → 结构化原因码（与 definition.ts 的 FixReasonCode 对齐）。
// Controller 依据原因码确定性映射回流阶段，不允许自由文本影响 Transition。
export const FIX_REVIEW_REASONS: Record<string, FixReasonCode> = {
  '根因或影响面判断错误': 'root_cause_or_impact',
  '修复不完整或引入回归': 'fix_incomplete_or_regression',
  '需求分类或处置方式错误': 'requirement_disposition_error',
  '缺少外部条件': 'missing_external_condition',
};

// UI 上下文抽象：hasUI=false 表示无交互环境，collectDecision 直接放弃；
// notify/select 由上层适配（终端选择、飞书交互、CLI 提问等）。
export interface ReviewContextUI {
  hasUI: boolean;
  notify(msg: string, type?: 'info' | 'warning' | 'error'): void;
  select(title: string, options: string[]): Promise<string | undefined>;
  /** 可选自由文本收集（如 continue_disposition 的处置决定内容）；宿主无 input 能力时缺省跳过。 */
  input?(prompt: string, placeholder?: string): Promise<string | undefined>;
}

export interface CollectDecisionPayload {
  requestId?: string;
  candidateRevision?: string;
  summary?: string;
  /** 仅展示指定动作（文案键，必须是 FIX_REVIEW_ACTIONS 的子集）；缺省展示全部动作。 */
  actions?: string[];
}

// 通过 UI 收集人工最终验收决定并构造 user_decision Artifact。
// 流程：notify(summary) → select 动作 → 若打回再 select 原因码；任一步取消（返回 undefined）整体放弃。
// requestId 在 Artifact 契约中要求非空字符串；UI 层允许缺省，由调用方保证提供。
export async function collectDecision(ctx: ReviewContextUI, payload: CollectDecisionPayload): Promise<UserDecisionArtifact | undefined> {
  if (!ctx.hasUI) return undefined;
  ctx.notify(payload.summary ?? '');
  const actionOptions = payload.actions ?? Object.keys(FIX_REVIEW_ACTIONS);
  const action = await ctx.select('最终验收决定', actionOptions);
  if (action === undefined) return undefined;
  const actionDecision = FIX_REVIEW_ACTIONS[action];
  let decision: 'approve' | 'request_changes' | 'reject' | 'continue_verification' | 'continue_disposition';
  let reasonCode: string | undefined;
  let noteValue: string | undefined;
  if (actionDecision === 'request-changes') {
    decision = 'request_changes';
    const reasonLabel = await ctx.select('打回原因', Object.keys(FIX_REVIEW_REASONS));
    if (reasonLabel === undefined) return undefined;
    reasonCode = FIX_REVIEW_REASONS[reasonLabel];
  } else if (actionDecision === 'continue-verification') {
    decision = 'continue_verification';
  } else if (actionDecision === 'continue-disposition') {
    decision = 'continue_disposition';
    // F1：继续处置必须携带用户处置决定内容（note）。有输入能力时收集，空/取消视为整体放弃
    //（保持 WAITING_FOR_USER，避免无内容继续造成 wait_decision 反复循环）；无输入能力的宿主
    //（如纯 CLI 构造路径）不强制，由调用方保证通过 reasonCode 等字段携带内容。
    if (ctx.input) {
      const note = (await ctx.input('处置决定内容（将传给处置 worker）', ''))?.trim();
      if (!note) return undefined;
      noteValue = note;
    }
  } else {
    decision = actionDecision;
  }
  return {
    kind: 'user_decision',
    decision,
    requestId: payload.requestId,
    reasonCode,
    ...(noteValue !== undefined ? { note: noteValue } : {}),
    candidateRevision: payload.candidateRevision,
  } as UserDecisionArtifact;
}

// 判断证据项是否为工具/测试/外部证据：字符串前缀（tool:/test:/external:）或对象 kind。
const isToolOrTestExternalEvidence = (item: EvidenceItem): boolean => {
  if (typeof item === 'string') {
    return item.startsWith('tool:') || item.startsWith('test:') || item.startsWith('external:');
  }
  return item.kind === 'tool' || item.kind === 'test' || item.kind === 'external';
};

// 验证契约守卫：验证 Artifact 不满足 VerificationRequirement 时抛带前缀码的 Error，
// 便于调用方分类处理与测试断言。检查顺序：版本绑定 → 证据 → 必检项（存在且值为 true）→ 未验证项 → 剩余风险。
// candidateRevision 按 requiresRepositoryChange 区分：仓库变更路径必须绑定被验证的 implementation 版本
//（与 implementation 的一致性由 Runtime/Acceptance 控制面强制）；无仓库变更路径没有 implementation
// 可比对，允许省略；未声明路径时不在此拦截，由 Runtime/Acceptance 把关。
export function guardVerification(req: VerificationRequirement, artifact: VerificationArtifact, opts: { requiresRepositoryChange?: boolean } = {}): void {
  if (opts.requiresRepositoryChange === true && (!artifact.candidateRevision || artifact.candidateRevision.trim().length === 0)) {
    throw new Error('VERIFICATION_REVISION_MISSING: repository-change verification must bind the verified version (candidateRevision) equal to the implementation revision');
  }
  if (req.requireToolOrTestEvidence && !artifact.evidence.some(isToolOrTestExternalEvidence)) {
    throw new Error('VERIFICATION_EVIDENCE_INSUFFICIENT: 验证证据缺少 tool:/test:/external: 来源');
  }
  const checks = artifact.checks;
  if (!checks || !req.requiredChecks.every((check) => check in checks)) {
    throw new Error('VERIFICATION_CHECKS_MISSING: 必检项未全部出现在 verification.checks 键中');
  }
  // 必检项不仅需要存在，值还必须显式为 true：false 或非布尔说明（仅占位）不构成通过。
  if (!req.requiredChecks.every((check) => checks[check] === true)) {
    throw new Error('VERIFICATION_CHECKS_NOT_PASSED: 必检项必须显式标记为 true');
  }
  if (!req.allowUnverified && artifact.unverified !== undefined && artifact.unverified.length > 0) {
    throw new Error('VERIFICATION_HAS_UNVERIFIED: 存在未验证项，契约不允许通过');
  }
  if (req.requireRemainingRisk && (artifact.remainingRisk === undefined || artifact.remainingRisk.length === 0)) {
    throw new Error('VERIFICATION_REMAINING_RISK_MISSING: 缺少剩余风险评估');
  }
}

// 把 guardVerification 抛出的“message 前缀码”（VERIFICATION_*: …）提升为结构化 code，
// 供 pauseRecoverableNode 写入 workflow-node-failure.data.code 与通知文本，避免退化为 WORKFLOW_ERROR。
// 无法解析前缀的普通 Error 用 VERIFICATION_GUARD_FAILED 兜底（仍是稳定码，不是自由文本）。
export function withGuardCode(error: unknown): { code: string; message: string } {
  if (!(error instanceof Error)) return { code: 'VERIFICATION_GUARD_FAILED', message: String(error) };
  // 只承认 guardVerification 自己的 VERIFICATION_* 命名空间前缀；其他大写前缀的普通 Error
  // 不得被误分类成稳定验证码（否则普通异常会混入验证 Guard 的错误边界）。
  const match = /^(VERIFICATION_[A-Z][A-Z0-9_]+):\s*/.exec(error.message);
  return { code: match ? match[1] : 'VERIFICATION_GUARD_FAILED', message: error.message };
}

export interface BuildReviewPayloadInput {
  summary?: string;
  overview?: string;
  candidateRevision?: string;
  rootCause?: string;
  dispositionSummary?: string;
  changeSummary?: string;
  filesChanged?: string[];
  evidence?: unknown[];
  unverified?: string[];
  remainingRisk?: string[];
  verificationFailure?: { kind: string; reason: string; responsibility?: string; resolution?: string };
  reviewConclusions?: unknown[];
}

// 评审/验收摘要载荷：traceId 取 runId 保持端到端可追溯；
// currentVersion 缺省为 'no-change'（未产生仓库候选变更时明确标记）。
// 现象字段投影自 Intake 的 summary/overview（用户可读字段），原始 problem 不进入人工摘要。
export function buildReviewPayload(runId: string, requestId: string | undefined, p: BuildReviewPayloadInput): Record<string, unknown> {
  return {
    traceId: runId,
    ...(requestId !== undefined ? { requestId } : {}),
    ...(p.summary !== undefined ? { summary: p.summary } : {}),
    ...(p.overview !== undefined ? { overview: p.overview } : {}),
    ...(p.rootCause !== undefined ? { rootCause: p.rootCause } : {}),
    ...(p.dispositionSummary !== undefined ? { disposition: p.dispositionSummary } : {}),
    ...(p.changeSummary !== undefined ? { changeSummary: p.changeSummary } : {}),
    ...(p.filesChanged !== undefined ? { filesChanged: p.filesChanged } : {}),
    verification: {
      ...(p.evidence !== undefined ? { evidence: p.evidence } : {}),
      ...(p.unverified !== undefined ? { unverified: p.unverified } : {}),
    },
    ...(p.remainingRisk !== undefined ? { remainingRisk: p.remainingRisk } : {}),
    ...(p.verificationFailure !== undefined ? { verificationFailure: p.verificationFailure } : {}),
    currentVersion: p.candidateRevision ?? 'no-change',
    ...(p.reviewConclusions !== undefined ? { reviewConclusions: p.reviewConclusions } : {}),
  };
}

// 验证是否通过：accepted===true。
// 与 guardVerification 配合：guard 抛错表示“验证契约不满足”（证据/必检/未验证/剩余风险缺失），
// accepted===false 表示“验证未通过需回流实现”，二者是不同失败语义，调用方需区分处理。
export function checkVerificationAccepted(verification: VerificationArtifact): boolean {
  return verification.accepted === true;
}