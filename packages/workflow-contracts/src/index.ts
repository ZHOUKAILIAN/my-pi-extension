export type Stage = 'INVESTIGATING'|'IMPLEMENTING'|'VERIFYING'|'ACCEPTED'|'BLOCKED'|'WAITING_FOR_USER';
export type InvestigationRoute = 'local_fix'|'requirement_change'|'design_change'|'needs_more_evidence'|'blocked';
export interface InvestigationArtifact { kind:'investigation'; route:InvestigationRoute; rootCause:string; evidence:string[]; id?:string; [key:string]:unknown }
export interface ImplementationDetails { summary:string; filesChanged:string[]; candidateRevision:string; prUrl?:string; }
export interface ImplementationArtifact { kind:'implementation'; artifact:ImplementationDetails; id?:string; [key:string]:unknown }
export interface VerificationArtifact { kind:'verification'; accepted:boolean; evidence:string[]; candidateRevision:string; id?:string; [key:string]:unknown }
export interface UserDecisionArtifact { kind:'user_decision'; decision:'continue_investigating'; requestId:string; [key:string]:unknown }
export interface GuardRejectionArtifact { kind:'guard_rejection'; error:string; [key:string]:unknown }
export type Artifact = InvestigationArtifact|ImplementationArtifact|VerificationArtifact|UserDecisionArtifact|GuardRejectionArtifact;
export type Capsule = Record<string, unknown>;
export interface WorkerExecutor { execute(node: NodeDefinition, task: unknown, capsule: Capsule): Promise<Artifact>; }
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
const evidenceList = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every(nonEmptyString);

export function validateSubmitArtifact(value:unknown):asserts value is Artifact {
  if (!value || typeof value !== 'object' || !nonEmptyString((value as any).kind)) {
    throw new ArtifactContractError('INVALID_KIND', 'artifact.kind must be a non-empty string');
  }
  const artifact = value as Record<string, unknown>;
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
    if (!evidenceList(details.filesChanged)) throw new ArtifactContractError('MISSING_FILES_CHANGED', 'implementation.artifact.filesChanged must contain at least one file');
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
  throw new ArtifactContractError('UNSUPPORTED_ARTIFACT_KIND', `unsupported artifact kind: ${String(artifact.kind)}`);
}
export interface UserDecisionGate { getDecision(requestId?:string):UserDecisionArtifact|undefined; }
export class InMemoryUserDecisionGate implements UserDecisionGate { private value?:UserDecisionArtifact; decide(v:UserDecisionArtifact){this.value=v;} getDecision(requestId?:string){if(!this.value || (this.value.requestId !== undefined && this.value.requestId!==requestId)) return undefined; const v=this.value; this.value=undefined; return v;} }
export interface CustomTool { name:string; description:string; parameters:{type:string;required:string[];properties:Record<string,unknown>}; execute(v:unknown):Artifact; }
export const SUBMIT_ARTIFACT_TOOL:CustomTool={name:'submit_artifact',description:'Submit a workflow artifact',parameters:{type:'object',required:['kind'],properties:{kind:{type:'string'}}},execute(v){validateSubmitArtifact(v);return v;}};
export interface PiSession { prompt(task:unknown):Promise<void>; }
export interface PiSessionRequest {tools:string[];skills:string[];context:string[];customTools:CustomTool[];}
export interface PiWorkerFactory {createAgentSession(r:PiSessionRequest):Promise<PiSession>;}
