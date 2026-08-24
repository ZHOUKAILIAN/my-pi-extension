import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFixCommand, loadModelPolicy, resolveModelRef } from '../src/policy.ts';

const usage = 'usage: /fix <问题描述>';

test('public parser exposes only a problem description', () => {
  assert.deepEqual(parseFixCommand('登录后白屏'), { valid: true, problem: '登录后白屏' });
  for (const command of ['start 登录后白屏', 'resume', 'decision runId=x'])
    assert.deepEqual(parseFixCommand(command), { valid: false, usage });
});

test('policy defaults use the high-capability Sol/Terra/Sol model split', () => {
  const policy = loadModelPolicy('/definitely/missing/workflow-models.json');
  assert.equal(policy.nodes.investigate.configuredRef, 'smartingredients/gpt-5.6-sol');
  assert.equal(policy.nodes.implement.configuredRef, 'smartingredients/gpt-5.6-terra');
  assert.equal(policy.nodes.verify.configuredRef, 'smartingredients/gpt-5.6-sol');
  assert.deepEqual(policy.nodes.implement.skills, ['tdd']);

  const model = { provider: 'p', id: 'm' };
  const investigationModel = { provider: 'smartingredients', id: 'gpt-5.6-sol' };
  assert.equal(resolveModelRef(policy.nodes.investigate.configuredRef, undefined, { find: (provider: string, id: string) => provider === 'smartingredients' && id === 'gpt-5.6-sol' ? investigationModel : undefined }), investigationModel);
  assert.equal(resolveModelRef('inherit', model, undefined), model);
  assert.deepEqual(resolveModelRef(policy.nodes.implement.configuredRef, undefined, { find: (provider: string, id: string) => provider === 'smartingredients' && id === 'gpt-5.6-terra' ? { provider, id } : undefined }), {
    provider: 'smartingredients', id: 'gpt-5.6-terra',
  });
});

test('fixed node defaults resolve without ctx.model, while inherit does not', () => {
  const registry = { find: (provider: string, id: string) => ({ provider, id }) };
  assert.deepEqual(resolveModelRef('smartingredients/gpt-5.6-sol', undefined, registry), {
    provider: 'smartingredients', id: 'gpt-5.6-sol',
  });
  assert.deepEqual(resolveModelRef('smartingredients/gpt-5.6-terra', undefined, registry), {
    provider: 'smartingredients', id: 'gpt-5.6-terra',
  });
  assert.throws(() => resolveModelRef('inherit', undefined, registry), /requires ctx\.model/);
});

test('policy keeps legacy string node references compatible', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fix-policy-'));
  const path = join(dir, 'models.json');
  writeFileSync(path, JSON.stringify({ version: 1, nodes: { investigate: 'p/legacy' } }));
  const policy = loadModelPolicy(path);
  assert.equal(policy.nodes.investigate.configuredRef, 'p/legacy');
  assert.deepEqual(policy.nodes.investigate.skills, []);
});

test('policy accepts object node overrides with node-scoped skills', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fix-policy-'));
  const path = join(dir, 'models.json');
  writeFileSync(path, JSON.stringify({
    version: 1,
    default: 'p/default',
    nodes: { investigate: { model: 'p/special', skills: ['cst-plus', 'aliyun-sls-query'] } },
  }));
  const policy = loadModelPolicy(path);
  assert.equal(policy.nodes.investigate.configuredRef, 'p/special');
  assert.deepEqual(policy.nodes.investigate.skills, ['cst-plus', 'aliyun-sls-query']);
  assert.equal(policy.nodes.implement.configuredRef, 'p/default');
  assert.deepEqual(policy.nodes.implement.skills, []);
  assert.equal(policy.nodes.verify.source, 'project-file');
});

test('policy rejects bad JSON, schema, and model refs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fix-policy-'));
  const check = (value: string, message: string) => {
    const path = join(dir, `${Math.random()}.json`); writeFileSync(path, value);
    assert.throws(() => loadModelPolicy(path), new RegExp(message));
  };
  check('{', 'JSON');
  check(JSON.stringify({ version: 2 }), 'schema');
  check(JSON.stringify({ version: 1, nodes: null }), 'schema');
  check(JSON.stringify({ version: 1, default: 'invalid' }), 'schema|ref|node policy');
  check(JSON.stringify({ version: 1, nodes: { investigate: 'invalid' } }), 'schema|ref|node policy');
  check(JSON.stringify({ version: 1, nodes: { investigat: 'inherit' } }), 'unknown');
  check(JSON.stringify({ version: 1, nodes: { investigate: { model: 'inherit', skills: ['invalid_skill'] } } }), 'node policy');
  check(JSON.stringify({ version: 1, nodes: { investigate: { model: 'inherit', skills: ['cst-plus', 'cst-plus'] } } }), 'node policy');
  check(JSON.stringify({ version: 1, nodes: { investigate: { model: 'inherit', unknown: true } } }), 'node policy');
});

// Keep the public parser contract explicit for callers that previously used operation fields.
assert.equal(typeof parseFixCommand, 'function');
