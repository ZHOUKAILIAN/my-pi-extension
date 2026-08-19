import { createAgentSession, SessionManager, DefaultResourceLoader, getAgentDir, type ToolDefinition, type ResourceLoader } from '@earendil-works/pi-coding-agent';
import type { Artifact, NodeDefinition, WorkerExecutor, Capsule } from '@pi/workflow-contracts';
import { validateSubmitArtifact } from '@pi/workflow-contracts';

/** 真实 SDK adapter；model/factory 显式注入，避免无模型时误调用 prompt。 */
export class PiSdkWorkerExecutor implements WorkerExecutor {
  private readonly options: { model?: unknown; createSession?: typeof createAgentSession; resourceLoader?: ResourceLoader };
  constructor(options: { model?: unknown; createSession?: typeof createAgentSession; resourceLoader?: ResourceLoader } = {}) { this.options=options; }
  async execute(node:NodeDefinition, task:unknown, capsule:Capsule):Promise<Artifact> {
    let captured: Artifact|undefined;
    const submit: ToolDefinition = { name:'submit_artifact', label:'submit_artifact', description:'Submit workflow artifact', parameters:{type:'object',properties:{kind:{type:'string'}},required:['kind']}, execute: async (_id, params) => { validateSubmitArtifact(params); captured=params; return {content:[{type:'text',text:'captured'}],details:{}}; } } as ToolDefinition;
    const profile=node.profile;
    // skillsOverride 清空全局 skills；工具 allowlist 不含 bash 时仅是工具层只读，不是 OS sandbox。
    const loader=this.options.resourceLoader ?? new DefaultResourceLoader({cwd:process.cwd(),agentDir:getAgentDir(),skillsOverride:()=>({skills:[],diagnostics:[]}),agentsFilesOverride:()=>({agentsFiles:[]})});
    await loader.reload();
    const create=this.options.createSession ?? createAgentSession;
    if (!this.options.model && !this.options.createSession) throw Error('model must be explicitly configured');
    const {session}=await create({tools:profile?.tools??[],customTools:[submit],resourceLoader:loader,sessionManager:SessionManager.inMemory(),...(this.options.model ? {model:this.options.model as any} : {})} as any);
    // artifact capture 只认 submit_artifact，普通文本不能推进状态。
    await session.prompt(`${String(task)}\nCAPSULE:${JSON.stringify(capsule)}`);
    if(!captured) throw Error('worker did not submit artifact'); return captured;
  }
}
