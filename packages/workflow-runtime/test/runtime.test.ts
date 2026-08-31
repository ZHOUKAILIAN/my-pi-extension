import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowRuntime, type Artifact, type WorkerExecutor } from '../src/index.ts';
import { fixDefinition } from './fixtures/legacy-fix-definition.ts';

test('runtime rejects worker-authorized nextStage and invalid transitions', async () => {
  const runtime = new WorkflowRuntime(fixDefinition, { saveCheckpoint() {}, loadLast() { return undefined; } });
  assert.equal(runtime.stage, 'INVESTIGATING');
  // legacy 定义未 opt-in 受控终局：ACCEPTED 由其自身 guard 决定，无验证证据的直传（INVESTIGATING→ACCEPTED）
  // 被 guard 拒绝（不允许该边），不走 Runtime 受控路径。
  assert.throws(() => runtime.transition('ACCEPTED'), /invalid transition INVESTIGATING -> ACCEPTED/);
  const worker: WorkerExecutor = { execute: async () => ({ kind: 'worker', nextStage: 'ACCEPTED' } as Artifact) };
  await assert.rejects(() => runtime.runNode({ id: 'investigate', worker }, {}), /unsupported artifact kind: worker/);
  assert.equal(runtime.stage, 'INVESTIGATING');
});

test('legacy workflow: VERIFYING -> ACCEPTED via accepted verification, and the ACCEPTED checkpoint restores under legacy semantics', async () => {
  const checkpoints: any[] = [];
  const store = { saveCheckpoint: (c: any) => checkpoints.push(c), loadLast: () => checkpoints.at(-1) };
  const runtime = new WorkflowRuntime(fixDefinition, store);
  const investigation: WorkerExecutor = { execute: async () => ({ kind: 'investigation', route: 'local_fix', rootCause: 'cause', evidence: ['trace'] }) };
  await runtime.runNode({ id: 'investigate', worker: investigation }, {});
  assert.equal(runtime.stage, 'IMPLEMENTING');
  // legacy fixDefinition 允许 IMPLEMENTING → VERIFYING。
  runtime.transition('VERIFYING');
  const verification: WorkerExecutor = { execute: async () => ({ kind: 'verification', accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1' }) };
  await runtime.runNode({ id: 'verify', worker: verification }, {});
  // legacy 定义未 opt-in 受控终局：验证 accepted 按其自身 guard 进入 ACCEPTED（v2 三向路由/WAITING_FOR_USER 不生效）。
  assert.equal(runtime.stage, 'ACCEPTED');
  // legacy ACCEPTED checkpoint 可恢复：不要求 decisionReference/pendingDecisionRequest/sourceVersion
  //（legacy 的 ACCEPTED 是定义 guard 的产出，非 Runtime 决策记录）。
  const restored = WorkflowRuntime.restore(fixDefinition, store);
  assert.equal(restored.stage, 'ACCEPTED');
  assert.ok(restored.getArtifacts().some((artifact) => artifact.kind === 'verification' && (artifact as { accepted?: boolean }).accepted === true));
});

test('legacy workflow: verification accepted=false without the structured failure field keeps the legacy guard semantics', async () => {
  const runtime = new WorkflowRuntime(fixDefinition, { saveCheckpoint() {}, loadLast() { return undefined; } });
  const investigation: WorkerExecutor = { execute: async () => ({ kind: 'investigation', route: 'local_fix', rootCause: 'cause', evidence: ['trace'] }) };
  await runtime.runNode({ id: 'investigate', worker: investigation }, {});
  runtime.transition('VERIFYING');
  // 旧验证失败形状（accepted=false 但无结构化 failure）：结构化 failure 契约只约束受控结论定义
  //（requiresArtifactConclusion 上下文）；legacy 定义（runNode 无上下文校验）按自身 guard 语义处理：
  // VERIFYING→IMPLEMENTING 只要求 accepted=false + 证据，不要求 failure 类别。
  const oldShapeFailure: WorkerExecutor = { execute: async () => ({ kind: 'verification', accepted: false, evidence: ['failing-test'], candidateRevision: 'rev-1' }) };
  const artifact = await runtime.runNode({ id: 'verify', worker: oldShapeFailure }, {});
  assert.equal(runtime.stage, 'IMPLEMENTING');
  assert.equal(artifact.kind, 'verification');
});

test('legacy workflow: structured-failure contract never applies to legacy (context stays absent) and accepted verification still reaches ACCEPTED', async () => {
  const checkpoints: any[] = [];
  const store = { saveCheckpoint: (c: any) => checkpoints.push(c), loadLast: () => checkpoints.at(-1) };
  const runtime = new WorkflowRuntime(fixDefinition, store);
  await runtime.runNode({ id: 'investigate', worker: { execute: async () => ({ kind: 'investigation', route: 'local_fix', rootCause: 'cause', evidence: ['trace'] }) } }, {});
  runtime.transition('VERIFYING');
  // legacy 失败（accepted=false + 结构化 failure 也可选地出现在 legacy 形状中）→ 回 IMPLEMENTING，不入 ACCEPTED。
  await runtime.runNode({ id: 'verify', worker: { execute: async () => ({ kind: 'verification', accepted: false, evidence: ['failing-test'], candidateRevision: 'rev-1', failure: { kind: 'implementation', reason: 'reproduced' } }) } }, {});
  assert.equal(runtime.stage, 'IMPLEMENTING');
  // 回到 VERIFYING 后，legacy accepted=true 验证按其自身 guard 进入 ACCEPTED，不受 v2 失败契约影响。
  runtime.transition('VERIFYING');
  await runtime.runNode({ id: 'verify', worker: { execute: async () => ({ kind: 'verification', accepted: true, evidence: ['test:passed'], candidateRevision: 'rev-1' }) } }, {});
  assert.equal(runtime.stage, 'ACCEPTED');
  // legacy ACCEPTED checkpoint 可恢复：不要求 decisionReference/sourceVersion（legacy 是定义 guard 的产出）。
  const restored = WorkflowRuntime.restore(fixDefinition, store);
  assert.equal(restored.stage, 'ACCEPTED');
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
