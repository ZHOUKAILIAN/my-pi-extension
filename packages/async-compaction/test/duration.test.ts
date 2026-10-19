import test from 'node:test';
import assert from 'node:assert/strict';
import { CompactionDurationObserver, installCompactionDurationObserver } from '../src/duration.ts';

const id = 'f1c3b1a2-5435-4d4a-8bcb-233fa8d946a1';
test('observer consumes terminal by operation scope, reason and active branch delta rather than event pointer', () => {
  let now = 100; const branch: any[] = [{ id: 'old-compaction', type: 'compaction' }]; const records: any[] = [], renderers = new Map<string, Function>();
  const pi = { registerEntryRenderer: (name: string, renderer: Function) => renderers.set(name, renderer), appendEntry: (type: string, data: unknown) => records.push({ type, data }) } as any;
  const observer = new CompactionDurationObserver(pi, () => now, () => id);
  const ctx = { mode: 'tui', sessionManager: { getSessionId: () => 's', getBranch: () => branch } } as any;
  observer.setBranch(ctx);
  observer.before({ reason: 'threshold' }, ctx);
  now = 1234; branch.push({ id: 'inserted-custom', type: 'custom' }, { id: 'new-compaction', type: 'compaction', summary: 'same summary' });
  observer.compact({ reason: 'threshold', compactionEntry: branch[0] }, ctx);
  observer.compact({ reason: 'threshold', compactionEntry: branch[0] }, ctx);
  assert.equal(records.length, 1);
  assert.equal(records[0].type, 'compaction-duration');
  assert.deepEqual(records[0].data, { schemaVersion: 1, operationId: id, compactionEntryId: 'new-compaction', reason: 'threshold', outcome: 'completed', durationMs: 1134 });
  const renderer: any = renderers.get('compaction-duration');
  assert.match(renderer({ data: records[0].data }, {}, { fg: (_c: string, text: string) => text }).render(80).join(''), /压缩阶段耗时：1\.13s/u);
});

test('observer does not persist orphan terminals, rejects mismatched reasons and uses unknown for invalid clocks', () => {
  let now = 5; const branch: any[] = [{ id: 'source', type: 'message' }], records: any[] = []; let counter = 0;
  const observer = new CompactionDurationObserver({ registerEntryRenderer() {}, appendEntry: (_type: string, data: unknown) => records.push(data) } as any, () => now, () => `f1c3b1a2-5435-4d4a-8bcb-${String(++counter).padStart(12, '0')}`);
  const ctx = { mode: 'tui', sessionManager: { getSessionId: () => 's', getBranch: () => branch } } as any;
  observer.compact({ reason: 'manual' }, ctx); assert.equal(records.length, 0);
  observer.before({ reason: 'manual' }, ctx); observer.compact({ reason: 'threshold' }, ctx);
  assert.equal(records[0].outcome, 'unknown'); assert.equal(records[0].unknownReason, 'ambiguous_terminal');
  observer.before({ reason: 'overflow' }, ctx); now = Number.NaN; observer.failed({ reason: 'overflow', aborted: true }, ctx);
  assert.equal(records[1].outcome, 'unknown'); assert.equal(records[1].unknownReason, 'clock_invalid');
  observer.before({ reason: 'threshold' }, ctx); observer.leave(ctx);
  assert.equal(records[2].outcome, 'unknown'); assert.equal(records[2].unknownReason, 'scope_left');
});

test('failed branch snapshots, sibling leaves, empty scopes and observer reinstallation stay non-numeric and isolated', () => {
  const records: any[] = [], renderers: Function[] = []; let failBranch = false, sessionId = 'valid-session', now = 10, sequence = 0;
  const pi = { registerEntryRenderer: (_name: string, renderer: Function) => renderers.push(renderer), appendEntry: (_type: string, data: unknown) => records.push(data) } as any;
  const observer = installCompactionDurationObserver(pi, () => now);
  assert.equal(installCompactionDurationObserver(pi), observer);
  assert.equal(renderers.length, 1, 'same host object cannot register duplicate renderers');
  const branch: any[] = [{ id: 'start', type: 'message' }];
  const ctx = { mode: 'tui', sessionManager: { getSessionId: () => sessionId, getBranch: () => { if (failBranch) throw Error('branch failure'); return branch; } } } as any;
  observer.setBranch(ctx);
  observer.before({ reason: 'manual' }, ctx); failBranch = true; now = 20; observer.compact({ reason: 'manual' }, ctx);
  assert.equal(records[0].outcome, 'unknown'); assert.equal(records[0].unknownReason, 'ambiguous_terminal');
  failBranch = false; observer.before({ reason: 'threshold' }, ctx); branch.splice(0, branch.length, { id: 'sibling', type: 'message' }); now = 30; observer.compact({ reason: 'threshold' }, ctx);
  assert.equal(records[1].outcome, 'unknown', 'a start leaf absent from current branch is fenced');
  sessionId = ''; observer.before({ reason: 'overflow' }, ctx); observer.compact({ reason: 'overflow' }, ctx);
  assert.equal(records.length, 2, 'empty session ids cannot establish or persist an operation scope');
  const duplicateEvent = { reason: 'manual' }; sessionId = 'valid-session'; observer.before(duplicateEvent, ctx); observer.before(duplicateEvent, ctx);
  assert.equal(records.length, 2, 'the same host event observed through duplicate registrations is consumed once');
});

test('generic observer produces diagnostics without a metrics dependency', () => {
  const records: any[] = []; let sequence = 0;
  const observer = new CompactionDurationObserver({ registerEntryRenderer() {}, appendEntry: (type: string, data: unknown) => records.push({ type, data }) } as any, () => 100, () => `f1c3b1a2-5435-4d4a-8bcb-${String(++sequence).padStart(12, '0')}`);
  const branch: any[] = [{ id: 'source', type: 'message' }];
  const ctx = { mode: 'tui', sessionManager: { getSessionId: () => 's', getBranch: () => branch } } as any;
  for (const reason of ['manual', 'threshold', 'overflow'] as const) {
    observer.before({ reason }, ctx);
    branch.push({ id: `${reason}-entry`, type: 'compaction' });
    observer.compact({ reason }, ctx);
    observer.before({ reason }, ctx);
    observer.failed({ reason, aborted: true }, ctx);
  }
  assert.equal(records.length, 6);
  assert.equal(records.every(record => record.type === 'compaction-duration'), true);
});
