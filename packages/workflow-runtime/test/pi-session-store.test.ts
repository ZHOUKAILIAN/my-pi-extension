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

function runCheckpoint(runId: string, stage: string, position: number) {
  return { customType: 'workflow-run', data: { runId, stage, at: position, id: `${runId}-${position}`, problem: 'problem' } };
}

test('latestUncompleted excludes a run whose final checkpoint is ACCEPTED', () => {
  const entries = [runCheckpoint('bugFix-a', 'INVESTIGATING', 1), runCheckpoint('bugFix-a', 'ACCEPTED', 2)];
  const store = new PiSessionRunStore({ getEntries: () => entries }, () => {});
  assert.equal(store.latestUncompleted(), undefined);
});

test('latestUncompleted selects the unfinished run by final checkpoint position', () => {
  const entries = [
    runCheckpoint('bugFix-a', 'BLOCKED', 1),
    runCheckpoint('bugFix-b', 'ACCEPTED', 2),
    runCheckpoint('bugFix-a', 'VERIFYING', 3),
  ];
  const store = new PiSessionRunStore({ getEntries: () => entries }, () => {});
  assert.equal(store.latestUncompleted()?.runId, 'bugFix-a');
});

test('latestUncompleted selects the later unfinished run when entries are interleaved', () => {
  const entries = [
    runCheckpoint('bugFix-a', 'BLOCKED', 1),
    runCheckpoint('bugFix-b', 'IMPLEMENTING', 2),
    runCheckpoint('bugFix-a', 'INVESTIGATING', 3),
  ];
  const store = new PiSessionRunStore({ getEntries: () => entries }, () => {});
  assert.equal(store.latestUncompleted()?.runId, 'bugFix-a');
});
