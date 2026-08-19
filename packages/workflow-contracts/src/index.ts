export type Stage = 'INVESTIGATING'|'IMPLEMENTING'|'VERIFYING'|'ACCEPTED'|'BLOCKED'|'WAITING_FOR_USER';
export interface InvestigationArtifact { kind:'investigation'; route:'local_fix'|'requirement_change'|'design_change'|'needs_more_evidence'|'blocked'; evidence:string[]; id?:string; [key:string]:unknown }
export interface ImplementationArtifact { kind:'implementation'; artifact?:unknown; id?:string; [key:string]:unknown }
export interface VerificationArtifact { kind:'verification'; accepted:boolean; evidence:string[]; id?:string; [key:string]:unknown }
export interface UserDecisionArtifact { kind:'user_decision'; decision:'continue_investigating'; requestId:string; [key:string]:unknown }
export interface GuardRejectionArtifact { kind:'guard_rejection'; error:string; [key:string]:unknown }
export type Artifact = InvestigationArtifact|ImplementationArtifact|VerificationArtifact|UserDecisionArtifact|GuardRejectionArtifact;
export type Capsule = Record<string, unknown>;
export interface WorkerExecutor { execute(node: NodeDefinition, task: unknown, capsule: Capsule): Promise<Artifact>; }
export interface NodeDefinition { id: string; worker?: WorkerExecutor; profile?: WorkerProfile; }
export interface Checkpoint { runId:string; stage:Stage; at:number; id:string; problem?:string; artifactRefs?:string[]; pendingDecisionRequest?:string; decisionReference?:string; }
export interface RunStore { saveCheckpoint(c:Checkpoint):void; loadLast(runId:string):Checkpoint|undefined; }
export interface WorkflowDefinition { id:string; initialStage:Stage; nodes?: Record<string, NodeDefinition>; guard(from:Stage,to:Stage,artifact?:Artifact):void; transition(from:Stage,to:Stage,artifact?:Artifact):Stage; }
export interface WorkerProfile { tools:string[]; skills?:string[]; context?:string[]; }
export const INVESTIGATE_PROFILE:WorkerProfile={tools:['read','submit_artifact'],skills:[],context:[]}; export const IMPLEMENT_PROFILE:WorkerProfile={tools:['read','edit','write','submit_artifact']};
export function validateSubmitArtifact(value:unknown):asserts value is Artifact { if(!value||typeof value!=='object'||typeof (value as any).kind!=='string') throw new Error('invalid submit_artifact schema'); }
export interface UserDecisionGate { getDecision(requestId?:string):UserDecisionArtifact|undefined; }
export class InMemoryUserDecisionGate implements UserDecisionGate { private value?:UserDecisionArtifact; decide(v:UserDecisionArtifact){this.value=v;} getDecision(requestId?:string){if(!this.value || (this.value.requestId !== undefined && this.value.requestId!==requestId)) return undefined; const v=this.value; this.value=undefined; return v;} }
export interface CustomTool { name:string; description:string; parameters:{type:string;required:string[];properties:Record<string,unknown>}; execute(v:unknown):Artifact; }
export const SUBMIT_ARTIFACT_TOOL:CustomTool={name:'submit_artifact',description:'Submit a workflow artifact',parameters:{type:'object',required:['kind'],properties:{kind:{type:'string'}}},execute(v){validateSubmitArtifact(v);return v;}};
export interface PiSession { prompt(task:unknown):Promise<void>; }
export interface PiSessionRequest {tools:string[];skills:string[];context:string[];customTools:CustomTool[];}
export interface PiWorkerFactory {createAgentSession(r:PiSessionRequest):Promise<PiSession>;}
