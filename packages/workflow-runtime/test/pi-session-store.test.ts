import test from 'node:test';
import assert from 'node:assert/strict';
import { PiSessionRunStore } from '../src/index.ts';

const checkpoint = (stage: any, at = 1, id = stage) => ({ runId: 'r', stage, at, id });

test('PiSessionRunStore reads the last legal checkpoint and ignores invalid entries', () => {
  const entries = [
    { customType: 'workflow-run', data: checkpoint('INVESTIGATING', 1, 'a') },
    { customType: 'workflow-run', data: { ...checkpoint('NOT_A_STAGE'), id: 'bad' } },
    { customType: 'other', data: checkpoint('BLOCKED') },
    { customType: 'workflow-run', data: checkpoint('BLOCKED', 2, 'b') },
  ];
  const store = new PiSessionRunStore({ getEntries: () => entries }, () => {});
  assert.equal(store.loadLast('r')?.id, 'b');
});

test('PiSessionRunStore preserves append order for equal timestamps', () => {
  const entries = [
    { customType: 'workflow-run', data: checkpoint('IMPLEMENTING', 10, 'first') },
    { customType: 'workflow-run', data: checkpoint('VERIFYING', 10, 'second') },
  ];
  const store = new PiSessionRunStore({ getEntries: () => entries }, () => {});
  assert.equal(store.loadLast('r')?.id, 'second');
});
