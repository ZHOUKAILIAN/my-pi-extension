import { randomUUID } from 'node:crypto';
import type { AgentSession, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { RunControlWal, RunControlWalError } from './run-control-wal.ts';

export type WorkerStatus = 'starting' | 'streaming' | 'idle' | 'settled' | 'failed';
export type SupplementState = 'recorded' | 'enqueue_accepted' | 'model_call_completed' | 'artifact_bound' | 'delivery_failed' | 'rejected_after_fence' | 'redelivered';
export type ModelChangeState = 'requested' | 'pending' | 'applied' | 'not_applied' | 'failed';
export type WorkerModel = Parameters<AgentSession['setModel']>[0];

export interface WorkerSessionLike {
  readonly sessionId?: string;
  readonly isStreaming?: boolean;
  readonly isIdle?: boolean;
  readonly model?: WorkerModel;
  steer(text: string, images?: SupplementImages): Promise<void>;
  prompt(text: string, options?: { streamingBehavior?: 'steer' | 'followUp'; source?: 'extension' }): Promise<void>;
  setModel?(model: WorkerModel): Promise<void>;
  subscribe?(listener: (event: unknown) => void): () => void;
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
  recoveryAttempt: number;
  actualModel: { provider: string; id: string };
  status: WorkerStatus;
  contextSupplementVersion: number;
  closeFenceSequence?: number;
  session: WorkerSessionLike;
  wal: RunControlWal;
}

export interface RunOwner {
  runId: string;
  parentSessionId: string;
  parentLeafId: string;
  nodeExecutionId: string;
  workerSessionId?: string;
  status: 'starting' | 'running' | 'settled' | 'failed' | 'shutdown';
  wal: RunControlWal;
}

export interface SupplementResult {
  submissionAttemptId: string;
  supplementId?: string;
  sequence?: number;
  state: SupplementState;
  error?: string;
}
export interface ModelChangeResult { requestId: string; state: ModelChangeState; actualModel?: { provider: string; id: string }; error?: string; }

const ownerKey = (parentSessionId: string, parentLeafId: string, runId: string) => `${parentSessionId}\0${parentLeafId}\0${runId}`;

/** Process-local foreground ownership. Ownership outlives a Child publication gap. */
export class ActiveWorkerRegistry {
  private readonly workers = new Map<string, ActiveWorkerHandle>();
  private readonly owners = new Map<string, RunOwner>();
  private readonly byRun = new Map<string, string>();
  private readonly listeners = new Set<(event: Record<string, unknown>) => void>();

  reserve(owner: RunOwner) {
    const key = ownerKey(owner.parentSessionId, owner.parentLeafId, owner.runId);
    const existing = [...this.owners.values()].find((candidate) => candidate.parentSessionId === owner.parentSessionId && candidate.parentLeafId === owner.parentLeafId);
    if (existing && existing.runId !== owner.runId) throw new RunControlWalError('RUN_OWNER_ALREADY_RESERVED', 'the parent already owns another live Run');
    if (this.byRun.has(owner.runId) && !this.owners.has(key)) throw new RunControlWalError('RUN_OWNER_ALREADY_RESERVED', `run ${owner.runId} has another owner`);
    this.owners.set(key, owner);
    this.byRun.set(owner.runId, key);
    this.emit({ type: 'run_owner_reserved', runId: owner.runId, status: owner.status });
  }

  owner(runId: string): RunOwner | undefined { const key = this.byRun.get(runId); return key === undefined ? undefined : this.owners.get(key); }
  ownerForParent(parentSessionId: string, parentLeafId: string): RunOwner | undefined {
    const matches = [...this.owners.values()].filter((owner) => owner.parentSessionId === parentSessionId && owner.parentLeafId === parentLeafId);
    return matches.length === 1 ? matches[0] : undefined;
  }
  hasOwner(parentSessionId: string, parentLeafId: string) { return this.ownerForParent(parentSessionId, parentLeafId) !== undefined; }

  register(handle: ActiveWorkerHandle) {
    const key = ownerKey(handle.parentSessionId, handle.parentLeafId, handle.runId);
    let owner = this.owners.get(key);
    // Direct registry users (including embedders/tests) are upgraded to the
    // same reservation protocol before publication; normal live runs reserve
    // earlier, closing the starting/publication gap.
    if (!owner) {
      this.reserve({ runId: handle.runId, parentSessionId: handle.parentSessionId, parentLeafId: handle.parentLeafId, nodeExecutionId: handle.nodeExecutionId, workerSessionId: handle.workerSessionId, status: 'starting', wal: handle.wal });
      owner = this.owners.get(key);
    }
    if (!owner || owner.runId !== handle.runId) throw new RunControlWalError('RUN_OWNER_MISSING', `run ${handle.runId} must reserve its parent before publishing a Worker`);
    const existingKey = this.byRun.get(handle.runId);
    const previous = existingKey ? this.workers.get(existingKey) : undefined;
    if (previous && previous.workerSessionId !== handle.workerSessionId) throw new RunControlWalError('ACTIVE_WORKER_ALREADY_PUBLISHED', `run ${handle.runId} already has a foreground Worker`);
    this.workers.set(key, handle);
    owner.nodeExecutionId = handle.nodeExecutionId;
    owner.workerSessionId = handle.workerSessionId;
    owner.status = 'running';
    this.emit({ type: 'worker_published', runId: handle.runId, nodeExecutionId: handle.nodeExecutionId, workerSessionId: handle.workerSessionId, workerId: handle.workerId, model: handle.actualModel });
  }

  get(runId: string, expectedNodeExecutionId?: string): ActiveWorkerHandle | undefined {
    const key = this.byRun.get(runId); const handle = key === undefined ? undefined : this.workers.get(key);
    if (!handle || (expectedNodeExecutionId !== undefined && handle.nodeExecutionId !== expectedNodeExecutionId)) return undefined;
    return handle;
  }
  getForParent(parentSessionId: string, parentLeafId: string) {
    const candidates = [...this.workers.values()].filter((worker) => worker.parentSessionId === parentSessionId && worker.parentLeafId === parentLeafId);
    return candidates.length === 1 ? candidates[0] : undefined;
  }
  countForParent(parentSessionId: string, parentLeafId: string) { return [...this.owners.values()].filter((owner) => owner.parentSessionId === parentSessionId && owner.parentLeafId === parentLeafId).length; }
  hasActiveForParent(parentSessionId: string, parentLeafId: string) { return this.hasOwner(parentSessionId, parentLeafId); }

  unregisterWorker(runId: string, workerSessionId?: string) {
    const key = this.byRun.get(runId); if (key === undefined) return;
    const current = this.workers.get(key);
    if (current && workerSessionId !== undefined && current.workerSessionId !== workerSessionId) return;
    this.workers.delete(key);
    const owner = this.owners.get(key); if (owner && owner.status === 'running') owner.status = 'settled';
    this.emit({ type: 'worker_unpublished', runId, workerSessionId: current?.workerSessionId });
  }
  release(runId: string) {
    const key = this.byRun.get(runId); if (key === undefined) return;
    this.workers.delete(key); this.owners.delete(key); this.byRun.delete(runId);
    this.emit({ type: 'run_owner_released', runId });
  }
  markShutdown(runId: string) { const owner = this.owner(runId); if (owner) owner.status = 'shutdown'; }
  subscribe(listener: (event: Record<string, unknown>) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(event: Record<string, unknown>) { for (const listener of this.listeners) { try { listener(event); } catch { /* projection is never a control dependency */ } } }
  all() { return [...this.workers.values()]; }
  allOwners() { return [...this.owners.values()]; }
}

class SerialQueue {
  private tail = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> { const next = this.tail.then(operation, operation); this.tail = next.then(() => undefined, () => undefined); return next; }
}

export interface ModelCandidate { ref: string; model: WorkerModel; compatible?: (worker: ActiveWorkerHandle) => boolean; }
type SupplementImages = Parameters<AgentSession['steer']>[1];
export interface SupplementInput { runId: string; expectedNodeExecutionId: string; text: string; images?: SupplementImages; }

/** Host-neutral interaction contract shared by TUI, RPC and tests. */
export class WorkflowInteractionPort {
  readonly registry: ActiveWorkerRegistry;
  private readonly modelCandidates: (worker: ActiveWorkerHandle) => readonly ModelCandidate[];
  private readonly queues = new Map<string, SerialQueue>();
  private readonly pendingCalls = new Map<string, string[]>();
  private readonly pendingArtifacts = new Map<string, { supplementId: string; sequence: number; artifactRevisionId: string; nodeExecutionId: string; workerSessionId: string }>();
  private readonly artifactRevisions = new Map<string, string>();
  constructor(registry: ActiveWorkerRegistry, modelCandidates: (worker: ActiveWorkerHandle) => readonly ModelCandidate[] = () => []) { this.registry = registry; this.modelCandidates = modelCandidates; }
  private queue(runId: string) { const existing = this.queues.get(runId); if (existing) return existing; const created = new SerialQueue(); this.queues.set(runId, created); return created; }

  async submitSupplement(input: SupplementInput): Promise<SupplementResult> {
    const submissionAttemptId = randomUUID();
    return this.queue(input.runId).run(async () => {
      const owner = this.registry.owner(input.runId);
      if (!owner || owner.nodeExecutionId !== input.expectedNodeExecutionId) return { submissionAttemptId, state: 'delivery_failed', error: 'no unique Run owner for this node execution' };
      let recorded;
      try { recorded = owner.wal.recordSupplement({ submissionAttemptId, nodeExecutionId: owner.nodeExecutionId, workerSessionId: owner.workerSessionId ?? 'unpublished', text: input.text }); }
      catch (error) { return { submissionAttemptId, state: 'delivery_failed', error: error instanceof Error ? error.message : String(error) }; }
      if (recorded.payload.state === 'rejected_after_fence') return { submissionAttemptId, state: 'rejected_after_fence', error: 'Worker close fence already committed' };
      const supplementId = String(recorded.payload.supplementId); const sequence = Number(recorded.payload.sequence);
      const current = this.registry.get(input.runId, input.expectedNodeExecutionId);
      if (!current) {
        owner.wal.recordDelivery({ submissionAttemptId, supplementId, sequence, nodeExecutionId: owner.nodeExecutionId, workerSessionId: owner.workerSessionId ?? 'unpublished', state: 'delivery_failed', error: 'Worker publication gap; retained for the next logical attempt' });
        return { submissionAttemptId, supplementId, sequence, state: 'delivery_failed', error: 'Worker publication gap; text retained' };
      }
      try {
        this.pendingCalls.set(input.runId, [...(this.pendingCalls.get(input.runId) ?? []), supplementId]);
        if (current.session.isStreaming) await current.session.steer(input.text, input.images);
        else await current.session.prompt(input.text, { source: 'extension' });
        owner.wal.recordDelivery({ submissionAttemptId, supplementId, sequence, nodeExecutionId: current.nodeExecutionId, workerSessionId: current.workerSessionId, state: 'enqueue_accepted' });
        return { submissionAttemptId, supplementId, sequence, state: 'enqueue_accepted' };
      } catch (error) {
        const pending = this.pendingCalls.get(input.runId) ?? [];
        this.pendingCalls.set(input.runId, pending.filter((id) => id !== supplementId));
        owner.wal.recordDelivery({ submissionAttemptId, supplementId, sequence, nodeExecutionId: current.nodeExecutionId, workerSessionId: current.workerSessionId, state: 'delivery_failed', error: error instanceof Error ? error.message : String(error) });
        return { submissionAttemptId, supplementId, sequence, state: 'delivery_failed', error: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  /** Model completion is serialized with artifact binding and the close fence. */
  recordModelCallCompleted(runId: string, modelCallRef: string): Promise<void> {
    return this.queue(runId).run(async () => {
      const worker = this.registry.get(runId); const pendingIds = this.pendingCalls.get(runId) ?? [];
      if (!worker || pendingIds.length === 0) return;
      this.pendingCalls.delete(runId);
      const records = worker.wal.records();
      for (const supplementId of pendingIds) {
        const record = records.find((item) => item.type === 'supplement' && item.payload.supplementId === supplementId);
        if (record) worker.wal.recordDelivery({ submissionAttemptId: record.payload.submissionAttemptId, supplementId, sequence: record.payload.sequence, nodeExecutionId: worker.nodeExecutionId, workerSessionId: worker.workerSessionId, state: 'model_call_completed', modelCallRef });
      }
      this.bindPendingArtifact(worker);
    });
  }

  private bindPendingArtifact(worker: ActiveWorkerHandle) {
    const pending = this.pendingArtifacts.get(worker.runId);
    if (!pending) return;
    const records = worker.wal.records();
    const supplements = records.filter((record) => record.type === 'supplement');
    const completed = new Set(records.filter((record) => record.type === 'delivery' && record.payload.state === 'model_call_completed').map((record) => String(record.payload.supplementId)));
    if (supplements.some((record) => !completed.has(String(record.payload.supplementId)))) return;
    const alreadyBound = new Set(records.filter((record) => record.type === 'delivery' && record.payload.state === 'artifact_bound').map((record) => String(record.payload.supplementId)));
    for (const supplement of supplements) {
      const supplementId = String(supplement.payload.supplementId);
      if (!alreadyBound.has(supplementId)) worker.wal.recordDelivery({ supplementId, sequence: supplement.payload.sequence, nodeExecutionId: pending.nodeExecutionId, workerSessionId: pending.workerSessionId, state: 'artifact_bound', artifactRevisionId: pending.artifactRevisionId });
    }
    this.pendingArtifacts.delete(worker.runId);
  }

  /** Returns a new immutable Artifact revision; the worker object is never mutated in place. */
  bindArtifact(runId: string, artifact: object, revisionId = randomUUID()): Promise<object> {
    return this.queue(runId).run(async () => {
      const worker = this.registry.get(runId); const owner = this.registry.owner(runId);
      if (!worker || !owner) return artifact;
      const supplements = worker.wal.records().filter((record) => record.type === 'supplement');
      const latest = supplements.at(-1);
      if (!latest) return Object.freeze({ ...artifact });
      const previousRevision = this.artifactRevisions.get(runId);
      const revision = Object.freeze({ ...artifact, artifactRevisionId: revisionId, supplementVersion: Number(latest.payload.sequence), supplementContextRef: randomUUID(), ...(previousRevision ? { supersedesArtifactRevisionId: previousRevision } : {}) });
      this.pendingArtifacts.set(runId, { supplementId: String(latest.payload.supplementId), sequence: Number(latest.payload.sequence), artifactRevisionId: revisionId, nodeExecutionId: worker.nodeExecutionId, workerSessionId: worker.workerSessionId });
      worker.contextSupplementVersion = Number(latest.payload.sequence);
      this.artifactRevisions.set(runId, revisionId);
      if (this.hasModelCallCompleted(worker.wal, String(latest.payload.supplementId))) this.bindPendingArtifact(worker);
      return revision;
    });
  }

  private hasModelCallCompleted(wal: RunControlWal, supplementId: string) { return wal.records().some((record) => record.type === 'delivery' && record.payload.supplementId === supplementId && record.payload.state === 'model_call_completed'); }

  /** Reconstructs unbound supplements for a replacement Worker and redelivers
   * each supplement at most once per Worker attempt. */
  async reconcileWorker(worker: ActiveWorkerHandle): Promise<void> {
    const records = worker.wal.records();
    const bound = new Set(records.filter((record) => record.type === 'delivery' && record.payload.state === 'artifact_bound').map((record) => String(record.payload.supplementId)));
    const redelivered = new Set(records.filter((record) => record.type === 'delivery' && record.payload.state === 'redelivered' && record.payload.workerSessionId === worker.workerSessionId).map((record) => String(record.payload.supplementId)));
    const acceptedForWorker = new Set(records.filter((record) => record.type === 'delivery' && record.payload.state === 'enqueue_accepted' && record.payload.redelivery === true && record.payload.workerSessionId === worker.workerSessionId).map((record) => String(record.payload.supplementId)));
    const pendingIds: string[] = [];
    for (const supplement of records.filter((record) => record.type === 'supplement')) {
      const id = String(supplement.payload.supplementId);
      if (bound.has(id)) continue;
      if (acceptedForWorker.has(id)) {
        pendingIds.push(id);
        this.pendingCalls.set(worker.runId, [...pendingIds]);
      }
      if (redelivered.has(id)) continue;
      worker.wal.recordDelivery({ supplementId: id, sequence: supplement.payload.sequence, nodeExecutionId: worker.nodeExecutionId, workerSessionId: worker.workerSessionId, state: 'redelivered', recoveryAttempt: worker.recoveryAttempt });
      pendingIds.push(id);
      this.pendingCalls.set(worker.runId, [...pendingIds]);
      try {
        await worker.session.prompt(String(supplement.payload.text ?? ''), { source: 'extension' });
        worker.wal.recordDelivery({ submissionAttemptId: supplement.payload.submissionAttemptId, supplementId: id, sequence: supplement.payload.sequence, nodeExecutionId: worker.nodeExecutionId, workerSessionId: worker.workerSessionId, state: 'enqueue_accepted', redelivery: true });
      } catch (error) {
        pendingIds.splice(pendingIds.indexOf(id), 1);
        this.pendingCalls.set(worker.runId, [...pendingIds]);
        worker.wal.recordDelivery({ submissionAttemptId: supplement.payload.submissionAttemptId, supplementId: id, sequence: supplement.payload.sequence, nodeExecutionId: worker.nodeExecutionId, workerSessionId: worker.workerSessionId, state: 'delivery_failed', redelivery: true, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  async requestModelChange(input: { runId: string; expectedNodeExecutionId: string; modelRef: string }): Promise<ModelChangeResult> {
    return this.queue(input.runId).run(async () => {
      const requestId = randomUUID(); const worker = this.registry.get(input.runId, input.expectedNodeExecutionId);
      if (!worker || !worker.session.setModel) return { requestId, state: 'failed', error: 'current Worker changed or Child setModel is unavailable' };
      const candidate = this.modelCandidates(worker).find((item) => item.ref === input.modelRef && (item.compatible?.(worker) ?? true));
      if (!candidate) return { requestId, state: 'failed', error: 'model is not scoped, authenticated, or compatible with this Worker' };
      const requestedModel = { provider: String(candidate.model.provider), id: String(candidate.model.id) };
      try {
        worker.wal.recordWorker({ kind: 'model_change', requestId, state: 'requested', nodeExecutionId: worker.nodeExecutionId, workerSessionId: worker.workerSessionId, modelRef: input.modelRef, actualModel: requestedModel });
        await worker.session.setModel(candidate.model);
        worker.wal.recordWorker({ kind: 'model_change', requestId, state: 'pending', nodeExecutionId: worker.nodeExecutionId, workerSessionId: worker.workerSessionId, modelRef: input.modelRef, actualModel: requestedModel });
        return { requestId, state: 'pending', actualModel: requestedModel };
      } catch (error) {
        worker.wal.recordWorker({ kind: 'model_change', requestId, state: 'failed', nodeExecutionId: worker.nodeExecutionId, workerSessionId: worker.workerSessionId, modelRef: input.modelRef, error: error instanceof Error ? error.message : String(error) });
        return { requestId, state: 'failed', error: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  /** Serializes close behind all input/model operations and refuses an unbound supplement. */
  async closeWorker(runId: string, reason = 'node_settled'): Promise<void> {
    await this.queue(runId).run(async () => {
      const worker = this.registry.get(runId); if (!worker) return;
      const records = worker.wal.records();
      const supplements = records.filter((record) => record.type === 'supplement');
      const bound = new Set(records.filter((record) => record.type === 'delivery' && record.payload.state === 'artifact_bound').map((record) => String(record.payload.supplementId)));
      const unbound = supplements.filter((record) => !bound.has(String(record.payload.supplementId)));
      if (unbound.length) throw new RunControlWalError('SUPPLEMENT_ARTIFACT_NOT_BOUND', `cannot close ${runId}: ${unbound.length} supplement(s) lack a completed model call and immutable Artifact revision`);
      for (const pending of records.filter((record) => record.type === 'worker' && record.payload.kind === 'model_change' && record.payload.state === 'pending' && record.payload.nodeExecutionId === worker.nodeExecutionId)) worker.wal.recordWorker({ ...pending.payload, state: 'not_applied', reason });
      const fence = worker.wal.closeFence({ nodeExecutionId: worker.nodeExecutionId, workerSessionId: worker.workerSessionId, reason });
      worker.closeFenceSequence = fence?.index;
      this.registry.unregisterWorker(runId, worker.workerSessionId);
    });
  }

  async shutdown() {
    for (const owner of this.registry.allOwners()) {
      this.registry.markShutdown(owner.runId);
      const worker = this.registry.get(owner.runId);
      if (worker) { try { await this.closeWorker(owner.runId, 'session_shutdown'); } catch { owner.wal.markShutdown(); this.registry.unregisterWorker(owner.runId, worker.workerSessionId); } }
      owner.wal.markShutdown();
      worker?.session.dispose?.();
    }
  }
}

/** Extracts the parent identity without using an untyped side channel. */
export const parentOwnerFor = (ctx: Pick<ExtensionContext, 'sessionManager'>) => ({
  parentSessionId: ctx.sessionManager.getSessionId(),
  parentLeafId: ctx.sessionManager.getLeafId() ?? 'root',
});

export { RunControlWal, RunControlWalError } from './run-control-wal.ts';
