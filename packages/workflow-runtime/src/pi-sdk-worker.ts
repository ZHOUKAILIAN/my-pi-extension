import { createAgentSession, SessionManager, DefaultResourceLoader, getAgentDir, type ToolDefinition, type ResourceLoader } from '@earendil-works/pi-coding-agent';
import type { Artifact, NodeDefinition, WorkerExecutor, Capsule } from '@pi/workflow-contracts';
import { validateSubmitArtifact } from '@pi/workflow-contracts';

// Keep the schema dependency-free: Pi validates this JSON Schema-shaped object at
// the SDK boundary, while validateSubmitArtifact remains the Runtime authority.
const artifactSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['investigation', 'implementation', 'verification'] },
    route: { type: 'string', enum: ['local_fix', 'requirement_change', 'design_change', 'needs_more_evidence', 'blocked'] },
    accepted: { type: 'boolean' },
    evidence: { type: 'array', items: { type: 'string' } },
    artifact: {},
  },
  required: ['kind'],
  additionalProperties: true,
} as any;

function submissionContract(nodeId: string): string {
  switch (nodeId) {
    case 'investigate':
      return "Call submit_artifact exactly once with {kind:'investigation', route:'local_fix'|'requirement_change'|'design_change'|'needs_more_evidence'|'blocked', evidence:string[]}.";
    case 'implement':
      return "Call submit_artifact exactly once with {kind:'implementation', artifact:any}.";
    case 'verify':
      return "Call submit_artifact exactly once with {kind:'verification', accepted:boolean, evidence:string[]}.";
    default:
      return 'Call submit_artifact exactly once with the valid structured artifact for this workflow node.';
  }
}

function workerPrompt(node: NodeDefinition, task: unknown, capsule: Capsule, retry = false): string {
  const retryInstruction = retry
    ? '\nYour previous response did not call submit_artifact. Do not answer with ordinary text. Call submit_artifact now.'
    : '';
  return [
    'You are executing one controlled workflow node.',
    submissionContract(node.id),
    'A text response is not a completion. Submit the structured artifact through the tool, then stop.',
    `TASK:\n${String(task)}`,
    `CAPSULE:\n${JSON.stringify(capsule)}`,
    retryInstruction,
  ].join('\n');
}

/** 真实 SDK adapter；model/factory 显式注入，避免无模型时误调用 prompt。 */
export class PiSdkWorkerExecutor implements WorkerExecutor {
  private readonly options: {
    model?: unknown;
    thinkingLevel?: unknown;
    skills?: string[];
    cwd?: string;
    createSession?: typeof createAgentSession;
    resourceLoader?: ResourceLoader;
  };

  constructor(options: {
    model?: unknown;
    thinkingLevel?: unknown;
    skills?: string[];
    cwd?: string;
    createSession?: typeof createAgentSession;
    resourceLoader?: ResourceLoader;
  } = {}) {
    this.options = options;
  }

  async execute(node: NodeDefinition, task: unknown, capsule: Capsule): Promise<Artifact> {
    let captured: Artifact | undefined;
    const submit: ToolDefinition = {
      name: 'submit_artifact',
      label: 'submit_artifact',
      description: 'Submit the required structured workflow artifact. Ordinary text is not accepted as completion.',
      parameters: artifactSchema,
      execute: async (_id, params) => {
        validateSubmitArtifact(params);
        captured = params;
        return { content: [{ type: 'text', text: 'captured' }], details: {} };
      },
    };

    const requestedSkills = this.options.skills ?? node.profile?.skills ?? [];
    const loader = this.options.resourceLoader ?? new DefaultResourceLoader({
      cwd: this.options.cwd ?? process.cwd(),
      agentDir: getAgentDir(),
      // Worker 只能看到当前 Node 明确允许的 skill，不能继承主 Session 的全部 skill。
      skillsOverride: (base) => {
        const available = new Map(base.skills.map((skill) => [skill.name, skill]));
        const missing = requestedSkills.filter((name) => !available.has(name));
        if (missing.length) throw Error(`unknown node skill: ${missing.join(', ')}`);
        return { ...base, skills: requestedSkills.map((name) => available.get(name)!) };
      },
      agentsFilesOverride: () => ({ agentsFiles: [] }),
    });
    await loader.reload();

    const scopedSkills = () => {
      const availableSkills = typeof loader.getSkills === 'function'
        ? loader.getSkills()
        : { skills: [], diagnostics: [] };
      const availableByName = new Map(availableSkills.skills.map((skill) => [skill.name, skill]));
      const missing = requestedSkills.filter((name) => !availableByName.has(name));
      if (missing.length) throw Error(`unknown node skill: ${missing.join(', ')}`);
      return {
        ...availableSkills,
        skills: requestedSkills.map((name) => availableByName.get(name)!),
      };
    };
    scopedSkills();
    // 即使 reload 后 catalogue 变化，session 也只看到当前 Node allowlist 中仍可解析的 skill。
    const scopedLoader = new Proxy(loader, {
      get(target, property) {
        if (property === 'getSkills') return scopedSkills;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as ResourceLoader;

    const create = this.options.createSession ?? createAgentSession;
    if (!this.options.model && !this.options.createSession) throw Error('model must be explicitly configured');
    const { session } = await create({
      tools: node.profile?.tools ?? [],
      customTools: [submit],
      resourceLoader: scopedLoader,
      sessionManager: SessionManager.inMemory(),
      ...(this.options.model ? { model: this.options.model as any } : {}),
      ...(this.options.thinkingLevel !== undefined ? { thinkingLevel: this.options.thinkingLevel } : {}),
    } as any);

    await session.prompt(workerPrompt(node, task, capsule));
    if (!captured) await session.prompt(workerPrompt(node, task, capsule, true));
    if (!captured) throw Error('worker did not submit artifact');
    return captured;
  }
}
