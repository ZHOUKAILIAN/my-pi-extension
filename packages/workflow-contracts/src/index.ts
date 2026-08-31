export type Stage = 'INTAKE'|'INVESTIGATING'|'DISPOSITION'|'IMPLEMENTING'|'VERIFYING'|'BLOCKED'|'WAITING_FOR_USER'|'ACCEPTED';
export type InvestigationRoute = 'local_fix'|'requirement_change'|'design_change'|'needs_more_evidence'|'blocked';
export type ProducerKind = 'worker'|'user_decision'|'controller';
export type EvidenceKind = 'tool'|'test'|'log'|'external';
export type EvidenceItem = string | { ref: string; kind?: EvidenceKind; summary?: string };
export type ConclusionStatus = 'accepted'|'rejected'|'blocked'|'inconclusive'|'needs_more_evidence';
export interface ArtifactConclusion { status: ConclusionStatus; summary: string; }

/** Common provenance fields for an explicitly enveloped Artifact. */
export interface ArtifactEnvelope {
  schemaVersion: 1;
  runId: string;
  nodeExecutionId?: string;
  workerId?: string;
  producerKind: ProducerKind;
  sourceVersion: string;
  evidence: EvidenceItem[];
  unverified: string[];
  conclusion?: ArtifactConclusion;
}
export interface WorkerArtifactEnvelope extends ArtifactEnvelope {
  nodeExecutionId: string;
  workerId: string;
  producerKind: 'worker';
  conclusion?: ArtifactConclusion;
}
export interface ArtifactExecutionContext {
  schemaVersion: 1;
  runId: string;
  nodeExecutionId: string;
  workerId: string;
  sourceVersion: string;
  /** Whether this verification belongs to a repository-change path. */
  requiresRepositoryChange?: boolean;
  /** Whether the active workflow requires a real worker-supplied conclusion. */
  requiresArtifactConclusion?: boolean;
}

export interface InvestigationArtifact { kind:'investigation'; route:InvestigationRoute; rootCause:string; evidence:EvidenceItem[]; id?:string; [key:string]:unknown }
export interface ImplementationDetails { summary:string; filesChanged:string[]; candidateRevision:string; prUrl?:string; }
export interface ImplementationArtifact { kind:'implementation'; artifact:ImplementationDetails; id?:string; [key:string]:unknown }
// 验证失败的三类原因：代码/仓库变更可修复 → IMPLEMENTING；配置问题需用户修改 → WAITING_FOR_USER；
// 权限/环境/外部依赖缺失 → BLOCKED。accepted===false 时 failure 必填，禁止静默回 IMPLEMENTING。
export type VerificationFailureKind = 'implementation'|'configuration'|'external_condition';
export interface VerificationFailure { kind:VerificationFailureKind; reason:string; responsibility?:string; resolution?:string }
export interface VerificationArtifact { kind:'verification'; accepted:boolean; evidence:EvidenceItem[]; candidateRevision?:string; unverified?:string[]; remainingRisk?:string[]; checks?:Record<string, boolean|string>; failure?:VerificationFailure; id?:string; [key:string]:unknown }
export interface UserDecisionArtifact { kind:'user_decision'; decision:'approve'|'request_changes'|'reject'|'continue_investigating'|'continue_verification'|'continue_disposition'; requestId:string; reasonCode?:string; candidateRevision?:string; note?:string; producerKind?:'user_decision'; schemaVersion?:1; runId?:string; sourceVersion?:string; evidence?:EvidenceItem[]; unverified?:string[]; conclusion?:ArtifactConclusion; [key:string]:unknown }

// WAITING_FOR_USER 的等待种类：区分三类人工/外部等待（D3：处置决定 / 外部动作完成；最终验收），
// 加上显式的配置类验证失败等待（configuration_wait，与既有 continue_verification 出口对应）。
// 由 Extension 在进入 WAITING_FOR_USER 前显式声明（Runtime 保持业务无关：只持久化/恢复，不推导）；
// legacy checkpoint 无该字段时以既有 Verification 推导语义（isPendingConfigurationWait）兼容。
export type PendingDecisionKind = 'final_acceptance' | 'configuration_wait' | 'disposition_decision' | 'external_action_completion';
export interface GuardRejectionArtifact { kind:'guard_rejection'; error:string; [key:string]:unknown }

// Intake 正式用户可读字段：summary（一句话问题摘要）+ overview（两三句话场景/影响/已知上下文）。
// 原始 problem 保留为 Run 级追溯事实（checkpoint.problem），不进入报告或人工摘要；
// 不再保留 phenomenon 兼容字段，旧 checkpoint 缺 summary/overview 视为不完整。
export interface IntakeArtifact { kind:'intake'; summary:string; overview:string; environment?:string; scope?:string; urgency?:'low'|'medium'|'high'|'critical'; [key:string]:unknown }
export interface Finding { id:string; summary:string; severity?:'info'|'warning'|'blocker'; check?:string; disposition?:'open'|'closed'|'accepted_with_note' }
export interface InvestigationReviewArtifact { kind:'investigation_review'; targetArtifactId?:string; rootCauseConclusion:string; evidenceSufficiency:'sufficient'|'insufficient'; gaps:string[]; stopReason?:string; conclusion:ArtifactConclusion; [key:string]:unknown }
export interface DispositionArtifact { kind:'disposition'; dispositionType:'remediation'|'mitigation'|'explanation'|'external_action'|'wait_decision'|'change_request'|'insufficient_evidence'; requiresRepositoryChange:boolean; requiresFormalPlanReview?:boolean; minimalScope:string; risks:string[]; verificationTarget:string; conclusion:ArtifactConclusion; [key:string]:unknown }
export interface ChangePlanReviewArtifact { kind:'change_plan_review'; targetPlanRevision?:string; rootCauseAlignment:boolean; changedScope:string; risks:string[]; compatibility:string[]; verification:string[]; rollback:string[]; findings:Finding[]; conclusion:ArtifactConclusion; [key:string]:unknown }
export interface ChangeReviewArtifact { kind:'change_review'; reviewedRevision?:string; prRef?:string; findings:Finding[]; findingDisposition:'all_closed'|'open'; conclusion:ArtifactConclusion; [key:string]:unknown }

export type FixAuditEventType =
  | 'run_started'
  | 'artifact_submitted'
  | 'artifact_rejected'
  | 'investigation_review_completed'
  | 'change_plan_review_completed'
  | 'disposition_completed'
  | 'implementation_created'
  | 'change_review_completed'
  | 'verification_completed'
  | 'human_review_decided'
  | 'run_accepted'
  /** 预留给后验收 reopen 专项（D6）；语义源自归档评审草案，待 L1 回写，当前无 emit 点。 */
  | 'run_reopened'
  /** 人工返工回流（decide 的 request_changes / reject / continue_* 回流到执行 Stage）。 */
  | 'run_rework'
  | 'run_rolled_back'
  | 'post_acceptance_issue_confirmed';
export interface FixAuditEvent<T = Record<string, unknown>> {
  schemaVersion: 1;
  eventId: string;
  eventType: FixAuditEventType;
  occurredAt: string;
  runId: string;
  workflowId: string;
  workflowDefinitionVersion: string;
  policyDigest: string;
  stage: string;
  /** 未分类时不虚构：只有调用方/扩展在事件里传实值时才有值（avoid fabricated defaults）。 */
  bugCategory?: string;
  riskLevel?: 'low'|'medium'|'high'|'critical';
  nodeId?: string;
  nodeExecutionId?: string;
  workerId?: string;
  role?: string;
  sourceVersion?: string;
  artifactId?: string;
  candidateRevision?: string;
  reviewCycleId?: string;
  decision?: string;
  reasonCode?: string;
  payload: T;
  supersedesEventId?: string;
}

export interface ReviewParticipant { model?:string; skills?:string[] }
export interface ReviewPolicy { reviewers:ReviewParticipant[]; mode:'parallel'; requiredApprovals:number; requireIndependentWorker:boolean; excludeNodes:string[]; requiredChecks?:string[]; onRejected:string }
export interface VerificationRequirement { requiredChecks:string[]; requireToolOrTestEvidence:boolean; requireCandidateRevisionMatch:boolean; allowUnverified:boolean; requireRemainingRisk:boolean; onRejected:string }
export interface AcceptanceDefinition { requires:string[]; repositoryChangeRequires?:string[]; humanFinalApproval?:boolean; verification?:VerificationRequirement }
export interface NodeExecutionConfig { model?:string; skills?:string[]; tools:string[]; context?:string[] }
export interface ExecutionPolicy { maxAttemptsPerNode:number; retryTransientModelErrors:boolean; retryContractErrors:boolean; checkpointAfter:string[]; resume:{ requireWorkflowVersionMatch:boolean; requirePolicyDigestMatch:boolean; requireSchemaVersionCompatibility:boolean } }
export interface EffectivePolicy { workflow:{ id:string; definitionVersion:string; initialStage:string; transitions:{ from:string; to:string; after:string }[] }; nodes:Record<string, NodeExecutionConfig>; review:Record<string, ReviewPolicy>; verification:VerificationRequirement; acceptance:AcceptanceDefinition; execution:ExecutionPolicy; digest:string }

export type WorkerArtifact = (InvestigationArtifact|ImplementationArtifact|VerificationArtifact) & WorkerArtifactEnvelope;
export type Artifact = InvestigationArtifact|ImplementationArtifact|VerificationArtifact|UserDecisionArtifact|GuardRejectionArtifact|WorkerArtifact|IntakeArtifact|InvestigationReviewArtifact|DispositionArtifact|ChangePlanReviewArtifact|ChangeReviewArtifact;
export type Capsule = Record<string, unknown>;
export interface WorkerExecutor { readonly workerId?: string; execute(node: NodeDefinition, task: unknown, capsule: Capsule): Promise<Artifact>; }
export interface NodeDefinition { id: string; worker?: WorkerExecutor; profile?: WorkerProfile; }
export interface Checkpoint { schemaVersion?:1; runId:string; stage:Stage; at:number; id:string; problem?:string; artifactRefs?:string[]; artifacts?:Artifact[]; pendingDecisionRequest?:string; decisionReference?:string; workflowVersion?:string; policyDigest?:string; nodeExecutionId?:string; activeNodeId?:string; sourceVersion?:string; candidateRevision?:string; reviewCycleId?:string; /** 运行是否已发出 run_started（首个 Node 执行后即为 true，恢复时避免重复启动事件）。 */ started?:boolean; /** 评审周期账本：runReview 每次记账一条；change_plan_review 的 DISPOSITION → IMPLEMENTING 门禁
  只认绑定到账本周期（含 quorum / 独立评审者 / 与当前处置配对）的评审 Artifact，直传伪造不再放行。
  其他评审 kind（investigation_review / change_review）也记录，保持跨 session 恢复的评审事实连续。 */ reviewCycles?:ReviewCycleRecord[]; /** BLOCKED 解除后回到的目标阶段：记录产生 BLOCKED 时的现场，跨 session 恢复时按此回放，不允许默认回滚到 INVESTIGATING。 */ blockedReturnStage?:Stage; incomplete?:boolean; // 用户决策的审计事实：决策种类（approve 等）、绑定版本与原因进入 checkpoint，避免依赖易丢的决策 Artifact；
  // ACCEPTED 恢复以此为可验证的人工 approve 事实（decisionKind==='approve' + decisionReference + 版本绑定）。
  decisionKind?:UserDecisionArtifact['decision']; decisionCandidateRevision?:string; decisionReasonCode?:string;
  // WAITING_FOR_USER 的等待种类（Extension 进入等待前声明，Runtime 持久化/恢复；无值不写，
  // legacy checkpoint 形状保持不变）。restore 的 WAITING 一致性校验与 continue_disposition 路由
  // 都以它为事实基础：disposition_decision / external_action_completion 由 disposition 等待产生，
  // final_acceptance / configuration_wait 由验证产生。
  pendingDecisionKind?:PendingDecisionKind;
  // 显式的 Runtime 决策记录（与业务字段平铺的 decisionKind/decisionReference 并存，但受控终局恢复只认
  // 本记录：由 Runtime.decide 路径产生的唯一记录，包含 producer/source 来源事实，不允许任意字符串相等
  // 作为唯一证明）。只有 decide() 委托路径由 Runtime 盖章写入；legacy resume()/gate 决策不附加本记录
  //（未 opt-in 的 legacy checkpoint 保持原形状，不被声称为 runtime:decide 产出）。
  decisionRecord?:DecisionRecord; }

/** Runtime 决策记录：decide()/决策路径由 Runtime 盖章写入 checkpoint 的唯一来源事实，
 *  与业务 Artifact 字段分离（producer/source 指向决策产生路径，不混入业务载荷）。
 *  requestId 必须等于 checkpoint.pendingDecisionRequest（绑定 Run 决策记录），
 *  ACCEPTED 受控终局恢复只接受 decision==='approve' 且 producerKind==='user_decision' 的记录。 */
export interface DecisionRecord {
  /** Runtime 产生的唯一决策记录 id（dec:${runId}:${ts}），用于审计与恢复绑定。 */
  recordId: string;
  decision: UserDecisionArtifact['decision'];
  requestId: string;
  /** approve 决策绑定的候选版本（run 已产生候选版本时必须一致）。 */
  candidateRevision?: string;
  /** 用户决定内容（打回原因码 / continue_disposition 的处置决定内容等），与平铺 decisionReasonCode
   *  并存，作为 trace 事实；不是受控终局验收的必要字段（approve 不要求）。 */
  reasonCode?: string;
  /** 用户决定内容的自由文本（continue_disposition 的处置决定说明 / 打回补充等），trace 事实。 */
  note?: string;
  /** 决策产生者（Runtime 依据决策 Artifact 种类盖章）：人工用户决策为 'user_decision'。 */
  producerKind: string;
  producer: string;
  producerName?: string;
  /** 决策记录产生来源：固定标记 'runtime:decide'（Runtime 决策路径），区分业务字段。 */
  source: 'runtime:decide';
}

export interface ReviewCycleRecord {
  cycleId: string;
  reviewNodeId: string;
  reviewArtifactKind: Artifact['kind'];
  reviewedNodeId: string;
  requiredApprovals: number;
  approvals: number;
  passed: boolean;
  reviewerWorkerIds: string[];
  /** 记账时刻执行评审所使用 ReviewPolicy 的规范化摘要：与 Runtime 当前策略比较的绑定依据，
   *  门禁（配置了 reviewPolicyFor 时）要求周期由当前策略产出，防止降级策略/篡改账本绕过 quorum。 */
  policyDigest: string;
  /** 记账时刻当前 disposition 在 artifacts 中的序号（无 disposition 为 -1）：门禁要求周期与当前处置配对，
   *  重开处置后的旧周期不得放行新处置。 */
  dispositionIndexAtCycle: number;
  /** 记账时刻最后一个评审 Artifact 在 artifacts 中的序号（审计用）。 */
  recordedAtIndex: number;
}
export interface RunStore { saveCheckpoint(c:Checkpoint):void; loadLast(runId:string):Checkpoint|undefined; }
export interface WorkflowDefinition { id:string; initialStage:Stage; nodes?: Record<string, NodeDefinition>; guard(from:Stage,to:Stage,artifact?:Artifact):void; transition(from:Stage,to:Stage,artifact?:Artifact):Stage; version?:string; acceptance?:AcceptanceDefinition; /** v2 workflows require real worker conclusions. */ requiresArtifactConclusion?:boolean; /** 终局决策的显式能力声明：'user' = 人工最终验收由 Runtime decide() 控制（受控终局），
   *  'controller' 或未声明 = 不使用受控终局，ACCEPTED 沿用定义自身 guard/transition 语义。
   *  不得仅凭 acceptance 的 human_final_approval marker 推断受控终局。 */ decision?: 'user' | 'controller'; /** 定义的“产生来源”版本：无外部 source resolver 时，Runtime 以它作为可验证的来源绑定
 *  （checkpoint 顶层 sourceVersion 必须等于 definition.sourceVersion，任意伪造字符串不能通过）。
 *  未声明 → unbound：受控终局 ACCEPTED 恢复 fail-closed。 */ sourceVersion?:string; }
export interface WorkerProfile { tools:string[]; skills?:string[]; context?:string[]; }
export const INVESTIGATE_PROFILE:WorkerProfile={tools:['read','submit_artifact'],skills:[],context:[]}; export const IMPLEMENT_PROFILE:WorkerProfile={tools:['read','edit','write','submit_artifact']};
export class ArtifactContractError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ArtifactContractError';
    this.code = code;
  }
}
export class CheckpointRestoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CheckpointRestoreError';
    this.code = code;
  }
}
export interface AuditSink { append(event: FixAuditEvent): void; }

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const optionalString = (value: unknown): value is string => value === undefined || nonEmptyString(value);
const evidenceItem = (value: unknown): value is EvidenceItem => nonEmptyString(value) || (
  !!value && typeof value === 'object' && nonEmptyString((value as Record<string, unknown>).ref)
);
const evidenceList = (value: unknown): value is EvidenceItem[] => Array.isArray(value) && value.length > 0 && value.every(evidenceItem);
const stringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(nonEmptyString);
const isValidConclusion = (value: unknown): value is ArtifactConclusion => {
  if (!value || typeof value !== 'object') return false;
  const conclusion = value as Record<string, unknown>;
  return ['accepted', 'rejected', 'blocked', 'inconclusive', 'needs_more_evidence'].includes(String(conclusion.status)) && nonEmptyString(conclusion.summary);
};
const requireConclusion = (value: unknown): void => {
  if (value === undefined) throw new ArtifactContractError('MISSING_ARTIFACT_CONCLUSION', 'artifact.conclusion is required');
  if (!isValidConclusion(value)) throw new ArtifactContractError('INVALID_ARTIFACT_CONCLUSION', 'artifact.conclusion must contain a valid status and summary');
};
const isValidFinding = (value: unknown): value is Finding => {
  if (!value || typeof value !== 'object') return false;
  const finding = value as Record<string, unknown>;
  if (!nonEmptyString(finding.id) || !nonEmptyString(finding.summary)) return false;
  if (finding.severity !== undefined && !['info', 'warning', 'blocker'].includes(String(finding.severity))) return false;
  if (finding.check !== undefined && !nonEmptyString(finding.check)) return false;
  if (finding.disposition !== undefined && !['open', 'closed', 'accepted_with_note'].includes(String(finding.disposition))) return false;
  return true;
};
const findingList = (value: unknown): value is Finding[] => Array.isArray(value) && value.every(isValidFinding);

export function validateArtifactEnvelope(value: unknown, context?: ArtifactExecutionContext): asserts value is ArtifactEnvelope {
  if (!value || typeof value !== 'object') throw new ArtifactContractError('INVALID_ARTIFACT_ENVELOPE', 'artifact envelope must be an object');
  const envelope = value as Record<string, unknown>;
  if (envelope.schemaVersion !== 1) throw new ArtifactContractError('UNSUPPORTED_ARTIFACT_SCHEMA_VERSION', 'artifact.schemaVersion must be 1');
  if (!nonEmptyString(envelope.runId)) throw new ArtifactContractError('MISSING_ARTIFACT_RUN_ID', 'artifact.runId is required');
  if (!['worker', 'user_decision', 'controller'].includes(String(envelope.producerKind))) throw new ArtifactContractError('INVALID_ARTIFACT_PRODUCER_KIND', 'artifact.producerKind is invalid');
  if (!nonEmptyString(envelope.sourceVersion)) throw new ArtifactContractError('MISSING_ARTIFACT_SOURCE_VERSION', 'artifact.sourceVersion is required');
  if (!stringList(envelope.unverified)) throw new ArtifactContractError('INVALID_ARTIFACT_UNVERIFIED', 'artifact.unverified must be an array of non-empty strings');
  // evidence 缺省时不在此强校验：是否必须由业务校验器按 kind 决定（investigation/verification 强制，intake 等不要求）。
  // 显式声明为空数组仍是违规声明，必须拒绝。
  if (envelope.evidence !== undefined && !evidenceList(envelope.evidence)) throw new ArtifactContractError('MISSING_ARTIFACT_EVIDENCE', 'artifact.evidence must contain at least one evidence reference');
  if (envelope.conclusion !== undefined) {
    const conclusion = envelope.conclusion as Record<string, unknown>;
    if (!conclusion || typeof conclusion !== 'object' || !['accepted', 'rejected', 'blocked', 'inconclusive', 'needs_more_evidence'].includes(String(conclusion.status)) || !nonEmptyString(conclusion.summary)) {
      throw new ArtifactContractError('INVALID_ARTIFACT_CONCLUSION', 'artifact.conclusion must contain a valid status and summary');
    }
  }
  if (context?.requiresArtifactConclusion && envelope.conclusion === undefined) {
    throw new ArtifactContractError('MISSING_ARTIFACT_CONCLUSION', 'worker artifact.conclusion is required for this workflow');
  }
  if (envelope.producerKind === 'worker') {
    if (!nonEmptyString(envelope.nodeExecutionId)) throw new ArtifactContractError('MISSING_ARTIFACT_NODE_EXECUTION_ID', 'worker artifact.nodeExecutionId is required');
    if (!nonEmptyString(envelope.workerId)) throw new ArtifactContractError('MISSING_ARTIFACT_WORKER_ID', 'worker artifact.workerId is required');
  } else if (envelope.nodeExecutionId !== undefined || envelope.workerId !== undefined) {
    throw new ArtifactContractError('INVALID_NON_WORKER_PROVENANCE', 'only worker artifacts may identify nodeExecutionId or workerId');
  }
  if (!context) return;
  if (envelope.producerKind !== 'worker') throw new ArtifactContractError('INVALID_ARTIFACT_PRODUCER_FOR_WORKER_SUBMISSION', 'workers may submit only producerKind worker artifacts');
  if (envelope.runId !== context.runId) throw new ArtifactContractError('ARTIFACT_RUN_ID_MISMATCH', 'artifact.runId does not match the current run');
  if (envelope.nodeExecutionId !== context.nodeExecutionId) throw new ArtifactContractError('ARTIFACT_NODE_EXECUTION_ID_MISMATCH', 'artifact.nodeExecutionId does not match the current node execution');
  if (envelope.workerId !== context.workerId) throw new ArtifactContractError('ARTIFACT_WORKER_ID_MISMATCH', 'artifact.workerId does not match the current worker');
  if (envelope.sourceVersion !== context.sourceVersion) throw new ArtifactContractError('ARTIFACT_SOURCE_VERSION_MISMATCH', 'artifact.sourceVersion does not match the current source version');
  if (envelope.kind === 'verification' && context.requiresRepositoryChange === true && !nonEmptyString(envelope.candidateRevision)) {
    // candidateRevision 按 requiresRepositoryChange 区分：仓库变更路径必须绑定被验证的版本
    // （与 implementation 的一致性由 Runtime/Acceptance 控制面强制）；无仓库变更路径没有
    // implementation 可比对，允许省略。无 context 时无法判定路径，交由 Runtime/Acceptance 把关。
    throw new ArtifactContractError('MISSING_VERIFICATION_REVISION', 'verification.candidateRevision is required on a repository-change path (bind the verified implementation revision)');
  }
}

/** Validates business fields and, when present, the explicit provenance envelope. */
export function validateSubmitArtifact(value:unknown, context?: ArtifactExecutionContext):asserts value is Artifact {
  if (!value || typeof value !== 'object' || !nonEmptyString((value as any).kind)) {
    throw new ArtifactContractError('INVALID_KIND', 'artifact.kind must be a non-empty string');
  }
  const artifact = value as Record<string, unknown>;
  const envelopeFields = ['schemaVersion', 'runId', 'producerKind', 'sourceVersion', 'nodeExecutionId', 'workerId'];
  if (envelopeFields.some((field) => field in artifact)) validateArtifactEnvelope(artifact, context);
  if ('conclusion' in artifact && !isValidConclusion(artifact.conclusion)) {
    throw new ArtifactContractError('INVALID_ARTIFACT_CONCLUSION', 'artifact.conclusion must contain a valid status and summary');
  }
  if (artifact.kind === 'guard_rejection') {
    if (!nonEmptyString(artifact.error)) throw new ArtifactContractError('MISSING_GUARD_REJECTION_ERROR', 'guard_rejection.error is required');
    return;
  }
  if (artifact.kind === 'investigation') {
    if (!['local_fix', 'requirement_change', 'design_change', 'needs_more_evidence', 'blocked'].includes(String(artifact.route))) {
      throw new ArtifactContractError('INVALID_INVESTIGATION_ROUTE', 'investigation.route is invalid');
    }
    if (!nonEmptyString(artifact.rootCause)) throw new ArtifactContractError('MISSING_ROOT_CAUSE', 'investigation.rootCause is required');
    if (!evidenceList(artifact.evidence)) throw new ArtifactContractError('MISSING_INVESTIGATION_EVIDENCE', 'investigation.evidence must contain at least one non-empty item');
    return;
  }
  if (artifact.kind === 'implementation') {
    const details = artifact.artifact as Record<string, unknown> | undefined;
    if (!details || typeof details !== 'object') throw new ArtifactContractError('MISSING_IMPLEMENTATION_DETAILS', 'implementation.artifact is required');
    if (!nonEmptyString(details.summary)) throw new ArtifactContractError('MISSING_IMPLEMENTATION_SUMMARY', 'implementation.artifact.summary is required');
    if (!Array.isArray(details.filesChanged) || details.filesChanged.length === 0 || !details.filesChanged.every(nonEmptyString)) throw new ArtifactContractError('MISSING_FILES_CHANGED', 'implementation.artifact.filesChanged must contain at least one file');
    if (!nonEmptyString(details.candidateRevision)) throw new ArtifactContractError('MISSING_CANDIDATE_REVISION', 'implementation.artifact.candidateRevision is required');
    if (details.prUrl !== undefined && !nonEmptyString(details.prUrl)) throw new ArtifactContractError('INVALID_PR_URL', 'implementation.artifact.prUrl must be a non-empty string when provided');
    return;
  }
    if (artifact.kind === 'verification') {
    if (typeof artifact.accepted !== 'boolean') throw new ArtifactContractError('MISSING_VERIFICATION_DECISION', 'verification.accepted must be boolean');
    if (!evidenceList(artifact.evidence)) throw new ArtifactContractError('MISSING_VERIFICATION_EVIDENCE', 'verification.evidence must contain at least one non-empty item');
    // candidateRevision 按 requiresRepositoryChange 区分：仓库变更路径必须绑定被验证的
    // implementation 版本（一致性由 Runtime/Acceptance 控制面强制，版本一致率 100%）；
    // 无仓库变更路径没有 implementation 可比对，允许省略（声明了版本时不在此拒绝，
    // 跨 Artifact 矛盾由 Runtime 校验）。
    if (context?.requiresRepositoryChange === true && !nonEmptyString(artifact.candidateRevision)) throw new ArtifactContractError('MISSING_VERIFICATION_REVISION', 'verification.candidateRevision is required on a repository-change path (bind the verified implementation revision)');
    if (artifact.accepted === false) {
      // v2 工作流（requiresArtifactConclusion，校验上下文携带 requiresArtifactConclusion=true）下验证失败
      // 必须声明失败类别：契约强制 D4 三向路由的事实基础，禁止静默回 IMPLEMENTING。
      // legacy 定义（裸 Artifact 路径，validateSubmitArtifact 无上下文或上下文未声明的受控结论要求）
      // 不在此强制结构化 failure——accepted=false 的流向由 legacy 自己的 transition/guard 定义
      //（如 legacy fixDefinition 的 VERIFYING→IMPLEMENTING 只要求 accepted=false + 证据），
      // 不能把 v2 失败契约无条件套到 legacy 上。accepted=true 携带 failure 的自相矛盾仍是全局规则。
      if (context?.requiresArtifactConclusion === true) {
        if (!artifact.failure || typeof artifact.failure !== 'object') throw new ArtifactContractError('MISSING_VERIFICATION_FAILURE', 'verification.failure is required when accepted is false');
        const failure = artifact.failure as Record<string, unknown>;
        if (!['implementation', 'configuration', 'external_condition'].includes(String(failure.kind))) throw new ArtifactContractError('INVALID_VERIFICATION_FAILURE_KIND', 'verification.failure.kind is invalid');
        if (!nonEmptyString(failure.reason)) throw new ArtifactContractError('MISSING_VERIFICATION_FAILURE_REASON', 'verification.failure.reason is required');
        if (failure.responsibility !== undefined && !nonEmptyString(failure.responsibility)) throw new ArtifactContractError('INVALID_VERIFICATION_FAILURE_RESPONSIBILITY', 'verification.failure.responsibility must be a non-empty string when provided');
        if (failure.resolution !== undefined && !nonEmptyString(failure.resolution)) throw new ArtifactContractError('INVALID_VERIFICATION_FAILURE_RESOLUTION', 'verification.failure.resolution must be a non-empty string when provided');
      }
    } else if (artifact.failure !== undefined) {
      throw new ArtifactContractError('INVALID_VERIFICATION_FAILURE_ON_ACCEPTED', 'verification.failure must be absent when accepted is true');
    }
    return;
  }
  if (artifact.kind === 'intake') {
    // 新 Intake 契约为 summary/overview；旧 phenomenon 兼容字段已移除，携带即拒绝（不做静默降级）。
    if ('phenomenon' in artifact) throw new ArtifactContractError('INVALID_INTAKE_PHENOMENON', 'intake.phenomenon is removed; use summary/overview');
    if (!nonEmptyString(artifact.summary)) throw new ArtifactContractError('MISSING_INTAKE_SUMMARY', 'intake.summary is required');
    if (!nonEmptyString(artifact.overview)) throw new ArtifactContractError('MISSING_INTAKE_OVERVIEW', 'intake.overview is required');
    if (!optionalString(artifact.environment)) throw new ArtifactContractError('INVALID_INTAKE_ENVIRONMENT', 'intake.environment must be a non-empty string when provided');
    if (!optionalString(artifact.scope)) throw new ArtifactContractError('INVALID_INTAKE_SCOPE', 'intake.scope must be a non-empty string when provided');
    if (artifact.urgency !== undefined && !['low', 'medium', 'high', 'critical'].includes(String(artifact.urgency))) throw new ArtifactContractError('INVALID_INTAKE_URGENCY', 'intake.urgency is invalid');
    return;
  }
  if (artifact.kind === 'investigation_review') {
    if (!optionalString(artifact.targetArtifactId)) throw new ArtifactContractError('INVALID_INVESTIGATION_REVIEW_TARGET', 'investigation_review.targetArtifactId must be a non-empty string when provided');
    if (!nonEmptyString(artifact.rootCauseConclusion)) throw new ArtifactContractError('MISSING_INVESTIGATION_REVIEW_ROOT_CAUSE_CONCLUSION', 'investigation_review.rootCauseConclusion is required');
    if (!['sufficient', 'insufficient'].includes(String(artifact.evidenceSufficiency))) throw new ArtifactContractError('INVALID_INVESTIGATION_REVIEW_EVIDENCE_SUFFICIENCY', 'investigation_review.evidenceSufficiency is invalid');
    if (!stringList(artifact.gaps)) throw new ArtifactContractError('INVALID_INVESTIGATION_REVIEW_GAPS', 'investigation_review.gaps must be an array of non-empty strings');
    if (!optionalString(artifact.stopReason)) throw new ArtifactContractError('INVALID_INVESTIGATION_REVIEW_STOP_REASON', 'investigation_review.stopReason must be a non-empty string when provided');
    requireConclusion(artifact.conclusion);
    return;
  }
  if (artifact.kind === 'disposition') {
    if (!['remediation', 'mitigation', 'explanation', 'external_action', 'wait_decision', 'change_request', 'insufficient_evidence'].includes(String(artifact.dispositionType))) throw new ArtifactContractError('INVALID_DISPOSITION_TYPE', 'disposition.dispositionType is invalid');
    if (typeof artifact.requiresRepositoryChange !== 'boolean') throw new ArtifactContractError('INVALID_DISPOSITION_REQUIRES_REPOSITORY_CHANGE', 'disposition.requiresRepositoryChange must be boolean');
    if (artifact.requiresFormalPlanReview !== undefined && typeof artifact.requiresFormalPlanReview !== 'boolean') throw new ArtifactContractError('INVALID_DISPOSITION_REQUIRES_FORMAL_PLAN_REVIEW', 'disposition.requiresFormalPlanReview must be boolean when provided');
    if (!nonEmptyString(artifact.minimalScope)) throw new ArtifactContractError('MISSING_DISPOSITION_MINIMAL_SCOPE', 'disposition.minimalScope is required');
    if (!stringList(artifact.risks)) throw new ArtifactContractError('INVALID_DISPOSITION_RISKS', 'disposition.risks must be an array of non-empty strings');
    if (!nonEmptyString(artifact.verificationTarget)) throw new ArtifactContractError('MISSING_DISPOSITION_VERIFICATION_TARGET', 'disposition.verificationTarget is required');
    requireConclusion(artifact.conclusion);
    return;
  }
  if (artifact.kind === 'change_plan_review') {
    if (!optionalString(artifact.targetPlanRevision)) throw new ArtifactContractError('INVALID_CHANGE_PLAN_REVIEW_TARGET_REVISION', 'change_plan_review.targetPlanRevision must be a non-empty string when provided');
    if (typeof artifact.rootCauseAlignment !== 'boolean') throw new ArtifactContractError('INVALID_CHANGE_PLAN_REVIEW_ROOT_CAUSE_ALIGNMENT', 'change_plan_review.rootCauseAlignment must be boolean');
    if (!nonEmptyString(artifact.changedScope)) throw new ArtifactContractError('MISSING_CHANGE_PLAN_REVIEW_CHANGED_SCOPE', 'change_plan_review.changedScope is required');
    if (!stringList(artifact.risks)) throw new ArtifactContractError('INVALID_CHANGE_PLAN_REVIEW_RISKS', 'change_plan_review.risks must be an array of non-empty strings');
    if (!stringList(artifact.compatibility)) throw new ArtifactContractError('INVALID_CHANGE_PLAN_REVIEW_COMPATIBILITY', 'change_plan_review.compatibility must be an array of non-empty strings');
    if (!stringList(artifact.verification)) throw new ArtifactContractError('INVALID_CHANGE_PLAN_REVIEW_VERIFICATION', 'change_plan_review.verification must be an array of non-empty strings');
    if (!stringList(artifact.rollback)) throw new ArtifactContractError('INVALID_CHANGE_PLAN_REVIEW_ROLLBACK', 'change_plan_review.rollback must be an array of non-empty strings');
    if (!findingList(artifact.findings)) throw new ArtifactContractError('INVALID_CHANGE_PLAN_REVIEW_FINDINGS', 'change_plan_review.findings must be an array of valid findings');
    requireConclusion(artifact.conclusion);
    return;
  }
  if (artifact.kind === 'change_review') {
    if (!optionalString(artifact.reviewedRevision)) throw new ArtifactContractError('INVALID_CHANGE_REVIEW_REVISION', 'change_review.reviewedRevision must be a non-empty string when provided');
    if (!optionalString(artifact.prRef)) throw new ArtifactContractError('INVALID_CHANGE_REVIEW_PR_REF', 'change_review.prRef must be a non-empty string when provided');
    if (!findingList(artifact.findings)) throw new ArtifactContractError('INVALID_CHANGE_REVIEW_FINDINGS', 'change_review.findings must be an array of valid findings');
    if (!['all_closed', 'open'].includes(String(artifact.findingDisposition))) throw new ArtifactContractError('INVALID_CHANGE_REVIEW_FINDING_DISPOSITION', 'change_review.findingDisposition is invalid');
    requireConclusion(artifact.conclusion);
    return;
  }
  if (artifact.kind === 'user_decision') {
    // 决策值域与 Stage/Guard 一一对应；continue_verification 是配置类验证失败后的继续验证动作（只能回 VERIFYING）；
    // continue_disposition 是处置决定等待（disposition_decision）与外部动作完成等待（external_action_completion）
    // 的继续动作（由 Runtime decide 按等待种类路由回 DISPOSITION 或 VERIFYING）。
    if (!['approve', 'request_changes', 'reject', 'continue_investigating', 'continue_verification', 'continue_disposition'].includes(String(artifact.decision))) {
      throw new ArtifactContractError('INVALID_USER_DECISION', `user_decision.decision must be one of approve, request_changes, reject, continue_investigating, continue_verification, continue_disposition; got ${String(artifact.decision)}`);
    }
    if (!nonEmptyString(artifact.requestId)) throw new ArtifactContractError('MISSING_USER_DECISION_REQUEST_ID', 'user_decision.requestId is required');
    if (artifact.producerKind !== undefined && artifact.producerKind !== 'user_decision') throw new ArtifactContractError('INVALID_USER_DECISION_PRODUCER_KIND', 'user_decision.producerKind must be user_decision');
    return;
  }
  throw new ArtifactContractError('UNSUPPORTED_ARTIFACT_KIND', `unsupported artifact kind: ${String(artifact.kind)}`);
}
export interface UserDecisionGate { getDecision(requestId?:string):UserDecisionArtifact|undefined; }
export class InMemoryUserDecisionGate implements UserDecisionGate { private value?:UserDecisionArtifact; decide(v:UserDecisionArtifact){this.value=v;} getDecision(requestId?:string){if(!this.value || (this.value.requestId !== undefined && this.value.requestId!==requestId)) return undefined; const v=this.value; this.value=undefined; return v;} }
export interface CustomTool { name:string; description:string; parameters:{type:string;required:string[];properties:Record<string,unknown>}; execute(v:unknown):Artifact; }
export const SUBMIT_ARTIFACT_TOOL:CustomTool={name:'submit_artifact',description:'Submit a workflow artifact',parameters:{type:'object',required:['kind'],properties:{kind:{type:'string'}}},execute(v){validateSubmitArtifact(v);return v;}};
export interface PiSession { prompt(task:unknown):Promise<void>; }
export interface PiSessionRequest {tools:string[];skills:string[];context:string[];customTools:CustomTool[];}
export interface PiWorkerFactory {createAgentSession(r:PiSessionRequest):Promise<PiSession>;}
