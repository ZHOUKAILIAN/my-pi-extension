import type {
  Artifact,
  NodeDefinition,
  RunStore,
  Stage,
  WorkflowDefinition,
  UserDecisionGate,
  WorkerExecutor,
} from '@pi/workflow-contracts';

export * from '@pi/workflow-contracts';
export * from './pi-session-store.ts';
export * from './pi-sdk-worker.ts';

export const bugFixNodes = (worker: WorkerExecutor): Record<string, NodeDefinition> => ({
  investigate: { id: 'investigate', worker, profile: { tools: ['read', 'submit_artifact'] } },
  implement: { id: 'implement', worker, profile: { tools: ['read', 'edit', 'write', 'submit_artifact'] } },
  verify: { id: 'verify', worker, profile: { tools: ['read', 'submit_artifact'] } },
});

export const bugFixDefinition: WorkflowDefinition = {
  nodes: {},
  id: 'bugFix',
  initialStage: 'INVESTIGATING',
  guard(from, to, artifact) {
    const allowed: Record<Stage, Stage[]> = {
      INVESTIGATING: ['INVESTIGATING', 'IMPLEMENTING', 'BLOCKED', 'WAITING_FOR_USER'],
      IMPLEMENTING: ['VERIFYING', 'BLOCKED'],
      VERIFYING: ['ACCEPTED', 'IMPLEMENTING', 'BLOCKED'],
      BLOCKED: ['INVESTIGATING'],
      WAITING_FOR_USER: ['INVESTIGATING'],
      ACCEPTED: [],
    };
    // Guard 是状态机的越权边界：worker 只能提交事实，不能自行指定下一状态。
    if (!allowed[from]?.includes(to)) throw Error(`invalid transition ${from} -> ${to}`);
    if (to === 'IMPLEMENTING' && from === 'INVESTIGATING' && (!artifact || artifact.kind !== 'investigation' || artifact.route !== 'local_fix' || !artifact.evidence.length)) throw Error('invalid evidence');
    if (to === 'IMPLEMENTING' && from === 'VERIFYING' && (!artifact || artifact.kind !== 'verification' || artifact.accepted !== false || !artifact.evidence.length)) throw Error('invalid verification evidence');
    if (to === 'WAITING_FOR_USER' && (!artifact || artifact.kind !== 'investigation' || !['requirement_change', 'design_change'].includes(artifact.route) || !artifact.evidence.length)) throw Error('invalid investigation evidence');
    if (to === 'BLOCKED' && (!artifact || (artifact.kind !== 'investigation' && artifact.kind !== 'guard_rejection'))) throw Error('invalid block evidence');
    if (to === 'INVESTIGATING' && from === 'BLOCKED' && (!artifact || artifact.kind !== 'investigation' || !artifact.evidence.length)) throw Error('invalid investigation evidence');
    if (to === 'ACCEPTED' && (!artifact || artifact.kind !== 'verification' || artifact.accepted !== true || !artifact.evidence.length)) throw Error('invalid acceptance evidence');
  },
  transition(from, to, artifact) {
    this.guard(from, to, artifact);
    return to;
  },
};

export class WorkflowRuntime {
  stage: Stage;
  private readonly clock: () => number;
  private readonly idGen: () => string;
  private gate?: UserDecisionGate;
  private pendingDecision?: string;
  private problem?: string;
  readonly definition: WorkflowDefinition;
  readonly store: RunStore;
  readonly runId: string;

  constructor(definition: WorkflowDefinition, store: RunStore, runId = 'run-1', clock = () => Date.now(), idGen = () => `${runId}-${clock()}`) {
    this.definition = definition;
    this.store = store;
    this.runId = runId;
    this.stage = definition.initialStage;
    this.clock = clock;
    this.idGen = idGen;
  }

  setDecisionGate(gate: UserDecisionGate) { this.gate = gate; }

  resume() {
    if (this.stage !== 'WAITING_FOR_USER') return;
    const decision = this.gate?.getDecision(this.pendingDecision);
    if (!decision) throw Error('user decision required');
    this.pendingDecision = undefined;
    this.transition('INVESTIGATING', decision);
  }

  transition(to: Stage, artifact?: Artifact) {
    this.stage = this.definition.transition(this.stage, to, artifact);
    if (to === 'WAITING_FOR_USER') this.pendingDecision = `${this.runId}:${this.idGen()}`;
    this.store.saveCheckpoint({
      runId: this.runId,
      stage: this.stage,
      at: this.clock(),
      id: this.idGen(),
      problem: this.problem,
      pendingDecisionRequest: this.pendingDecision,
      decisionReference: artifact?.kind === 'user_decision' ? String(artifact.requestId) : undefined,
      artifactRefs: artifact ? [String(artifact.id ?? artifact.kind)] : undefined,
    });
  }

  async runNode(node: NodeDefinition, task: unknown, capsule: Record<string, unknown> = {}) {
    if (typeof task === 'string') this.problem = task;
    if (!node.worker) {
      // 没有 worker 时不执行模型，避免命令看似成功却产生不可追溯副作用。
      throw Error('node worker required');
    }
    const artifact = await node.worker.execute(node, task, capsule);
    if (this.stage === 'INVESTIGATING' && artifact.kind === 'investigation') {
      if (artifact.route === 'local_fix') this.transition('IMPLEMENTING', artifact);
      else if (artifact.route === 'requirement_change' || artifact.route === 'design_change') this.transition('WAITING_FOR_USER', artifact);
      else if (artifact.route === 'needs_more_evidence' || artifact.route === 'blocked') this.transition('BLOCKED', artifact);
      else throw Error('invalid investigation route');
    } else if (this.stage === 'IMPLEMENTING' && artifact.kind === 'implementation') {
      this.transition('VERIFYING', artifact);
    } else if (this.stage === 'VERIFYING' && artifact.kind === 'verification') {
      // 验证失败仍保留实现阶段，允许下一轮实现和验证。
      this.transition(artifact.accepted ? 'ACCEPTED' : 'IMPLEMENTING', artifact);
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

  static restore(definition: WorkflowDefinition, store: RunStore, runId = 'run-1') {
    const checkpoint = store.loadLast(runId);
    if (checkpoint && !['INVESTIGATING', 'IMPLEMENTING', 'VERIFYING', 'ACCEPTED', 'BLOCKED', 'WAITING_FOR_USER'].includes(checkpoint.stage)) throw Error('checkpoint stage is not in definition');
    const runtime = new WorkflowRuntime(definition, store, runId);
    if (checkpoint) {
      runtime.stage = checkpoint.stage;
      runtime.problem = checkpoint.problem;
      runtime.pendingDecision = checkpoint.pendingDecisionRequest;
    }
    return runtime;
  }
}
