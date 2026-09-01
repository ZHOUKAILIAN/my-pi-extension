// submit_artifact per-kind schema 上游门禁回归测试（方案 v2 §6.2-6.4）：
// 不写裸 JSON Schema 校验器，直接用 pi-ai 的 validateToolArguments（生产路径是
// convert → validate，裸校验器测不出 coerce 差异）对每个 kind 的 schema 做「convert→validate」实测。
import test from 'node:test';
import assert from 'node:assert/strict';
// pi-ai 嵌套在 pi-coding-agent 的 node_modules 下（workspace 未直接声明依赖，按已装模块相对解析）。
// @ts-expect-error installed module without type declarations for this subpath
import { validateToolArguments } from '../../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils/validation.js';
import { PiSdkWorkerExecutor } from '../src/index.ts';
import { validateSubmitArtifact, NODE_ARTIFACT_KINDS, ARTIFACT_JSON_SCHEMAS } from '@pi/workflow-contracts';
import type { WorkerProgress } from '../src/pi-sdk-worker.ts';

const validate = (schema: unknown, args: unknown): unknown =>
  validateToolArguments({ name: 'submit_artifact', parameters: schema }, { name: 'submit_artifact', arguments: args });

// 各 kind 的合法完整样例（字段级合法 + kind enum 匹配），经 pi 管道 convert→validate 后
// 还应通过权威层 validateSubmitArtifact（双门禁一致）。
const VALID_SAMPLES: Record<string, Record<string, unknown>> = {
  intake: { kind: 'intake', summary: 'save fails with timeout', overview: 'payments 保存超时', environment: 'prod', scope: 'payments', urgency: 'high' },
  investigation: { kind: 'investigation', route: 'local_fix', rootCause: 'missing null check', evidence: ['log:trace-1'] },
  implementation: { kind: 'implementation', artifact: { summary: 'patch', filesChanged: ['a.ts'], candidateRevision: 'rev-1' } },
  verification: { kind: 'verification', accepted: true, evidence: ['test:passed'] },
  investigation_review: { kind: 'investigation_review', rootCauseConclusion: 'missing null check', evidenceSufficiency: 'sufficient', gaps: [], conclusion: { status: 'accepted', summary: 'confirmed' } },
  disposition: { kind: 'disposition', dispositionType: 'remediation', requiresRepositoryChange: true, minimalScope: 'one null check', risks: [], verificationTarget: 'original issue', conclusion: { status: 'accepted', summary: 'remediate' } },
  change_plan_review: { kind: 'change_plan_review', rootCauseAlignment: true, changedScope: 'one null check', risks: [], compatibility: [], verification: ['npm test'], rollback: ['git revert'], findings: [{ id: 'f1', summary: 'scope minimal' }], conclusion: { status: 'accepted', summary: 'plan approved' } },
  change_review: { kind: 'change_review', findings: [], findingDisposition: 'all_closed', conclusion: { status: 'accepted', summary: 'approved' } },
};

test('pi gate: every worker node id is bound to a per-kind schema', () => {
  for (const [nodeId, kind] of Object.entries(NODE_ARTIFACT_KINDS)) {
    assert.ok((ARTIFACT_JSON_SCHEMAS as Record<string, unknown>)[kind], `${nodeId} → ${kind} schema must exist`);
  }
});

test('pi gate: each node schema pins kind single-value enum and required list', () => {
  for (const [nodeId, kind] of Object.entries(NODE_ARTIFACT_KINDS)) {
    const schema = (ARTIFACT_JSON_SCHEMAS as Record<string, any>)[kind];
    assert.deepEqual(schema.properties.kind, { type: 'string', enum: [kind] }, `${nodeId}: kind must be a single-value enum`);
    assert.ok(schema.required.includes('kind'), `${nodeId}: kind must be required`);
    assert.equal(schema.additionalProperties, true, `${nodeId}: envelope fields must stay allowed`);
  }
  // 节点绑定抽查：boolean 判决字段不带 type 关键字（探针结论，见方案 §7）。
  const cpr = (ARTIFACT_JSON_SCHEMAS as Record<string, any>).change_plan_review;
  assert.deepEqual(cpr.properties.rootCauseAlignment, { enum: [true, false] });
  assert.equal(cpr.properties.rootCauseAlignment.type, undefined);
  const disp = (ARTIFACT_JSON_SCHEMAS as Record<string, any>).disposition;
  assert.deepEqual(disp.properties.requiresRepositoryChange, { enum: [true, false] });
  const ver = (ARTIFACT_JSON_SCHEMAS as Record<string, any>).verification;
  assert.deepEqual(ver.properties.accepted, { enum: [true, false] });
});

test('pi gate: valid complete samples pass the real pi pipeline and the authority layer', () => {
  for (const [kind, sample] of Object.entries(VALID_SAMPLES)) {
    const schema = (ARTIFACT_JSON_SCHEMAS as Record<string, unknown>)[kind];
    const converted = validate(schema, sample);
    assert.deepEqual(converted, sample, `${kind}: pi pipeline must not alter a valid sample`);
    assert.doesNotThrow(() => validateSubmitArtifact(converted), `${kind}: authority layer must accept`);
  }
});

test('pi gate: boolean verdict field rejects "true"/null/1 (regression for INVALID_CHANGE_PLAN_REVIEW_ROOT_CAUSE_ALIGNMENT)', () => {
  const schema = (ARTIFACT_JSON_SCHEMAS as Record<string, unknown>).change_plan_review;
  for (const bad of ['true', null, 1]) {
    assert.throws(
      () => validate(schema, { kind: 'change_plan_review', rootCauseAlignment: bad }),
      /Validation failed[\s\S]*rootCauseAlignment/,
      `rootCauseAlignment: ${String(bad)} must be rejected by the pi entry gate`,
    );
  }
  // 合法 boolean（完整 required 字段）通过。
  assert.doesNotThrow(() => validate(schema, VALID_SAMPLES.change_plan_review));
  // 权威层对同一故障输入仍拒绝（双门禁语义一致）。
  assert.throws(
    () => validateSubmitArtifact({ kind: 'change_plan_review', rootCauseAlignment: 'true' }),
    (error: unknown) => (error as { code?: string }).code === 'INVALID_CHANGE_PLAN_REVIEW_ROOT_CAUSE_ALIGNMENT',
  );
});

test('pi gate: verification accepted and disposition requiresRepositoryChange reject coerced inputs', () => {
  assert.throws(() => validate((ARTIFACT_JSON_SCHEMAS as Record<string, unknown>).verification, { kind: 'verification', accepted: 'true' }), /Validation failed/);
  assert.throws(() => validate((ARTIFACT_JSON_SCHEMAS as Record<string, unknown>).verification, { kind: 'verification', accepted: null }), /Validation failed/);
  assert.throws(() => validate((ARTIFACT_JSON_SCHEMAS as Record<string, unknown>).disposition, { kind: 'disposition', requiresRepositoryChange: 'yes' }), /Validation failed/);
});

test('pi gate: string fields coerce numbers to strings (known platform behavior, accepted)', () => {
  // filesChanged: [123] → ["123"]，pi 转换后通过，权威层同样接受。
  const schema = (ARTIFACT_JSON_SCHEMAS as Record<string, unknown>).implementation;
  const converted = validate(schema, { kind: 'implementation', artifact: { summary: 'patch', filesChanged: [123], candidateRevision: 'rev-1' } }) as any;
  assert.deepEqual(converted.artifact.filesChanged, ['123']);
  assert.doesNotThrow(() => validateSubmitArtifact(converted));
  // 可选字段 null：pi 删除该字段后通过（等价于未提供）。
  const withNull = validate(schema, { kind: 'implementation', artifact: { summary: 'patch', filesChanged: ['a.ts'], candidateRevision: 'rev-1', prUrl: null } }) as any;
  assert.equal('prUrl' in withNull.artifact, false);
  assert.doesNotThrow(() => validateSubmitArtifact(withNull));
});

test('pi gate: missing required fields are rejected at the entry gate', () => {
  assert.throws(() => validate((ARTIFACT_JSON_SCHEMAS as Record<string, unknown>).investigation, { kind: 'investigation', route: 'local_fix' }), /Validation failed[\s\S]*rootCause/);
  assert.throws(() => validate((ARTIFACT_JSON_SCHEMAS as Record<string, unknown>).intake, { kind: 'intake', summary: 'only summary' }), /Validation failed[\s\S]*overview/);
  assert.throws(() => validate((ARTIFACT_JSON_SCHEMAS as Record<string, unknown>).change_plan_review, { kind: 'change_plan_review' }), /Validation failed[\s\S]*rootCauseAlignment/);
});

// F1 回归（code_reviewer P1）：stringList/implementationDetails 变体必须参与 required 派生，
// 每组逐个删除后双门禁都必须拒绝，且权威层错误码钉住。
test('pi gate: missing required fields previously leaked from the type whitelist are rejected by both gates', () => {
  const omit = (kind: string, field: string): Record<string, unknown> => {
    const copy = { ...VALID_SAMPLES[kind] } as Record<string, unknown>;
    delete copy[field];
    return copy;
  };
  const cases: { kind: string; field: string; authorityCode: string }[] = [
    { kind: 'implementation', field: 'artifact', authorityCode: 'MISSING_IMPLEMENTATION_DETAILS' },
    { kind: 'investigation_review', field: 'gaps', authorityCode: 'INVALID_INVESTIGATION_REVIEW_GAPS' },
    { kind: 'disposition', field: 'risks', authorityCode: 'INVALID_DISPOSITION_RISKS' },
    { kind: 'change_plan_review', field: 'risks', authorityCode: 'INVALID_CHANGE_PLAN_REVIEW_RISKS' },
    { kind: 'change_plan_review', field: 'compatibility', authorityCode: 'INVALID_CHANGE_PLAN_REVIEW_COMPATIBILITY' },
    { kind: 'change_plan_review', field: 'verification', authorityCode: 'INVALID_CHANGE_PLAN_REVIEW_VERIFICATION' },
    { kind: 'change_plan_review', field: 'rollback', authorityCode: 'INVALID_CHANGE_PLAN_REVIEW_ROLLBACK' },
  ];
  for (const { kind, field, authorityCode } of cases) {
    const schema = (ARTIFACT_JSON_SCHEMAS as Record<string, unknown>)[kind];
    const missing = omit(kind, field);
    assert.throws(() => validate(schema, missing), new RegExp(`Validation failed[\\s\\S]*${field}`), `${kind}.${field} missing must be rejected at the pi entry gate`);
    assert.throws(
      () => validateSubmitArtifact(missing),
      (error: unknown) => (error as { code?: string }).code === authorityCode,
      `${kind}.${field} missing must be rejected by the authority layer with ${authorityCode}`,
    );
  }
});

// stringList 语义：必须存在、可为空数组——缺省拒（上方测试）、[] 过（本测试），双门禁一致。
test('pi gate: stringList fields accept empty arrays at both gates', () => {
  for (const kind of ['investigation_review', 'disposition', 'change_plan_review']) {
    const schema = (ARTIFACT_JSON_SCHEMAS as Record<string, unknown>)[kind];
    const converted = validate(schema, VALID_SAMPLES[kind]);
    assert.deepEqual(converted, VALID_SAMPLES[kind], `${kind}: empty stringList arrays must pass the pi entry gate unchanged`);
    assert.doesNotThrow(() => validateSubmitArtifact(converted), `${kind}: empty stringList arrays must pass the authority layer`);
  }
});

// required 清单钉住（方案 §4）：由 FieldRule.required 单源派生，禁止再出现类型白名单遗漏。
test('pi gate: per-kind required lists match the contract exactly', () => {
  const expected: Record<string, string[]> = {
    intake: ['kind', 'summary', 'overview'],
    investigation: ['kind', 'route', 'rootCause', 'evidence'],
    implementation: ['kind', 'artifact'],
    verification: ['kind', 'accepted', 'evidence'],
    investigation_review: ['kind', 'rootCauseConclusion', 'evidenceSufficiency', 'gaps', 'conclusion'],
    disposition: ['kind', 'dispositionType', 'requiresRepositoryChange', 'minimalScope', 'risks', 'verificationTarget', 'conclusion'],
    change_plan_review: ['kind', 'rootCauseAlignment', 'changedScope', 'risks', 'compatibility', 'verification', 'rollback', 'findings', 'conclusion'],
    change_review: ['kind', 'findings', 'findingDisposition', 'conclusion'],
  };
  for (const [kind, required] of Object.entries(expected)) {
    assert.deepEqual((ARTIFACT_JSON_SCHEMAS as Record<string, any>)[kind].required, required, `${kind}: required list must match the contract`);
  }
  // 嵌套对象内部 required 保持不变。
  assert.deepEqual((ARTIFACT_JSON_SCHEMAS as Record<string, any>).implementation.properties.artifact.required, ['summary', 'filesChanged', 'candidateRevision']);
  assert.deepEqual((ARTIFACT_JSON_SCHEMAS as Record<string, any>).investigation_review.properties.conclusion.required, ['status', 'summary']);
  assert.deepEqual((ARTIFACT_JSON_SCHEMAS as Record<string, any>).change_plan_review.properties.findings.items.required, ['id', 'summary']);
});

// F2：导出深冻结——模块级可变对象被直接引用进每次工具声明，任何原地修改会静默污染后续节点。
test('pi gate: ARTIFACT_JSON_SCHEMAS is deep frozen and immutable in place', () => {
  for (const schema of Object.values(ARTIFACT_JSON_SCHEMAS)) {
    assert.ok(Object.isFrozen(schema), 'per-kind schema must be frozen');
    assert.ok(Object.isFrozen((schema as { properties: unknown }).properties), 'properties must be frozen');
    assert.ok(Object.isFrozen((schema as { required: unknown }).required), 'required array must be frozen');
  }
  // 嵌套共享子对象（implementationDetails / evidence item / conclusion / finding schema）也被冻结。
  assert.ok(Object.isFrozen((ARTIFACT_JSON_SCHEMAS as Record<string, any>).implementation.properties.artifact));
  assert.ok(Object.isFrozen((ARTIFACT_JSON_SCHEMAS as Record<string, any>).investigation.properties.evidence.items));
  // 原地修改被拒绝（ESM 模块为严格模式）：冻结对象不可被污染。
  assert.throws(() => { (ARTIFACT_JSON_SCHEMAS as Record<string, any>).disposition.required.push('extra'); });
  assert.throws(() => { (ARTIFACT_JSON_SCHEMAS as Record<string, any>).intake.properties.summary.type = 'number'; });
});

test('runtime binding: submit_artifact tool is bound to the node kind schema', async () => {
  let boundSchema: unknown;
  let boundDescription: unknown;
  const resourceLoader: any = { reload: async () => {}, getSkills: () => ({ skills: [], diagnostics: [] }) };
  const executor = new PiSdkWorkerExecutor({
    model: { provider: 'p', id: 'm' },
    resourceLoader,
    createSession: async (request: any) => {
      const tool = request.customTools.find((item: any) => item.name === 'submit_artifact');
      boundSchema = tool.parameters;
      boundDescription = tool.description;
      return { session: { prompt: async () => {
        await tool.execute('call-1', { kind: 'change_plan_review', rootCauseAlignment: 'true' });
      } } };
    },
  });
  await assert.rejects(
    executor.execute({ id: 'change_plan_review', profile: { tools: ['read'] } }, 'task', {}),
    (error: unknown) => (error as { code?: string }).code === 'INVALID_CHANGE_PLAN_REVIEW_ROOT_CAUSE_ALIGNMENT',
  );
  assert.deepEqual((boundSchema as any).properties.rootCauseAlignment, { enum: [true, false] });
  assert.ok(boundDescription);
});

test('runtime binding: unknown node id falls back to loose schema and emits a visible schema_fallback event', async () => {
  const progress: WorkerProgress[] = [];
  let boundSchema: any;
  const resourceLoader: any = { reload: async () => {}, getSkills: () => ({ skills: [], diagnostics: [] }) };
  const executor = new PiSdkWorkerExecutor({
    model: { provider: 'p', id: 'm' },
    resourceLoader,
    onProgress: (event) => progress.push(event),
    createSession: async (request: any) => {
      const tool = request.customTools.find((item: any) => item.name === 'submit_artifact');
      boundSchema = tool.parameters;
      return { session: { prompt: async () => {
        // 宽松 schema 不挡 shape；结构合法性由 execute 内权威层兜底拒绝。
        await tool.execute('call-1', { kind: 'nope' });
      } } };
    },
  });
  await assert.rejects(
    executor.execute({ id: 'mystery_node', profile: { tools: ['read'] } }, 'task', {}),
    (error: unknown) => (error as { code?: string }).code === 'UNSUPPORTED_ARTIFACT_KIND',
  );
  assert.deepEqual(boundSchema, { type: 'object', properties: { kind: { type: 'string' } }, required: ['kind'], additionalProperties: true });
  assert.ok(progress.some((event) => event.type === 'schema_fallback' && event.nodeId === 'mystery_node'), 'schema_fallback event must be emitted for unknown node id');
});
