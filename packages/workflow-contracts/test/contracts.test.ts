import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSubmitArtifact, INVESTIGATE_PROFILE, IMPLEMENT_PROFILE } from '../src/index.ts';
import { fixNodes } from '@pi/workflow-runtime';
test('profiles and artifact schema are capability boundaries', () => { assert(!INVESTIGATE_PROFILE.tools.includes('bash')); assert(!INVESTIGATE_PROFILE.tools.includes('edit')); assert(IMPLEMENT_PROFILE.tools.includes('edit')); assert.throws(() => validateSubmitArtifact({kind: 3}), /artifact.kind/);
  assert.throws(() => validateSubmitArtifact({ kind: 'implementation', artifact: 'patch' }), /implementation.artifact/);
  assert.doesNotThrow(() => validateSubmitArtifact({ kind: 'implementation', artifact: { summary: 'patch', filesChanged: ['a.ts'], candidateRevision: 'rev-1' } })); });
test('node skills are scoped independently from tools', () => {
  const nodes = fixNodes({ execute: async () => ({ kind: 'investigation', route: 'local_fix', rootCause: 'cause', evidence: ['x'] }) }, { investigate: ['cst-plus'] });
  assert.deepEqual(nodes.investigate.profile?.skills, ['cst-plus']);
  assert.deepEqual(nodes.implement.profile?.skills, []);
  assert(!nodes.investigate.profile?.tools.includes('bash'));
});
