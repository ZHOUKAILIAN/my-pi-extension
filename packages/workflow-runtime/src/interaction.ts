import { randomUUID } from 'node:crypto';
import type { AgentSession, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { RunControlWal, RunControlWalError } from './run-control-wal.ts';

export type WorkerStatus = 'starting' | 'streaming' | 'idle' | 'settled' | 'failed';
export type SupplementState = 'recorded' | 'enqueue_accepted' | 'model_call_started' | 'model_call_completed' | 'artifact_bound' | 'delivery_failed' | 'rejected_after_fence' | 'redelivered';
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
  private readonly activeCalls = new Map<string, { ref: string; supplementIds: string[]; supplementVersion: number; contextRef: string }>();
  private readonly completedCalls = new Map<string, { ref: string; supplementIds: string[]; supplementVersion: number; contextRef: string }>();
  private readonly pendingArtifacts = new Map<string, { modelCallRef: string; supplementIds: string[]; supplementVersion: number; contextRef: string; artifactRevisionId: string; nodeExecutionId: string; workerSessionId: string }>();
  private readonly artifactRevisions = new Map<string, string>();
  constructor(registry: ActiveWorkerRegistry, modelCandidates: (worker: ActiveWorkerHandle) => readonly ModelCandidate[] = () => []) { this.registry = registry; this.modelCandidates = modelCandidates; }
  private queue(runId: string) { const existing = this.queues.get(runId); if (existing) return existing; const created = new SerialQueue(); this.queues.set(runId, created); return created; }

  async submitSupplement(input: SupplementInput): Promise<SupplementResult> {
    const submissionAttemptId = randomUUID();
    // Only the durable target/sequence decision and the *initiation* of the
    // SDK operation are serialized. Never await Pi prompt/steer while holding
    // this queue: Pi invokes turn_start/turn_end synchronously from those
    // methods, and those callbacks must be allowed to re-enter this queue.
    const scheduled = await this.queue(input.runId).run(async () => {
      const owner = this.registry.owner(input.runId);
      if (!owner || owner.nodeExecutionId !== input.expectedNodeExecutionId) return { result: { submissionAttemptId, state: 'delivery_failed' as const, error: 'no unique Run owner for this node execution' } };
      // A starting owner is only an interception fence. It must not consume a
      // supplement sequence before a Child is durably published.
      if (owner.status === 'starting') return { result: { submissionAttemptId, state: 'delivery_failed' as const, error: 'Worker is starting; text was retained by the editor' } };
      const current = this.registry.get(input.runId, input.expectedNodeExecutionId);
      if (!current) {
        // A publication gap retains only the edited content. It is not a
        // supplement and therefore cannot create a false sequence or binding.
        try { owner.wal.recordDelivery({ submissionAttemptId, state: 'delivery_failed', nodeExecutionId: owner.nodeExecutionId, workerSessionId: owner.workerSessionId ?? 'unpublished', text: input.text, error: 'Worker publication gap; retained editor content' }); }
        catch { /* the UI still retains the input */ }
        return { result: { submissionAttemptId, state: 'delivery_failed' as const, error: 'Worker publication gap; text retained' } };
      }
      let recorded;
      try { recorded = owner.wal.recordSupplement({ submissionAttemptId, nodeExecutionId: current.nodeExecutionId, workerSessionId: current.workerSessionId, text: input.text }); }
      catch (error) { return { result: { submissionAttemptId, state: 'delivery_failed' as const, error: error instanceof Error ? error.message : String(error) } };
      }
      if (recorded.payload.state === 'rejected_after_fence') return { result: { submissionAttemptId, state: 'rejected_after_fence' as const, error: 'Worker close fence already committed' } };
      const supplementId = String(recorded.payload.supplementId); const sequence = Number(recorded.payload.sequence);
      this.pendingCalls.set(input.runId, [...(this.pendingCalls.get(input.runId) ?? []), supplementId]);
      let operation: Promise<void>;
      try {
        // Calling (not awaiting) is intentional. The promise is carried out of
        // the queue so turn_start/turn_end can be folded before it settles.
        operation = current.session.isStreaming
          ? current.session.steer(input.text, input.images)
          : current.session.prompt(input.text, { source: 'extension' });
      } catch (error) {
        return { result: { submissionAttemptId, supplementId, sequence, state: 'delivery_failed' as const, error: error instanceof Error ? error.message : String(error) }, syncFailure: { owner, current, supplementId, sequence, error } };
      }
      return { operation, owner, current, supplementId, sequence, result: undefined };
    });
    if (!scheduled.operation) {
      if (scheduled.syncFailure) {
        await this.queue(input.runId).run(async () => {
          const pending = this.pendingCalls.get(input.runId) ?? [];
          this.pendingCalls.set(input.runId, pending.filter((id) => id !== scheduled.syncFailure!.supplementId));
          try { scheduled.syncFailure!.owner.wal.recordDelivery({ submissionAttemptId, supplementId: scheduled.syncFailure!.supplementId, sequence: scheduled.syncFailure!.sequence, nodeExecutionId: scheduled.syncFailure!.current.nodeExecutionId, workerSessionId: scheduled.syncFailure!.current.workerSessionId, state: 'delivery_failed', error: scheduled.syncFailure!.error instanceof Error ? scheduled.syncFailure!.error.message : String(scheduled.syncFailure!.error) }); } catch { /* retain the editor text */ }
        });
      }
      return scheduled.result;
    }
    try {
      await scheduled.operation;
    } catch (error) {
      return this.queue(input.runId).run(async () => {
        const pending = this.pendingCalls.get(input.runId) ?? [];
        this.pendingCalls.set(input.runId, pending.filter((id) => id !== scheduled.supplementId));
        try { scheduled.owner.wal.recordDelivery({ submissionAttemptId, supplementId: scheduled.supplementId, sequence: scheduled.sequence, nodeExecutionId: scheduled.current.nodeExecutionId, workerSessionId: scheduled.current.workerSessionId, state: 'delivery_failed', error: error instanceof Error ? error.message : String(error) }); } catch { /* retain the editor text */ }
        return { submissionAttemptId, supplementId: scheduled.supplementId, sequence: scheduled.sequence, state: 'delivery_failed' as const, error: error instanceof Error ? error.message : String(error) };
      });
    }
    return this.queue(input.runId).run(async () => {
      try { scheduled.owner.wal.recordDelivery({ submissionAttemptId, supplementId: scheduled.supplementId, sequence: scheduled.sequence, nodeExecutionId: scheduled.current.nodeExecutionId, workerSessionId: scheduled.current.workerSessionId, state: 'enqueue_accepted' }); }
      catch (error) { return { submissionAttemptId, supplementId: scheduled.supplementId, sequence: scheduled.sequence, state: 'delivery_failed' as const, error: error instanceof Error ? error.message : String(error) }; }
      return { submissionAttemptId, supplementId: scheduled.supplementId, sequence: scheduled.sequence, state: 'enqueue_accepted' as const };
    });
  }

  /**
   * Pi 0.84.2 establishes the next provider call at turn_start. A
   * message_end is too late: steering is consumed before that event.
   */
  recordModelTurnStart(runId: string, turnIndex: number, modelCallRef: string): Promise<{ modelCallRef: string; supplementVersion: number; contextRef: string; appliedModel?: { provider: string; id: string } } | undefined> {
    return this.queue(runId).run(async () => {
      const worker = this.registry.get(runId); const pendingIds = this.pendingCalls.get(runId) ?? [];
      if (!worker) return undefined;
      const records = worker.wal.records();
      const ids = pendingIds.filter((id) => records.some((record) => record.type === 'supplement' && record.payload.supplementId === id && record.payload.nodeExecutionId === worker.nodeExecutionId));
      this.pendingCalls.delete(runId);
      const pendingVersion = ids.reduce((max, id) => {
        const record = records.find((item) => item.type === 'supplement' && item.payload.supplementId === id);
        return Math.max(max, typeof record?.payload.sequence === 'number' ? record.payload.sequence : 0);
      }, 0);
      // The snapshot is cumulative: consuming the last supplement does not
      // reset the next model call to version 0. A later call inherits the
      // Worker/WAL version and advances only to a newer pending sequence.
      const cumulativeVersion = Math.max(worker.contextSupplementVersion, worker.wal.getSupplementVersion(), pendingVersion);
      const call = { ref: modelCallRef, supplementIds: ids, supplementVersion: cumulativeVersion, contextRef: randomUUID() };
      worker.contextSupplementVersion = cumulativeVersion;
      worker.wal.recordWorker({ kind: 'model_call_snapshot', nodeExecutionId: worker.nodeExecutionId, workerSessionId: worker.workerSessionId, modelCallRef, supplementVersion: cumulativeVersion, contextRef: call.contextRef, turnIndex });
      this.activeCalls.set(runId, call);
      for (const supplementId of ids) {
        const record = records.find((item) => item.type === 'supplement' && item.payload.supplementId === supplementId);
        if (record) worker.wal.recordDelivery({ submissionAttemptId: record.payload.submissionAttemptId, supplementId, sequence: record.payload.sequence, nodeExecutionId: worker.nodeExecutionId, workerSessionId: worker.workerSessionId, state: 'model_call_started', modelCallRef, supplementVersion: cumulativeVersion, contextRef: call.contextRef, turnIndex });
      }
      const appliedModel = this.applyPendingModelChanges(worker, modelCallRef);
      return { modelCallRef, supplementVersion: cumulativeVersion, contextRef: call.contextRef, ...(appliedModel ? { appliedModel } : {}) };
    });
  }

  /** Completion is accepted only for the ref established at turn_start. */
  recordModelCallCompleted(runId: string, modelCallRef: string): Promise<void> {
    return this.queue(runId).run(async () => {
      const worker = this.registry.get(runId); if (!worker) return;
      const active = this.activeCalls.get(runId);
      if (!active || active.ref !== modelCallRef) return;
      this.activeCalls.delete(runId);
      this.completedCalls.set(runId, active);
      const records = worker.wal.records();
      for (const supplementId of active.supplementIds) {
        const record = records.find((item) => item.type === 'supplement' && item.payload.supplementId === supplementId && item.payload.nodeExecutionId === worker.nodeExecutionId);
        if (record) worker.wal.recordDelivery({ submissionAttemptId: record.payload.submissionAttemptId, supplementId, sequence: record.payload.sequence, nodeExecutionId: worker.nodeExecutionId, workerSessionId: worker.workerSessionId, state: 'model_call_completed', modelCallRef, supplementVersion: active.supplementVersion, contextRef: active.contextRef });
      }
      // Binding is deliberately after turn_end and is scoped to this exact call.
      this.bindPendingArtifact(worker, active);
    });
  }

  private applyPendingModelChanges(worker: ActiveWorkerHandle, modelCallRef: string): { provider: string; id: string } | undefined {
    const actual = worker.session.model;
    let appliedModel: { provider: string; id: string } | undefined;
    const latestByRequest = new Map<string, ReturnType<RunControlWal['records']>[number]>();
    for (const record of worker.wal.records().filter((item) => item.type === 'worker' && item.payload.kind === 'model_change' && item.payload.nodeExecutionId === worker.nodeExecutionId && typeof item.payload.requestId === 'string')) {
      latestByRequest.set(String(record.payload.requestId), record);
    }
    for (const record of latestByRequest.values()) {
      if (record.payload.state !== 'pending') continue;
      const requested = record.payload.actualModel as { provider?: unknown; id?: unknown } | undefined;
      if (!actual || requested?.provider !== actual.provider || requested?.id !== actual.id) {
        worker.wal.recordWorker({ ...record.payload, state: 'failed', error: 'Pi session did not report the requested model at turn_start', effectiveFromModelCallRef: modelCallRef });
      } else {
        worker.actualModel = { provider: String(actual.provider), id: String(actual.id) };
        worker.wal.recordWorker({ ...record.payload, state: 'applied', actualModel: worker.actualModel, effectiveFromModelCallRef: modelCallRef });
        appliedModel = worker.actualModel;
      }
    }
    return appliedModel;
  }

  private bindPendingArtifact(worker: ActiveWorkerHandle, completedCall?: { ref: string; supplementIds: string[]; supplementVersion: number; contextRef: string }) {
    const pending = this.pendingArtifacts.get(worker.runId);
    if (!pending || (completedCall && pending.modelCallRef !== completedCall.ref)) return;
    const call = completedCall ?? this.completedCalls.get(worker.runId);
    if (!call || pending.modelCallRef !== call.ref) return;
    const records = worker.wal.records();
    const completed = new Set(records.filter((record) => record.type === 'delivery' && record.payload.state === 'model_call_completed' && record.payload.modelCallRef === call.ref).map((record) => String(record.payload.supplementId)));
    if (call.supplementIds.some((id) => !completed.has(id))) return;
    const alreadyBound = new Set(records.filter((record) => record.type === 'delivery' && record.payload.state === 'artifact_bound' && record.payload.modelCallRef === call.ref).map((record) => String(record.payload.supplementId)));
    if (!call.supplementIds.length) {
      worker.wal.recordDelivery({ nodeExecutionId: pending.nodeExecutionId, workerSessionId: pending.workerSessionId, state: 'artifact_bound', artifactRevisionId: pending.artifactRevisionId, modelCallRef: call.ref, supplementVersion: call.supplementVersion, contextRef: call.contextRef });
    } else for (const supplementId of call.supplementIds) {
      if (!alreadyBound.has(supplementId)) worker.wal.recordDelivery({ supplementId, sequence: records.find((record) => record.type === 'supplement' && record.payload.supplementId === supplementId)?.payload.sequence, nodeExecutionId: pending.nodeExecutionId, workerSessionId: pending.workerSessionId, state: 'artifact_bound', artifactRevisionId: pending.artifactRevisionId, modelCallRef: call.ref, supplementVersion: call.supplementVersion, contextRef: call.contextRef });
    }
    this.pendingArtifacts.delete(worker.runId);
  }

  /** Returns a new immutable Artifact revision; the worker object is never mutated in place. */
  bindArtifact(runId: string, artifact: object, revisionId = randomUUID()): Promise<object> {
    return this.queue(runId).run(async () => {
      const worker = this.registry.get(runId); const owner = this.registry.owner(runId);
      if (!worker || !owner) return artifact;
      const call = this.activeCalls.get(runId) ?? this.completedCalls.get(runId);
      if (!call) throw new RunControlWalError('ARTIFACT_MODEL_CALL_REQUIRED', 'submit_artifact must occur during or immediately after a Pi model call');
      const supplied = artifact as Record<string, unknown>;
      if (typeof supplied.artifactRevisionId === 'string' || typeof supplied.modelCallRef === 'string' || typeof supplied.supplementContextRef === 'string') {
        throw new RunControlWalError('ARTIFACT_REVISION_ALREADY_BOUND', 'an Artifact revision from an earlier model call cannot be rebound to a newer supplement');
      }
      const previousRevision = this.artifactRevisions.get(runId);
      const revision = Object.freeze({ ...artifact, artifactRevisionId: revisionId, modelCallRef: call.ref, supplementVersion: call.supplementVersion, supplementContextRef: call.contextRef, ...(previousRevision ? { supersedesArtifactRevisionId: previousRevision } : {}) });
      this.pendingArtifacts.set(runId, { modelCallRef: call.ref, supplementIds: call.supplementIds, supplementVersion: call.supplementVersion, contextRef: call.contextRef, artifactRevisionId: revisionId, nodeExecutionId: worker.nodeExecutionId, workerSessionId: worker.workerSessionId });
      worker.contextSupplementVersion = call.supplementVersion;
      this.artifactRevisions.set(runId, revisionId);
      if (this.completedCalls.get(runId)?.ref === call.ref) this.bindPendingArtifact(worker, call);
      return revision;
    });
  }

  /** Reconstructs unbound supplements for a replacement Worker and redelivers
   * each supplement at most once per Worker attempt. */
  async reconcileWorker(worker: ActiveWorkerHandle): Promise<void> {
    const records = worker.wal.records();
    const bound = new Set(records.filter((record) => record.type === 'delivery' && record.payload.state === 'artifact_bound' && record.payload.nodeExecutionId === worker.nodeExecutionId).map((record) => String(record.payload.supplementId)));
    const redelivered = new Set(records.filter((record) => record.type === 'delivery' && record.payload.state === 'redelivered' && record.payload.workerSessionId === worker.workerSessionId).map((record) => String(record.payload.supplementId)));
    const acceptedForWorker = new Set(records.filter((record) => record.type === 'delivery' && record.payload.state === 'enqueue_accepted' && record.payload.redelivery === true && record.payload.workerSessionId === worker.workerSessionId).map((record) => String(record.payload.supplementId)));
    const pendingIds: string[] = [];
    for (const supplement of records.filter((record) => record.type === 'supplement')) {
      const id = String(supplement.payload.supplementId);
      if (String(supplement.payload.nodeExecutionId) !== worker.nodeExecutionId || bound.has(id)) continue;
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

  async requestModelChange(input: { runId: string; expectedNodeExecutionId: string; expectedWorkerSessionId: string; expectedAttemptId: string; modelRef: string }): Promise<ModelChangeResult> {
    return this.queue(input.runId).run(async () => {
      const requestId = randomUUID();
      const worker = this.registry.get(input.runId, input.expectedNodeExecutionId);
      if (!worker || worker.workerSessionId !== input.expectedWorkerSessionId || worker.attemptId !== input.expectedAttemptId || !worker.session.setModel) {
        return { requestId, state: 'failed', error: 'current Worker session or attempt changed; refusing model picker action' };
      }
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
      const supplements = records.filter((record) => record.type === 'supplement' && record.payload.nodeExecutionId === worker.nodeExecutionId);
      const bound = new Set(records.filter((record) => record.type === 'delivery' && record.payload.state === 'artifact_bound' && record.payload.nodeExecutionId === worker.nodeExecutionId).map((record) => String(record.payload.supplementId)));
      const unbound = supplements.filter((record) => !bound.has(String(record.payload.supplementId)));
      if (unbound.length) throw new RunControlWalError('SUPPLEMENT_ARTIFACT_NOT_BOUND', `cannot close ${runId}: ${unbound.length} supplement(s) lack a completed model call and immutable Artifact revision`);
      if (supplements.length) {
        const latest = supplements.at(-1)!;
        const latestBinding = records.find((record) => record.type === 'delivery' && record.payload.state === 'artifact_bound' && String(record.payload.supplementId) === String(latest.payload.supplementId));
        if (!latestBinding || latestBinding.payload.supplementVersion !== latest.payload.sequence || typeof latestBinding.payload.modelCallRef !== 'string' || typeof latestBinding.payload.contextRef !== 'string') {
          throw new RunControlWalError('SUPPLEMENT_ARTIFACT_STALE', 'the latest committed supplement is not bound to a completed model call revision');
        }
      }
      const latestModelState = new Map<string, typeof records[number]>();
      for (const record of records.filter((item) => item.type === 'worker' && item.payload.kind === 'model_change' && item.payload.nodeExecutionId === worker.nodeExecutionId && typeof item.payload.requestId === 'string')) latestModelState.set(String(record.payload.requestId), record);
      for (const pending of latestModelState.values()) if (pending.payload.state === 'pending' || pending.payload.state === 'requested') worker.wal.recordWorker({ ...pending.payload, state: 'not_applied', reason });
      const fence = worker.wal.closeFence({ nodeExecutionId: worker.nodeExecutionId, workerSessionId: worker.workerSessionId, attemptId: worker.attemptId, reason });
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
