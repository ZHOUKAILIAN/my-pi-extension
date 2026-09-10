import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunControlWal, RunGarbageCollector, runTombstonePath } from '../src/index.ts';

const accepted = (root: string, runId: string, now: number, parentSessionFile?: string) => {
  const wal = RunControlWal.open(runId, { rootDir: root, now: () => now, cwd: process.cwd(), parentSessionFile });
  wal.recordCheckpoint({ checkpoint: { runId, stage: 'ACCEPTED', at: now, id: `${runId}-accepted` } });
  wal.releaseLease();
  return wal;
};

test('GC tombstones and renames an expired settled run, and recovery stays fenced', () => {
  const root = mkdtempSync(join(tmpdir(), 'fix-gc-settled-'));
  accepted(root, 'fix-gc-settled', 1_000);
  assert.equal(RunControlWal.gc(root, 2_000, 0), 1);
  assert.equal(existsSync(runTombstonePath(root, 'fix-gc-settled')), true);
  assert.throws(() => RunControlWal.open('fix-gc-settled', { rootDir: root }), (error: unknown) => (error as { code?: string }).code === 'RUN_TOMBSTONED');
});

test('GC does not remove an unfinished run while its lease is live, then uses last durable event', () => {
  const root = mkdtempSync(join(tmpdir(), 'fix-gc-live-'));
  const wal = RunControlWal.open('fix-gc-live', { rootDir: root, now: () => 1_000, cwd: process.cwd() });
  wal.recordCheckpoint({ checkpoint: { runId: 'fix-gc-live', stage: 'INVESTIGATING', at: 1_000, id: 'unfinished' } });
  assert.equal(RunControlWal.gc(root, 2_000, 0), 0);
  wal.releaseLease();
  assert.equal(RunControlWal.gc(root, 2_000, 0), 1);
});

test('GC uses the latest valid parent_rebind for orphan retention', () => {
  const root = mkdtempSync(join(tmpdir(), 'fix-gc-rebind-'));
  const oldParent = join(root, 'old-session.json');
  const newParent = join(root, 'new-session.json');
  accepted(root, 'fix-gc-rebind', 1_000, oldParent);
  writeFileSync(newParent, '{}');
  RunControlWal.rebindParent('fix-gc-rebind', { rootDir: root, parentSessionId: 'new-parent', parentLeafId: 'new-leaf', parentSessionFile: newParent, cwd: process.cwd(), confirmed: true });
  assert.equal(RunGarbageCollector.collect(root, { now: 3_000, retentionMs: 10_000, orphanDeadlineMs: 100 }), 0);
});

test('GC retries a trash directory after deletion failure on the next scan', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fix-gc-trash-retry-'));
  accepted(root, 'fix-gc-trash-retry', 1_000);
  let fail = true;
  const removeTrash = (path: string) => { if (fail) throw new Error('simulated delete failure'); rmSync(path, { recursive: true, force: false }); };
  assert.equal(RunGarbageCollector.collect(root, { now: 2_000, retentionMs: 0, removeTrash }), 1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(readdirSync(join(root, 'workflow-runs')).some((entry) => entry.startsWith('.trash-')));
  fail = false;
  assert.equal(RunGarbageCollector.collect(root, { now: 2_001, retentionMs: 0, removeTrash }), 0);
  assert.equal(readdirSync(join(root, 'workflow-runs')).some((entry) => entry.startsWith('.trash-')), false);
});

test('GC durably observes a missing parent and applies the earlier seven-day orphan deadline', () => {
  const root = mkdtempSync(join(tmpdir(), 'fix-gc-orphan-'));
  const missingParent = join(root, 'parent-session.json');
  accepted(root, 'fix-gc-orphan', 1_000, missingParent);
  assert.equal(RunGarbageCollector.collect(root, { now: 2_000, retentionMs: 10_000, orphanDeadlineMs: 100 }), 0);
  assert.equal(RunGarbageCollector.collect(root, { now: 2_050, retentionMs: 10_000, orphanDeadlineMs: 100 }), 0);
  assert.equal(RunGarbageCollector.collect(root, { now: 2_101, retentionMs: 10_000, orphanDeadlineMs: 100 }), 1);
});
