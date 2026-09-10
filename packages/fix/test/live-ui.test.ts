import test from 'node:test';
import assert from 'node:assert/strict';
import { renderWorkerText } from '../src/extension-v2.ts';
import { visibleWidth } from '@earendil-works/pi-tui';

test('Worker renderer uses Pi width semantics for CJK and newlines', () => {
  const rendered = renderWorkerText('中文\nalpha beta', 6);
  const lines = rendered.split('\n');
  assert.deepEqual(lines, ['中文', 'alpha', 'beta']);
  assert.ok(lines.every((line) => visibleWidth(line) <= 6));
});
