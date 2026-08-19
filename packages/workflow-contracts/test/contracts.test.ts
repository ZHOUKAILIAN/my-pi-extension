import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSubmitArtifact, INVESTIGATE_PROFILE, IMPLEMENT_PROFILE } from '../src/index.ts';
test('profiles and artifact schema are capability boundaries', () => { assert(!INVESTIGATE_PROFILE.tools.includes('bash')); assert(!INVESTIGATE_PROFILE.tools.includes('edit')); assert(IMPLEMENT_PROFILE.tools.includes('edit')); assert.throws(() => validateSubmitArtifact({kind: 3}), /schema/); });
