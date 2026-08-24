import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowRuntime, fixDefinition, InMemoryUserDecisionGate } from '../src/index.ts';

test('requirement/design investigation waits, checkpoints, and resumes only with decision', async () => {
  const checkpoints: any[] = []; const gate = new InMemoryUserDecisionGate();
  const r = new WorkflowRuntime(fixDefinition, { saveCheckpoint: c => checkpoints.push(c), loadLast: () => checkpoints.at(-1) }, 'r', () => 1, () => 'c');
  r.setDecisionGate(gate);
  await r.runNode({ id: 'investigate', worker: { execute: async () => ({ kind: 'investigation', route: 'design_change', rootCause: 'cause', evidence: ['x'] }) } }, {});
  assert.equal(r.stage, 'WAITING_FOR_USER'); assert.equal(checkpoints.at(-1).stage, 'WAITING_FOR_USER');
  assert.throws(() => r.resume(), /decision/);
  gate.decide({ kind: 'user_decision', decision: 'continue_investigating', requestId: 'unused' });
  assert.throws(() => r.resume(), /decision/);
  gate.decide({ kind: 'user_decision', decision: 'continue_investigating' }); r.resume();
  assert.equal(r.stage, 'INVESTIGATING');
});

test('decision gate rejects a mismatched request without consuming the decision', () => {
  const gate = new InMemoryUserDecisionGate();
  gate.decide({ kind: 'user_decision', decision: 'continue_investigating', requestId: 'req-1' });
  assert.equal(gate.getDecision('wrong'), undefined);
  assert.equal(gate.getDecision('req-1')?.requestId, 'req-1');
});

test('decision gate consumes a matching request exactly once', () => {
  const gate = new InMemoryUserDecisionGate();
  gate.decide({ kind: 'user_decision', decision: 'continue_investigating', requestId: 'req-2' });
  assert.ok(gate.getDecision('req-2'));
  assert.equal(gate.getDecision('req-2'), undefined);
});
