import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowRuntime, fixDefinition, type Artifact, type WorkerExecutor } from '../src/index.ts';

test('runtime rejects worker-authorized nextStage and invalid transitions', async () => {
  const runtime = new WorkflowRuntime(fixDefinition, { saveCheckpoint() {}, loadLast() { return undefined; } });
  assert.equal(runtime.stage, 'INVESTIGATING');
  assert.throws(() => runtime.transition('ACCEPTED'), /invalid transition/);
  const worker: WorkerExecutor = { execute: async () => ({ kind: 'worker', nextStage: 'ACCEPTED' } as Artifact) };
  await assert.rejects(() => runtime.runNode({ id: 'investigate', worker }, {}), /unsupported artifact kind: worker/);
  assert.equal(runtime.stage, 'INVESTIGATING');
});

test('fake worker e2e requires evidence and verifies checkpoint recovery', async () => {
  const checkpoints: any[] = [];
  const store = { saveCheckpoint: (c: any) => checkpoints.push(c), loadLast: () => checkpoints.at(-1) };
  const runtime = new WorkflowRuntime(fixDefinition, store);
  const evidence: WorkerExecutor = { execute: async () => ({ kind: 'investigation', route: 'local_fix', rootCause: 'cause', evidence: ['trace'] }) };
  await runtime.runNode({ id: 'investigate', worker: evidence }, {});
  assert.equal(runtime.stage, 'IMPLEMENTING');
  const restored = WorkflowRuntime.restore(fixDefinition, store);
  assert.equal(restored.stage, 'IMPLEMENTING');
  assert.deepEqual(restored.getArtifacts(), [{ kind: 'investigation', route: 'local_fix', rootCause: 'cause', evidence: ['trace'] }]);
});
