import {
  validateSubmitArtifact,
  ArtifactContractError,
  CheckpointRestoreError,
  type Artifact,
  type ArtifactConclusion,
  type ArtifactExecutionContext,
  type AuditSink,
  type Capsule,
  type ChangePlanReviewArtifact,
  type ChangeReviewArtifact,
  type Checkpoint,
  type DispositionArtifact,
  type EvidenceItem,
  type FixAuditEvent,
  type FixAuditEventType,
  type ImplementationArtifact,
  type IntakeArtifact,
  type InvestigationArtifact,
  type InvestigationReviewArtifact,
  type NodeDefinition,
  type PendingDecisionKind,
  type ReviewPolicy,
  type ReviewCycleRecord,
  type RunStore,
  type Stage,
  type UserDecisionArtifact,
  type UserDecisionGate,
  type VerificationArtifact,
  type VerificationRequirement,
  type WorkerExecutor,
  type WorkflowDefinition,
} from '@pi/workflow-contracts';

export * from '@pi/workflow-contracts';
export * from './pi-session-store.ts';
export * from './pi-sdk-worker.ts';

// checkpoint 中的业务事实只允许由 Worker 信封携带（executeNode 盖章）。
// user_decision 不参与 executeNode/runNode 的 Worker 提交（唯一产出者是 Runtime.decide 的受控
// 终局盖章路径，受控终局下该决策 Artifact 随 checkpoint 归档，作为 decisionRecord 的背书）。
// guard_rejection 是 Controller 的裸阻塞记录（无 producerKind），不属于业务事实。
const BUSINESS_ARTIFACT_KINDS = new Set([
  'intake', 'investigation', 'investigation_review', 'disposition',
  'change_plan_review', 'implementation', 'change_review', 'verification',
]);

// nodeExecutionId 的 node 段（${runId}.${node.id}.${ts}）→ 该节点能产出的业务 kind。
// restore 时校验 nodeId 与 Artifact kind 的必要关联：只有 Worker 信封携带 nodeExecutionId，
// 评审节点 id 也映射到其评审 kind（investigation_review 等）。
const NODE_KIND_BY_NODE_ID: Record<string, Artifact['kind']> = {
  intake: 'intake',
  investigate: 'investigation',
  investigation_review: 'investigation_review',
  disposition: 'disposition',
  change_plan_review: 'change_plan_review',
  implement: 'implementation',
  change_review: 'change_review',
  verify: 'verification',
};

// 评审 Artifact kind → 被评审的业务 kind；restore 时校验评审者 Worker 身份与被评审产物独立。
const REVIEWED_KIND_BY_REVIEW_KIND: Record<string, Artifact['kind']> = {
  investigation_review: 'investigation',
  change_plan_review: 'disposition',
  change_review: 'implementation',
};

// 证据项是否 tool/test/external 来源（与 Fix guardVerification 的判定一致）：
// 字符串前缀 tool:/test:/external:，或对象 kind 属三类之一。
const isToolTestExternalEvidence = (item: EvidenceItem): boolean => {
  if (typeof item === 'string') return item.startsWith('tool:') || item.startsWith('test:') || item.startsWith('external:');
  return item.kind === 'tool' || item.kind === 'test' || item.kind === 'external';
};

// verification.candidateRevision 必须是非空字符串：仓库变更路径要求绑定“被验证的版本”，
// 无仓库变更路径允许省略（声明了则不得与已有 implementation 版本矛盾，见 evaluateAcceptance）。
const nonEmptyVerificationRevision = (revision: unknown): revision is string => typeof revision === 'string' && revision.trim().length > 0;

/** Review 策略违约：quorum 不足、评审者不独立或 artifact 种类不符。 */
export class ReviewPolicyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ReviewPolicyError';
    this.code = code;
  }
}

/** Runtime 内部违约：缺少 worker 等执行前提不满足。 */
export class WorkflowRuntimeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'WorkflowRuntimeError';
    this.code = code;
  }
}

export const fixNodes = (worker: WorkerExecutor, skills: Partial<Record<'investigate' | 'implement' | 'verify', string[]>> = {}): Record<string, NodeDefinition> => ({
  investigate: { id: 'investigate', worker, profile: { tools: ['read', 'submit_artifact'], skills: skills.investigate ?? [] } },
  implement: { id: 'implement', worker, profile: { tools: ['read', 'edit', 'write', 'submit_artifact'], skills: skills.implement ?? [] } },
  verify: { id: 'verify', worker, profile: { tools: ['read', 'submit_artifact'], skills: skills.verify ?? [] } },
});

// conclusion 是业务 Artifact 的真实事实，不能由 Runtime 用固定文本伪造。
// 缺少 conclusion 的 v2 worker artifact 会在信封校验时被拒绝；legacy runNode 仍保留旧 API 兼容性。
//（历史遗留的运行时结论盖章函数已删除：Runtime 不得为缺 conclusion 的 Artifact 自动注入 accepted，
//  避免 Acceptance fail-open；legacy runNode 只搬运 provenance，不伪造业务结论。）// 不新增未定义的检查语义：检查名映射到各自评审 Artifact 的既有字段；
// 未知检查名视为不满足（策略声明了无法由 Artifact 证明的检查，不得放行）。
const REVIEW_CHECK_SATISFIERS: Record<string, (artifact: Artifact) => boolean> = {
  root_cause_alignment: (a) => a.kind === 'change_plan_review' && (a as ChangePlanReviewArtifact).rootCauseAlignment === true,
  minimal_scope: (a) => a.kind === 'change_plan_review' && typeof (a as ChangePlanReviewArtifact).changedScope === 'string' && (a as ChangePlanReviewArtifact).changedScope.length > 0,
  // risks/compatibility 由合同强制为数组；这里只验证评审确实声明了对应字段。
  risk_and_compatibility: (a) => a.kind === 'change_plan_review' && Array.isArray((a as ChangePlanReviewArtifact).risks) && Array.isArray((a as ChangePlanReviewArtifact).compatibility),
  verification_plan: (a) => a.kind === 'change_plan_review' && Array.isArray((a as ChangePlanReviewArtifact).verification),
  rollback_plan: (a) => a.kind === 'change_plan_review' && Array.isArray((a as ChangePlanReviewArtifact).rollback),
};

// 评审 Artifact 的硬性通过条件：conclusion accepted，且各评审 kind 至少满足其硬性门槛。
// - investigation_review：evidenceSufficiency 至少要求 sufficient；
// - change_plan_review：rootCauseAlignment 必须为 true；
// - change_review：findingDisposition 必须 all_closed，且每个 finding 必须有正式非-open disposition
//   （closed / accepted_with_note）；缺失（undefined）与 open 一样不能通过，不得被 all_closed 掩盖。
const satisfiesReviewHard = (artifact: Artifact): boolean => {
  if ((artifact as { conclusion?: ArtifactConclusion }).conclusion?.status !== 'accepted') return false;
  if (artifact.kind === 'investigation_review') return (artifact as InvestigationReviewArtifact).evidenceSufficiency === 'sufficient';
  if (artifact.kind === 'change_plan_review') return (artifact as ChangePlanReviewArtifact).rootCauseAlignment === true;
  if (artifact.kind === 'change_review') {
    return (artifact as ChangeReviewArtifact).findingDisposition === 'all_closed'
      && (artifact as ChangeReviewArtifact).findings.every(
        (finding) => finding.disposition === 'closed' || finding.disposition === 'accepted_with_note',
      );
  }
  return true; // 非评审 kind 不作为评审通过项（保留通用语义）
};

// 评审是否算通过：硬性条件 + policy.requiredChecks 全部满足。
const satisfiesReview = (policy: ReviewPolicy, artifact: Artifact): boolean => {
  if (!satisfiesReviewHard(artifact)) return false;
  if (!policy.requiredChecks?.length) return true;
  return policy.requiredChecks.every((check) => REVIEW_CHECK_SATISFIERS[check]?.(artifact) ?? false);
};

// 从账本周期对应的评审 Artifact 推导评审事实（approvals / 唯一评审者 / 评审者身份集合 /
// 周期最后一个 Artifact 的实际位置），用于门禁与恢复时对照账本记录：账本数字必须能被实际评审
// Artifact 支撑（防“仅改账本数字”或“单张评审 Artifact 声称两人批准”的伪造），评审者身份
// 集合必须与 Artifact workerId 集合一致（防“改成同样人数但换了一伙人”），recordedAtIndex 必须
// 等于周期最后一个 Artifact 在产物列表中的实际位置（book 时 artifacts.length-1，后续追加不改历史
// 下标，因此恢复/门禁现场仍可精确核对）。policy 缺失时按硬性通过项计数（不含 requiredChecks）。
const deriveCycleFacts = (record: ReviewCycleRecord, artifacts: readonly Artifact[], policy?: ReviewPolicy): {
  cycleArtifactCount: number; approvals: number; uniqueReviewers: number; reviewerWorkerIds: string[]; lastCycleArtifactIndex: number;
} => {
  const matches: { index: number; artifact: Artifact }[] = artifacts
    .map((artifact, index) => ({ index, artifact }))
    .filter(({ artifact }) => {
      const stamped = artifact as Artifact & { reviewCycleId?: unknown; reviewedNodeId?: unknown };
      return stamped.reviewCycleId === record.cycleId
        && artifact.kind === record.reviewArtifactKind
        && stamped.reviewedNodeId === record.reviewedNodeId;
    });
  const cycleArtifacts = matches.map(({ artifact }) => artifact);
  const approvals = policy === undefined
    ? cycleArtifacts.filter((artifact) => satisfiesReviewHard(artifact)).length
    : cycleArtifacts.filter((artifact) => satisfiesReview(policy, artifact)).length;
  const reviewerWorkerIds = [...new Set(
    cycleArtifacts
      .map((artifact) => (artifact as Artifact & { workerId?: unknown }).workerId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  )].sort();
  const lastCycleArtifactIndex = matches.length ? matches[matches.length - 1].index : -1;
  return {
    cycleArtifactCount: cycleArtifacts.length,
    approvals,
    uniqueReviewers: reviewerWorkerIds.length,
    reviewerWorkerIds,
    lastCycleArtifactIndex,
  };
};

// 账本声明评审者集合与推导集合是否完全一致（与顺序无关，去重后比较）。
const sameReviewerSet = (declared: readonly string[], derived: readonly string[]): boolean => {
  const a = [...new Set(declared)].sort();
  const b = [...new Set(derived)].sort();
  return a.length === b.length && a.every((id, index) => id === b[index]);
};

// 账本记录形状校验：reviewCycles 来自 checkpoint，恢复时只接受结构完整的记录；
// 形状不完整的记录视为不可信（fail-closed），不进入账本 → 门禁不会把它当作合法评审周期。
// 必填字段含 reviewNodeId（评审节点身份）与 recordedAtIndex（记账时刻位置）；数值字段必须为
// 有限非负整数（dispositionIndexAtCycle 允许 -1 = 记账时无最新处置），NaN/负数/小数都拒绝。
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);
const isReviewCycleRecord = (value: unknown): value is ReviewCycleRecord => {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const { cycleId, reviewArtifactKind, reviewedNodeId, requiredApprovals, approvals, passed, reviewerWorkerIds, policyDigest, dispositionIndexAtCycle } = record;
  return typeof cycleId === 'string' && cycleId.length > 0
    && typeof record.reviewNodeId === 'string' && record.reviewNodeId.length > 0
    && typeof reviewArtifactKind === 'string' && reviewArtifactKind.length > 0
    && typeof reviewedNodeId === 'string' && reviewedNodeId.length > 0
    && isNumber(requiredApprovals) && requiredApprovals >= 0
    && isNumber(approvals) && approvals >= 0
    && typeof passed === 'boolean'
    && Array.isArray(reviewerWorkerIds) && reviewerWorkerIds.every((id) => typeof id === 'string' && id.length > 0)
    && typeof policyDigest === 'string' && policyDigest.length > 0
    && isNumber(dispositionIndexAtCycle) && dispositionIndexAtCycle >= -1
    && isNumber(record.recordedAtIndex) && record.recordedAtIndex >= 0;
};

// 唯一的 nodeExecutionId node 段解析规则：`${runId}.<node>.<ts>`——node 段非空且不含 '.'，
// ts 段非空。非法格式（多段/缺段/空段）返回 undefined。restore 校验与 collectNodeWorkerIds
// 必须共用这一规则（否则恢复接受的历史作者可能不进入正确 Node 的排除表，绕过评审独立性）；
// 恢复校验遇非法格式整体 fail-closed。
const parseNodeExecutionId = (runId: string, executionId: string): string | undefined => {
  const prefix = `${runId}.`;
  if (!executionId.startsWith(prefix)) return undefined;
  const parts = executionId.slice(prefix.length).split('.');
  if (parts.length !== 2) return undefined;
  const [nodeId, ts] = parts;
  if (!nodeId || nodeId.length === 0 || ts.length === 0) return undefined;
  return nodeId;
};

// 恢复时重建 Node→Worker 映射（评审独立性守卫只读 nodeWorkerIds）：
// checkpoint 中每个带 nodeExecutionId/workerId 的 Artifact 都登记进所属 Node 的 Worker 名单，
// 保证后续新发起的 runReview（requireIndependentWorker、excludeNodes、reviewedNode 排除）
// 仍把历史作者排除在外；解析失败的协议外记录跳过（不伪造身份）。
const collectNodeWorkerIds = (runId: string, artifacts: readonly Artifact[]): Record<string, string[]> => {
  const nodeWorkerIds: Record<string, string[]> = {};
  for (const artifact of artifacts) {
    const stamp = artifact as Artifact & { nodeExecutionId?: unknown; workerId?: unknown };
    if (typeof stamp.workerId !== 'string' || stamp.workerId.length === 0) continue;
    if (typeof stamp.nodeExecutionId !== 'string') continue;
    const nodeId = parseNodeExecutionId(runId, stamp.nodeExecutionId);
    if (nodeId === undefined) continue;
    (nodeWorkerIds[nodeId] ??= []).push(stamp.workerId);
  }
  return nodeWorkerIds;
};

// ReviewPolicy 的规范化摘要：固定字段序 + 规范化的 reviewer 数组，同一策略两次调用得到同一字符串，
// 用于“周期由当前策略产出”的绑定比较（runReview 记账时写入 cycle.policyDigest；门禁/恢复对照
// Runtime 当前配置的 reviewPolicyFor 结果）。不做加密哈希：绑定目标是逻辑等价值，不是反篡改签名。
export const serializeReviewPolicy = (policy: ReviewPolicy): string => {
  const reviewers = (policy.reviewers ?? []).map((participant) => ({
    model: participant.model,
    skills: participant.skills ? [...participant.skills].sort() : undefined,
  }));
  return JSON.stringify({
    mode: policy.mode,
    requiredApprovals: policy.requiredApprovals,
    requireIndependentWorker: policy.requireIndependentWorker === true,
    excludeNodes: [...(policy.excludeNodes ?? [])].sort(),
    requiredChecks: [...(policy.requiredChecks ?? [])].sort(),
    onRejected: policy.onRejected,
    reviewers,
  });
};

// Runtime 决策记录形状校验：decisionRecord 来自 checkpoint，受控终局 ACCEPTED 恢复只接受
// Runtime.decide 路径盖章的记录（producerKind='user_decision' + source='runtime:decide' +
// 绑定 pendingDecisionRequest 的 requestId）。形状/来源不完整的记录无法构成可验证的人工 approve 事实。
const isDecisionRecord = (value: unknown): value is NonNullable<import('@pi/workflow-contracts').Checkpoint['decisionRecord']> => {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.recordId === 'string' && record.recordId.length > 0
    && ['approve', 'continue_verification', 'continue_disposition', 'request_changes', 'reject'].includes(String(record.decision))
    && typeof record.requestId === 'string' && record.requestId.length > 0
    && record.producerKind === 'user_decision'
    && record.producer === 'user'
    && record.source === 'runtime:decide';
};

// legacy fixDefinition 已迁出产品源码：见 packages/workflow-runtime/test/fixtures/legacy-fix-definition.ts
// （仅 runtime 机制测试使用；产品流程使用 packages/fix 的 fixDefinitionV2）

// “受控终局”能力由定义自身的 acceptance 声明供给（definition-supplied capability，非 Fix 专属开关）：
// 定义在 acceptance 中声明 human_final_approval（人工最终验收）→ Runtime 拥有 ACCEPTED 终局控制面
// （public transition()/runNode() 不得进入；恢复时必须以可验证的 approve 决策事实复算，缺事实 fail-closed）；
// legacy 定义未声明 → 保留定义自身 guard/transition 的验收语义（如 legacy fixDefinition 的
// VERIFYING→ACCEPTED：验证 accepted 才允许），不受 Runtime 终局控制面约束。
const declarationControlledAcceptance = (definition: WorkflowDefinition): boolean => {
  // 受控终局必须由定义显式声明能力（decision: 'user'），不得仅凭 acceptance 的
  // human_final_approval marker 推断——防止任何带该 marker 的定义意外获得 ACCEPTED 终局控制权。
  if (definition.decision !== 'user') return false;
  const acceptance = definition.acceptance;
  if (!acceptance) return false;
  return acceptance.requires.includes('human_final_approval') || acceptance.humanFinalApproval === true;
};

export class WorkflowRuntime {
  stage: Stage;
  private readonly clock: () => number;
  private readonly idGen: () => string;
  private gate?: UserDecisionGate;
  private pendingDecision?: string;
  /** WAITING_FOR_USER 的等待种类（Extension 进入等待前显式声明，Runtime 只负责持久化/恢复与
   *  decide 路由；业务无关，不自行从 Artifact 推导）。无字段的 legacy checkpoint 恢复为 undefined，
   *  沿用既有 Verification 推导语义（isPendingConfigurationWait）。 */
  private pendingDecisionKind?: PendingDecisionKind;
  private problem?: string;
  readonly definition: WorkflowDefinition;
  readonly store: RunStore;
  readonly runId: string;
  private artifacts: Artifact[] = [];
  private definitionVersion?: string;
  private policyDigest?: string;
  private readonly auditSink?: AuditSink;
  private sourceVersion?: string;
  /** 当前有效策略解析器（可选）：配置后 runReview 强制调用方策略与之一致，门禁/恢复按它重算 quorum
   *  与政策摘要，防止降级策略或篡改账本绕过 quorum。未配置时以记账记录自身为准（通用 Runtime 语义）。 */
  private reviewPolicyFor?: (reviewArtifactKind: Artifact['kind']) => ReviewPolicy | undefined;
  private activeNodeId?: string;
  private currentExecution?: { nodeId: string; nodeExecutionId: string; workerId: string; attempt: number };
  private candidateRevision?: string;
  private reviewCycleId?: string;
  /** 评审周期账本：runReview 每次记账一条，随 checkpoint 持久化/恢复。
   *  change_plan_review 的 DISPOSITION → IMPLEMENTING 门禁只认绑定到账本周期（quorum/独立评审者/
   *  与当前处置配对）的评审 Artifact；executeNode/transition/runNode 直传伪造的评审没有账本周期，
   *  一律 fail-closed。 */
  private reviewCycles: ReviewCycleRecord[] = [];
  // 周期唯一性：reviewCycleId 是账本与 Artifact 盖章的绑定键。默认 clock 为毫秒级时，同一 run 内在
  // 同一毫秒发起的两次 runReview 会产生相同 cycleId，导致账本/产物推导跨周期串号（门禁会把两轮的
  // 评审 Artifact 一并算进一个周期）。以实例内单调序号保证同 run 内周期身份唯一。
  private reviewSeq = 0;
  // 审计事件序号：eventId 是审计去重/回放的绑定键，默认 idGen 为毫秒级，同一毫秒内多个事件
  // 必须能区分；以实例内单调序号保证唯一性，跨秒/跨实例由 idGen（含 runId 与时钟）区分。
  private eventSeq = 0;
  private checkpointIncomplete = false;
  // 决策记录产生者：仅 decide() 委托路径置为 'runtime:decide'；legacy resume()/gate 路径不置位，
  // 因此不会把 gate 决策误标成 Runtime decide 路径（未 opt-in 的 legacy checkpoint 不附加 v2 决策来源记录）。
  private decisionRecordProducer?: 'runtime:decide';
  private nodeWorkerIds: Record<string, string[]> = {};
  private ranAnyNode = false;
  /** BLOCKED 解除后回到的目标阶段（外部条件/证据不足等阻塞的 live 现场）；
   *  写入 BLOCKED checkpoint，跨 session 恢复时不能默认回滚到 INVESTIGATING。 */
  private blockedReturnStage?: Stage;

  constructor(
    definition: WorkflowDefinition,
    store: RunStore,
    runId = 'run-1',
    clock = () => Date.now(),
    idGen = () => `${runId}-${clock()}`,
    opts: { definitionVersion?: string; policyDigest?: string; auditSink?: AuditSink; sourceVersion?: string; reviewPolicyFor?: (reviewArtifactKind: Artifact['kind']) => ReviewPolicy | undefined } = {},
  ) {
    this.definition = definition;
    this.store = store;
    this.runId = runId;
    this.stage = definition.initialStage;
    this.clock = clock;
    this.idGen = idGen;
    this.definitionVersion = opts.definitionVersion;
    this.policyDigest = opts.policyDigest;
    this.auditSink = opts.auditSink;
    // 来源绑定优先取构造显式值；缺省以定义声明的 sourceVersion 作为可验证来源（无外部 resolver 时）。
    this.sourceVersion = opts.sourceVersion ?? definition.sourceVersion;
    this.reviewPolicyFor = opts.reviewPolicyFor;
  }

  getArtifacts(): readonly Artifact[] { return this.artifacts; }
  restoreArtifacts(artifacts: readonly Artifact[] | undefined) {
    this.artifacts = artifacts ? [...artifacts] : [];
    for (const artifact of this.artifacts) {
      const record = artifact as Record<string, unknown>;
      try {
        validateSubmitArtifact(artifact);
      } catch (error) {
        const hasEnvelope = ['schemaVersion', 'runId', 'producerKind', 'sourceVersion', 'nodeExecutionId', 'workerId']
          .some((field) => field in record);
        if (!hasEnvelope && (error as { code?: string }).code === 'INVALID_INTAKE_PHENOMENON') {
          // Known legacy Intake shape remains readable for recovery. It is an
          // artifact-level legacy shape: the intake_accepted marker (which requires
          // summary/overview) rejects it at Acceptance time, so it cannot satisfy
          // a v2 Acceptance Definition without blocking the whole restore.
          continue;
        }
        throw new CheckpointRestoreError(
          'INVALID_CHECKPOINT_ARTIFACT',
          `checkpoint artifact ${String(record.kind ?? 'unknown')} is invalid: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const hasEnvelope = ['schemaVersion', 'runId', 'producerKind', 'sourceVersion', 'nodeExecutionId', 'workerId']
        .some((field) => field in record);
      if (!hasEnvelope) {
        // Legacy business artifacts remain readable for recovery. A v2
        // definition marks them incomplete because their provenance cannot be verified.
        if (this.definition.requiresArtifactConclusion) this.checkpointIncomplete = true;
        continue;
      }
      if (this.definition.requiresArtifactConclusion && record.conclusion === undefined && record.kind !== 'guard_rejection' && record.kind !== 'user_decision') {
        // An enveloped legacy artifact may still be read for recovery, but it
        // cannot be treated as a complete v2 business fact. user_decision is
        // the Runtime-stamped decision artifact（由 decide() 盖章归档，本身是验收事实的背书，
        // 不是 Worker 业务结论，不适用 conclusion 契约）。
        this.checkpointIncomplete = true;
      }
      if (record.schemaVersion !== 1 || record.runId !== this.runId || typeof record.sourceVersion !== 'string' || !record.sourceVersion.trim()) {
        throw new CheckpointRestoreError('INVALID_CHECKPOINT_PROVENANCE', `checkpoint artifact ${String(record.kind)} has invalid run/provenance binding`);
      }
      if (record.producerKind === 'worker') {
        if (typeof record.nodeExecutionId !== 'string' || !record.nodeExecutionId.trim() || typeof record.workerId !== 'string' || !record.workerId.trim()) {
          throw new CheckpointRestoreError('INVALID_CHECKPOINT_PROVENANCE', `checkpoint worker artifact ${String(record.kind)} is missing nodeExecutionId or workerId`);
        }
        // Node/Worker 绑定：nodeExecutionId 必须以 runId 为前缀，防止跨 run 复用/伪造执行记录。
        if (!record.nodeExecutionId.startsWith(`${this.runId}.`)) {
          throw new CheckpointRestoreError('INVALID_CHECKPOINT_PROVENANCE', `checkpoint worker artifact ${String(record.kind)} nodeExecutionId ${String(record.nodeExecutionId)} is not bound to run ${this.runId}`);
        }
        // NodeId ↔ Artifact kind 必要关联：nodeExecutionId 的 node 段必须能产出该 kind。
        // 与 collectNodeWorkerIds 共用同一严格解析规则（`${runId}.<node>.<ts>`，无额外段）：
        // 多段/缺段/空段解析失败一律 fail-closed，防止“恢复校验接受的历史作者不进排除表”
        // 或“以合法 run 前缀包装错误的执行记录”冒充正确产物。
        const nodeId = parseNodeExecutionId(this.runId, String(record.nodeExecutionId));
        if (nodeId === undefined) {
          throw new CheckpointRestoreError(
            'INVALID_CHECKPOINT_PROVENANCE',
            `checkpoint worker artifact ${String(record.kind)} has malformed nodeExecutionId ${String(record.nodeExecutionId)} (expected ${this.runId}.<node>.<ts>)`,
          );
        }
        const expectedKindForNode = NODE_KIND_BY_NODE_ID[nodeId];
        if (expectedKindForNode === undefined || expectedKindForNode !== record.kind) {
          throw new CheckpointRestoreError(
            'INVALID_CHECKPOINT_PROVENANCE',
            `checkpoint worker artifact ${String(record.kind)} claims nodeExecutionId ${String(record.nodeExecutionId)} whose node ${nodeId} cannot produce it`,
          );
        }
        // Worker 身份与执行身份的必要关联：评审 Artifact 必须由独立 Worker 产出，
        // 不得与被评审产物共享同一 workerId（否则伪造 checkpoint 可在评审节点“自我评审”冒充独立评审）。
        const reviewedKind = REVIEWED_KIND_BY_REVIEW_KIND[String(record.kind)];
        if (reviewedKind) {
          const reviewed = [...this.artifacts].slice(0, this.artifacts.indexOf(artifact)).reverse()
            .find((item) => item.kind === reviewedKind);
          if (reviewed && String((reviewed as Record<string, unknown>).workerId) === String(record.workerId)) {
            throw new CheckpointRestoreError(
              'INVALID_CHECKPOINT_PROVENANCE',
              `checkpoint review artifact ${String(record.kind)} shares worker ${String(record.workerId)} with the ${reviewedKind} it reviews; a review must be produced by an independent worker`,
            );
          }
        }
      } else if (record.nodeExecutionId !== undefined || record.workerId !== undefined) {
        throw new CheckpointRestoreError('INVALID_CHECKPOINT_PROVENANCE', `checkpoint non-worker artifact ${String(record.kind)} contains worker provenance`);
      }
      // 业务事实只允许由 Worker 信封携带：controller（或用户）以非 worker producerKind 伪造
      // 业务 Artifact 冒充 worker 产出是恢复期 provenance 伪造，fail-closed 拒绝。
      // 裸 Artifact（无 producerKind 字段）保留 legacy 可读路径，由 checkpointIncomplete 标记。
      if (record.producerKind !== undefined && record.producerKind !== 'worker' && BUSINESS_ARTIFACT_KINDS.has(String(record.kind))) {
        throw new CheckpointRestoreError('INVALID_CHECKPOINT_PROVENANCE', `checkpoint business artifact ${String(record.kind)} claims ${String(record.producerKind)} provenance; business facts must be produced by a worker`);
      }
    }
  }

  setDecisionGate(gate: UserDecisionGate) { this.gate = gate; }

  /** 记录 BLOCKED 解除后回到的目标阶段；由产生 BLOCKED 的调用方在 transition('BLOCKED') 前置。 */
  setBlockedReturnStage(stage: Stage) { this.blockedReturnStage = stage; }

  /** 恢复（或当次 Run 已设置）的 BLOCKED 解除目标阶段；无从 checkpoint 恢复时为 undefined。 */
  getBlockedReturnStage(): Stage | undefined { return this.blockedReturnStage; }

  resume() {
    if (this.stage !== 'WAITING_FOR_USER') return;
    const decision = this.gate?.getDecision(this.pendingDecision);
    if (!decision) throw Error('user decision required');
    this.pendingDecision = undefined;
    this.transition('INVESTIGATING', decision);
  }

  transition(to: Stage, artifact?: Artifact) {
    // 受控定义下 ACCEPTED 是受控终局验收态：公共 transition() 一律禁止进入；
    // legacy 定义未 opt-in 受控终局，由其自身 guard/transition 决定 ACCEPTED 边（如验证 accepted → ACCEPTED）。
    if (to === 'ACCEPTED' && this.controlledAcceptance()) {
      throw new WorkflowRuntimeError('ACCEPTED_TRANSITION_NOT_PERMITTED', 'ACCEPTED is a controlled terminal state; only decide() approve can enter it');
    }
    this.assertInvestigationReviewGate(this.stage, to, artifact);
    this.assertVerificationEntryBound(this.stage, to, artifact);
    this.assertChangePlanReviewGate(this.stage, to, artifact);
    this.applyTransition(to, artifact);
  }

  /** acceptance（requires + repositoryChangeRequires）是否声明了某个评审/验收 marker。
   *  当前架构下 Runtime 以此做最小的 Fix-v2 评审语义判断，防止公共 runNode()/transition()
   *  绕过 v2 Review 门禁；后续多 Extension 时应把该判断拆分为 Definition 显式声明。 */
  private acceptanceRequires(marker: string): boolean {
    const acceptance = this.definition.acceptance;
    if (!acceptance) return false;
    return acceptance.requires.includes(marker) || (acceptance.repositoryChangeRequires?.includes(marker) ?? false);
  }

  /** 当前定义是否 opt-in “受控终局”（acceptance 声明 human_final_approval）。
   *  legacy 定义未声明时保留自身对 ACCEPTED 的 guard/transition 语义，不享受 Runtime 终局控制面。 */
  private controlledAcceptance(): boolean {
    return declarationControlledAcceptance(this.definition);
  }

  /** Investigation Review 必须与当前 investigation 成对产生，不能只检查 review 自身 accepted：
   *  - 当前 investigation 有 id 时，review.targetArtifactId 必须显式匹配，且 review 必须晚于
   *    当前 investigation 产生（id 可被重复声明/伪造，不能单独作为配对证明）；
   *  - review 声明了 targetArtifactId 而当前 investigation 无 id（或 id 不同）→ 视为 stale review；
   *  - 双方都无 id 时，review 必须晚于当前 investigation 产生（产生顺序配对），不得复用旧 review。 */
  investigationReviewBindsCurrentInvestigation(): boolean {
    const investigation = this.latestOf('investigation') as InvestigationArtifact | undefined;
    const review = this.latestOf('investigation_review') as InvestigationReviewArtifact | undefined;
    if (!investigation || !review) return false;
    if (review.conclusion?.status !== 'accepted' || review.evidenceSufficiency !== 'sufficient') return false;
    // 产生周期对应：review 只能配对“在它之前产生”的当前 investigation；
    // 旧 review（即使 targetArtifactId 与当前 investigation 的 id 相同）不得放行 fresh investigation。
    const reviewProducedAfterCurrentInvestigation = this.artifacts.indexOf(review) > this.artifacts.indexOf(investigation);
    const targetId = review.targetArtifactId;
    const investigationId = investigation.id;
    if (typeof targetId === 'string' && targetId.trim().length > 0) {
      return reviewProducedAfterCurrentInvestigation
        && typeof investigationId === 'string' && investigationId.trim().length > 0
        && investigationId === targetId;
    }
    if (typeof investigationId === 'string' && investigationId.trim().length > 0) return false;
    return reviewProducedAfterCurrentInvestigation;
  }

  /** 当前 Investigation 是否构成可接受的调查事实：conclusion.status==='accepted' 且
   *  route 属于可进入处置的行动路线（local_fix/requirement_change/design_change）。
   *  调查被拒（rejected/blocked）或证据不足（needs_more_evidence）不构成验收/处置输入。 */
  private currentInvestigationIsAccepted(): boolean {
    const investigation = this.latestOf('investigation') as (InvestigationArtifact & { conclusion?: ArtifactConclusion }) | undefined;
    if (!investigation) return false;
    if (investigation.conclusion?.status !== 'accepted') return false;
    return ['local_fix', 'requirement_change', 'design_change'].includes(investigation.route);
  }

  /** Fix-v2 评审语义门禁：acceptance 声明 investigation_review_accepted 或 investigation_accepted 时，
   *  离开 INVESTIGATING（进入 DISPOSITION / IMPLEMENTING）前必须存在与当前 investigation
   *  配对的有效 investigation_review，且当前 investigation 自身必须构成可接受的调查事实
   *  （conclusion accepted + route 可行动）；防止公共 runNode()/transition() 绕过 v2 门禁，
   *  也防止“调查被拒 + 评审通过”的错误配对进入处置。 */
  private assertInvestigationReviewGate(from: Stage, to: Stage, artifact?: Artifact): void {
    if (from !== 'INVESTIGATING' || (to !== 'DISPOSITION' && to !== 'IMPLEMENTING')) return;
    if (!this.acceptanceRequires('investigation_review_accepted') && !this.acceptanceRequires('investigation_accepted')) return;
    // runNode 等公共入口可能在 artifact 归档前直接 transition：此时该 fresh investigation
    // 视为最后产生，任何已归档 review 都在其之前 → stale，必须拒绝。
    if (artifact?.kind === 'investigation' && !this.artifacts.includes(artifact)) {
      throw new WorkflowRuntimeError(
        'INVESTIGATION_REVIEW_NOT_BOUND',
        'a valid investigation_review bound to the current investigation is required before leaving INVESTIGATING',
      );
    }
    if (!this.investigationReviewBindsCurrentInvestigation()) {
      throw new WorkflowRuntimeError(
        'INVESTIGATION_REVIEW_NOT_BOUND',
        'a valid investigation_review bound to the current investigation is required before leaving INVESTIGATING',
      );
    }
    // 调查本身必须是可接受事实：即使 review 通过并配对，当前 investigation 的 conclusion
    // 被拒或 route 不可行动（needs_more_evidence/blocked）也不得离开 INVESTIGATING 进入处置。
    if (!this.currentInvestigationIsAccepted()) {
      throw new WorkflowRuntimeError(
        'INVESTIGATION_NOT_ACCEPTED',
        'the current investigation must carry an accepted conclusion and a legal actionable route before leaving INVESTIGATING',
      );
    }
  }

  /** 进入 VERIFYING 前的 Change Review Runtime 硬门禁（不能只依赖 Extension 手工检查）：
   *  - 具备 Fix 评审语义（acceptance 声明 change_review_accepted）或当前处置要求仓库变更时启用；
   *  - change_review 必须存在且通过：conclusion accepted、findingDisposition all_closed、
   *    每个 finding 有正式非-open disposition（closed / accepted_with_note，缺失与 open 都不通过）；
   *  - reviewedRevision 必须与当前 implementation 的 candidateRevision 一致；
   *    无仓库变更（当前无 implementation）不凭空要求 candidate revision。 */
  private assertVerificationEntryBound(from: Stage, to: Stage, artifact?: Artifact): void {
    if (to !== 'VERIFYING' || from !== 'IMPLEMENTING') return;
    const repoChange = this.dispositionRequiresRepositoryChange();
    if (!repoChange && !this.acceptanceRequires('change_review_accepted')) return;
    // runNode 等公共入口可能在 artifact 归档前直接 transition：此时该 fresh implementation
    // 视为最后产生（产生序号取当前末尾），已归档 review 都在其之前，不得放行。
    const freshImplementation = artifact?.kind === 'implementation' && !this.artifacts.includes(artifact)
      ? artifact as ImplementationArtifact
      : undefined;
    const implementation = freshImplementation
      ?? this.latestOf('implementation') as ImplementationArtifact | undefined;
    const review = this.latestOf('change_review') as ChangeReviewArtifact | undefined;
    if (!review) {
      throw new WorkflowRuntimeError('CHANGE_REVIEW_NOT_BOUND', 'change_review must bind the current implementation candidateRevision before entering verification');
    }
    if (
      review.conclusion?.status !== 'accepted'
      || review.findingDisposition !== 'all_closed'
      || !review.findings.every((finding) => finding.disposition === 'closed' || finding.disposition === 'accepted_with_note')
    ) {
      throw new WorkflowRuntimeError('CHANGE_REVIEW_NOT_PASSED', 'change_review must be accepted with findingDisposition all_closed and a formal non-open disposition on every finding before entering verification');
    }
    if (implementation) {
      // fresh implementation 不能被旧同 kind Review 放行：review 必须绑定当前 candidateRevision
      // 且晚于当前 implementation 产生（验证失败回流后重交的同版本实现同样需要重新评审）。
      const implementationProducedAtIndex = freshImplementation ? this.artifacts.length : this.artifacts.indexOf(implementation);
      if (!implementation.artifact.candidateRevision || review.reviewedRevision !== implementation.artifact.candidateRevision
        || this.artifacts.indexOf(review) < implementationProducedAtIndex) {
        throw new WorkflowRuntimeError('CHANGE_REVIEW_NOT_BOUND', 'change_review must bind the current implementation candidateRevision before entering verification');
      }
    } else if (repoChange) {
      throw new WorkflowRuntimeError('CHANGE_REVIEW_NOT_BOUND', 'change_review must bind the current implementation candidateRevision before entering verification');
    }
  }

  /** Change Plan Review 硬门禁（DISPOSITION → IMPLEMENTING 的仓库变更路径）：
   *  当前有效的 disposition 声明 requiresRepositoryChange===true 时，离开 DISPOSITION 进入
   *  IMPLEMENTING 前必须存在通过且配对当前处置/方案的 change_plan_review：
   *  - conclusion accepted + rootCauseAlignment===true（根因对齐）；
   *  - 每个 finding 必须有正式非-open disposition（closed / accepted_with_note；缺失与 open 不通过）；
   *  - review 必须晚于当前 disposition 产生（旧 review 不构成对当前处置/方案的评审）；
   *  - transition/runNode 直传未归档的 fresh disposition → 一律拒绝（已归档 review 都产生于它之前，
   *    公共入口不能在归档前绕过评审）；
   *  无仓库变更的处置 / 非 DISPOSITION→IMPLEMENTING 边不要求 plan review。
   *  gate 不依赖 FIX_REVIEW_POLICIES：合同只保证结构完整，此门禁强制根因对齐 + 正式 finding 处置 +
   *  配对周期。这是统一控制面（不因定义 opt-in 顺序/acceptance 差异而漏过），对 legacy 定义同样生效。 */
  private assertChangePlanReviewGate(from: Stage, to: Stage, artifact?: Artifact): void {
    if (from !== 'DISPOSITION' || to !== 'IMPLEMENTING') return;
    const freshDisposition = artifact?.kind === 'disposition' && !this.artifacts.includes(artifact)
      ? artifact as DispositionArtifact
      : undefined;
    const disposition = freshDisposition ?? this.latestOf('disposition') as DispositionArtifact | undefined;
    if (!disposition || disposition.requiresRepositoryChange !== true) return;
    if (freshDisposition) {
      // fresh disposition 未被归档：即使存在已归档 review，也产生于该 disposition 之前 → stale，不得放行。
      throw new WorkflowRuntimeError(
        'CHANGE_PLAN_REVIEW_NOT_BOUND',
        'a valid change_plan_review bound to the current disposition/plan is required before leaving DISPOSITION to IMPLEMENTING',
      );
    }
    const review = this.latestOf('change_plan_review') as ChangePlanReviewArtifact | undefined;
    if (!review) {
      throw new WorkflowRuntimeError(
        'CHANGE_PLAN_REVIEW_NOT_BOUND',
        'a valid change_plan_review bound to the current disposition/plan is required before leaving DISPOSITION to IMPLEMENTING',
      );
    }
    if (
      review.conclusion?.status !== 'accepted'
      || review.rootCauseAlignment !== true
      || !review.findings.every((finding) => finding.disposition === 'closed' || finding.disposition === 'accepted_with_note')
    ) {
      throw new WorkflowRuntimeError(
        'CHANGE_PLAN_REVIEW_NOT_PASSED',
        'change_plan_review must be accepted with rootCauseAlignment true and a formal non-open disposition on every finding before leaving DISPOSITION to IMPLEMENTING',
      );
    }
    if (this.artifacts.indexOf(review) < this.artifacts.indexOf(disposition)) {
      // review 产生于当前 disposition 之前：旧 review 不能放行新的处置/方案（配对周期对应）。
      throw new WorkflowRuntimeError(
        'CHANGE_PLAN_REVIEW_NOT_BOUND',
        'change_plan_review must be produced after the current disposition/plan before leaving DISPOSITION to IMPLEMENTING',
      );
    }
    // 评审必须是 Runtime review cycle 的产物（不能由 executeNode/transition/runNode 直传伪造）：
    // Artifact 必须在记账时被盖章 reviewCycleId，并且该周期必须是 runReview 专门为
    // change_plan_review + reviewedNodeId='disposition' 记账的（reviewArtifactKind/reviewedNodeId 匹配），
    // 且记账时刻与当前 disposition 配对（dispositionIndexAtCycle===当前 disposition 序号——重开处置
    // 后旧周期的 cplan Artifact 即使被重新盖章/重排序也不得放行新处置）。缺账本周期或周期不匹配
    // → fail-closed（NOT_BOUND）。
    const reviewCycleId = (review as unknown as Record<string, unknown>).reviewCycleId;
    const cycle = typeof reviewCycleId === 'string'
      ? [...this.reviewCycles].reverse().find((record) => record.cycleId === reviewCycleId)
      : undefined;
    if (!cycle || cycle.reviewArtifactKind !== 'change_plan_review' || cycle.reviewedNodeId !== 'disposition'
      || cycle.dispositionIndexAtCycle !== this.artifacts.indexOf(disposition)
      // 语义节点绑定：cplan 周期必须由规定义上的 change_plan_review 节点记账产出，未知/影子
      // 节点（如伪造的 change_plan_review_shadow）不得参与正式门禁（与 runReview 语义节点绑定同源）。
      || NODE_KIND_BY_NODE_ID[cycle.reviewNodeId] !== 'change_plan_review') {
      throw new WorkflowRuntimeError(
        'CHANGE_PLAN_REVIEW_NOT_BOUND',
        'change_plan_review must be produced by a Runtime review cycle on the change_plan_review node bound to the current disposition/plan before leaving DISPOSITION to IMPLEMENTING',
      );
    }
    // 账本↔产物一致性：周期的通过数字必须由实际评审 Artifact 组成——同一周期必须存在足够数量的
    // 已归档 change_plan_review Artifact（approvals 等于策略下实际通过数，唯一评审者与账本声明一致）。
    // 防“仅改账本数字/单张 Artifact 声称两人批准”的整体伪造：门禁不是只检查 cycle 字段，而是
    // 用产物重算后对照账本，账本虚增必与实际不符。
    const currentPolicy = this.reviewPolicyFor?.('change_plan_review');
    if (this.reviewPolicyFor && (!currentPolicy || serializeReviewPolicy(currentPolicy) !== cycle.policyDigest)) {
      throw new WorkflowRuntimeError(
        'CHANGE_PLAN_REVIEW_NOT_BOUND',
        'change_plan_review must be produced by the current review policy before leaving DISPOSITION to IMPLEMENTING',
      );
    }
    const derived = this.reviewPolicyFor
      ? deriveCycleFacts(cycle, this.artifacts, currentPolicy)
      : deriveCycleFacts(cycle, this.artifacts, undefined);
    if (this.reviewPolicyFor
      ? (cycle.approvals !== derived.approvals
        || cycle.passed !== (cycle.approvals >= cycle.requiredApprovals)
        || new Set(cycle.reviewerWorkerIds).size !== derived.uniqueReviewers
        || !sameReviewerSet(cycle.reviewerWorkerIds, derived.reviewerWorkerIds)
        || cycle.recordedAtIndex !== derived.lastCycleArtifactIndex)
      // 未配置 resolver 时无策略可精确重算通过项：账本的通过数不得超出实际硬性通过项（防单票虚增），
      // 唯一评审者不得低于法定 quorum（防同一身份重复计数凑足人数）。评审者身份集合与记账位置是
      // 与策略无关的事实，两种路径都精确绑定。
      : (cycle.approvals > derived.approvals || derived.approvals < cycle.requiredApprovals
        || derived.uniqueReviewers < cycle.requiredApprovals
        || !sameReviewerSet(cycle.reviewerWorkerIds, derived.reviewerWorkerIds)
        || cycle.recordedAtIndex !== derived.lastCycleArtifactIndex)) {
      throw new WorkflowRuntimeError(
        'CHANGE_PLAN_REVIEW_NOT_PASSED',
        'change_plan_review cycle ledger facts are not backed by the review artifacts before leaving DISPOSITION to IMPLEMENTING',
      );
    }
    // 周期存在但未达 quorum / 未按 policy 通过：评审者在 runReview 时刻已按 policy 强制独立
    //（reviewerWorkerIds 是独立评审者的记账事实，按唯一身份计数——同一 worker 重复出票不能凑足人数）。
    // 配置了 reviewPolicyFor 时（受控扩展），门禁对照“当前有效策略”重算：周期必须由当前策略产出
    //（policyDigest 一致，防止降级策略绕过两人批准），quorum 按当前策略的 requiredApprovals 判定；
    // 未配置时以记账记录自身为准（通用 Runtime 语义）。
    const uniqueReviewerCount = new Set(cycle.reviewerWorkerIds).size;
    if (this.reviewPolicyFor) {
      if (!cycle.passed || cycle.approvals < currentPolicy!.requiredApprovals || uniqueReviewerCount < currentPolicy!.requiredApprovals) {
        throw new WorkflowRuntimeError(
          'CHANGE_PLAN_REVIEW_NOT_PASSED',
          'change_plan_review must be approved by the required quorum of independent reviewers under the current review policy before leaving DISPOSITION to IMPLEMENTING',
        );
      }
    } else if (!cycle.passed || cycle.approvals < cycle.requiredApprovals || uniqueReviewerCount < cycle.requiredApprovals) {
      throw new WorkflowRuntimeError(
        'CHANGE_PLAN_REVIEW_NOT_PASSED',
        'change_plan_review must be approved by the required quorum of independent reviewers before leaving DISPOSITION to IMPLEMENTING',
      );
    }
  }

  /**
   * 受控终局（acceptance 声明 human_final_approval）下 Runtime 是终局验收的唯一 owner：
   * 定义自身的公开 transition() 不得进入 ACCEPTED。legacy 定义未 opt-in 时保留自身 guard/transition 语义。
   */
  private applyTransition(to: Stage, artifact?: Artifact) {
    if (to === 'ACCEPTED') {
      if (this.controlledAcceptance()) {
        // 受控终局：ACCEPTED 只能由 Runtime 内部 decide() approve 路径进入（fixDefinitionV2 公开接口也拒绝）。
        if (this.stage !== 'WAITING_FOR_USER' || artifact?.kind !== 'user_decision' || artifact.decision !== 'approve') {
          throw new WorkflowRuntimeError('ACCEPTED_TRANSITION_NOT_PERMITTED', 'only an approved decision from WAITING_FOR_USER can enter ACCEPTED');
        }
        // 来源绑定（live 控制面）：定义声明 sourceVersion 时，当前 runtime 来源必须等于定义声明值。
        // 防止伪造 source 的非终局 checkpoint 续跑后在同一 continueRun 中直接 approve 产出 ACCEPTED
        //（该 ACCEPTED 不会再经过 restore 的顶层来源检查即发报告）。
        if (this.definition.sourceVersion !== undefined && this.sourceVersion !== this.definition.sourceVersion) {
          throw new WorkflowRuntimeError(
            'ACCEPTED_SOURCE_VERSION_MISMATCH',
            `runtime sourceVersion ${String(this.sourceVersion)} does not match the definition-declared ${this.definition.sourceVersion}`,
          );
        }
        this.stage = 'ACCEPTED';
      } else {
        // Legacy：未 opt-in 受控终局的定义按其自身 transition/guard 语义进入 ACCEPTED
        //（如 legacy fixDefinition 的 VERIFYING→ACCEPTED：验证 accepted 才允许）。
        this.stage = this.definition.transition(this.stage, to, artifact);
      }
    } else {
      this.assertInvestigationReviewGate(this.stage, to, artifact);
      this.assertVerificationEntryBound(this.stage, to, artifact);
      this.assertChangePlanReviewGate(this.stage, to, artifact);
      this.stage = this.definition.transition(this.stage, to, artifact);
    }
    if (artifact && artifact.kind !== 'user_decision') {
      // transition 传递的 Artifact 若已由 executeNode/runReview 归档（同一对象），保持原产生顺序；
      // 只有未经归档的新 Artifact 才替换同 kind 旧值。重排会破坏“review 晚于 investigation”等
      // 产生顺序事实（investigation_review 配对、stale 判定依赖顺序）。
      this.artifacts = this.artifacts.includes(artifact)
        ? this.artifacts
        : [...this.artifacts.filter((item) => item.kind !== artifact.kind), artifact];
    }
    if (to === 'WAITING_FOR_USER') this.pendingDecision = `${this.runId}:${this.idGen()}`;
    const checkpoint: Checkpoint = {
      runId: this.runId,
      schemaVersion: 1,
      stage: this.stage,
      at: this.clock(),
      id: this.idGen(),
      problem: this.problem,
      pendingDecisionRequest: this.pendingDecision,
      decisionReference: artifact?.kind === 'user_decision' && typeof artifact.requestId === 'string' && artifact.requestId.length > 0 ? artifact.requestId : undefined,
      artifactRefs: artifact ? [String(artifact.id ?? artifact.kind)] : undefined,
      artifacts: this.artifacts.length ? this.artifacts : undefined,
      // run_started 一次性语义的持久化标记：首个 Node 执行即记录（即使该 Node 在 Worker 提交前失败，
      // 恢复后也不能对同一 runId 再次发出启动事件）。无值不写，legacy checkpoint 形状不变。
      ...(this.ranAnyNode ? { started: true } : {}),
    };
    // 等待种类：进入 WAITING_FOR_USER 时把 Extension 声明的 pendingDecisionKind 随 checkpoint 落盘
    //（只写有值，无声明 / legacy 形状不写）；离开 WAITING_FOR_USER（继续 / 打回 / 拒绝等一切转出）
    // 立即清除，防止旧等待种类残留到下一个等待点误导 continue_disposition 路由校验。
    if (to === 'WAITING_FOR_USER') {
      if (this.pendingDecisionKind !== undefined) checkpoint.pendingDecisionKind = this.pendingDecisionKind;
    } else {
      this.pendingDecisionKind = undefined;
    }
    // 用户决策的版本/原因至少进入 checkpoint：approve 的版本绑定可审计，request_changes 的原因可追溯。
    // 决策种类（decisionKind）也一并持久化：ACCEPTED 恢复时必须以 decisionKind==='approve' 作为
    // 可验证的人工 approve 事实，防止仅凭 decisionReference + 若干业务 Artifact 伪造验收态。
    if (artifact?.kind === 'user_decision') {
      const decision = artifact as UserDecisionArtifact;
      checkpoint.decisionKind = decision.decision;
      if (decision.candidateRevision !== undefined) checkpoint.decisionCandidateRevision = decision.candidateRevision;
      if (decision.reasonCode !== undefined) checkpoint.decisionReasonCode = decision.reasonCode;
      // 显式的 Runtime 决策记录：由 Runtime 盖章写入的唯一来源事实（recordId + producer/source），
      // 与业务字段分离。受控终局 ACCEPTED 恢复只接受本记录（decision==='approve'）作为可验证的
      // 人工 approve 事实，平铺的 decisionKind/decisionReference 仅作审计与交叉校验，不能独自构成
      // 验收证明（“手工拼齐平铺字段”不再是恢复的充分条件）。只有 decide() 决策路径会盖出本记录：
      // legacy resume()（未经受控终局 opt-in 的定义）不附加 v2 决策来源记录，保持 legacy 形状；
      // 未产生的来源不得声称为 runtime:decide。
      if (artifact?.kind === 'user_decision' && this.decisionRecordProducer === 'runtime:decide') {
        checkpoint.decisionRecord = {
          recordId: `dec:${this.runId}:${this.idGen()}`,
          decision: decision.decision,
          requestId: decision.requestId,
          ...(decision.candidateRevision !== undefined ? { candidateRevision: decision.candidateRevision } : {}),
          // 用户决定内容进入决策记录（trace 事实）：打回原因码 / continue_disposition 的处置决定
          // 说明等。ACCEPTED 受控终局只认 approve（decisionRecord.decision==='approve'），note/…
          // reasonCode 不参与验收判定，仅作审计与后续 worker 输入的回读来源。
          ...(decision.reasonCode !== undefined ? { reasonCode: decision.reasonCode } : {}),
          ...(decision.note !== undefined ? { note: decision.note } : {}),
          producerKind: 'user_decision',
          producer: 'user',
          producerName: '用户',
          source: 'runtime:decide',
        };
      }
    }
    // checkpoint 扩展字段有值才写，无值不写，legacy checkpoint 形状保持不变。
    if (this.definitionVersion !== undefined) checkpoint.workflowVersion = this.definitionVersion;
    if (this.policyDigest !== undefined) checkpoint.policyDigest = this.policyDigest;
    if (this.sourceVersion !== undefined) checkpoint.sourceVersion = this.sourceVersion;
    if (this.activeNodeId !== undefined) checkpoint.activeNodeId = this.activeNodeId;
    if (this.currentExecution?.nodeExecutionId !== undefined) checkpoint.nodeExecutionId = this.currentExecution.nodeExecutionId;
    if (this.candidateRevision !== undefined) checkpoint.candidateRevision = this.candidateRevision;
    if (this.reviewCycleId !== undefined) checkpoint.reviewCycleId = this.reviewCycleId;
    // 评审周期账本有记录才写，无记录不写，legacy checkpoint 形状保持不变。
    if (this.reviewCycles.length) checkpoint.reviewCycles = this.reviewCycles;
    // BLOCKED checkpoint 记录解除目标阶段：跨 session 恢复时据此回到现场（不得默认回 INVESTIGATING）。
    if (to === 'BLOCKED') checkpoint.blockedReturnStage = this.blockedReturnStage;
    if (this.checkpointIncomplete) checkpoint.incomplete = true;
    this.store.saveCheckpoint(checkpoint);
  }

  async runNode(node: NodeDefinition, task: unknown, capsule: Record<string, unknown> = {}) {
    if (typeof task === 'string') this.problem = task;
    if (!node.worker) {
      // 没有 worker 时不执行模型，避免命令看似成功却产生不可追溯副作用。
      throw Error('node worker required');
    }
    // v2 定义下 public/legacy runNode() 不允许把裸 Worker Artifact 直接当业务事实放行：
    // 必须走 executeNode 同一信封/绑定控制面，由 Runtime 以自身身份盖章并校验 provenance
    //（schemaVersion/runId/producerKind/sourceVersion/nodeExecutionId/workerId 全部以运行时为准；
    // 缺 conclusion 的 artifact 在控制面被拒，不会以未盖章的裸 Artifact 进入 run）。
    const artifact = this.definition.requiresArtifactConclusion
      ? (await this.executeNode(node, task, { context: capsule })).artifact
      : await node.worker.execute(node, task, capsule);
    validateSubmitArtifact(artifact);
    if (this.definition.requiresArtifactConclusion && artifact.kind !== 'guard_rejection' && !(artifact as { conclusion?: ArtifactConclusion }).conclusion) {
      throw new ArtifactContractError('MISSING_ARTIFACT_CONCLUSION', 'artifact.conclusion is required for this workflow');
    }
    if (this.stage === 'INVESTIGATING' && artifact.kind === 'investigation') {
      if (artifact.route === 'local_fix') this.transition('IMPLEMENTING', artifact);
      else if (artifact.route === 'requirement_change' || artifact.route === 'design_change') this.transition('WAITING_FOR_USER', artifact);
      else if (artifact.route === 'needs_more_evidence' || artifact.route === 'blocked') {
        this.blockedReturnStage = 'INVESTIGATING';
        this.transition('BLOCKED', artifact);
      }
      else throw Error('invalid investigation route');
    } else if (this.stage === 'IMPLEMENTING' && artifact.kind === 'implementation') {
      this.transition('VERIFYING', artifact);
    } else if (this.stage === 'VERIFYING' && artifact.kind === 'verification') {
      const verification = artifact as VerificationArtifact;
      if (this.controlledAcceptance()) {
        // D4 验证失败三向路由（v2 opt-in 语义）：
        //   accepted → WAITING_FOR_USER（等待人工验收）；
        //   failure.kind === 'external_condition' → BLOCKED（权限/环境/外部依赖缺失，不回流实现，
        //     挂起等待条件恢复，避免后续误报“已解决/验收通过”）；
        //   failure.kind === 'configuration' → WAITING_FOR_USER（用户修改配置，continue_verification 回 VERIFYING）；
        //   其余（实现类失败）→ IMPLEMENTING，允许下一轮实现和验证。
        // ACCEPTED 是受控终局态：runNode 不提供自动验收内部路径，唯一入口是 decide() 的 approve 决策。
        if (verification.accepted) {
          this.transition('WAITING_FOR_USER', artifact);
        } else if (verification.failure?.kind === 'external_condition') {
          // 外部条件阻塞 → BLOCKED，解除后回 VERIFYING（不回流实现，避免后续误报已解决）；
          // returnStage 写入 checkpoint，跨 session 恢复不默认回 INVESTIGATING。
          this.blockedReturnStage = 'VERIFYING';
          this.transition('BLOCKED', { kind: 'guard_rejection', error: String(verification.failure?.reason ?? 'external condition missing') } as Artifact);
        } else if (verification.failure?.kind === 'configuration') {
          this.transition('WAITING_FOR_USER', artifact);
        } else {
          this.transition('IMPLEMENTING', artifact);
        }
      } else {
        // Legacy 未 opt-in 受控终局：保持定义自身验收语义。
        // 验证 accepted → ACCEPTED 由定义 guard 的门槛决定（如 legacy fixDefinition 只接受
        // accepted=true 的验证进入 ACCEPTED）；失败（accepted=false）→ IMPLEMENTING 同样走定义 guard。
        // 旧失败形状（accepted=false 无结构化 failure）在 legacy 下按其自身 guard 语义处理：
        // 验证失败（accepted=false）→ IMPLEMENTING；结构化 failure 契约只约束受控结论定义。
        this.transition(verification.accepted ? 'ACCEPTED' : 'IMPLEMENTING', artifact);
      }
    } else if (this.stage === 'BLOCKED' && artifact.kind === 'investigation') {
      if (artifact.route !== 'local_fix') throw Error('invalid investigation evidence');
      // BLOCKED 解锁先经过 INVESTIGATING，再由同一份合法新证据进入实现阶段。
      this.transition('INVESTIGATING', artifact);
      this.transition('IMPLEMENTING', artifact);
    } else {
      // runNode 拒绝非法 artifact/stage 组合，不能静默吞掉 worker 错误。
      throw Error(`invalid artifact ${artifact.kind} for stage ${this.stage}`);
    }
    return artifact;
  }

  /** 记录审计事件；auditSink 异常静默，不影响主流程。 */
  recordEvent(
    eventType: FixAuditEventType,
    payload: Record<string, unknown> = {},
    extra?: Partial<Omit<FixAuditEvent, 'schemaVersion' | 'eventId' | 'eventType' | 'occurredAt'>>,
  ): void {
    const event: FixAuditEvent = {
      schemaVersion: 1,
      eventId: `${this.idGen()}.event.${++this.eventSeq}`,
      eventType,
      occurredAt: new Date().toISOString(),
      runId: this.runId,
      workflowId: this.definition.id,
      workflowDefinitionVersion: this.definitionVersion ?? 'unknown',
      policyDigest: this.policyDigest ?? '',
      stage: this.stage,
      // 未分类时不虚构 bugCategory/riskLevel，由调用方/扩展传实值（避免把默认值当作已分类事实）。
      sourceVersion: this.sourceVersion ?? this.definition.sourceVersion,
      ...extra,
      payload,
    };
    try {
      this.auditSink?.append(event);
    } catch {
      // audit sink 失败只影响审计，不阻断执行。
    }
  }

  /** 执行单个节点：worker 产出经信封盖章与契约校验后归档并登记执行上下文。 */
  async executeNode(
    node: NodeDefinition,
    task: unknown,
    opts: { context?: Capsule } = {},
  ): Promise<{ artifact: Artifact; execution: { nodeId: string; nodeExecutionId: string; workerId: string; attempt: number } }> {
    if (!this.ranAnyNode) {
      this.recordEvent('run_started');
      this.ranAnyNode = true;
      // 立即持久化启动标记：run_started 在首个 Node 的 Worker 调用前发出，若 Worker 提交前失败
      // 且尚无 Artifact/过渡，checkpoint 仍可能为空——不落盘标记则恢复后会对同一 runId 再次发出
      // 启动事件。此处只在这一时刻补写一次（此后每次 checkpoint 都带 started:true）。
      // 启动标记同时携带版本/策略/来源上下文：首个 Worker 在提交前失败后，恢复该标记 checkpoint
      // 若缺 workflowVersion/policyDigest 会被标记 checkpointIncomplete，导致 ACCEPTED 永远无法
      // 通过验收；缺 sourceVersion 则后续盖章退回 'baseline'，与定义声明来源不一致同样无法进入
      // ACCEPTED（ACCEPTED_SOURCE_VERSION_MISMATCH）——rescue 路径必须是可完成的（restore 在
      // executeNode 前已把三者恢复到实例上）。
      this.store.saveCheckpoint({
        schemaVersion: 1, runId: this.runId, stage: this.stage, at: this.clock(), id: this.idGen(), started: true,
        workflowVersion: this.definitionVersion ?? this.definition.sourceVersion,
        policyDigest: this.policyDigest,
        sourceVersion: this.sourceVersion ?? this.definition.sourceVersion,
      });
    }
    const nodeExecutionId = `${this.runId}.${node.id}.${this.clock()}`;
    const workerId = node.worker?.workerId ?? 'worker';
    // sourceVersion 是运行时可选择绑定的来源标记（如外部源/模型快照）。未绑定时用 'baseline'
    // 作为信封完整性的 fallback 盖章：信封合同要求非空 sourceVersion，fallback 只保证信封可写、
    // 绝不把 'baseline' 当作已验证/可接受的来源事实——受控终局（ACCEPTED）恢复要求 checkpoint
    // 顶层携带 bound sourceVersion，fallback 串无法满足 v2 终局来源验证。
    const srcVersion = this.sourceVersion ?? 'baseline';
    const capsule = {
      runId: this.runId,
      nodeExecutionId,
      workerId,
      sourceVersion: srcVersion,
      requiresArtifactConclusion: this.definition.requiresArtifactConclusion === true,
      ...(node.id === 'verify' ? { requiresRepositoryChange: this.dispositionRequiresRepositoryChange() } : {}),
      ...opts.context,
    };
    if (!node.worker) throw new WorkflowRuntimeError('NODE_WORKER_REQUIRED', 'node worker required');
    const raw = await node.worker.execute(node, task, capsule);
    // 信封盖章：只认 schemaVersion/runId/producerKind/sourceVersion/unverified/nodeExecutionId/workerId，conclusion 不触发校验。
    const hasEnvelope = ['schemaVersion', 'runId', 'producerKind', 'sourceVersion', 'nodeExecutionId', 'workerId']
      .some((field) => field in raw);
    const rawEvidence = (raw as { evidence?: Artifact['evidence'] }).evidence;
    const rawUnverified = (raw as { unverified?: unknown }).unverified;
    const stamped = (hasEnvelope ? raw : {
      ...(raw as Record<string, unknown>),
      schemaVersion: 1,
      runId: this.runId,
      nodeExecutionId,
      workerId,
      producerKind: 'worker',
      sourceVersion: srcVersion,
      // 只搬移 worker 自带的 evidence；缺省不注入空数组。evidence 是否需要由业务校验按 kind 决定。
      ...(rawEvidence !== undefined ? { evidence: rawEvidence } : {}),
      // Worker 显式提交的 unverified 是 worker 事实，必须保留（allowUnverified=false 时由
      // Verification Acceptance / Guard 拒绝）；缺省才补空数组，不得无条件覆盖。
      ...(rawUnverified !== undefined ? { unverified: rawUnverified } : { unverified: [] }),
    // Worker Artifact 的 conclusion 必须由 Worker 真实提交；Runtime 只负责补 provenance，不伪造业务结论。
    // 无 conclusion 的结果会由 validateArtifactEnvelope 拒绝。
    }) as Artifact;
    if (this.definition.requiresArtifactConclusion && stamped.kind !== 'guard_rejection' && !(stamped as { conclusion?: ArtifactConclusion }).conclusion) {
      const error = new ArtifactContractError('MISSING_ARTIFACT_CONCLUSION', 'artifact.conclusion is required for this workflow');
      this.recordEvent('artifact_rejected', { code: error.code, message: error.message, nodeId: node.id });
      throw error;
    }
    try {
      const context: ArtifactExecutionContext = {
        schemaVersion: 1,
        runId: this.runId,
        nodeExecutionId,
        workerId,
        sourceVersion: srcVersion,
        requiresRepositoryChange: this.dispositionRequiresRepositoryChange(),
        requiresArtifactConclusion: this.definition.requiresArtifactConclusion === true,
      };
      validateSubmitArtifact(stamped, context);
    } catch (error) {
      const contractError = error as ArtifactContractError;
      this.recordEvent('artifact_rejected', { code: contractError.code, message: contractError.message, nodeId: node.id });
      throw error;
    }
    // NodeId ↔ Artifact kind 必要关联（与 restore 的 NODE_KIND_BY_NODE_ID 同源）：已知节点的 Worker
    // 只能提交该节点能产出的 kind，避免 verify 节点冒充验收通过等跨节点产物。未知节点 id（如测试/扩展
    // 自定义评审者）不在此表内时跳过，保持 executeNode 的通用性；restore 对未知 nodeId 仍 fail-closed。
    const expectedKindForNode = NODE_KIND_BY_NODE_ID[node.id];
    if (expectedKindForNode !== undefined && expectedKindForNode !== stamped.kind) {
      const error = new WorkflowRuntimeError(
        'NODE_KIND_MISMATCH',
        `node ${node.id} cannot produce artifact kind ${stamped.kind} (expected ${expectedKindForNode})`,
      );
      this.recordEvent('artifact_rejected', { code: error.code, message: error.message, nodeId: node.id });
      throw error;
    }
    // user_decision 是 Runtime 独有产物：Worker 不得提交人工决策 Artifact（唯一产出者是受控终局
    // decide() 的盖章归档路径）。executeNode 直传 user_decision 视为伪造决策事实，拒绝。
    if (stamped.kind === 'user_decision') {
      const error = new WorkflowRuntimeError(
        'USER_DECISION_ARTIFACT_FORBIDDEN',
        `node ${node.id} cannot submit a user_decision artifact; user decisions are produced only by Runtime.decide`,
      );
      this.recordEvent('artifact_rejected', { code: error.code, message: error.message, nodeId: node.id });
      throw error;
    }
    this.artifacts = [...this.artifacts, stamped];
    this.activeNodeId = node.id;
    const execution = { nodeId: node.id, nodeExecutionId, workerId, attempt: 1 };
    this.currentExecution = execution;
    this.nodeWorkerIds[node.id] = [...(this.nodeWorkerIds[node.id] ?? []), workerId];
    if (stamped.kind === 'implementation') this.candidateRevision = (stamped as ImplementationArtifact).artifact.candidateRevision;
    this.recordEvent(
      'artifact_submitted',
      { artifactId: stamped.id ?? stamped.kind, kind: stamped.kind },
      { nodeId: node.id, nodeExecutionId, workerId, candidateRevision: this.candidateRevision },
    );
    return { artifact: stamped, execution };
  }

  /** 并行评审：校验 quorum 与独立性，逐个评审者执行并汇总通过率。 */
  async runReview(
    reviewNodeId: string,
    reviewers: NodeDefinition[],
    policy: ReviewPolicy,
    opts: { reviewedNodeId: string; reviewArtifactKind: Artifact['kind']; eventType?: 'investigation_review_completed' | 'change_review_completed'; context?: Capsule },
  ): Promise<{ reviewNodeId: string; reviewCycleId: string; approvals: number; requiredApprovals: number; passed: boolean; reviewArtifacts: Artifact[]; reviewerWorkerIds: string[]; ratedArtifacts: { artifactId: string; workerId: string; accepted: boolean }[] }> {
    const reviewCycleId = `${this.runId}.review.${this.clock()}.${++this.reviewSeq}`;
    this.reviewCycleId = reviewCycleId;
    // 语义节点绑定：已知 reviewNodeId 必须能产出本评审 kind（防“verify 节点冒充评审”、“已知节点
    // 提交跨 kind 产物”），已知 reviewedNodeId 必须能产出被评审的业务 kind（评审必须指向合法的
    // 被评审节点）。未知 node id（测试/扩展自定义评审者）保持通用性——由门禁与 restore 的
    // 语义节点控制面把关（cplan 门禁要求周期 node 等于 change_plan_review；restore 要求
    // nodeExecutionId 的 node 段与 Artifact kind 关联）。
    const reviewNodeKind = NODE_KIND_BY_NODE_ID[reviewNodeId];
    if (reviewNodeKind !== undefined && reviewNodeKind !== opts.reviewArtifactKind) {
      throw new ReviewPolicyError('REVIEW_NODE_KIND_MISMATCH', `reviewNodeId ${reviewNodeId} cannot produce ${opts.reviewArtifactKind} (it produces ${reviewNodeKind})`);
    }
    const reviewedBusinessKind = REVIEWED_KIND_BY_REVIEW_KIND[opts.reviewArtifactKind];
    if (reviewedBusinessKind !== undefined) {
      const reviewedNodeKind = NODE_KIND_BY_NODE_ID[opts.reviewedNodeId];
      if (reviewedNodeKind !== undefined && reviewedNodeKind !== reviewedBusinessKind) {
        throw new ReviewPolicyError('REVIEWED_NODE_KIND_MISMATCH', `reviewedNodeId ${opts.reviewedNodeId} cannot produce the ${reviewedBusinessKind} under review (it produces ${reviewedNodeKind})`);
      }
    }
    // 当前策略绑定：配置了 reviewPolicyFor 时，调用方传入的 policy 必须与当前有效策略逻辑等价
    // （规范化摘要一致），否则降级策略（如把两人批准改为一人）不允许执行；未配置时保持通用语义。
    const policyDigest = serializeReviewPolicy(policy);
    const currentPolicy = this.reviewPolicyFor?.(opts.reviewArtifactKind);
    if (this.reviewPolicyFor && (!currentPolicy || serializeReviewPolicy(currentPolicy) !== policyDigest)) {
      throw new ReviewPolicyError(
        'REVIEW_POLICY_MISMATCH',
        `review policy for ${opts.reviewArtifactKind} does not match the current effective policy; refusing a weakened or stale policy`,
      );
    }
    if (reviewers.length < policy.requiredApprovals) {
      throw new ReviewPolicyError('REVIEWER_COUNT_BELOW_QUORUM', `need at least ${policy.requiredApprovals} reviewers, got ${reviewers.length}`);
    }
    // 独立性：排除上下文指定的 worker、policy.excludeNodes 对应节点已执行的 worker，
    // 以及被评审节点（reviewedNodeId）自身已执行的 worker——评审者不得与被评审节点同 worker。
    const excluded = new Set<string>([
      ...((opts.context?.excludeWorkerIds as string[] | undefined) ?? []),
      ...policy.excludeNodes.flatMap((nodeId) => this.nodeWorkerIds[nodeId] ?? []),
      ...(this.nodeWorkerIds[opts.reviewedNodeId] ?? []),
    ]);
    // 独立身份唯一性：同一周期的评审者必须使用互不相同的 worker 身份（quorum 按唯一独立身份计数，
    // 同一个 worker 重复出票不能凑足人数）。requireIndependentWorker=false 时未声明 workerId 的评审者
    // 不受此约束，但显式声明的身份仍不得彼此重复。
    const declaredWorkerIds = reviewers.map((reviewer) => reviewer.worker?.workerId).filter((id): id is string => typeof id === 'string');
    if (new Set(declaredWorkerIds).size !== declaredWorkerIds.length) {
      throw new ReviewPolicyError(
        'REVIEWER_WORKER_ID_REPEATED',
        'reviewers must use distinct worker identities; the same worker cannot vote multiple times in one cycle',
      );
    }
    for (const reviewer of reviewers) {
      const workerId = reviewer.worker?.workerId;
      if (policy.requireIndependentWorker) {
        // requireIndependentWorker=true 是硬约束：评审者必须声明 workerId，且不得复用已执行节点的 worker。
        if (!workerId) {
          throw new ReviewPolicyError('REVIEWER_WORKER_ID_REQUIRED', `reviewer ${reviewer.id} must declare a workerId under requireIndependentWorker`);
        }
        if (excluded.has(workerId)) {
          throw new ReviewPolicyError('REVIEWER_NOT_INDEPENDENT', `reviewer ${reviewer.id} uses worker ${workerId} which is not independent`);
        }
      } else if (workerId && excluded.has(workerId)) {
        throw new ReviewPolicyError('REVIEWER_NOT_INDEPENDENT', `reviewer ${reviewer.id} uses worker ${workerId} which is not independent`);
      }
    }
    const reviewArtifacts: Artifact[] = [];
    const reviewerWorkerIds: string[] = [];
    const ratedArtifacts: { artifactId: string; workerId: string; accepted: boolean }[] = [];
    for (const reviewer of reviewers) {
      const { artifact, execution } = await this.executeNode(reviewer, `review audit task: ${opts.reviewedNodeId}`, {
        context: { ...opts.context, reviewedNodeId: opts.reviewedNodeId, reviewCycleId },
      });
      if (artifact.kind !== opts.reviewArtifactKind) {
        throw new ReviewPolicyError('WRONG_REVIEW_ARTIFACT_KIND', `expected ${opts.reviewArtifactKind} got ${artifact.kind}`);
      }
      reviewArtifacts.push(artifact);
      reviewerWorkerIds.push(execution.workerId);
      ratedArtifacts.push({ artifactId: (artifact.id as string | undefined) ?? artifact.kind, workerId: execution.workerId, accepted: satisfiesReview(policy, artifact) });
    }
    const approvals = ratedArtifacts.filter((rated) => rated.accepted).length;
    const passed = approvals >= policy.requiredApprovals;
    // 评审周期记账：每次 runReview 记录一条账本记录（含通过与否），随 checkpoint 持久化。
    // gate 用 dispositionIndexAtCycle 把周期绑定到记账时刻的处置实例（重开处置后的旧周期
    // 不得放行新处置）；reviewerWorkerIds 是评审时刻的独立评审者（独立性由本方法在调用时强制）。
    const latestDisposition = this.latestOf('disposition') as DispositionArtifact | undefined;
    const cycleRecord: ReviewCycleRecord = {
      cycleId: reviewCycleId,
      reviewNodeId,
      reviewArtifactKind: opts.reviewArtifactKind,
      reviewedNodeId: opts.reviewedNodeId,
      requiredApprovals: policy.requiredApprovals,
      approvals,
      passed,
      reviewerWorkerIds,
      policyDigest,
      dispositionIndexAtCycle: latestDisposition === undefined ? -1 : this.artifacts.indexOf(latestDisposition),
      recordedAtIndex: this.artifacts.length - 1,
    };
    this.reviewCycles = [...this.reviewCycles, cycleRecord];
    // 在同一评审 Artifact 对象上盖章周期绑定（reviewCycleId + reviewedNodeId）：评审 Artifact
    // 已由 executeNode 归档（同一对象），随 checkpoint 序列化；门禁据此把“最新 change_plan_review”
    // 关联到账本某条周期，直传伪造（无周期盖章）无法冒充 runReview 的产出。
    for (const artifact of reviewArtifacts) {
      (artifact as unknown as Record<string, unknown>).reviewCycleId = reviewCycleId;
      (artifact as unknown as Record<string, unknown>).reviewedNodeId = opts.reviewedNodeId;
    }
    this.recordEvent(
      opts.eventType
        // 三类评审使用显式事件类型：change_review 不得混入 investigation_review_completed。
        ?? (opts.reviewArtifactKind === 'change_review'
          ? 'change_review_completed'
          : opts.reviewArtifactKind === 'change_plan_review'
            ? 'change_plan_review_completed'
            : 'investigation_review_completed'),
      { reviewCycleId, reviewedNodeId: opts.reviewedNodeId, approvals, requiredApprovals: policy.requiredApprovals, passed },
      { nodeId: reviewNodeId },
    );
    return { reviewNodeId, reviewCycleId, approvals, requiredApprovals: policy.requiredApprovals, passed, reviewArtifacts, reviewerWorkerIds, ratedArtifacts };
  }

  /** 当前 run 是否处在配置类验证失败后的 WAITING_FOR_USER（仅此等待允许 continue_verification）。 */
  isPendingConfigurationWait(): boolean {
    const verification = this.latestOf('verification') as VerificationArtifact | undefined;
    return this.stage === 'WAITING_FOR_USER' && verification?.accepted === false && verification.failure?.kind === 'configuration';
  }

  // WAITING_FOR_USER 的等待种类控制：Extension 在进入等待前先 setPendingDecisionKind，
  // applyTransition 把它随 checkpoint 持久化（进入等待时），离开等待即清除；restore 从 checkpoint 回读。
  setPendingDecisionKind(kind: PendingDecisionKind): void {
    this.pendingDecisionKind = kind;
  }

  /** 当前等待种类；非等待阶段或 legacy checkpoint（无字段）时为 undefined。 */
  getPendingDecisionKind(): PendingDecisionKind | undefined {
    return this.pendingDecisionKind;
  }

  /** 由 disposition artifact 推导 acceptance 是否需要仓库变更标记组（与 Controller 求值一致）。
   *  取“当前有效（最新）disposition”，旧处置不覆盖新处置。 */
  dispositionRequiresRepositoryChange(): boolean {
    const disposition = [...this.artifacts].reverse().find((a) => a.kind === 'disposition');
    return (disposition as DispositionArtifact | undefined)?.requiresRepositoryChange === true;
  }

  /** 仓库变更路径下 change_review 必须绑定当前 implementation 的 candidateRevision，
   *  且晚于当前 implementation 产生（fresh implementation 不能被旧 review 放行）；
   *  缺失、不匹配或 stale 均不得视为已通过。无仓库变更（或当前无 implementation）不凭空要求绑定。 */
  changeReviewBindsImplementation(requiresRepositoryChange: boolean): boolean {
    if (!requiresRepositoryChange) return true;
    const review = this.latestOf('change_review') as ChangeReviewArtifact | undefined;
    const implementation = this.latestOf('implementation') as ImplementationArtifact | undefined;
    if (!review || !implementation) return false;
    return review.reviewedRevision === implementation.artifact.candidateRevision
      && this.artifacts.indexOf(review) > this.artifacts.indexOf(implementation);
  }

  /** 仓库变更路径下 change_plan_review 必须与当前 disposition/方案配对：review 晚于当前
   *  disposition 产生（新的处置不能被旧 plan review 放行）；缺失配对评审不得视为已通过。
   *  无仓库变更（requiresRepositoryChange!==true）不构成约束（返回 true）。 */
  changePlanReviewBindsCurrentDisposition(): boolean {
    const disposition = this.latestOf('disposition') as DispositionArtifact | undefined;
    if (!disposition || disposition.requiresRepositoryChange !== true) return true;
    const review = this.latestOf('change_plan_review') as ChangePlanReviewArtifact | undefined;
    if (!review) return false;
    return this.artifacts.indexOf(review) > this.artifacts.indexOf(disposition);
  }

  /** 受控终局 acceptance 的评审账本要求（与 DISPOSITION→IMPLEMENTING 门禁同一套绑定规则）：
   *  仓库变更路径的 acceptance（含 ACCEPTED 恢复重放）必须以“绑定当前处置 + 当前策略 + 规定义节点
   *  身份 + quorum 被实际 Artifact 支撑”的 Runtime review cycle 为前置事实——只有 Artifact marker
   *  （内容/顺序/处置绑定）不够，缺失账本或影子周期不得通过验收（防“删掉 reviewCycles 让伪造
   *  ACCEPTED 过关”）。无仓库变更路径不需要方案评审，直接通过。 */
  planReviewCycleBacked(): boolean {
    const disposition = this.latestOf('disposition') as DispositionArtifact | undefined;
    if (!disposition || disposition.requiresRepositoryChange !== true) return true;
    const review = this.latestOf('change_plan_review') as ChangePlanReviewArtifact | undefined;
    if (!review) return false;
    const reviewCycleId = (review as unknown as Record<string, unknown>).reviewCycleId;
    const cycle = typeof reviewCycleId === 'string'
      ? [...this.reviewCycles].reverse().find((record) => record.cycleId === reviewCycleId)
      : undefined;
    if (!cycle || cycle.reviewArtifactKind !== 'change_plan_review' || cycle.reviewedNodeId !== 'disposition'
      || cycle.dispositionIndexAtCycle !== this.artifacts.indexOf(disposition)
      // 语义节点绑定：周期必须由规定义上的 change_plan_review 节点记账产出（影子节点不得验收）。
      || NODE_KIND_BY_NODE_ID[cycle.reviewNodeId] !== 'change_plan_review') return false;
    const currentPolicy = this.reviewPolicyFor?.('change_plan_review');
    if (this.reviewPolicyFor && (!currentPolicy || serializeReviewPolicy(currentPolicy) !== cycle.policyDigest)) return false;
    const derived = this.reviewPolicyFor
      ? deriveCycleFacts(cycle, this.artifacts, currentPolicy)
      : deriveCycleFacts(cycle, this.artifacts, undefined);
    if (this.reviewPolicyFor
      ? (cycle.approvals !== derived.approvals
        || cycle.passed !== (cycle.approvals >= cycle.requiredApprovals)
        || new Set(cycle.reviewerWorkerIds).size !== derived.uniqueReviewers
        || !sameReviewerSet(cycle.reviewerWorkerIds, derived.reviewerWorkerIds)
        || cycle.recordedAtIndex !== derived.lastCycleArtifactIndex)
      : (cycle.approvals > derived.approvals || derived.approvals < cycle.requiredApprovals || derived.uniqueReviewers < cycle.requiredApprovals
        || !sameReviewerSet(cycle.reviewerWorkerIds, derived.reviewerWorkerIds)
        || cycle.recordedAtIndex !== derived.lastCycleArtifactIndex)) return false;
    const uniqueReviewerCount = new Set(cycle.reviewerWorkerIds).size;
    if (this.reviewPolicyFor
      ? (!cycle.passed || cycle.approvals < currentPolicy!.requiredApprovals || uniqueReviewerCount < currentPolicy!.requiredApprovals)
      : (!cycle.passed || cycle.approvals < cycle.requiredApprovals || uniqueReviewerCount < cycle.requiredApprovals)) return false;
    return true;
  }

  /**
   * 新语义用户决策：处理 approve / request_changes / reject / continue_verification 四种决策。
   * legacy resume() 仍走 gate，不经过 decide。
   */
  decide(
    decision: UserDecisionArtifact,
    opts: { reasonToStage?: (reasonCode?: string) => Stage; acceptance?: { passed: boolean; missing: string[] } } = {},
  ): { outcome: 'accepted' | 'reopened' | 'blocked'; toStage?: Stage } {
    // 整个决策路径视为 Runtime decide 产出（decisionRecord 只在本路径盖章）；
    // 失败/异常也复位，避免后续 legacy resume() 误继承来源标记。
    try {
      this.decisionRecordProducer = 'runtime:decide';
      const outcome = this.decideCore(decision, opts);
      return outcome;
    } finally {
      this.decisionRecordProducer = undefined;
    }
  }

  /** decide() 的内部实现（wrapper 负责决策来源标记的 set/reset）。 */
  private decideCore(
    decision: UserDecisionArtifact,
    opts: { reasonToStage?: (reasonCode?: string) => Stage; acceptance?: { passed: boolean; missing: string[] } } = {},
  ): { outcome: 'accepted' | 'reopened' | 'blocked'; toStage?: Stage } {
    if (this.stage !== 'WAITING_FOR_USER') {
      throw new WorkflowRuntimeError('DECISION_NOT_IN_WAITING_STAGE', `user decision can only be applied in WAITING_FOR_USER, got ${this.stage}`);
    }
    validateSubmitArtifact(decision);
    if (decision.requestId !== this.pendingDecision) {
      throw new WorkflowRuntimeError('DECISION_REQUEST_ID_MISMATCH', `decision requestId ${decision.requestId} does not match pending request ${this.pendingDecision}`);
    }
    if (decision.decision === 'approve') {
      // 强制 Acceptance：approve 只有在 acceptance 满足时才允许进入 ACCEPTED，不允许直接调用绕过。
      // 内部基于 definition acceptance + 当前 artifacts 求值；requiresRepositoryChange 由 disposition artifact 推导
      //（与 Controller 求值一致）；opts.acceptance 保留兼容签名，不参与放行判定。
      const acceptance = this.evaluateAcceptance({
        userDecision: decision,
        requiresRepositoryChange: this.dispositionRequiresRepositoryChange(),
      });
      if (!acceptance.passed) {
        throw new WorkflowRuntimeError('APPROVAL_ACCEPTANCE_NOT_MET', `approve requires acceptance to pass; missing: ${acceptance.missing.join(', ')}`);
      }
      if (this.dispositionRequiresRepositoryChange()) {
        try {
          this.assertCandidateRevisionConsistent(this.artifacts, true);
        } catch (error) {
          throw new WorkflowRuntimeError(
            'APPROVAL_CANDIDATE_REVISION_NOT_BOUND',
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      // 当前 run 已产生候选版本时，approve 决策必须携带匹配的 candidateRevision。
      if (this.candidateRevision !== undefined && decision.candidateRevision !== this.candidateRevision) {
        throw new WorkflowRuntimeError('DECISION_CANDIDATE_REVISION_MISMATCH', `decision candidateRevision ${String(decision.candidateRevision)} does not match run candidate ${this.candidateRevision}`);
      }
      // 人工 approve 的“决策 Artifact”作为 Runtime 盖章背书归档（仅受控终局定义；legacy 决策路径
      // 不改变 checkpoint 形状）。restore 受控终局要求 ACCEPTED checkpoint 必须持有唯一匹配的
      // user_decision approve Artifact（producerKind='user_decision' + producer='user' +
      // requestId===decisionReference + sourceVersion===定义声明来源），与 decisionRecord 互为背书：
      // 只有 Runtime decide 能盖出该身份的 Artifact（executeNode/runReview 一律拒绝 user_decision），
      // 手工拼齐平铺字段而不配齐决策 Artifact 不是可验证的验收证明。必须在本 checkpoint 序列化前归档
      //（applyTransition 构建 checkpoint 时读取 this.artifacts）。
      if (this.controlledAcceptance()) {
        const stamp = `${this.runId}.user_decision.${this.idGen()}`;
        this.artifacts = [...this.artifacts, {
          ...decision,
          id: stamp,
          schemaVersion: 1,
          runId: this.runId,
          unverified: [],
          producerKind: 'user_decision',
          producer: 'user',
          producerName: '用户',
          sourceVersion: this.sourceVersion ?? this.definition.sourceVersion,
        } as UserDecisionArtifact & { id: string; schemaVersion: 1; runId: string; producerKind: 'user_decision'; producer: string }];
      }
      this.applyTransition('ACCEPTED', decision);
      this.recordEvent('human_review_decided', { decision: 'approve', requestId: decision.requestId }, { decision: 'approve' });
      this.recordEvent('run_accepted', { missing: acceptance.missing });
      this.pendingDecision = undefined;
      return { outcome: 'accepted' };
    }
    if (decision.decision === 'continue_verification') {
      // 配置类验证失败后的继续验证出口：只能回到 VERIFYING，不能代替 approve，也不能回流 IMPLEMENTING。
      // 仅当当前等待确实是配置类失败（verification accepted=false 且 failure.kind=configuration）时允许。
      if (!this.isPendingConfigurationWait()) {
        throw new WorkflowRuntimeError('CONTINUE_VERIFICATION_NOT_AVAILABLE', 'continue_verification is only allowed after a configuration verification failure');
      }
      this.transition('VERIFYING', decision);
      this.recordEvent('human_review_decided', { decision: 'continue_verification', requestId: decision.requestId }, { decision: 'continue_verification' });
      this.recordEvent('run_rework', { reasonCode: 'configuration_revoked', toStage: 'VERIFYING' }, { reasonCode: 'configuration_revoked', candidateRevision: this.candidateRevision });
      this.pendingDecision = undefined;
      return { outcome: 'reopened', toStage: 'VERIFYING' };
    }
    if (decision.decision === 'continue_disposition') {
      // D3：处置决定等待（disposition_decision）/ 外部动作完成等待（external_action_completion）
      // 的用户决定出口，只能在该等待种类下消费（fail-closed）。
      //   disposition_decision → 回 DISPOSITION：用户已给出处置决定，重新执行处置（以决定作为
      //     补充输入），由新一轮 disposition 决定后续路线（repo-change 走 change_plan_review 等）；
      //   external_action_completion → 外部动作已完成、已补完成证据：无仓库变更回 VERIFYING 按
      //     处置的验证目标验证既有现场；声明仓库变更的处置回 DISPOSITION 走常规 repo-change 流程。
      if (this.pendingDecisionKind !== 'disposition_decision' && this.pendingDecisionKind !== 'external_action_completion') {
        throw new WorkflowRuntimeError('CONTINUE_DISPOSITION_NOT_AVAILABLE', 'continue_disposition is only allowed while waiting on a disposition decision or an external action completion');
      }
      const toStage: Stage = this.pendingDecisionKind === 'disposition_decision'
        ? 'DISPOSITION'
        : this.dispositionRequiresRepositoryChange()
          ? 'DISPOSITION'
          : 'VERIFYING';
      this.transition(toStage, decision);
      this.recordEvent('human_review_decided', { decision: 'continue_disposition', requestId: decision.requestId, toStage }, { decision: 'continue_disposition' });
      this.recordEvent('run_rework', { reasonCode: 'disposition_resolved', toStage }, { reasonCode: 'disposition_resolved', candidateRevision: this.candidateRevision });
      this.pendingDecision = undefined;
      return { outcome: 'reopened', toStage };
    }
    if (decision.decision === 'request_changes') {
      const toStage = opts.reasonToStage?.(decision.reasonCode) ?? 'IMPLEMENTING';
      this.transition(toStage, decision);
      this.recordEvent(
        'human_review_decided',
        { decision: 'request_changes', reasonCode: decision.reasonCode, toStage },
        { decision: 'request_changes', reasonCode: decision.reasonCode },
      );
      this.recordEvent('run_rework', { reasonCode: decision.reasonCode, toStage }, { reasonCode: decision.reasonCode, candidateRevision: this.candidateRevision });
      this.pendingDecision = undefined;
      return { outcome: 'reopened', toStage };
    }
    if (decision.decision === 'reject') {
      const reasonCode = decision.reasonCode;
      this.transition('BLOCKED', decision);
      this.recordEvent('human_review_decided', { decision: 'reject', reasonCode, requestId: decision.requestId }, { decision: 'reject', reasonCode });
      this.recordEvent('run_rework', { reasonCode, toStage: 'BLOCKED' }, { reasonCode });
      this.pendingDecision = undefined;
      return { outcome: 'blocked', toStage: 'BLOCKED' };
    }
    // decide 不处理 legacy 路径（如 continue_investigating），那些继续走 resume()。
    throw new WorkflowRuntimeError('UNSUPPORTED_DECISION_KIND', `decision ${decision.decision} is not handled by decide()`);
  }

  /** 当前 run 已产生（或从 checkpoint/implementation artifact 恢复）的候选版本；无仓库变更时为 undefined。 */
  get runCandidateRevision(): string | undefined {
    return this.candidateRevision;
  }

  /** 当前有效的（最新的）某类 Artifact；不存在返回 undefined。 */
  private latestOf(kind: Artifact['kind']): Artifact | undefined {
    return [...this.artifacts].reverse().find((artifact) => artifact.kind === kind);
  }

  /** 按 acceptance 定义求值未满足的 marker；需仓库改动时才额外求值 repositoryChangeRequires。
   *  未知 marker 视为不满足（fail-closed），不静默跳过；
   *  业务 marker 必须检查“当前有效 Artifact”的 accepted conclusion/硬条件，不能只凭 kind 存在放行。 */
  evaluateAcceptance(extra: { userDecision?: UserDecisionArtifact; candidateRevisionConsistent?: boolean; requiresRepositoryChange?: boolean } = {}): { passed: boolean; missing: string[] } {
    const acceptance = this.definition.acceptance;
    if (!acceptance) return { passed: true, missing: [] };
      if (this.definition.requiresArtifactConclusion && this.checkpointIncomplete) {
        return { passed: false, missing: ['checkpoint_complete'] };
      }
      const conclusionAccepted = (artifact: Artifact | undefined): boolean => {
        const conclusion = (artifact as { conclusion?: ArtifactConclusion } | undefined)?.conclusion;
        if (conclusion === undefined) return !this.definition.requiresArtifactConclusion;
        return conclusion.status === 'accepted';
      };
    const evaluateMarker = (marker: string): boolean => {
      switch (marker) {
        case 'intake_accepted': {
          // 新 Intake 契约为 summary/overview，且必须带 accepted conclusion（executeNode 盖章）；
          // 仅含旧 phenomenon 或 conclusion 非 accepted 的 intake 不静默通过。
          const intake = this.latestOf('intake') as IntakeArtifact | undefined;
          if (!intake || !conclusionAccepted(intake)) return false;
          return typeof intake.summary === 'string' && intake.summary.trim().length > 0 && typeof intake.overview === 'string' && intake.overview.trim().length > 0;
        }
        case 'investigation_accepted': {
          // 硬条件：accepted conclusion + 可继续的调查结论（需要更多证据/阻塞的调查不构成验收）。
          const investigation = this.latestOf('investigation') as InvestigationArtifact | undefined;
          if (!investigation || !conclusionAccepted(investigation)) return false;
          return ['local_fix', 'requirement_change', 'design_change'].includes(investigation.route);
        }
        case 'investigation_review_accepted': {
          // 硬条件：accepted conclusion + evidenceSufficiency sufficient + 与当前 investigation
          // 配对（targetArtifactId 匹配或成对产生）；不能只检查 review 自身 accepted。
          return this.investigationReviewBindsCurrentInvestigation();
        }
        case 'disposition_accepted': {
          const disposition = this.latestOf('disposition') as DispositionArtifact | undefined;
          return disposition !== undefined && conclusionAccepted(disposition);
        }
        case 'change_plan_review_accepted': {
          // 硬条件：accepted conclusion + rootCauseAlignment true + 每个 finding 有正式非-open
          // disposition（closed / accepted_with_note；缺失与 open 都不通过）+ 与当前 disposition
          // 配对（review 晚于当前 disposition 产生）——旧的已通过 plan review 不能凑数。
          const review = this.latestOf('change_plan_review') as ChangePlanReviewArtifact | undefined;
          if (!review || review.rootCauseAlignment !== true || review.conclusion?.status !== 'accepted') return false;
          if (review.findings.some((finding) => finding.disposition !== 'closed' && finding.disposition !== 'accepted_with_note')) return false;
          if (!this.changePlanReviewBindsCurrentDisposition()) return false;
          // 评审必须由 Runtime review cycle 记账产出（S1：删账本/影子周期不得通过验收）。
          return this.planReviewCycleBacked();
        }
        case 'implementation_accepted': {
          // 硬条件：accepted conclusion（candidateRevision 非空由合同强制）。
          const implementation = this.latestOf('implementation') as ImplementationArtifact | undefined;
          return implementation !== undefined && conclusionAccepted(implementation);
        }
        case 'change_review_accepted': {
          // 硬条件：accepted conclusion + all_closed + 无 open finding；仓库变更路径还必须绑定
          // 当前 implementation candidateRevision（缺/不一致不得通过）。
          const review = this.latestOf('change_review') as ChangeReviewArtifact | undefined;
          if (!review || review.conclusion?.status !== 'accepted') return false;
          if (review.findingDisposition !== 'all_closed') return false;
          // 每个 finding 必须有正式非-open disposition；缺失（undefined）与 open 一样不能通过。
          if (review.findings.some((finding) => finding.disposition !== 'closed' && finding.disposition !== 'accepted_with_note')) return false;
          if (extra.requiresRepositoryChange === true && !this.changeReviewBindsImplementation(true)) return false;
          return true;
        }
        case 'verification_accepted': {
          // Verification Contract 硬门禁（与 Fix guardVerification 语义一致）：
          // 1) accepted 必须为 true；2) 若带结论（envelope/结论），结论必须是 accepted；
          // 3) candidateRevision 按 requiresRepositoryChange 区分：仓库变更路径必须存在且与
          //    implementation 一致；无仓库变更路径可省略，声明了则不得与已有 implementation 矛盾；
          // 4) acceptance.verification 定义的 requiredChecks 每项存在且值 === true（不接受 false 或仅存在）；
          // 5) requireToolOrTestEvidence → 必须有 tool/test/external 证据；allowUnverified=false → 无 unverified；
          // 6) requireRemainingRisk → remainingRisk 非空。
          const verification = this.latestOf('verification') as VerificationArtifact | undefined;
          if (!verification || verification.accepted !== true) return false;
          const conclusion = (verification as { conclusion?: ArtifactConclusion }).conclusion;
          if (this.definition.requiresArtifactConclusion && !conclusionAccepted(verification)) return false;
          if (conclusion !== undefined && conclusion.status !== 'accepted') return false;
          const implementation = this.latestOf('implementation') as ImplementationArtifact | undefined;
          if (extra.requiresRepositoryChange === true) {
            // 仓库变更路径：candidateRevision 必须存在且与 implementation 版本一致，缺失即不通过。
            if (!implementation || !nonEmptyVerificationRevision(verification.candidateRevision)
              || verification.candidateRevision !== implementation.artifact.candidateRevision) return false;
          } else if (implementation && verification.candidateRevision !== undefined
            && verification.candidateRevision !== implementation.artifact.candidateRevision) {
            // 无仓库变更路径允许省略 candidateRevision；但声明了版本时不得与已有
            // implementation 版本矛盾（声明矛盾版本不构成有效验证）。
            return false;
          }
          const requirement = acceptance.verification;
          if (requirement) {
            if (!verification.checks || !requirement.requiredChecks.every((check) => verification.checks![check] === true)) return false;
            if (requirement.requireToolOrTestEvidence && !verification.evidence.some(isToolTestExternalEvidence)) return false;
            if (!requirement.allowUnverified && (verification.unverified?.length ?? 0) > 0) return false;
            if (requirement.requireRemainingRisk && !(verification.remainingRisk && verification.remainingRisk.length > 0)) return false;
          }
          return true;
        }
        case 'candidate_revision_consistent':
          if (extra.candidateRevisionConsistent !== undefined) return extra.candidateRevisionConsistent;
          try {
            this.assertCandidateRevisionConsistent(this.artifacts, extra.requiresRepositoryChange === true);
            return true;
          } catch {
            return false;
          }
        case 'human_final_approval':
          return extra.userDecision?.decision === 'approve';
        default:
          return false; // 未知 marker：fail-closed，纳入 missing，不得放行
      }
    };
    const markers = [...acceptance.requires];
    if (extra.requiresRepositoryChange === true && !markers.includes('candidate_revision_consistent')) {
      markers.push('candidate_revision_consistent');
    }
    if (extra.requiresRepositoryChange === true && acceptance.repositoryChangeRequires) {
      markers.push(...acceptance.repositoryChangeRequires);
    }
    const missing = markers.filter((marker) => evaluateMarker(marker) === false);
    return { passed: missing.length === 0, missing };
  }

  /** 校验实施/评审/验证之间的 candidate revision 一致；不一致抛 ArtifactContractError。 */
  assertCandidateRevisionConsistent(artifacts: readonly Artifact[], requiresRepositoryChange = false): void {
    const implementation = [...artifacts].reverse().find((a): a is ImplementationArtifact => a.kind === 'implementation');
    const changeReview = [...artifacts].reverse().find((a): a is ChangeReviewArtifact => a.kind === 'change_review');
    const verification = [...artifacts].reverse().find((a): a is VerificationArtifact => a.kind === 'verification');
    const implementationRev = implementation?.artifact.candidateRevision;
    const reviewRev = changeReview?.reviewedRevision;
    const verificationRev = verification?.candidateRevision;
    if (requiresRepositoryChange) {
      if (!implementation || !implementationRev || !changeReview || !reviewRev || !verification || !verificationRev) {
        throw new ArtifactContractError('CANDIDATE_REVISION_MISSING', 'repository-change path requires implementation, change_review, and verification revisions');
      }
      if (reviewRev !== implementationRev || verificationRev !== implementationRev) {
        throw new ArtifactContractError('CANDIDATE_REVISION_MISMATCH', 'implementation, change_review, and verification revisions must match');
      }
      return;
    }
    // No-repository-change verification may omit candidateRevision. If revisions
    // are present for compatibility, they must still not contradict each other.
    const revisions = [implementationRev, reviewRev, verificationRev]
      .filter((rev): rev is string => rev !== undefined);
    if (revisions.length > 1 && revisions.some((revision) => revision !== revisions[0])) {
      throw new ArtifactContractError('CANDIDATE_REVISION_MISMATCH', 'candidate revision values are not pairwise consistent');
    }
  }

  static restore(
    definition: WorkflowDefinition,
    store: RunStore,
    runId = 'run-1',
    opts: { requireWorkflowVersionMatch?: boolean; requirePolicyDigestMatch?: boolean; requireSchemaVersionCompatibility?: boolean; expectedWorkflowVersion?: string; expectedPolicyDigest?: string; reviewPolicyFor?: (reviewArtifactKind: Artifact['kind']) => ReviewPolicy | undefined; auditSink?: AuditSink } = {},
  ) {
    const requireWorkflowVersionMatch = opts.requireWorkflowVersionMatch ?? true;
    const requirePolicyDigestMatch = opts.requirePolicyDigestMatch ?? true;
    const requireSchemaVersionCompatibility = opts.requireSchemaVersionCompatibility ?? true;
    // 定义声明 version 时，它即是恢复的默认期望版本：调用方未显式传 expectedWorkflowVersion 也绑定，
    // 错误版本不能因调用方漏传而被接受（round-7）：声明版本是恢复契约的一部分。
    // definition.version 未声明 → unbound，维持向后兼容（checkpoint 自带版本仍以 1771 行恢复）。
    const expectedWorkflowVersion = opts.expectedWorkflowVersion ?? definition.version;
    const checkpoint = store.loadLast(runId);
    // checkpoint 顶层 sourceVersion 是统一来源绑定：与任一 artifact 来源不一致 → 拒绝。
    // 顶层缺失时不静默填 baseline/任意字符串：从既有 artifact 来源推导统一值——
    //   · 混合来源（>1 种）无法证明 checkpoint 出自同一产生来源 → 拒绝；
    //   · 一致单一值 → 推导为该值（恢复后的 runtime.sourceVersion 与 executeNode 盖章一致）；
    //   · 完全无来源（legacy 裸 Artifact checkpoint）→ 保持 undefined（legacy 可读路径）。
    let effectiveSourceVersion: string | undefined;
    if (checkpoint && checkpoint.schemaVersion !== 1) {
      // 旧 checkpoint 可继续读取，但不允许参与 v2 Acceptance。
    }
    if (checkpoint && !['INTAKE', 'INVESTIGATING', 'DISPOSITION', 'IMPLEMENTING', 'VERIFYING', 'BLOCKED', 'WAITING_FOR_USER', 'ACCEPTED'].includes(checkpoint.stage)) throw Error('checkpoint stage is not in definition');
    if (checkpoint) {
      // 顶层 sourceVersion 定义时：与任何 artifact 来源不一致 → 统一来源绑定失败。
      // 顶层缺省时：从既有 artifact 一致来源推导统一值；混合来源无法证明单一产生来源 → 拒绝；
      // 无任何来源（legacy 裸 Artifact）保持 undefined，不做 baseline/任意字符串填充。
      const artifactSourceVersions = (checkpoint.artifacts ?? [])
        .map((record) => (record as Record<string, unknown>).sourceVersion)
        .filter((sourceVersion): sourceVersion is string => typeof sourceVersion === 'string' && sourceVersion.length > 0);
      if (checkpoint.sourceVersion !== undefined) {
        if (artifactSourceVersions.some((sourceVersion) => sourceVersion !== checkpoint.sourceVersion)) {
          throw new CheckpointRestoreError('ARTIFACT_SOURCE_VERSION_MISMATCH', 'checkpoint artifact sourceVersion does not match checkpoint sourceVersion');
        }
        effectiveSourceVersion = checkpoint.sourceVersion;
      } else if (new Set(artifactSourceVersions).size > 1) {
        throw new CheckpointRestoreError('ARTIFACT_SOURCE_VERSION_MISMATCH', 'checkpoint mixes artifact sourceVersions without a checkpoint sourceVersion; cannot derive a single source');
      } else if (artifactSourceVersions.length > 0) {
        effectiveSourceVersion = artifactSourceVersions[0];
      }
      // 受控终局（acceptance 声明 human_final_approval 的定义）下，ACCEPTED 恢复时必须能证明验收事实完整
      //（schema/版本/策略/决策记录/产物齐备、未被标记 incomplete）。缺任何一项都视为不可信或伪造的
      // checkpoint，fail-closed 拒绝恢复，避免 continueRun/applyReviewDecision 误将其当作已验收并发出
      // “已解决/验收通过”报告。approve 事实只认 Runtime 盖章的显式决策记录（checkpoint.decisionRecord，
      // producerKind='user_decision' + source='runtime:decide' + requestId===pendingDecisionRequest）：
      // 仅凭 stage + 平铺的 decisionKind/decisionReference + 若干业务 Artifact 不足以构成验收（手工
      // 拼齐平铺字段不再是通过路径——平铺字段只作审计与交叉校验）。
      if (checkpoint.stage === 'ACCEPTED' && declarationControlledAcceptance(definition)) {
        const checkpointSchemaVersion = (checkpoint as Checkpoint & { schemaVersion?: number }).schemaVersion;
        const decisionRecord = checkpoint.decisionRecord;
        if (
          checkpointSchemaVersion !== 1
          || checkpoint.workflowVersion === undefined
          || checkpoint.policyDigest === undefined
          || checkpoint.decisionReference === undefined || !String(checkpoint.decisionReference).trim()
          || checkpoint.decisionKind !== 'approve'
          || checkpoint.pendingDecisionRequest === undefined
          || String(checkpoint.pendingDecisionRequest) !== String(checkpoint.decisionReference)
          || !isDecisionRecord(decisionRecord)
          || decisionRecord.decision !== 'approve'
          || decisionRecord.requestId !== String(checkpoint.pendingDecisionRequest)
          || decisionRecord.requestId !== String(checkpoint.decisionReference)
          || checkpoint.incomplete === true
          || !Array.isArray(checkpoint.artifacts) || checkpoint.artifacts.length === 0
        ) {
          throw new CheckpointRestoreError(
            'ACCEPTED_CHECKPOINT_INCOMPLETE',
            'ACCEPTED checkpoint must carry a Runtime-written approve decision record (decisionRecord bound to the pending decision request) plus complete facts (schemaVersion 1, workflowVersion, policyDigest) and non-empty artifacts',
          );
        }
        // 来源绑定（definition 声明 + 统一一致）：无外部 source resolver 时，definition.sourceVersion 是
        // 唯一的可验证来源权威。受控终局 ACCEPTED 恢复要求 checkpoint 顶层来源等于定义声明——unbound
        //（定义未声明来源）或单一伪造字符串（顶层与 artifact 用同一个自洽即通过）都不是完整 V2 来源事实：
        // 伪造方必须猜中并匹配定义的 sourceVersion，且仍要通过决策记录 + 验收重算 + 版本绑定。
        // legacy（非受控终局定义）的 ACCEPTED 是定义自身 guard/transition 的产出，不受此约束。
        const declaredSourceVersion = definition.sourceVersion;
        if (declaredSourceVersion === undefined || checkpoint.sourceVersion !== declaredSourceVersion) {
          throw new CheckpointRestoreError(
            'ACCEPTED_CHECKPOINT_INCOMPLETE',
            'ACCEPTED checkpoint sourceVersion must equal the definition-declared sourceVersion (unbound or forged source is not a verifiable V2 fact)',
          );
        }
        // 决策 Artifact 背书：ACCEPTED checkpoint 必须包含唯一一条 Runtime 盖章的 user_decision
        // approve Artifact（producerKind='user_decision' + producer='user' + requestId 绑定决策请求
        // + 来源等于定义声明），与 decisionRecord 互为背书。只有 Runtime decide() 能盖出该身份的
        // Artifact（executeNode/runReview 一律拒绝 user_decision），手工拼齐 decisionRecord +
        // 业务 Artifact 而不配齐决策 Artifact 不是可验证的验收证明。
        const approvalArtifacts = (checkpoint.artifacts ?? []) as Artifact[];
        const approvalMatches = approvalArtifacts.filter((artifact) => {
          const record = artifact as Record<string, unknown>;
          return record.kind === 'user_decision'
            && record.decision === 'approve'
            && String(record.requestId) === String(checkpoint.decisionReference);
        });
        if (approvalMatches.length !== 1
          || approvalMatches[0]!.producerKind !== 'user_decision'
          || approvalMatches[0]!.producer !== 'user'
          || approvalMatches[0]!.sourceVersion !== declaredSourceVersion) {
          throw new CheckpointRestoreError(
            'ACCEPTED_CHECKPOINT_INCOMPLETE',
            'ACCEPTED checkpoint must carry exactly one Runtime-stamped user_decision approve artifact (producerKind user_decision, producer user, sourceVersion bound to the definition-declared source) backing the decision record',
          );
        }
        // 决策 Artifact 的版本绑定：run 产生候选版本时，approve Artifact 必须声明同一候选版本，
        // 且不得与平铺 decisionCandidateRevision 矛盾（decisionRecord/平铺字段/Artifact 三处版本
        // 必须同源）。防“record 与平铺字段已绑定版本、但 Artifact 声明不同版本”的分离伪造。
        // （此处 runtime.candidateRevision 尚未恢复，候选版本取 平铺字段 → implementation Artifact。）
        const boundRevision = checkpoint.candidateRevision
          ?? ([...(checkpoint.artifacts ?? [])].reverse().find((artifact): artifact is ImplementationArtifact => artifact.kind === 'implementation') as ImplementationArtifact | undefined)?.artifact.candidateRevision;
        if (boundRevision !== undefined) {
          const approvalRevision = (approvalMatches[0] as { candidateRevision?: unknown }).candidateRevision;
          if (approvalRevision !== boundRevision
            || (checkpoint.decisionCandidateRevision !== undefined && approvalRevision !== checkpoint.decisionCandidateRevision)) {
            throw new CheckpointRestoreError(
              'ACCEPTED_ACCEPTANCE_NOT_MET',
              'the user_decision approve artifact must bind the same candidate revision as the run and the decision record',
            );
          }
        }
      }
      if (checkpoint.workflowVersion !== undefined && requireWorkflowVersionMatch && expectedWorkflowVersion !== undefined && checkpoint.workflowVersion !== expectedWorkflowVersion) {
        throw new CheckpointRestoreError('WORKFLOW_VERSION_MISMATCH', `checkpoint workflowVersion ${checkpoint.workflowVersion} does not match expected ${expectedWorkflowVersion}`);
      }
      if (requireWorkflowVersionMatch && expectedWorkflowVersion !== undefined && checkpoint.workflowVersion === undefined) {
        // Missing version metadata is a readable legacy checkpoint. It is
        // marked incomplete below and therefore cannot pass v2 Acceptance.
      }
      if (checkpoint.policyDigest !== undefined && requirePolicyDigestMatch && opts.expectedPolicyDigest !== undefined && checkpoint.policyDigest !== opts.expectedPolicyDigest) {
        throw new CheckpointRestoreError('POLICY_DIGEST_MISMATCH', `checkpoint policyDigest ${checkpoint.policyDigest} does not match expected ${opts.expectedPolicyDigest}`);
      }
      if (requirePolicyDigestMatch && opts.expectedPolicyDigest !== undefined && checkpoint.policyDigest === undefined) {
        // Missing policy metadata is a readable legacy checkpoint. It is
        // marked incomplete below and therefore cannot pass v2 Acceptance.
      }
      // 旧 checkpoint（无 workflowVersion/policyDigest/schemaVersion 等新字段）可兼容读取，标记为 incomplete；
      // 当调用方提供期望版本时也不在 restore 阶段拒绝，由 Acceptance 阻止不完整 run 通过。
      const schemaVersion = (checkpoint as Checkpoint & { schemaVersion?: number }).schemaVersion;
      if (requireSchemaVersionCompatibility && schemaVersion !== undefined && schemaVersion !== 1) {
        throw new CheckpointRestoreError('SCHEMA_VERSION_MISMATCH', `checkpoint schemaVersion ${schemaVersion} is not compatible`);
      }
      if (checkpoint.artifacts) {
        const latestArtifact = (kind: Artifact['kind']) => [...checkpoint.artifacts!].reverse().find((artifact) => artifact.kind === kind);
        const implementation = latestArtifact('implementation') as ImplementationArtifact | undefined;
        const changeReview = latestArtifact('change_review') as ChangeReviewArtifact | undefined;
        const verification = latestArtifact('verification') as VerificationArtifact | undefined;
        const artifactRevisions = [
          implementation?.artifact.candidateRevision,
          changeReview?.reviewedRevision,
          verification?.candidateRevision,
        ];
        const disposition = latestArtifact('disposition') as DispositionArtifact | undefined;
        const requiresRepositoryBindings = disposition?.requiresRepositoryChange === true
          && ['VERIFYING', 'WAITING_FOR_USER', 'ACCEPTED'].includes(checkpoint.stage);
        if (requiresRepositoryBindings) {
          const [implementationRev, reviewRev, verificationRev] = artifactRevisions;
          const requiredRevisions = [implementationRev, reviewRev];
          const verificationRequired = ['WAITING_FOR_USER', 'ACCEPTED'].includes(checkpoint.stage);
          if (requiredRevisions.some((revision) => typeof revision !== 'string' || !revision.trim())
            || (verificationRequired && (typeof verificationRev !== 'string' || !verificationRev.trim()))
            || (!verificationRequired && verificationRev !== undefined && (typeof verificationRev !== 'string' || !verificationRev.trim()))
            || new Set(artifactRevisions.filter((revision): revision is string => typeof revision === 'string')).size !== 1) {
            throw new CheckpointRestoreError('CANDIDATE_REVISION_MISMATCH', 'repository-change checkpoint artifacts must bind current revisions consistently');
          }
        } else {
          const presentRevisions = artifactRevisions.filter((revision): revision is string => typeof revision === 'string');
          if (presentRevisions.length > 1 && new Set(presentRevisions).size > 1) {
            throw new CheckpointRestoreError('CANDIDATE_REVISION_MISMATCH', 'checkpoint artifact candidate revisions are inconsistent');
          }
        }
      }
    }
      const runtime = new WorkflowRuntime(definition, store, runId, () => Date.now(), () => `${runId}-${Date.now()}`, {
      definitionVersion: expectedWorkflowVersion,
      policyDigest: opts.expectedPolicyDigest,
      sourceVersion: effectiveSourceVersion,
      reviewPolicyFor: opts.reviewPolicyFor,
      auditSink: opts.auditSink,
    });
    if (checkpoint) {
      // 评审周期账本跨 session 恢复：门禁依赖账本判断 change_plan_review 是否由 runReview 在
      // 当前策略下记账产出（直传伪造没有任何账本周期）。账本只要存在就必须逐条完整合法——
      // 形状非法的记录是 checkpoint 损坏/篡改，fail-closed（CHECKPOINT_REVIEW_LEDGER_INCONSISTENT），
      // 不得静默过滤后继续（过滤会丢失审计事实并让受损账本看起来正常）。
      const rawCycles = checkpoint.reviewCycles;
      if (rawCycles !== undefined && !Array.isArray(rawCycles)) {
        throw new CheckpointRestoreError('CHECKPOINT_REVIEW_LEDGER_INCONSISTENT', 'checkpoint reviewCycles must be an array');
      }
      if (rawCycles && rawCycles.some((record) => !isReviewCycleRecord(record))) {
        throw new CheckpointRestoreError('CHECKPOINT_REVIEW_LEDGER_INCONSISTENT', 'checkpoint contains a malformed review cycle record');
      }
      runtime.reviewCycles = rawCycles ? [...rawCycles] : [];
      // 账本身份唯一性：cycleId 是账本↔Artifact 的绑定键，同一 run 内每个周期必须有唯一身份——
      // 两条同 id 的完整记录会让“按 cycleId 反向查找”的解释取决于记录顺序，账本事实发生歧义。
      // 重复 cycleId 一律 fail-closed（与形状校验同错误码）。
      if (rawCycles) {
        const cycleIds = rawCycles.map((record) => record.cycleId);
        if (new Set(cycleIds).size !== cycleIds.length) {
          throw new CheckpointRestoreError(
            'CHECKPOINT_REVIEW_LEDGER_INCONSISTENT',
            'checkpoint reviewCycles contain duplicate cycleId (cycle identity must be unique per run)',
          );
        }
      }
      // 恢复后新发起的 runReview 周期必须避开 checkpoint 内已有 cycleId（同一 runId + 同一毫秒时
      // 序号重叠会串号）：以已有周期 id 的最大序号后缀递增，而非“条数”（条数与最大序号可不同，
      // e.g. 账本仅一条 .5 记录的 checkpoint）。
      runtime.reviewSeq = runtime.reviewCycles.reduce((max, record) => {
        const match = /^(.*)\.(\d+)$/.exec(record.cycleId);
        const suffix = match ? Number(match[2]) : 0;
        return Number.isInteger(suffix) && suffix > max ? suffix : max;
      }, 0);
      // 账本↔产物一致性（恢复控制面）：配置了 reviewPolicyFor 时，每个周期必须由当前有效策略产出
      //（策略摘要一致，旧/降级策略不得冒充当前策略），且周期记账数字（approvals/passed/唯一评审者）
      // 必须能被 checkpoint 中实际评审 Artifact 支撑——防“恢复账本整体伪造（当前摘要 + 虚增 quorum
      // + 手写 cycleId）”。不配置 resolver 的通用 restore 保持形状校验（库里路径）。
      if (opts.reviewPolicyFor) {
        for (const record of runtime.reviewCycles) {
          const policy = opts.reviewPolicyFor(record.reviewArtifactKind);
          if (!policy || serializeReviewPolicy(policy) !== record.policyDigest) {
            throw new CheckpointRestoreError(
              'CHECKPOINT_REVIEW_LEDGER_INCONSISTENT',
              `review cycle ${record.cycleId} ${record.reviewArtifactKind} is not bound to the current effective policy (stale or weakened policy digest)`,
            );
          }
          // 语义节点绑定（与 live 门禁同源）：周期必须由规定义上能产出该评审 kind 的节点记账产出，
          // 影子/跨 kind 节点（如 change_plan_review_shadow 或称 investigate 的周期）不得通过恢复。
          if (NODE_KIND_BY_NODE_ID[record.reviewNodeId] !== record.reviewArtifactKind) {
            throw new CheckpointRestoreError(
              'CHECKPOINT_REVIEW_LEDGER_INCONSISTENT',
              `review cycle ${record.cycleId} reviewNodeId ${record.reviewNodeId} cannot produce ${record.reviewArtifactKind}`,
            );
          }
          const derived = deriveCycleFacts(record, checkpoint.artifacts ?? [], policy);
          if (record.approvals !== derived.approvals
            || record.passed !== (record.approvals >= record.requiredApprovals)
            || new Set(record.reviewerWorkerIds).size !== derived.uniqueReviewers
            || !sameReviewerSet(record.reviewerWorkerIds, derived.reviewerWorkerIds)
            || record.recordedAtIndex !== derived.lastCycleArtifactIndex) {
            throw new CheckpointRestoreError(
              'CHECKPOINT_REVIEW_LEDGER_INCONSISTENT',
              `review cycle ${record.cycleId} ledger facts are not backed by the restored review artifacts`,
            );
          }
        }
      }
      runtime.stage = checkpoint.stage;
      runtime.problem = checkpoint.problem;
      runtime.pendingDecision = checkpoint.pendingDecisionRequest;
      // 等待种类随 checkpoint 恢复：只接受合法值（未知种类 fail-closed，防伪造等待种类导流）；
      // 缺字段（legacy checkpoint）保持 undefined，沿用既有 Verification 推导语义。
      if (checkpoint.pendingDecisionKind !== undefined) {
        if (!['final_acceptance', 'configuration_wait', 'disposition_decision', 'external_action_completion'].includes(checkpoint.pendingDecisionKind)) {
          throw new CheckpointRestoreError('CHECKPOINT_STATE_INCONSISTENT', `unknown pendingDecisionKind on checkpoint: ${String(checkpoint.pendingDecisionKind)}`);
        }
        runtime.pendingDecisionKind = checkpoint.pendingDecisionKind;
      }
      if (checkpoint.incomplete === true) runtime.checkpointIncomplete = true;
      if (checkpoint.schemaVersion !== 1 || checkpoint.workflowVersion === undefined || checkpoint.policyDigest === undefined) runtime.checkpointIncomplete = true;
      runtime.restoreArtifacts(checkpoint.artifacts);
      // 恢复重建 Node→Worker 映射与“已执行过节点”标志：
      // (a) 评审独立性守卫只读 nodeWorkerIds，恢复后新发起的 runReview 必须仍把历史作者排除
      //     （同一作者在恢复后自评 = 绕过 requireIndependentWorker）；
      // (b) run_started 是“Runtime 创建新 runId”的一次性事件，恢复同一 runId 后续跑不得重复产生。
      runtime.nodeWorkerIds = collectNodeWorkerIds(runtime.runId, runtime.artifacts);
      // (b) run_started 是“Runtime 创建新 runId”的一次性事件，恢复同一 runId 后续跑不得重复产生。
      //   持久化标记 started 是权威依据（首个 Node 即使 Worker 提交前失败也已发出启动事件）；
      //   旧 checkpoint 无该字段时以“已有 Artifact”回退推断。
      if (checkpoint.started === true) runtime.ranAnyNode = true;
      else if (runtime.artifacts.length > 0) runtime.ranAnyNode = true;
      if (checkpoint.workflowVersion !== undefined) runtime.definitionVersion = checkpoint.workflowVersion;
      if (checkpoint.policyDigest !== undefined) runtime.policyDigest = checkpoint.policyDigest;
      if (effectiveSourceVersion !== undefined) runtime.sourceVersion = effectiveSourceVersion;
      if (checkpoint.activeNodeId !== undefined) runtime.activeNodeId = checkpoint.activeNodeId;
      if (checkpoint.candidateRevision !== undefined) {
        runtime.candidateRevision = checkpoint.candidateRevision;
      } else {
        // 旧 checkpoint 无 candidateRevision 时，从当前 implementation artifact 恢复，避免版本校验丢失。
        const implementation = [...(checkpoint.artifacts ?? [])].reverse().find((artifact): artifact is ImplementationArtifact => artifact.kind === 'implementation');
        if (implementation) runtime.candidateRevision = implementation.artifact.candidateRevision;
      }
      const restoredLatest = (kind: Artifact['kind']) => [...(checkpoint.artifacts ?? [])].reverse().find((artifact) => artifact.kind === kind);
      const restoredCurrentRevisions = [
        (restoredLatest('implementation') as ImplementationArtifact | undefined)?.artifact.candidateRevision,
        (restoredLatest('change_review') as ChangeReviewArtifact | undefined)?.reviewedRevision,
        (restoredLatest('verification') as VerificationArtifact | undefined)?.candidateRevision,
      ].filter((revision): revision is string => typeof revision === 'string');
      if (checkpoint.candidateRevision !== undefined && restoredCurrentRevisions.some((revision) => revision !== checkpoint.candidateRevision)) {
        throw new CheckpointRestoreError('CANDIDATE_REVISION_MISMATCH', 'checkpoint candidateRevision does not match its current artifacts');
      }
      // BLOCKED 解除目标阶段跨 session 恢复：产生 BLOCKED 时的现场保存于 checkpoint，
      // 恢复时回放，不允许 continueRun 默认回滚到 INVESTIGATING（外部条件/证据不足阻塞后
      // 应回到阻塞点所在阶段，而不是把用户引流回最初的调查）。
      if (checkpoint.blockedReturnStage !== undefined) runtime.blockedReturnStage = checkpoint.blockedReturnStage;
      // 受控终局定义下，WAITING_FOR_USER 恢复必须有合法等待现场：人工等待只能由“已接受的验证”
      // 产生（或配置类失败的验证），且必须携带 Runtime 创建的 pendingDecisionRequest——凭空伪造的
      // 等待态（无验证 / 验证未通过 / 无 pending request）不得续跑后在同一个调用里直接 approve 进入
      // ACCEPTED（绕过 ACCEPTED 恢复的决策记录与来源校验）。仅在 checkpoint 携带决策请求
      //（pendingDecisionRequest 非空）时校验——纯形状校验用的最小 WAITING 现场没有决策管线，
      // 不构成 approve 绕过面。
      if (checkpoint.stage === 'WAITING_FOR_USER' && declarationControlledAcceptance(definition)
        && !runtime.checkpointIncomplete
        && checkpoint.pendingDecisionRequest !== undefined) {
        const restoredVerification = ([...(checkpoint.artifacts ?? [])].reverse().find((artifact) => artifact.kind === 'verification') as VerificationArtifact | undefined);
        const waitsOnValidVerification = restoredVerification !== undefined
          && (restoredVerification.accepted === true
            || (restoredVerification.accepted === false && restoredVerification.failure?.kind === 'configuration'));
        // D3：处置决定等待 / 外部动作完成等待没有验证现场，等待事实由“最新的 disposition 声明
        // wait_decision / external_action”支撑；同样必须是 Runtime 创建的 pendingDecisionRequest。
        const restoredDisposition = ([...(checkpoint.artifacts ?? [])].reverse().find((artifact) => artifact.kind === 'disposition') as DispositionArtifact | undefined);
        // F2：等待种类与等待事实交叉校验——只有最新 disposition 声明的等待类型能产生对应的
        // pendingDecisionKind（wait_decision→disposition_decision，external_action→
        // external_action_completion）。声明了处置等待种类但现场不是处置等待（或种类与处置类型
        // 不配对）的 checkpoint 视为状态不一致 fail-closed，避免 resume 后按错误等待种类渲染
        //（如把 external_action 等待渲染成“等待处置决定”）。legacy checkpoint（缺字段）保持
        // undefined，沿用既有 Verification 推导回退，不接受也不要求该字段。
        const dispositionKindFor = (dispositionType: DispositionArtifact['dispositionType'] | undefined): PendingDecisionKind | undefined =>
          dispositionType === 'wait_decision' ? 'disposition_decision'
            : dispositionType === 'external_action' ? 'external_action_completion'
              : undefined;
        const waitsOnDispositionDecision = dispositionKindFor(restoredDisposition?.dispositionType) !== undefined;
        const pendingKind = checkpoint.pendingDecisionKind;
        const pendingKindMismatch = pendingKind !== undefined && (
          (waitsOnDispositionDecision && pendingKind !== dispositionKindFor(restoredDisposition?.dispositionType))
          || (!waitsOnDispositionDecision && (pendingKind === 'disposition_decision' || pendingKind === 'external_action_completion'))
          // F2b：验证等待的等待种类必须与验证现场配对——final_acceptance 只能由已接受验证产生，
          // configuration_wait 只能由配置类失败验证（accepted=false + failure.kind=configuration）产生；
          // accepted=true 却声明 configuration_wait（或反之）的伪造/损坏 checkpoint fail-closed，
          // 避免 resume 后按错误等待种类渲染或误用 continue_verification/approve 出口。
          || (pendingKind === 'final_acceptance' && restoredVerification?.accepted !== true)
          || (pendingKind === 'configuration_wait' && !(restoredVerification?.accepted === false && restoredVerification.failure?.kind === 'configuration'))
        );
        if (!(waitsOnValidVerification || waitsOnDispositionDecision)
          || pendingKindMismatch
          || typeof checkpoint.pendingDecisionRequest !== 'string' || !checkpoint.pendingDecisionRequest) {
          throw new CheckpointRestoreError(
            'CHECKPOINT_STATE_INCONSISTENT',
            'WAITING_FOR_USER checkpoint must be backed by an accepted (or configuration-failed) verification, or a wait_decision/external_action disposition awaiting a user decision with a matching pendingDecisionKind, and a Runtime-created pending decision request',
          );
        }
      }
      // ACCEPTED 恢复必须重放验收事实（仅受控终局定义需要复算；legacy 定义下 ACCEPTED 是其自身
      // guard/transition 的结果，不含 Runtime 决策记录）。字段齐全 ≠ 验收事实齐全：伪造方可以把
      // decisionReference + 非空 artifacts 填齐，但 artifacts 不构成完整 Acceptance
      //（缺 review marker / 缺真实 approve 决策事实）时仍可能被 continueRun 当作
      // “已解决（验收通过）”直接发报告。此处以 decisionReference 合成人工 approve 决策
      // 重新求值整个 Acceptance（含 checkpointIncomplete → checkpoint_complete 缺失）；
      // 不通过一律视为伪造/不完整验收态，fail-closed 拒绝恢复，不产出任何验收报告。
      if (checkpoint.stage === 'ACCEPTED' && declarationControlledAcceptance(definition)) {
        const acceptance = runtime.evaluateAcceptance({
          userDecision: { kind: 'user_decision', decision: 'approve', requestId: checkpoint.decisionReference ?? 'restore' } as UserDecisionArtifact,
          requiresRepositoryChange: runtime.dispositionRequiresRepositoryChange(),
        });
        if (!acceptance.passed) {
          throw new CheckpointRestoreError(
            'ACCEPTED_ACCEPTANCE_NOT_MET',
            `ACCEPTED checkpoint must re-satisfy the Fix acceptance definition on restore; missing: ${acceptance.missing.join(', ')}`,
          );
        }
        // approve 决策必须绑定 run 的当前候选版本：无论候选版本来自 checkpoint 顶层
        // candidateRevision 还是从 implementation Artifact 恢复，run 已产生候选版本（仓库变更路径）时，
        // approve 决策必须携带匹配的 decisionCandidateRevision（平铺字段）与 decisionRecord.candidateRevision；
        // 缺版本或版本不一致都不是可验证的验收事实（决策事实 + 版本 bind 共同构成完整的人工 approve 事实）。
        // 无仓库变更（无候选版本）不要求。
        const recordCandidateRevision = checkpoint.decisionRecord?.candidateRevision;
        if (runtime.candidateRevision !== undefined
          && (checkpoint.decisionCandidateRevision === undefined || checkpoint.decisionCandidateRevision !== runtime.candidateRevision
            || recordCandidateRevision === undefined || recordCandidateRevision !== runtime.candidateRevision)) {
          throw new CheckpointRestoreError('ACCEPTED_ACCEPTANCE_NOT_MET', 'ACCEPTED checkpoint approve decision must bind the run candidate revision when the run has produced one');
        }
      }
    }
    return runtime;
  }
}
