import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBugFixCommand, loadModelPolicy, resolveModelRef } from '../src/policy.ts';

const usage = 'usage: /bugFix <问题描述>';

test('public parser exposes only a problem description', () => {
  assert.deepEqual(parseBugFixCommand('登录后白屏'), { valid: true, problem: '登录后白屏' });
  for (const command of ['start 登录后白屏', 'resume', 'decision runId=x'])
    assert.deepEqual(parseBugFixCommand(command), { valid: false, usage });
});

test('policy defaults and resolves inherited model', () => {
  const policy = loadModelPolicy('/definitely/missing/workflow-models.json');
  assert.equal(policy.nodes.investigate.configuredRef, 'inherit');
  const model = { provider: 'p', id: 'm' };
  assert.equal(resolveModelRef('inherit', model, undefined), model);
});

test('policy accepts partial node overrides', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bugfix-policy-'));
  const path = join(dir, 'models.json');
  writeFileSync(path, JSON.stringify({ version: 1, default: 'p/default', nodes: { investigate: 'p/special' } }));
  const policy = loadModelPolicy(path);
  assert.equal(policy.nodes.investigate.configuredRef, 'p/special');
  assert.equal(policy.nodes.implement.configuredRef, 'p/default');
  assert.equal(policy.nodes.verify.source, 'project-file');
});

test('policy rejects bad JSON, schema, and model refs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bugfix-policy-'));
  const check = (value: string, message: string) => {
    const path = join(dir, `${Math.random()}.json`); writeFileSync(path, value);
    assert.throws(() => loadModelPolicy(path), new RegExp(message));
  };
  check('{', 'JSON');
  check(JSON.stringify({ version: 2 }), 'schema');
  check(JSON.stringify({ version: 1, nodes: null }), 'schema');
  check(JSON.stringify({ version: 1, default: 'invalid' }), 'schema|ref');
  check(JSON.stringify({ version: 1, nodes: { investigate: 'invalid' } }), 'schema|ref');
  check(JSON.stringify({ version: 1, nodes: { investigat: 'inherit' } }), 'unknown');
});

// Keep the public parser contract explicit for callers that previously used operation fields.
assert.equal(typeof parseBugFixCommand, 'function');
