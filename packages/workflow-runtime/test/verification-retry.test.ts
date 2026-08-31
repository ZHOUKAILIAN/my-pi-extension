import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowRuntime } from '../src/index.ts';
import { fixDefinition } from './fixtures/legacy-fix-definition.ts';

test('verification failure returns to implement with a checkpoint', async () => {
  const checkpoints: any[] = [];
  const runtime = new WorkflowRuntime(fixDefinition, { saveCheckpoint: c => checkpoints.push(c), loadLast: () => checkpoints.at(-1) }, 'verify-retry');
  runtime.stage = 'VERIFYING';
  await runtime.runNode({ id: 'verify', worker: { execute: async () => ({ kind: 'verification', accepted: false, evidence: ['failing test'], candidateRevision: 'rev-1', failure: { kind: 'implementation', reason: 'failing test' } }) } }, {});
  assert.equal(runtime.stage, 'IMPLEMENTING');
  assert.equal(checkpoints.at(-1).stage, 'IMPLEMENTING');
});
