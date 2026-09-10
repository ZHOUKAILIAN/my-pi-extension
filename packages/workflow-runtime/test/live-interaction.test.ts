import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActiveWorkerRegistry, RunControlWal, WorkflowInteractionPort } from '../src/index.ts';

const handle = (wal: RunControlWal, session: any, interaction: WorkflowInteractionPort) => ({
  runId: 'fix-live', parentSessionId: 'parent', parentLeafId: 'leaf', nodeExecutionId: 'fix-live.investigate.1',
  workerId: 'worker-1', workerSessionId: 'child-1', attemptId: 'attempt-1', actualModel: { provider: 'p', id: 'm' },
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
  await port.recordModelCallCompleted('fix-live', 'child-2:call');
  await port.bindArtifact('fix-live', { kind: 'investigation', route: 'local_fix', rootCause: 'cause', evidence: ['trace'] });
  await port.closeWorker('fix-live');
  assert.equal(wal.records().filter((record) => record.type === 'delivery' && record.payload.state === 'redelivered').length, 1);
  wal.releaseLease();
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
