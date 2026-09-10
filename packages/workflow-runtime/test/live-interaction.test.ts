import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActiveWorkerRegistry, RunControlWal, RunControlWalStore, WorkerSidecar, WorkflowInteractionPort } from '../src/index.ts';

const handle = (wal: RunControlWal, session: any, interaction: WorkflowInteractionPort, overrides: Record<string, unknown> = {}) => ({
  runId: 'fix-live', parentSessionId: 'parent', parentLeafId: 'leaf', nodeExecutionId: 'fix-live.investigate.1',
  workerId: 'worker-1', workerSessionId: 'child-1', attemptId: 'attempt-1', actualModel: { provider: 'p', id: 'm' },
  ...overrides,
  status: 'streaming' as const, contextSupplementVersion: 0, session, wal, interaction,
});

test('Run Control WAL is durable, permissioned, sequenced, and close-fenced', () => {
  const root = mkdtempSync(join(tmpdir(), 'fix-wal-'));
  const wal = RunControlWal.open('fix-live', { rootDir: root });
  const first = wal.recordSupplement({ submissionAttemptId: 'attempt', nodeExecutionId: 'fix-live.investigate.1', workerSessionId: 'child-1', text: 'new fact' });
  assert.equal(first.payload.sequence, 1);
  wal.closeFence({ nodeExecutionId: 'fix-live.investigate.1' });
  const rejected = wal.recordSupplement({ submissionAttemptId: 'after', nodeExecutionId: 'fix-live.investigate.1', workerSessionId: 'child-1', text: 'retry me' });
  assert.equal(rejected.payload.state, 'rejected_after_fence');
  assert.equal(statSync(join(root, 'workflow-runs', 'fix-live')).mode & 0o777, 0o700);
  assert.equal(statSync(wal.walPath).mode & 0o777, 0o600);
  assert.deepEqual(wal.records().map((record) => record.index), [0, 1, 2, 3]);
  wal.releaseLease();
});

test('replay truncates an incomplete WAL tail before the next writer appends', () => {
  const root = mkdtempSync(join(tmpdir(), 'fix-wal-crash-'));
  const first = RunControlWal.open('fix-crash', { rootDir: root });
  first.recordCheckpoint({ state: 'started' });
  first.releaseLease();
  appendFileSync(first.walPath, '{"type":"checkpoint"');
  const recovered = RunControlWal.open('fix-crash', { rootDir: root });
  assert.equal(recovered.records().length, 2);
  recovered.recordCheckpoint({ state: 'recovered' });
  assert.equal(recovered.records().length, 3);
  recovered.releaseLease();
});

test('WAL rejects a valid record without a newline and internal corruption', () => {
  const root = mkdtempSync(join(tmpdir(), 'fix-wal-integrity-'));
  const wal = RunControlWal.open('fix-integrity', { rootDir: root });
  wal.recordCheckpoint({ state: 'started' });
  wal.releaseLease();
  const contents = readFileSync(wal.walPath, 'utf8');
  writeFileSync(wal.walPath, contents.slice(0, -1));
  assert.throws(() => RunControlWal.open('fix-integrity', { rootDir: root }), (error: unknown) => (error as { code?: string }).code === 'WAL_CORRUPT');
  const internalRoot = mkdtempSync(join(tmpdir(), 'fix-wal-internal-'));
  const internal = RunControlWal.open('fix-internal', { rootDir: internalRoot });
  internal.recordCheckpoint({ state: 'started' });
  internal.releaseLease();
  appendFileSync(internal.walPath, 'not-json\n');
  assert.throws(() => RunControlWal.open('fix-internal', { rootDir: internalRoot }), (error: unknown) => (error as { code?: string }).code === 'WAL_CORRUPT');
});

test('operation locks fail closed for a different host even when its pid is not local', () => {
  const root = mkdtempSync(join(tmpdir(), 'fix-lock-host-'));
  const wal = RunControlWal.open('fix-lock-host', { rootDir: root });
  wal.releaseLease();
  const lockPath = join(root, 'workflow-runs', 'locks', 'fix-lock-host.lock');
  mkdirSync(lockPath);
  writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ host: 'other-host', pid: 1 }));
  assert.throws(() => RunControlWal.open('fix-lock-host', { rootDir: root }), (error: unknown) => (error as { code?: string }).code === 'OPERATION_LOCK_BUSY');
});

test('recovery attempts are capped at twenty per Run and parent rebind preserves run identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'fix-attempts-'));
  const oldParentFile = join(root, 'old-parent.json');
  const newParentFile = join(root, 'new-parent.json');
  const wal = RunControlWal.open('fix-attempts', { rootDir: root, parentSessionId: 'old', parentLeafId: 'old-leaf', parentSessionFile: oldParentFile, cwd: process.cwd() });
  for (let attempt = 0; attempt < 20; attempt += 1) wal.beginWorker({ nodeExecutionId: `fix-attempts.review.${attempt}`, workerId: `w-${attempt}`, workerSessionId: `s-${attempt}` });
  assert.throws(() => wal.beginWorker({ nodeExecutionId: 'fix-attempts.review.21', workerId: 'w-21', workerSessionId: 's-21' }), (error: unknown) => (error as { code?: string }).code === 'WORKER_ATTEMPT_LIMIT');
  wal.releaseLease();
  RunControlWal.rebindParent('fix-attempts', { rootDir: root, parentSessionId: 'new', parentLeafId: 'new-leaf', parentSessionFile: newParentFile, cwd: process.cwd(), confirmed: true });
  const rebound = RunControlWal.open('fix-attempts', { rootDir: root, parentSessionId: 'new', parentLeafId: 'new-leaf', parentSessionFile: newParentFile, cwd: process.cwd() });
  assert.equal(rebound.runId, 'fix-attempts');
  assert.equal(rebound.records().at(-1)?.payload.kind, 'parent_rebind');
  rebound.releaseLease();
});

test('WorkflowInteractionPort routes one input to the bound Child and preserves failed fence input', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fix-port-'));
  const wal = RunControlWal.open('fix-live', { rootDir: root });
  const registry = new ActiveWorkerRegistry();
  const calls: string[] = [];
  const session = {
    isStreaming: true,
    steer: async (text: string) => { calls.push(`steer:${text}`); },
    prompt: async (text: string) => { calls.push(`prompt:${text}`); },
  };
  const port = new WorkflowInteractionPort(registry);
  registry.register(handle(wal, session, port) as any);
  const accepted = await port.submitSupplement({ runId: 'fix-live', expectedNodeExecutionId: 'fix-live.investigate.1', text: 'please check cache' });
  assert.equal(accepted.state, 'enqueue_accepted');
  assert.deepEqual(calls, ['steer:please check cache']);
  await assert.rejects(port.closeWorker('fix-live'), (error: unknown) => error instanceof Error && error.message.includes('lack a completed model call'));
  const retained = await port.submitSupplement({ runId: 'fix-live', expectedNodeExecutionId: 'fix-live.investigate.1', text: 'keep this text' });
  assert.equal(retained.state, 'enqueue_accepted', 'an unbound supplement keeps the Worker open until it is settled');
  registry.release('fix-live');
  wal.releaseLease();
});

test('Worker recovery redelivers each unbound supplement to the replacement Child once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fix-redelivery-'));
  const wal = RunControlWal.open('fix-live', { rootDir: root });
  const registry = new ActiveWorkerRegistry();
  const calls: string[] = [];
  const port = new WorkflowInteractionPort(registry);
  const firstSession = { isStreaming: true, steer: async () => {}, prompt: async () => {} };
  const first = handle(wal, firstSession, port);
  registry.register(first);
  await port.submitSupplement({ runId: 'fix-live', expectedNodeExecutionId: first.nodeExecutionId, text: 'recover this fact' });
  registry.unregisterWorker('fix-live', first.workerSessionId);
  const replacementSession = { isStreaming: false, steer: async () => {}, prompt: async (text: string) => { calls.push(text); } };
  const replacement = { ...first, workerSessionId: 'child-2', workerId: 'worker-2', attemptId: 'attempt-2', recoveryAttempt: 2, session: replacementSession };
  registry.register(replacement);
  await port.reconcileWorker(replacement);
  await port.reconcileWorker(replacement);
  assert.deepEqual(calls, ['recover this fact']);
  await port.recordModelTurnStart('fix-live', 1, 'child-2:turn:1');
  await port.recordModelCallCompleted('fix-live', 'child-2:turn:1');
  await port.bindArtifact('fix-live', { kind: 'investigation', route: 'local_fix', rootCause: 'cause', evidence: ['trace'] });
  await port.closeWorker('fix-live');
  assert.equal(wal.records().filter((record) => record.type === 'delivery' && record.payload.state === 'redelivered').length, 1);
  wal.releaseLease();
});

test('turn_start binds the queued supplement; a late or unrelated message_end ref cannot consume it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fix-turn-'));
  const wal = RunControlWal.open('fix-live', { rootDir: root });
  const registry = new ActiveWorkerRegistry();
  const port = new WorkflowInteractionPort(registry);
  const session = { isStreaming: true, model: { provider: 'p', id: 'm' }, steer: async () => {}, prompt: async () => {} };
  const worker = handle(wal, session, port);
  registry.register(worker as any);
  const accepted = await port.submitSupplement({ runId: 'fix-live', expectedNodeExecutionId: worker.nodeExecutionId, text: 'steer me' });
  assert.equal(accepted.state, 'enqueue_accepted');
  await port.recordModelCallCompleted('fix-live', 'message-end-is-too-late');
  assert.equal(wal.records().some((record) => record.payload.state === 'model_call_completed'), false);
  await assert.rejects(port.closeWorker('fix-live'), /lack a completed model call/);
  await port.recordModelTurnStart('fix-live', 4, 'child-1:turn:4');
  await port.recordModelCallCompleted('fix-live', 'child-1:turn:4');
  await port.bindArtifact('fix-live', { kind: 'investigation', route: 'local_fix', rootCause: 'cause', evidence: ['trace'] });
  await port.closeWorker('fix-live');
  assert.equal(wal.records().filter((record) => record.payload.state === 'artifact_bound').length, 1);
  wal.releaseLease();
});

test('an artifact completed on turn 1 is never rebound to a later supplement after a failed steer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fix-causal-order-'));
  const wal = RunControlWal.open('fix-live', { rootDir: root });
  const registry = new ActiveWorkerRegistry();
  let failSteer = false;
  const session = {
    isStreaming: true,
    model: { provider: 'p', id: 'm' },
    steer: async (text: string) => { if (failSteer) throw new Error(`steer failed: ${text}`); },
    prompt: async () => {},
  };
  const port = new WorkflowInteractionPort(registry);
  const worker = handle(wal, session, port);
  registry.register(worker as any);
  const first = await port.submitSupplement({ runId: 'fix-live', expectedNodeExecutionId: worker.nodeExecutionId, text: 'first fact' });
  await port.recordModelTurnStart('fix-live', 1, 'child-1:turn:1');
  const firstArtifact = await port.bindArtifact('fix-live', { kind: 'investigation', route: 'local_fix', rootCause: 'first', evidence: ['trace'] });
  await port.recordModelCallCompleted('fix-live', 'child-1:turn:1');
  failSteer = true;
  const second = await port.submitSupplement({ runId: 'fix-live', expectedNodeExecutionId: worker.nodeExecutionId, text: 'second fact' });
  assert.equal(second.state, 'delivery_failed');
  const bound = wal.records().filter((record) => record.type === 'delivery' && record.payload.state === 'artifact_bound');
  assert.equal(bound.length, 1);
  assert.equal(bound[0]!.payload.supplementId, first.supplementId);
  assert.equal(bound[0]!.payload.artifactRevisionId, (firstArtifact as any).artifactRevisionId);
  await assert.rejects(port.closeWorker('fix-live'), /lack a completed model call/);
  wal.releaseLease();
});

test('restore projects a pre-Child review identity from the durable startup record', () => {
  const root = mkdtempSync(join(tmpdir(), 'fix-review-startup-'));
  const wal = RunControlWal.open('fix-review-startup', { rootDir: root });
  wal.recordCheckpoint({ checkpoint: { runId: 'fix-review-startup', stage: 'INVESTIGATING', at: 1, id: 'before-review' } });
  wal.beginWorker({ nodeExecutionId: 'fix-review-startup.investigation_review.2', workerId: 'reviewer', workerSessionId: 'child-review' });
  const restored = new RunControlWalStore(wal).loadLast('fix-review-startup');
  assert.equal(restored?.activeNodeId, 'investigation_review');
  assert.equal(restored?.logicalNodeExecutionId, 'fix-review-startup.investigation_review.2');
  assert.equal(restored?.recoveryAttempt, 1);
  wal.releaseLease();
});

test('idle prompt callback can re-enter turn_start, turn_end, and bindArtifact without queue deadlock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fix-prompt-reentry-'));
  const wal = RunControlWal.open('fix-prompt-reentry', { rootDir: root });
  const registry = new ActiveWorkerRegistry();
  const port = new WorkflowInteractionPort(registry);
  const calls: string[] = [];
  let turn: Promise<unknown> | undefined;
  const session = {
    isStreaming: false,
    steer: async () => {},
    prompt: async (text: string) => {
      calls.push(`prompt:${text}`);
      turn = (async () => {
        const started = await port.recordModelTurnStart('fix-prompt-reentry', 1, 'prompt-call-1');
        calls.push(`turn_start:${started?.supplementVersion}`);
        await port.recordModelCallCompleted('fix-prompt-reentry', 'prompt-call-1');
        await port.bindArtifact('fix-prompt-reentry', { kind: 'investigation', route: 'local_fix', rootCause: 'prompt callback', evidence: ['trace'] });
        calls.push('turn_end:bound');
      })();
      await turn;
    },
  };
  const worker = { ...handle(wal, session, port), runId: 'fix-prompt-reentry' } as any;
  registry.register(worker);
  const result = await Promise.race([
    port.submitSupplement({ runId: worker.runId, expectedNodeExecutionId: worker.nodeExecutionId, text: 'idle fact' }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('prompt/turn callback deadlocked')), 1000)),
  ]);
  assert.equal(result.state, 'enqueue_accepted');
  assert.deepEqual(calls, ['prompt:idle fact', 'turn_start:1', 'turn_end:bound']);
  assert.equal(wal.records().filter((record) => record.type === 'delivery' && record.payload.state === 'artifact_bound').length, 1);
  registry.release(worker.runId);
  wal.releaseLease();
});

test('settled reviewer lifecycle never projects an activeReviewAttempt', () => {
  const root = mkdtempSync(join(tmpdir(), 'fix-settled-review-'));
  const wal = RunControlWal.open('fix-settled-review', { rootDir: root });
  wal.recordCheckpoint({ checkpoint: { runId: 'fix-settled-review', stage: 'INVESTIGATING', at: 1, id: 'before-review' } });
  wal.beginWorker({ nodeExecutionId: 'fix-settled-review.investigation_review.1', workerId: 'reviewer-1', workerSessionId: 'child-review', attemptId: 'attempt-review', reviewCycleId: 'cycle-1', reviewerIndex: 0, recoveryAttempt: 1 });
  wal.recordWorker({ kind: 'session_settled', nodeExecutionId: 'fix-settled-review.investigation_review.1', workerId: 'reviewer-1', workerSessionId: 'child-review', attemptId: 'attempt-review', status: 'settled' });
  wal.closeFence({ nodeExecutionId: 'fix-settled-review.investigation_review.1', workerSessionId: 'child-review', attemptId: 'attempt-review' });
  const restored = new RunControlWalStore(wal).loadLast('fix-settled-review');
  assert.equal(restored?.activeReviewAttempt, undefined);
  assert.equal(restored?.activeNodeId, undefined);
  wal.releaseLease();
});

test('model-call snapshots keep cumulative supplement versions after delivery consumption', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fix-snapshot-version-'));
  const wal = RunControlWal.open('fix-snapshot-version', { rootDir: root });
  const registry = new ActiveWorkerRegistry();
  const port = new WorkflowInteractionPort(registry);
  const session = { isStreaming: true, steer: async () => {}, prompt: async () => {} };
  const worker = { ...handle(wal, session, port), runId: 'fix-snapshot-version' } as any;
  registry.register(worker);
  await port.submitSupplement({ runId: worker.runId, expectedNodeExecutionId: worker.nodeExecutionId, text: 'first' });
  const first = await port.recordModelTurnStart(worker.runId, 1, 'call-1');
  await port.recordModelCallCompleted(worker.runId, 'call-1');
  await port.submitSupplement({ runId: worker.runId, expectedNodeExecutionId: worker.nodeExecutionId, text: 'second' });
  const second = await port.recordModelTurnStart(worker.runId, 2, 'call-2');
  assert.equal(first?.supplementVersion, 1);
  assert.equal(second?.supplementVersion, 2);
  assert.deepEqual(wal.records().filter((record) => record.type === 'worker' && record.payload.kind === 'model_call_snapshot').map((record) => record.payload.supplementVersion), [1, 2]);
  registry.release(worker.runId);
  wal.releaseLease();
});

test('model changes are applied only at turn_start, use the reported model, and have one terminal state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fix-model-'));
  const wal = RunControlWal.open('fix-model', { rootDir: root });
  const registry = new ActiveWorkerRegistry();
  const model = { provider: 'p', id: 'old', api: 'anthropic-messages', input: ['text'] };
  const session: any = { model, isStreaming: false, steer: async () => {}, prompt: async () => {}, setModel: async (next: any) => { session.model = next; } };
  const worker = { ...handle(wal, session, undefined as any), runId: 'fix-live', wal } as any;
  const port = new WorkflowInteractionPort(registry, () => [{ ref: 'p/new', model: { provider: 'p', id: 'new', api: 'anthropic-messages', input: ['text'] } as any }]);
  registry.register(worker);
  const stale = await port.requestModelChange({ runId: worker.runId, expectedNodeExecutionId: worker.nodeExecutionId, expectedWorkerSessionId: 'stale-session', expectedAttemptId: worker.attemptId, modelRef: 'p/new' });
  assert.equal(stale.state, 'failed');
  assert.match(stale.error ?? '', /session or attempt changed/);
  const result = await port.requestModelChange({ runId: worker.runId, expectedNodeExecutionId: worker.nodeExecutionId, expectedWorkerSessionId: worker.workerSessionId, expectedAttemptId: worker.attemptId, modelRef: 'p/new' });
  assert.equal(result.state, 'pending');
  await port.recordModelTurnStart(worker.runId, 1, 'child-1:turn:1');
  const changes = wal.records().filter((record) => record.type === 'worker' && record.payload.kind === 'model_change');
  assert.equal(changes.filter((record) => record.payload.state === 'applied').length, 1);
  assert.equal(changes.filter((record) => record.payload.state === 'not_applied' || record.payload.state === 'failed').length, 0);
  assert.deepEqual(worker.actualModel, { provider: 'p', id: 'new' });
  registry.release(worker.runId);
  wal.releaseLease();
});

test('model requests fold by requestId and close creates only one terminal state per request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fix-model-fold-'));
  const wal = RunControlWal.open('fix-live', { rootDir: root });
  const registry = new ActiveWorkerRegistry();
  const session: any = { model: { provider: 'p', id: 'old' }, isStreaming: false, steer: async () => {}, prompt: async () => {}, setModel: async (model: any) => { session.model = model; } };
  const worker = handle(wal, session, undefined as any);
  const port = new WorkflowInteractionPort(registry, () => [
    { ref: 'p/a', model: { provider: 'p', id: 'a', api: 'anthropic-messages', input: ['text'] } as any },
    { ref: 'p/b', model: { provider: 'p', id: 'b', api: 'anthropic-messages', input: ['text'] } as any },
  ]);
  registry.register(worker as any);
  const a = await port.requestModelChange({ runId: 'fix-live', expectedNodeExecutionId: worker.nodeExecutionId, expectedWorkerSessionId: worker.workerSessionId, expectedAttemptId: worker.attemptId, modelRef: 'p/a' });
  const b = await port.requestModelChange({ runId: 'fix-live', expectedNodeExecutionId: worker.nodeExecutionId, expectedWorkerSessionId: worker.workerSessionId, expectedAttemptId: worker.attemptId, modelRef: 'p/b' });
  await port.recordModelTurnStart('fix-live', 1, 'child-1:turn:1');
  const afterTurn = wal.records().filter((record) => record.type === 'worker' && record.payload.kind === 'model_change');
  for (const requestId of [a.requestId, b.requestId]) assert.equal(afterTurn.filter((record) => record.payload.requestId === requestId && ['applied', 'failed', 'not_applied'].includes(String(record.payload.state))).length, 1);
  await port.closeWorker('fix-live');
  const afterClose = wal.records().filter((record) => record.type === 'worker' && record.payload.kind === 'model_change');
  assert.equal(afterClose.filter((record) => record.payload.state === 'not_applied').length, 0);
  wal.releaseLease();
});

test('a starting owner intercepts without committing a sequence and a publication gap stores only edited content', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fix-publication-gap-'));
  const wal = RunControlWal.open('fix-live', { rootDir: root });
  const registry = new ActiveWorkerRegistry();
  registry.reserve({ runId: 'fix-live', parentSessionId: 'parent', parentLeafId: 'leaf', nodeExecutionId: 'fix-live.investigate.1', status: 'starting', wal });
  const port = new WorkflowInteractionPort(registry);
  const starting = await port.submitSupplement({ runId: 'fix-live', expectedNodeExecutionId: 'fix-live.investigate.1', text: 'keep while starting' });
  assert.equal(starting.supplementId, undefined);
  assert.equal(wal.records().filter((record) => record.type === 'supplement').length, 0);
  const owner = registry.owner('fix-live')!;
  owner.status = 'running';
  const gap = await port.submitSupplement({ runId: 'fix-live', expectedNodeExecutionId: owner.nodeExecutionId, text: 'keep during publication gap' });
  assert.equal(gap.supplementId, undefined);
  assert.equal(wal.records().filter((record) => record.type === 'supplement').length, 0);
  const retained = wal.records().at(-1)!.payload;
  assert.equal(retained.text, 'keep during publication gap');
  assert.equal(retained.sequence, undefined);
  wal.releaseLease();
});

test('sidecar refs survive a renderer reload and retain Unicode text', () => {
  const root = mkdtempSync(join(tmpdir(), 'fix-sidecar-reload-'));
  const wal = RunControlWal.open('fix-sidecar', { rootDir: root });
  const sidecar = new WorkerSidecar(wal.runDir);
  sidecar.append({ ref: 'opaque-ref', runId: 'fix-sidecar', nodeId: 'investigate', eventKind: 'visible_text', text: '修复 ✅ café', occurredAt: new Date().toISOString() });
  const reloaded = WorkerSidecar.openExisting(wal.runDir);
  assert.equal(reloaded?.get('opaque-ref')?.text, '修复 ✅ café');
  wal.releaseLease();
});

test('GC uses terminal Run state and tombstone rename rather than constructor-time sidecar unlink', () => {
  const root = mkdtempSync(join(tmpdir(), 'fix-gc-'));
  const wal = RunControlWal.open('fix-gc', { rootDir: root });
  wal.recordCheckpoint({ checkpoint: { runId: 'fix-gc', stage: 'ACCEPTED', gcDeadline: 0, id: 'accepted', at: 1 } });
  const sidecar = new WorkerSidecar(wal.runDir);
  sidecar.append({ ref: 'r', runId: 'fix-gc', nodeId: 'investigate', eventKind: 'visible_text', text: 'done', occurredAt: new Date().toISOString() });
  wal.releaseLease();
  assert.equal(WorkerSidecar.gc(root, Date.now(), 0, 0), 1);
  assert.deepEqual(RunControlWal.list(root), []);
  assert.throws(() => RunControlWal.open('fix-gc', { rootDir: root }), (error: unknown) => (error as { code?: string }).code === 'RUN_TOMBSTONED');
});

test('a new Node reopens the WAL target without reusing the old Worker', () => {
  const root = mkdtempSync(join(tmpdir(), 'fix-wal-next-'));
  const wal = RunControlWal.open('fix-live', { rootDir: root });
  wal.closeFence({ nodeExecutionId: 'fix-live.intake.1' });
  wal.beginWorker({ nodeExecutionId: 'fix-live.investigate.2', workerId: 'worker-2', workerSessionId: 'child-2' });
  const supplement = wal.recordSupplement({ submissionAttemptId: 'next', nodeExecutionId: 'fix-live.investigate.2', workerSessionId: 'child-2', text: 'next node fact' });
  assert.equal(supplement.payload.sequence, 1);
  assert.equal(supplement.payload.nodeExecutionId, 'fix-live.investigate.2');
  wal.releaseLease();
});
