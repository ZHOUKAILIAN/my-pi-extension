import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowRuntime, InMemoryUserDecisionGate } from '../src/index.ts';
import { fixDefinition } from './fixtures/legacy-fix-definition.ts';

test('requirement/design investigation waits, checkpoints, and resumes only with decision', async () => {
  const checkpoints: any[] = []; const gate = new InMemoryUserDecisionGate();
  const r = new WorkflowRuntime(fixDefinition, { saveCheckpoint: c => checkpoints.push(c), loadLast: () => checkpoints.at(-1) }, 'r', () => 1, () => 'c');
  r.setDecisionGate(gate);
  await r.runNode({ id: 'investigate', worker: { execute: async () => ({ kind: 'investigation', route: 'design_change', rootCause: 'cause', evidence: ['x'] }) } }, {});
  assert.equal(r.stage, 'WAITING_FOR_USER'); assert.equal(checkpoints.at(-1).stage, 'WAITING_FOR_USER');
  assert.throws(() => r.resume(), /decision/);
  gate.decide({ kind: 'user_decision', decision: 'continue_investigating', requestId: 'unused' });
  assert.throws(() => r.resume(), /decision/);
  gate.decide({ kind: 'user_decision', decision: 'continue_investigating'});
  // 决策来源诚实性（round-5 P5）(a)：decide() 失败（requestId 不匹配）后不得把 runtime:decide
  // 来源泄漏给后续 legacy resume；此时仍在 WAITING_FOR_USER。
  assert.throws(() => r.decide({ kind: 'user_decision', decision: 'continue_investigating', requestId: 'nope' }), /requestId/);
  r.resume();
  assert.equal(r.stage, 'INVESTIGATING');
  // 决策来源诚实性 (b)：legacy resume() 不是 decide() 产出——不附加 v2 决策来源记录
  //（decisionRecord），且 requestId 缺失时不得写出 'undefined' 字面量 decisionReference。
  const last = checkpoints.at(-1) as Record<string, unknown>;
  assert.equal('decisionRecord' in last, false, 'legacy resume checkpoint must not carry a runtime:decide decisionRecord');
  assert.equal(last.decisionReference, undefined);
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
