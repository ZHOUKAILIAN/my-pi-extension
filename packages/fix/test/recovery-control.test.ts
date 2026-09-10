import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiveFixRunManager } from '../src/extension-v2.ts';
import { RunControlWal } from '@pi/workflow-runtime';

const context = (sessionId: string, leaf: string, branch: readonly unknown[], sessionFile: string, hasUI = true) => ({
  cwd: process.cwd(), hasUI,
  sessionManager: {
    getSessionId: () => sessionId,
    getLeafId: () => leaf,
    getBranch: () => branch,
    getSessionFile: () => sessionFile,
  },
} as any);

test('live recovery accepts a workflow entry whose header leaf is an active-branch ancestor', () => {
  const root = mkdtempSync(join(tmpdir(), 'fix-recovery-branch-'));
  const parentFile = join(root, 'parent.json');
  writeFileSync(parentFile, '{}');
  const oldRoot = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    const wal = RunControlWal.open('fix-branch-recovery', { rootDir: root, parentSessionId: 'parent-session', parentLeafId: 'ancestor', parentSessionFile: parentFile, cwd: process.cwd() });
    wal.recordCheckpoint({ checkpoint: { runId: 'fix-branch-recovery', stage: 'INVESTIGATING', at: 2, id: 'checkpoint', problem: 'branch entry' } });
    wal.releaseLease();
    const manager = new LiveFixRunManager();
    const selected = manager.latestStore(context('parent-session', 'current', [{ id: 'ancestor' }, { id: 'current' }], parentFile));
    assert.equal(selected?.checkpoint.runId, 'fix-branch-recovery');
    assert.equal(selected?.parentMatches, true);
    selected?.store?.wal.releaseLease();
  } finally {
    if (oldRoot === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldRoot;
  }
});

test('a header that recorded an existing parent file is never rebound as a no-file orphan', () => {
  const root = mkdtempSync(join(tmpdir(), 'fix-recovery-existing-parent-'));
  const parentFile = join(root, 'parent.json');
  writeFileSync(parentFile, '{}');
  const oldRoot = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    const wal = RunControlWal.open('fix-existing-parent', { rootDir: root, parentSessionId: 'old-session', parentLeafId: 'old-leaf', parentSessionFile: parentFile, cwd: process.cwd() });
    wal.recordCheckpoint({ checkpoint: { runId: 'fix-existing-parent', stage: 'INVESTIGATING', at: 3, id: 'checkpoint', problem: 'not an orphan' } });
    wal.releaseLease();
    assert.throws(() => RunControlWal.rebindParent('fix-existing-parent', { rootDir: root, parentSessionId: 'new-session-id', parentLeafId: 'new-leaf', cwd: process.cwd(), confirmed: true }), (error: unknown) => (error as { code?: string }).code === 'PARENT_REBIND_NOT_ORPHAN');
    const manager = new LiveFixRunManager();
    assert.equal(manager.latestStore(context('new-session-id', 'new-leaf', [{ id: 'new-leaf' }], join(root, 'new-parent.json'))), undefined);
  } finally {
    if (oldRoot === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldRoot;
  }
});

test('first-persist no-file orphan can be offered to a different session only for UI-confirmed rebind', () => {
  const root = mkdtempSync(join(tmpdir(), 'fix-recovery-orphan-'));
  const missingParent = join(root, 'not-created-yet.json');
  const newParent = join(root, 'new-parent.json');
  const oldRoot = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    const wal = RunControlWal.open('fix-no-file-orphan', { rootDir: root, parentSessionId: 'old-parent-session', parentLeafId: 'old-leaf', parentSessionFile: missingParent, cwd: process.cwd() });
    wal.recordCheckpoint({ checkpoint: { runId: 'fix-no-file-orphan', stage: 'INVESTIGATING', at: 3, id: 'checkpoint', problem: 'orphan entry' } });
    assert.equal(wal.records().find((record) => record.type === 'header')?.payload.parentSessionFileExists, false);
    wal.releaseLease();
    assert.equal(existsSync(missingParent), false);
    const manager = new LiveFixRunManager();
    assert.equal(manager.latestStore(context('new-session-id', 'new-leaf', [{ id: 'new-leaf' }], newParent, false)), undefined);
    const orphan = manager.latestStore(context('new-session-id', 'new-leaf', [{ id: 'new-leaf' }], newParent));
    assert.equal(orphan?.checkpoint.runId, 'fix-no-file-orphan');
    assert.equal(orphan?.parentMatches, false);
    orphan?.store?.wal.releaseLease();
    RunControlWal.rebindParent('fix-no-file-orphan', { rootDir: root, parentSessionId: 'new-session-id', parentLeafId: 'new-leaf', parentSessionFile: newParent, cwd: process.cwd(), confirmed: true });
    writeFileSync(newParent, '{}');
    const rebound = manager.latestStore(context('new-session-id', 'new-leaf', [{ id: 'new-leaf' }], newParent));
    assert.equal(rebound?.parentMatches, true);
    rebound?.store?.wal.releaseLease();
  } finally {
    if (oldRoot === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldRoot;
  }
});
