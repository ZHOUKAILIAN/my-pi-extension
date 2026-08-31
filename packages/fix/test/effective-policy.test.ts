import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computePolicyDigest,
  loadEffectivePolicy,
  parseProjectWorkflowPolicy,
} from '../src/effective-policy.ts';
import { FIX_NODE_IDS } from '../src/definition.ts';

// 在临时目录 .pi/ 下写入项目策略文件。
const writeProjectFile = (dir: string, name: string, value: string): string => {
  const piDir = join(dir, '.pi');
  mkdirSync(piDir, { recursive: true });
  const path = join(piDir, name);
  writeFileSync(path, value);
  return path;
};

test('missing project files fall back to pure runtime defaults across all fix nodes', () => {
  const cwd = join(tmpdir(), `fix-effective-missing-${Math.random()}`);
  const policy = loadEffectivePolicy(cwd, { trusted: true });
  assert.deepEqual(Object.keys(policy.nodes).sort(), [...FIX_NODE_IDS].sort());
  assert.equal(policy.nodes.investigate.model, 'smartingredients/gpt-5.6-sol');
  assert.ok(policy.nodes.implement.skills?.includes('tdd'));
  assert.equal(policy.nodes.verify.model, 'smartingredients/gpt-5.6-sol');
  assert.equal(policy.workflow.id, 'fix');
  assert.equal(policy.workflow.initialStage, 'INTAKE');
  assert.ok(policy.workflow.transitions.length > 0);
  assert.match(policy.digest, /^[0-9a-f]{64}$/);
});

test('workflow.json overrides model and skills per node, defaults fill the rest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fix-effective-'));
  writeProjectFile(dir, 'workflow.json', JSON.stringify({
    nodes: { investigate: { model: 'p/special', skills: ['cst-plus'] }, implement: {} },
  }));
  const policy = loadEffectivePolicy(dir, { trusted: true });
  assert.equal(policy.nodes.investigate.model, 'p/special');
  assert.deepEqual(policy.nodes.investigate.skills, ['cst-plus']);
  assert.equal(policy.nodes.implement.model, 'smartingredients/gpt-5.6-terra');
  assert.deepEqual(policy.nodes.implement.skills, ['tdd']);
  assert.equal(policy.nodes.verify.model, 'smartingredients/gpt-5.6-sol');
  assert.equal(policy.nodes.investigation_review.model, 'inherit');
  assert.ok(policy.nodes.investigate.tools.includes('submit_artifact'));
});

test('digest is deterministic for the same file and changes with the merged model', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fix-effective-'));
  const write = (model: string) => writeProjectFile(dir, 'workflow.json', JSON.stringify({ nodes: { investigate: { model } } }));
  write('p/one');
  const first = loadEffectivePolicy(dir, { trusted: true });
  const second = loadEffectivePolicy(dir, { trusted: true });
  assert.equal(first.digest, second.digest);
  const { digest, ...rest } = first;
  assert.equal(computePolicyDigest(rest), digest);
  write('p/two');
  const changed = loadEffectivePolicy(dir, { trusted: true });
  assert.notEqual(first.digest, changed.digest);
});

test('rejects bad JSON, schema, unknown nodes, and invalid node fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fix-effective-'));
  const rawCheck = (value: Record<string, unknown>, message: string) => {
    const path = writeProjectFile(dir, `w-${Math.random()}.json`, JSON.stringify(value));
    assert.throws(() => parseProjectWorkflowPolicy(value, path), new RegExp(message));
  };
  rawCheck({ version: 2 }, 'schema|version');
  rawCheck({ nodes: { madeUp: {} } }, 'unknown');
  rawCheck({ nodes: { implement: { tools: ['bash'] } } }, 'invalid workflow policy node');
  rawCheck({ nodes: { verify: { model: 'bad' } } }, 'invalid workflow policy node');
  rawCheck({ nodes: { verify: { skills: ['cst-plus', 'cst-plus'] } } }, 'invalid workflow policy node');

  const badJson = writeProjectFile(dir, 'workflow.json', '{');
  assert.throws(() => loadEffectivePolicy(dir, { trusted: true }), /JSON/);
  try {
    JSON.parse(badJson);
    assert.fail('bad JSON should fail to parse');
  } catch {
    // 预期：JSON.parse 对坏 JSON 抛 SyntaxError。
  }
});

test('untrusted loading ignores project files and uses runtime defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fix-effective-'));
  writeProjectFile(dir, 'workflow.json', JSON.stringify({ nodes: { investigate: { model: 'p/special' } } }));
  const policy = loadEffectivePolicy(dir, { trusted: false });
  assert.equal(policy.nodes.investigate.model, 'smartingredients/gpt-5.6-sol');
  assert.deepEqual(policy.nodes.investigate.skills, []);
});

test('falls back to legacy workflow-models.json and prefers workflow.json', () => {
  const legacyDir = mkdtempSync(join(tmpdir(), 'fix-effective-'));
  writeProjectFile(legacyDir, 'workflow-models.json', JSON.stringify({
    version: 1, default: 'p/d', nodes: { investigate: 'p/legacy' },
  }));
  const legacy = loadEffectivePolicy(legacyDir, { trusted: true });
  assert.equal(legacy.nodes.investigate.model, 'p/legacy');
  assert.equal(legacy.nodes.implement.model, 'p/d');
  assert.equal(legacy.nodes.verify.model, 'p/d');

  const both = mkdtempSync(join(tmpdir(), 'fix-effective-'));
  writeProjectFile(both, 'workflow.json', JSON.stringify({ nodes: { investigate: { model: 'p/new' } } }));
  writeProjectFile(both, 'workflow-models.json', JSON.stringify({ version: 1, default: 'p/old' }));
  const preferred = loadEffectivePolicy(both, { trusted: true });
  assert.equal(preferred.nodes.investigate.model, 'p/new');
  assert.equal(preferred.nodes.implement.model, 'smartingredients/gpt-5.6-terra');
});