import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSubmitArtifact, INVESTIGATE_PROFILE, IMPLEMENT_PROFILE } from '../src/index.ts';
import { bugFixNodes } from '@pi/workflow-runtime';
test('profiles and artifact schema are capability boundaries', () => { assert(!INVESTIGATE_PROFILE.tools.includes('bash')); assert(!INVESTIGATE_PROFILE.tools.includes('edit')); assert(IMPLEMENT_PROFILE.tools.includes('edit')); assert.throws(() => validateSubmitArtifact({kind: 3}), /schema/); });
test('node skills are scoped independently from tools', () => {
  const nodes = bugFixNodes({ execute: async () => ({ kind: 'investigation', route: 'local_fix', evidence: ['x'] }) }, { investigate: ['cst-plus'] });
  assert.deepEqual(nodes.investigate.profile?.skills, ['cst-plus']);
  assert.deepEqual(nodes.implement.profile?.skills, []);
  assert(!nodes.investigate.profile?.tools.includes('bash'));
});
