import { randomUUID } from 'node:crypto';
import { RunControlWal, RunControlWalError } from './run-control-wal.ts';

export type WorkerStatus = 'starting' | 'streaming' | 'idle' | 'settled' | 'failed';
export type SupplementState = 'recorded' | 'enqueue_accepted' | 'model_call_completed' | 'artifact_bound' | 'delivery_failed' | 'rejected_after_fence';
export type ModelChangeState = 'requested' | 'pending' | 'applied' | 'not_applied' | 'failed';

export interface WorkerSessionLike {
  readonly sessionId?: string;
  readonly isStreaming?: boolean;
  readonly isIdle?: boolean;
  readonly model?: { provider: string; id: string };
  steer(text: string, images?: any[]): Promise<void>;
  prompt(text: string, options?: { streamingBehavior?: 'steer' | 'followUp'; source?: 'extension' }): Promise<void>;
  setModel?(model: any, options?: { persist?: boolean }): Promise<void>;
  subscribe?(listener: (event: any) => void): () => void;
  dispose?(): void;
}

export interface ActiveWorkerHandle {
  runId: string;
  parentSessionId: string;
  parentLeafId: string;
  nodeExecutionId: string;
  workerId: string;
  workerSessionId: string;
  attemptId: string;
  actualModel: { provider: string; id: string };
  status: WorkerStatus;
  contextSupplementVersion: number;
  closeFenceSequence?: number;
  session: WorkerSessionLike;
  wal: RunControlWal;
  /** Called when the executor receives a new validated artifact revision. */
  onArtifact?: (artifact: unknown) => void;
  /** Called when the child has begun an effective model call. */
  onModelCall?: (ref: string) => void;
}

export interface SupplementResult {
  submissionAttemptId: string;
  supplementId?: string;
  sequence?: number;
  state: SupplementState;
  error?: string;
}

export interface ModelChangeResult {
  requestId: string;
  state: ModelChangeState;
  actualModel?: { provider: string; id: string };
  error?: string;
}

const ownerKey = (parentSessionId: string, parentLeafId: string, runId: string) => `${parentSessionId}\0${parentLeafId}\0${runId}`;

/**
 * Process-local index of the one Worker that may receive foreground input.
 * It deliberately does not own Workflow stage or Artifact state.
 */
export class ActiveWorkerRegistry {
  private readonly workers = new Map<string, ActiveWorkerHandle>();
  private readonly byRun = new Map<string, string>();
  private readonly listeners = new Set<(event: Record<string, unknown>) => void>();

  register(handle: ActiveWorkerHandle) {
    const key = ownerKey(handle.parentSessionId, handle.parentLeafId, handle.runId);
    const existingKey = this.byRun.get(handle.runId);
    const previous = existingKey ? this.workers.get(existingKey) : this.workers.get(key);
    if (previous && (existingKey !== key || previous.workerSessionId !== handle.workerSessionId)) {
      throw new RunControlWalError('ACTIVE_WORKER_ALREADY_PUBLISHED', `run ${handle.runId} already has a foreground Worker`);
    }
    this.workers.set(key, handle);
    this.byRun.set(handle.runId, key);
    this.emit({ type: 'worker_published', runId: handle.runId, nodeExecutionId: handle.nodeExecutionId, workerSessionId: handle.workerSessionId, workerId: handle.workerId, model: handle.actualModel });
  }

  get(runId: string, expectedNodeExecutionId?: string): ActiveWorkerHandle | undefined {
    const key = this.byRun.get(runId);
    const handle = key === undefined ? undefined : this.workers.get(key);
    if (!handle || (expectedNodeExecutionId !== undefined && handle.nodeExecutionId !== expectedNodeExecutionId)) return undefined;
    return handle;
  }

  getForParent(parentSessionId: string, parentLeafId: string): ActiveWorkerHandle | undefined {
    const candidates = [...this.workers.values()].filter((worker) => worker.parentSessionId === parentSessionId && worker.parentLeafId === parentLeafId);
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  countForParent(parentSessionId: string, parentLeafId: string) {
    return [...this.workers.values()].filter((worker) => worker.parentSessionId === parentSessionId && worker.parentLeafId === parentLeafId).length;
  }

  hasActiveForParent(parentSessionId: string, parentLeafId: string) {
    return this.countForParent(parentSessionId, parentLeafId) > 0;
  }

  unregister(runId: string, workerSessionId?: string) {
    const key = this.byRun.get(runId);
    if (key === undefined) return;
    const current = this.workers.get(key);
    if (current && workerSessionId !== undefined && current.workerSessionId !== workerSessionId) return;
    this.workers.delete(key);
    this.byRun.delete(runId);
    this.emit({ type: 'worker_unpublished', runId, workerSessionId: current?.workerSessionId });
  }

  subscribe(listener: (event: Record<string, unknown>) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(event: Record<string, unknown>) { for (const listener of this.listeners) { try { listener(event); } catch { /* projection is never a control dependency */ } } }
  all() { return [...this.workers.values()]; }
}

class SerialQueue {
  private tail = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation, operation);
    this.tail = next.then(() => undefined, () => undefined);
    return next;
  }
}

export interface ModelCandidate {
  ref: string;
  model: any;
  compatible?: (worker: ActiveWorkerHandle) => boolean;
}

/** The sole host-neutral control port used by TUI, RPC and tests. */
export class WorkflowInteractionPort {
  readonly registry: ActiveWorkerRegistry;
  private readonly modelCandidates: (worker: ActiveWorkerHandle) => readonly ModelCandidate[];
  private readonly queues = new Map<string, SerialQueue>();
  private readonly pending = new Map<string, string[]>();
  private readonly lastArtifactRevision = new Map<string, string>();
  private readonly pendingArtifacts = new Map<string, { supplementId: unknown; sequence: unknown; artifactRevisionId: string; nodeExecutionId: string; workerSessionId: string }>();
  constructor(registry: ActiveWorkerRegistry, modelCandidates: (worker: ActiveWorkerHandle) => readonly ModelCandidate[] = () => []) {
    this.registry = registry;
    this.modelCandidates = modelCandidates;
  }

  private queue(runId: string) { const existing = this.queues.get(runId); if (existing) return existing; const created = new SerialQueue(); this.queues.set(runId, created); return created; }

  async submitSupplement(input: { runId: string; expectedNodeExecutionId: string; text: string; images?: any[] }): Promise<SupplementResult> {
    const submissionAttemptId = randomUUID();
    const worker = this.registry.get(input.runId, input.expectedNodeExecutionId);
    if (!worker) return { submissionAttemptId, state: 'delivery_failed', error: 'no unique active Worker for this node execution' };
    return this.queue(input.runId).run(async () => {
      const current = this.registry.get(input.runId, input.expectedNodeExecutionId);
      if (!current) return { submissionAttemptId, state: 'delivery_failed', error: 'active Worker changed before recording input' };
      let recorded;
      try {
        recorded = current.wal.recordSupplement({ submissionAttemptId, nodeExecutionId: current.nodeExecutionId, workerSessionId: current.workerSessionId, text: input.text });
      } catch (error) {
        return { submissionAttemptId, state: 'delivery_failed', error: error instanceof Error ? error.message : String(error) };
      }
      if (recorded.payload.state === 'rejected_after_fence') {
        return { submissionAttemptId, state: 'rejected_after_fence', error: 'Worker close fence already committed' };
      }
      const supplementId = String(recorded.payload.supplementId);
      const sequence = Number(recorded.payload.sequence);
      const pending = this.pending.get(input.runId) ?? [];
      pending.push(supplementId);
      this.pending.set(input.runId, pending);
      try {
        if (current.session.isStreaming) await current.session.steer(input.text, input.images);
        else await current.session.prompt(input.text, { source: 'extension' });
        current.wal.recordDelivery({ submissionAttemptId, supplementId, sequence, nodeExecutionId: current.nodeExecutionId, workerSessionId: current.workerSessionId, state: 'enqueue_accepted' });
        return { submissionAttemptId, supplementId, sequence, state: 'enqueue_accepted' };
      } catch (error) {
        current.wal.recordDelivery({ submissionAttemptId, supplementId, sequence, nodeExecutionId: current.nodeExecutionId, workerSessionId: current.workerSessionId, state: 'delivery_failed', error: error instanceof Error ? error.message : String(error) });
        return { submissionAttemptId, supplementId, sequence, state: 'delivery_failed', error: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  /** Called by the child event projection after a terminal assistant message. */
  recordModelCallCompleted(runId: string, modelCallRef: string) {
    const worker = this.registry.get(runId);
    const supplementId = this.pending.get(runId)?.shift();
    if (!worker || !supplementId) return;
    const record = worker.wal.records().find((item) => item.payload.supplementId === supplementId && item.type === 'supplement');
    if (!record) return;
    worker.wal.recordDelivery({ submissionAttemptId: record.payload.submissionAttemptId, supplementId, sequence: record.payload.sequence, nodeExecutionId: worker.nodeExecutionId, workerSessionId: worker.workerSessionId, state: 'model_call_completed', modelCallRef });
    const pendingArtifact = this.pendingArtifacts.get(runId);
    if (pendingArtifact && pendingArtifact.supplementId === supplementId) {
      worker.wal.recordDelivery({ supplementId, sequence: pendingArtifact.sequence, nodeExecutionId: pendingArtifact.nodeExecutionId, workerSessionId: pendingArtifact.workerSessionId, state: 'artifact_bound', artifactRevisionId: pendingArtifact.artifactRevisionId });
      this.pendingArtifacts.delete(runId);
    }
  }

  bindArtifact(runId: string, artifact: unknown, revisionId = randomUUID()) {
    const worker = this.registry.get(runId);
    if (!worker) return;
    const supplements = worker.wal.records().filter((record) => record.type === 'supplement');
    const latest = supplements.at(-1);
    const artifactRecord = artifact as Record<string, unknown>;
    if (latest) {
      const previousRevision = this.lastArtifactRevision.get(runId);
      const binding = { artifactRevisionId: revisionId, supplementVersion: latest.payload.sequence, supplementContextRef: randomUUID(), ...(previousRevision ? { supersedesArtifactRevisionId: previousRevision } : {}) };
      Object.assign(artifactRecord, binding);
      this.pendingArtifacts.set(runId, { supplementId: latest.payload.supplementId, sequence: latest.payload.sequence, artifactRevisionId: revisionId, nodeExecutionId: worker.nodeExecutionId, workerSessionId: worker.workerSessionId });
      worker.contextSupplementVersion = Number(latest.payload.sequence);
      this.lastArtifactRevision.set(runId, revisionId);
    }
  }

  async requestModelChange(input: { runId: string; expectedNodeExecutionId: string; modelRef: string }): Promise<ModelChangeResult> {
    const requestId = randomUUID();
    const worker = this.registry.get(input.runId, input.expectedNodeExecutionId);
    if (!worker) return { requestId, state: 'failed', error: 'current Worker changed or is not active' };
    const candidate = this.modelCandidates(worker).find((item) => item.ref === input.modelRef && (item.compatible?.(worker) ?? true));
    if (!candidate || !worker.session.setModel) return { requestId, state: 'failed', error: 'model is not scoped/available or Child setModel is unavailable' };
    try {
      const requestedModel = { provider: String(candidate.model.provider), id: String(candidate.model.id) };
      worker.wal.recordWorker({ kind: 'model_change', requestId, state: 'requested', nodeExecutionId: worker.nodeExecutionId, workerSessionId: worker.workerSessionId, modelRef: input.modelRef, actualModel: requestedModel });
      await worker.session.setModel(candidate.model, { persist: false });
      worker.wal.recordWorker({ kind: 'model_change', requestId, state: 'pending', nodeExecutionId: worker.nodeExecutionId, workerSessionId: worker.workerSessionId, modelRef: input.modelRef, actualModel: requestedModel });
      return { requestId, state: 'pending', actualModel: { provider: candidate.model.provider, id: candidate.model.id } };
    } catch (error) {
      worker.wal.recordWorker({ kind: 'model_change', requestId, state: 'failed', modelRef: input.modelRef, error: error instanceof Error ? error.message : String(error) });
      return { requestId, state: 'failed', error: error instanceof Error ? error.message : String(error) };
    }
  }

  closeWorker(runId: string, reason = 'node_settled') {
    const worker = this.registry.get(runId);
    if (!worker) return;
    try {
      for (const pending of worker.wal.records().filter((record) => record.type === 'worker' && record.payload.kind === 'model_change' && record.payload.state === 'pending' && record.payload.nodeExecutionId === worker.nodeExecutionId)) {
        worker.wal.recordWorker({ ...pending.payload, state: 'not_applied', reason });
      }
      const fence = worker.wal.closeFence({ nodeExecutionId: worker.nodeExecutionId, workerSessionId: worker.workerSessionId, reason });
      worker.closeFenceSequence = fence?.index;
    } finally {
      this.registry.unregister(runId, worker.workerSessionId);
    }
  }

  shutdown() {
    for (const worker of this.registry.all()) {
      try {
        this.closeWorker(worker.runId, 'session_shutdown');
        worker.wal.markShutdown();
      } finally { this.registry.unregister(worker.runId, worker.workerSessionId); }
    }
  }
}

export { RunControlWal, RunControlWalError } from './run-control-wal.ts';