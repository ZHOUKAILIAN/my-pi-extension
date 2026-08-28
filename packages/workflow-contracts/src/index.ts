export type Stage = 'INVESTIGATING'|'IMPLEMENTING'|'VERIFYING'|'ACCEPTED'|'BLOCKED'|'WAITING_FOR_USER';
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
  conclusion: ArtifactConclusion;
}
export interface ArtifactExecutionContext {
  schemaVersion: 1;
  runId: string;
  nodeExecutionId: string;
  workerId: string;
  sourceVersion: string;
}

export interface InvestigationArtifact { kind:'investigation'; route:InvestigationRoute; rootCause:string; evidence:EvidenceItem[]; id?:string; [key:string]:unknown }
export interface ImplementationDetails { summary:string; filesChanged:string[]; candidateRevision:string; prUrl?:string; }
export interface ImplementationArtifact { kind:'implementation'; artifact:ImplementationDetails; id?:string; [key:string]:unknown }
export interface VerificationArtifact { kind:'verification'; accepted:boolean; evidence:EvidenceItem[]; candidateRevision:string; id?:string; [key:string]:unknown }
export interface UserDecisionArtifact { kind:'user_decision'; decision:'continue_investigating'; requestId:string; producerKind?:'user_decision'; schemaVersion?:1; runId?:string; sourceVersion?:string; evidence?:EvidenceItem[]; unverified?:string[]; conclusion?:ArtifactConclusion; [key:string]:unknown }
export interface GuardRejectionArtifact { kind:'guard_rejection'; error:string; [key:string]:unknown }
export type WorkerArtifact = (InvestigationArtifact|ImplementationArtifact|VerificationArtifact) & WorkerArtifactEnvelope;
export type Artifact = InvestigationArtifact|ImplementationArtifact|VerificationArtifact|UserDecisionArtifact|GuardRejectionArtifact|WorkerArtifact;
export type Capsule = Record<string, unknown>;
export interface WorkerExecutor { readonly workerId?: string; execute(node: NodeDefinition, task: unknown, capsule: Capsule): Promise<Artifact>; }
export interface NodeDefinition { id: string; worker?: WorkerExecutor; profile?: WorkerProfile; }
export interface Checkpoint { runId:string; stage:Stage; at:number; id:string; problem?:string; artifactRefs?:string[]; artifacts?:Artifact[]; pendingDecisionRequest?:string; decisionReference?:string; }
export interface RunStore { saveCheckpoint(c:Checkpoint):void; loadLast(runId:string):Checkpoint|undefined; }
export interface WorkflowDefinition { id:string; initialStage:Stage; nodes?: Record<string, NodeDefinition>; guard(from:Stage,to:Stage,artifact?:Artifact):void; transition(from:Stage,to:Stage,artifact?:Artifact):Stage; }
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

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const evidenceItem = (value: unknown): value is EvidenceItem => nonEmptyString(value) || (
  !!value && typeof value === 'object' && nonEmptyString((value as Record<string, unknown>).ref)
);
const evidenceList = (value: unknown): value is EvidenceItem[] => Array.isArray(value) && value.length > 0 && value.every(evidenceItem);
const stringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(nonEmptyString);

export function validateArtifactEnvelope(value: unknown, context?: ArtifactExecutionContext): asserts value is ArtifactEnvelope {
  if (!value || typeof value !== 'object') throw new ArtifactContractError('INVALID_ARTIFACT_ENVELOPE', 'artifact envelope must be an object');
  const envelope = value as Record<string, unknown>;
  if (envelope.schemaVersion !== 1) throw new ArtifactContractError('UNSUPPORTED_ARTIFACT_SCHEMA_VERSION', 'artifact.schemaVersion must be 1');
  if (!nonEmptyString(envelope.runId)) throw new ArtifactContractError('MISSING_ARTIFACT_RUN_ID', 'artifact.runId is required');
  if (!['worker', 'user_decision', 'controller'].includes(String(envelope.producerKind))) throw new ArtifactContractError('INVALID_ARTIFACT_PRODUCER_KIND', 'artifact.producerKind is invalid');
  if (!nonEmptyString(envelope.sourceVersion)) throw new ArtifactContractError('MISSING_ARTIFACT_SOURCE_VERSION', 'artifact.sourceVersion is required');
  if (!stringList(envelope.unverified)) throw new ArtifactContractError('INVALID_ARTIFACT_UNVERIFIED', 'artifact.unverified must be an array of non-empty strings');
  if (!evidenceList(envelope.evidence)) throw new ArtifactContractError('MISSING_ARTIFACT_EVIDENCE', 'artifact.evidence must contain at least one evidence reference');
  if (envelope.conclusion !== undefined) {
    const conclusion = envelope.conclusion as Record<string, unknown>;
    if (!conclusion || typeof conclusion !== 'object' || !['accepted', 'rejected', 'blocked', 'inconclusive', 'needs_more_evidence'].includes(String(conclusion.status)) || !nonEmptyString(conclusion.summary)) {
      throw new ArtifactContractError('INVALID_ARTIFACT_CONCLUSION', 'artifact.conclusion must contain a valid status and summary');
    }
  }
  if (envelope.producerKind === 'worker') {
    if (!nonEmptyString(envelope.nodeExecutionId)) throw new ArtifactContractError('MISSING_ARTIFACT_NODE_EXECUTION_ID', 'worker artifact.nodeExecutionId is required');
    if (!nonEmptyString(envelope.workerId)) throw new ArtifactContractError('MISSING_ARTIFACT_WORKER_ID', 'worker artifact.workerId is required');
    if (envelope.conclusion === undefined) throw new ArtifactContractError('MISSING_ARTIFACT_CONCLUSION', 'worker artifact.conclusion is required');
  } else if (envelope.nodeExecutionId !== undefined || envelope.workerId !== undefined) {
    throw new ArtifactContractError('INVALID_NON_WORKER_PROVENANCE', 'only worker artifacts may identify nodeExecutionId or workerId');
  }
  if (!context) return;
  if (envelope.producerKind !== 'worker') throw new ArtifactContractError('INVALID_ARTIFACT_PRODUCER_FOR_WORKER_SUBMISSION', 'workers may submit only producerKind worker artifacts');
  if (envelope.runId !== context.runId) throw new ArtifactContractError('ARTIFACT_RUN_ID_MISMATCH', 'artifact.runId does not match the current run');
  if (envelope.nodeExecutionId !== context.nodeExecutionId) throw new ArtifactContractError('ARTIFACT_NODE_EXECUTION_ID_MISMATCH', 'artifact.nodeExecutionId does not match the current node execution');
  if (envelope.workerId !== context.workerId) throw new ArtifactContractError('ARTIFACT_WORKER_ID_MISMATCH', 'artifact.workerId does not match the current worker');
  if (envelope.sourceVersion !== context.sourceVersion) throw new ArtifactContractError('ARTIFACT_SOURCE_VERSION_MISMATCH', 'artifact.sourceVersion does not match the current source version');
}

/** Validates business fields and, when present, the explicit provenance envelope. */
export function validateSubmitArtifact(value:unknown, context?: ArtifactExecutionContext):asserts value is Artifact {
  if (!value || typeof value !== 'object' || !nonEmptyString((value as any).kind)) {
    throw new ArtifactContractError('INVALID_KIND', 'artifact.kind must be a non-empty string');
  }
  const artifact = value as Record<string, unknown>;
  const envelopeFields = ['schemaVersion', 'runId', 'producerKind', 'sourceVersion', 'unverified', 'nodeExecutionId', 'workerId', 'conclusion'];
  if (envelopeFields.some((field) => field in artifact)) validateArtifactEnvelope(artifact, context);
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
    if (!nonEmptyString(artifact.candidateRevision)) throw new ArtifactContractError('MISSING_VERIFICATION_REVISION', 'verification.candidateRevision is required');
    return;
  }
  if (artifact.kind === 'user_decision') {
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
