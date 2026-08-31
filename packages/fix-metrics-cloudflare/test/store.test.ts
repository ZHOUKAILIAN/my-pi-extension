import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson } from '../src/canonical.ts';
import { buildSnapshotForWindow, type SnapshotBuildOptions } from '../src/projection.ts';
import type { BatchStatement, SqlDatabase } from '../src/store.ts';
import { MetricStore } from '../src/store.ts';
import { FIXED_NOW, makeAcceptedEvent, migratedInMemoryDb } from './helpers.ts';

function newStore() {
  const { sql, raw } = migratedInMemoryDb();
  return { store: new MetricStore(sql), raw };
}

const TS = FIXED_NOW.toISOString();

describe('MetricStore.insertAccepted', () => {
  it('persists an accepted event and reads it back', async () => {
    const { store, raw } = newStore();
    const ev = await makeAcceptedEvent('a', 'run_started');
    const out = await store.insertAccepted(ev, ev.receivedAt);
    assert.deepEqual(out, { status: 'accepted' });
    const rows = await store.allAcceptedEvents();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].eventId, ev.eventId);
    assert.equal(rows[0].eventBusinessKey, ev.eventBusinessKey);
    assert.equal(rows[0].payloadJson, '{}');
    const count = raw.prepare('SELECT COUNT(*) AS n FROM fix_metric_events').get() as { n: number };
    assert.equal(Number(count.n), 1);
  });

  it('exact replay (same id + same content) is a duplicate', async () => {
    const { store } = newStore();
    const ev = await makeAcceptedEvent('d', 'run_started');
    await store.insertAccepted(ev, ev.receivedAt);
    const again = await store.insertAccepted(ev, ev.receivedAt);
    assert.deepEqual(again, { status: 'duplicate', existingEventId: ev.eventId });
  });

  it('same event id but different content is a conflict (never overwrite)', async () => {
    const { store, raw } = newStore();
    const first = await makeAcceptedEvent('c', 'run_started', { occurredAt: TS });
    await store.insertAccepted(first, first.receivedAt);
    const second = await makeAcceptedEvent('c', 'run_started', { occurredAt: new Date(Date.parse(TS) + 60_000).toISOString() });
    assert.notEqual(second.eventCanonicalHash, first.eventCanonicalHash);
    const out = await store.insertAccepted(second, second.receivedAt);
    assert.deepEqual(out, { status: 'conflict', existingEventId: first.eventId });
    const rows = raw.prepare('SELECT COUNT(*) AS n FROM fix_metric_events').get() as { n: number };
    assert.equal(Number(rows.n), 1);
  });

  it('retry with a NEW event id but identical business content is a duplicate by key', async () => {
    const { store } = newStore();
    const payload = canonicalJson({ resolutionEvidenceRef: 'rev-shared' });
    const first = await makeAcceptedEvent('k1', 'resolution_completed', { factId: 'fact-shared', runId: 'run-shared', payloadJson: payload, occurredAt: TS });
    await store.insertAccepted(first, first.receivedAt);
    const retry = await makeAcceptedEvent('k2', 'resolution_completed', { factId: 'fact-shared', runId: 'run-shared', payloadJson: payload, occurredAt: TS });
    assert.equal(retry.eventBusinessKey, first.eventBusinessKey);
    assert.equal(retry.eventCanonicalHash, first.eventCanonicalHash);
    const out = await store.insertAccepted(retry, retry.receivedAt);
    assert.deepEqual(out, { status: 'duplicate', existingEventId: first.eventId });
  });

  it('same business key, different canonical content is a conflict by key', async () => {
    const { store } = newStore();
    const payload = canonicalJson({ resolutionEvidenceRef: 'rev-shared' });
    const first = await makeAcceptedEvent('x1', 'resolution_completed', { factId: 'fact-shared', runId: 'run-shared', payloadJson: payload, occurredAt: TS });
    await store.insertAccepted(first, first.receivedAt);
    const rework = await makeAcceptedEvent('x2', 'resolution_completed', {
      factId: 'fact-shared',
      runId: 'run-shared',
      payloadJson: payload,
      occurredAt: new Date(Date.parse(TS) + 5 * 60_000).toISOString(), // later confirmation, same fact
    });
    assert.equal(rework.eventBusinessKey, first.eventBusinessKey);
    assert.notEqual(rework.eventCanonicalHash, first.eventCanonicalHash);
    const out = await store.insertAccepted(rework, rework.receivedAt);
    assert.deepEqual(out, { status: 'conflict', existingEventId: first.eventId });
  });
});

describe('MetricStore quarantine', () => {
  it('inserts and counts within a window', async () => {
    const { store, raw } = newStore();
    await store.insertQuarantine({
      eventId: 'q-1',
      factId: 'fact-q',
      eventBusinessKey: 'k',
      eventCanonicalHash: 'h',
      reasonCode: 'late_event',
      receivedAt: TS,
      occurredAt: '2026-08-10T00:00:00.000Z',
      eventJson: '{"eventId":"q-1"}',
    });
    assert.equal(await store.quarantinedCountInWindow('2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'), 1);
    assert.equal(await store.quarantinedCountInWindow('2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'), 0);
    const row = raw.prepare('SELECT status FROM fix_metric_quarantine').get() as { status: string };
    assert.equal(row.status, 'quarantined');
  });

  it('persists a safe runId on quarantine records and tolerates records without one', async () => {
    const { store } = newStore();
    await store.insertQuarantine({
      eventId: 'q-r1', factId: 'fact-q1', runId: 'run-quar', eventBusinessKey: 'k1', eventCanonicalHash: 'h1',
      reasonCode: 'late_event', receivedAt: TS, occurredAt: '2026-08-10T00:00:00.000Z', eventJson: '{}',
    });
    await store.insertQuarantine({
      eventId: 'q-r2', factId: 'fact-q2', eventBusinessKey: 'k2', eventCanonicalHash: 'h2',
      reasonCode: 'late_event', receivedAt: TS, occurredAt: '2026-08-10T00:00:00.000Z', eventJson: '{}',
    });
    const rows = await store.quarantinedInWindow('2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    assert.equal(rows.length, 2);
    const withRun = rows.find((r) => r.eventId === 'q-r1');
    const withoutRun = rows.find((r) => r.eventId === 'q-r2');
    assert.equal(withRun?.runId, 'run-quar');
    assert.equal(withoutRun?.runId, undefined);
  });
});

describe('MetricStore snapshots + publication', () => {
  const ws = '2026-08-01T00:00:00.000Z';
  const we = '2026-09-01T00:00:00.000Z';
  const oct = '2026-10-01T00:00:00.000Z';

  async function seedRuns(store: MetricStore, seeds: string[]): Promise<void> {
    for (const seed of seeds) {
      const ev = await makeAcceptedEvent(seed, 'run_started', {
        occurredAt: '2026-08-02T10:00:00.000Z',
        receivedAt: '2026-08-02T10:00:00.000Z',
        runId: `run-${seed}`,
        factId: `fact-${seed}`,
      });
      const out = await store.insertAccepted(ev, ev.receivedAt);
      if (out.status !== 'accepted') throw new Error(`seed insert rejected: ${out.status}`);
    }
  }

  // A genuine canonical revision built by the projection (deterministic id/hash/content).
  async function genuineRow(
    store: MetricStore,
    snapshotAt = we,
    opts: Omit<SnapshotBuildOptions, 'snapshotAt'> = {},
    windowStart = ws,
    windowEnd = we,
  ) {
    const built = await buildSnapshotForWindow(store, await store.allAcceptedEvents(), windowStart, windowEnd, FIXED_NOW, {
      snapshotAt,
      ...opts,
    });
    return built.row;
  }

  it('snapshot insert is idempotent by revision hash and round-trips', async () => {
    const { store } = newStore();
    await seedRuns(store, ['f1', 'f2', 'f3', 'f4', 'f5']);
    const row = await genuineRow(store);
    assert.match(row.snapshotId, /^s_[A-Za-z0-9_-]+$/);
    assert.equal(await store.insertSnapshot(row, row.snapshotAt), true);
    assert.equal(await store.insertSnapshot({ ...row, createdAt: new Date(FIXED_NOW.getTime() + 1000).toISOString() }, row.snapshotAt), false); // OR IGNORE by unique hash
    const got = await store.getSnapshot(row.snapshotId);
    assert.ok(got);
    assert.equal(got.responseJson, row.responseJson);
  });

  it('rejects forged snapshot ids and revision hashes not bound to canonical revision content', async () => {
    const { store } = newStore();
    await seedRuns(store, ['f1', 'f2', 'f3', 'f4', 'f5']);
    const row = await genuineRow(store);

    // arbitrary forged id + hash pair (shape-consistent payload carrying the forged ids)
    const forgedPayload = { ...JSON.parse(row.responseJson) as Record<string, unknown>, snapshotId: 's_totally_forged_id' };
    await assert.rejects(
      () => store.insertSnapshot({ ...row, snapshotId: 's_totally_forged_id', revisionHash: 'forged-hash', responseJson: canonicalJson(forgedPayload) }, row.snapshotAt),
      /snapshot_revision_mismatch/,
    );
    // genuine hash but a snapshotId that is not derived from it
    const wrongIdPayload = { ...JSON.parse(row.responseJson) as Record<string, unknown>, snapshotId: 's_not_bound_to_hash' };
    await assert.rejects(
      () => store.insertSnapshot({ ...row, snapshotId: 's_not_bound_to_hash', responseJson: canonicalJson(wrongIdPayload) }, row.snapshotAt),
      /snapshot_revision_mismatch/,
    );
    // right snapshotId but a tampered revision hash
    await assert.rejects(() => store.insertSnapshot({ ...row, revisionHash: 'tampered-hash' }, row.snapshotAt), /snapshot_revision_mismatch/);
    // mutated payload content with untouched ids/hash (window metadata drifted)
    const mutatedPayload = { ...JSON.parse(row.responseJson) as Record<string, unknown>, totalRuns: 99 };
    await assert.rejects(() => store.insertSnapshot({ ...row, responseJson: canonicalJson(mutatedPayload) }, row.snapshotAt), /snapshot_revision_mismatch/);

    // the genuine revision inserts
    assert.equal(await store.insertSnapshot(row, row.snapshotAt), true);
  });

  it('rejects incoherent parent lineage: missing parent, mismatched window, non-earlier as-of point, half lineage', async () => {
    const { store } = newStore();
    await seedRuns(store, ['f1', 'f2', 'f3', 'f4', 'f5']);

    // root at the window boundary, coherent child at the next fixed point
    const root = await genuineRow(store, we);
    assert.equal(await store.insertSnapshot(root, root.snapshotAt), true);
    const child = await genuineRow(store, oct, { parentSnapshotId: root.snapshotId, rebuildTaskId: 'rebuild_20261001T000000000Z' });
    assert.equal(await store.insertSnapshot(child, child.snapshotAt), true);

    // missing parent row
    const orphan = await genuineRow(store, oct, { parentSnapshotId: 's_missing_parent_000000001', rebuildTaskId: 'rebuild_orphan' });
    await assert.rejects(() => store.insertSnapshot(orphan, oct), /snapshot_revision_mismatch/);

    // parent exists but covers a DIFFERENT window (September window row used as August parent)
    const septParent = await genuineRow(store, oct, {}, '2026-09-01T00:00:00.000Z', oct);
    assert.equal(await store.insertSnapshot(septParent, septParent.snapshotAt), true);
    const crossWindow = await genuineRow(store, oct, { parentSnapshotId: septParent.snapshotId, rebuildTaskId: 'rebuild_cross' });
    await assert.rejects(() => store.insertSnapshot(crossWindow, oct), /snapshot_revision_mismatch/);

    // parent at the SAME as-of point (not strictly earlier)
    const samePoint = await genuineRow(store, we, { parentSnapshotId: root.snapshotId, rebuildTaskId: 'rebuild_same_point' });
    await assert.rejects(() => store.insertSnapshot(samePoint, oct), /snapshot_revision_mismatch/);

    // parent without a rebuild task id, and a rebuild task without a parent
    const parentOnly = await genuineRow(store, oct, { parentSnapshotId: root.snapshotId });
    await assert.rejects(() => store.insertSnapshot(parentOnly, oct), /snapshot_revision_mismatch/);
    const taskOnly = await genuineRow(store, oct, { rebuildTaskId: 'rebuild_without_parent' });
    await assert.rejects(() => store.insertSnapshot(taskOnly, oct), /snapshot_revision_mismatch/);
  });

  it('rejects dangling and metadata-mismatched publication targets without creating a pointer', async () => {
    const { store } = newStore();
    assert.equal(await store.publishRevision(ws, we, 'fix-funnel-v1', 's_missing', we, TS), false);
    assert.equal(await store.getPublication(ws, we), undefined);

    await seedRuns(store, ['f1', 'f2', 'f3', 'f4', 'f5']);
    const row = await genuineRow(store);
    await store.insertSnapshot(row, row.snapshotAt);
    assert.equal(await store.publishRevision(ws, oct, 'fix-funnel-v1', row.snapshotId, oct, TS), false);
    assert.equal(await store.getPublication(ws, we), undefined);
    assert.equal(await store.publishRevision(ws, we, 'fix-funnel-v1', row.snapshotId, oct, TS), false);
    assert.equal(await store.getPublication(ws, we), undefined);
  });

  it('fails closed on an invalid/NaN/non-ISO server-controlled now (direct store APIs, review P1.7)', async () => {
    const { store } = newStore();
    await seedRuns(store, ['f1', 'f2', 'f3', 'f4', 'f5']);
    const row = await genuineRow(store);
    const futureRow = await genuineRow(store, oct);
    for (const bad of ['not-a-date', '2026-13-01T00:00:00.000Z', '2026-09-01 00:00:00', '2026-09-01T00:00:00', '']) {
      // an invalid `now` must never silently pass the future-as-of gate (NaN comparisons are false)
      await assert.rejects(() => store.insertSnapshot(row, bad), /invalid_server_now/);
      await assert.rejects(() => store.insertSnapshot(futureRow, bad), /invalid_server_now/);
      await assert.rejects(() => store.publishRevision(ws, we, 'fix-funnel-v1', row.snapshotId, we, bad), /invalid_server_now/);
    }
    assert.equal(await store.getSnapshot(row.snapshotId), undefined);
    assert.equal(await store.getPublication(ws, we), undefined);
  });

  it('rejects a future as-of point at the store boundary and still refuses future publication', async () => {
    const { store } = newStore();
    await seedRuns(store, ['f1', 'f2', 'f3', 'f4', 'f5']);
    const futureRow = await genuineRow(store, oct); // as-of point is two months after FIXED_NOW
    // direct future insertion is rejected at the store boundary (server-controlled now)
    await assert.rejects(() => store.insertSnapshot(futureRow, FIXED_NOW.toISOString()), /future_snapshot_at/);
    assert.equal(await store.getSnapshot(futureRow.snapshotId), undefined);
    // once the boundary is reached on the server clock, the same row inserts...
    await store.insertSnapshot(futureRow, oct);
    // ...but publication still fails closed while publishedAt lags the as-of point (defense in
    // depth retained behind the insert gate)
    assert.equal(await store.publishRevision(ws, we, 'fix-funnel-v1', futureRow.snapshotId, oct, TS), false);
    assert.equal(await store.getPublication(ws, we), undefined);
    // publication succeeds exactly at the reached boundary
    assert.equal(await store.publishRevision(ws, we, 'fix-funnel-v1', futureRow.snapshotId, oct, oct), true);
    assert.equal((await store.getPublication(ws, we))?.publishedSnapshotId, futureRow.snapshotId);
  });

  it('a lexically SMALLER new revision at the same fixed snapshotAt replaces the pointer via generation CAS', async () => {
    const { store } = newStore();
    await seedRuns(store, ['f1', 'f2', 'f3', 'f4', 'f5']);
    const revisionA = await genuineRow(store);
    await store.insertSnapshot(revisionA, revisionA.snapshotAt);
    await seedRuns(store, ['f6']); // new content -> a second canonical revision at the same as-of point
    const revisionB = await genuineRow(store);
    await store.insertSnapshot(revisionB, revisionB.snapshotAt);
    assert.notEqual(revisionA.snapshotId, revisionB.snapshotId);

    const [smaller, larger] = [revisionA, revisionB].sort((a, b) => (a.snapshotId < b.snapshotId ? -1 : a.snapshotId > b.snapshotId ? 1 : 0));
    // publish the lexically larger revision first, then the lexically smaller one (publishedAt at
    // the boundary: snapshotAt == publishedAt is publishable, strictly later is future)
    assert.equal(await store.publishRevision(ws, we, 'fix-funnel-v1', larger.snapshotId, we, we), true);
    let pub = await store.getPublication(ws, we);
    assert.equal(pub?.publishedSnapshotId, larger.snapshotId);
    assert.equal(pub?.publicationGeneration, 0);

    // snapshotId lexical order must NOT gate the CAS: the smaller new revision still replaces it
    assert.equal(await store.publishRevision(ws, we, 'fix-funnel-v1', smaller.snapshotId, we, we), true);
    pub = await store.getPublication(ws, we);
    assert.equal(pub?.publishedSnapshotId, smaller.snapshotId);
    assert.equal(pub?.publicationGeneration, 1);
    assert.equal(pub?.snapshotAt, we);
  });

  it('rejects corrupted snapshot payload metadata before storing it', async () => {
    const { store } = newStore();
    await seedRuns(store, ['f1', 'f2', 'f3', 'f4', 'f5']);
    const row = await genuineRow(store);
    const payload = JSON.parse(row.responseJson) as Record<string, unknown>;
    payload.windowEnd = oct;
    await assert.rejects(() => store.insertSnapshot({ ...row, responseJson: canonicalJson(payload) }, row.snapshotAt), /invalid_snapshot_payload/);
    assert.equal(await store.getSnapshot(row.snapshotId), undefined);
  });

  it('fails closed when an existing pointer metadata row is corrupted', async () => {
    const { store, raw } = newStore();
    await seedRuns(store, ['f1', 'f2', 'f3', 'f4', 'f5']);
    const row1 = await genuineRow(store);
    const row2 = await genuineRow(store, oct);
    await store.insertSnapshot(row1, row1.snapshotAt);
    await store.insertSnapshot(row2, row2.snapshotAt);
    assert.equal(await store.publishRevision(ws, we, 'fix-funnel-v1', row1.snapshotId, we, we), true);
    raw.prepare('UPDATE fix_metric_snapshot_publication SET snapshot_at = ? WHERE window_start = ? AND window_end = ?').run(oct, ws, we);
    assert.equal(await store.publishRevision(ws, we, 'fix-funnel-v1', row2.snapshotId, row2.snapshotAt, oct), false);
  });

  it('first-insert publication race leaves exactly one winner without overwriting it', async () => {
    const { store } = newStore();
    await seedRuns(store, ['f1', 'f2', 'f3', 'f4', 'f5']);
    const revisionA = await genuineRow(store);
    await store.insertSnapshot(revisionA, revisionA.snapshotAt);
    await seedRuns(store, ['f6']);
    const revisionB = await genuineRow(store);
    await store.insertSnapshot(revisionB, revisionB.snapshotAt);
    const results = await Promise.all([
      store.publishRevision(ws, we, 'fix-funnel-v1', revisionA.snapshotId, we, we),
      store.publishRevision(ws, we, 'fix-funnel-v1', revisionB.snapshotId, we, we),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    const winner = await store.getPublication(ws, we);
    assert.ok(winner);
    assert.ok(winner.publishedSnapshotId === revisionA.snapshotId || winner.publishedSnapshotId === revisionB.snapshotId);
    assert.equal(winner.publicationGeneration, 0);
  });

  it('publication history records every published revision; stored-but-never-published rows are not history (review P1.5)', async () => {
    const { store } = newStore();
    await seedRuns(store, ['f1', 'f2', 'f3', 'f4', 'f5']);
    const revA = await genuineRow(store);
    await store.insertSnapshot(revA, revA.snapshotAt);
    assert.equal(await store.publishRevision(ws, we, 'fix-funnel-v1', revA.snapshotId, we, we), true);
    await seedRuns(store, ['f6']);
    const revB = await genuineRow(store);
    await store.insertSnapshot(revB, revB.snapshotAt);
    assert.equal(await store.publishRevision(ws, we, 'fix-funnel-v1', revB.snapshotId, we, we), true);
    // the pointer follows the newest revision; BOTH revisions are published history
    assert.equal((await store.getPublication(ws, we))?.publishedSnapshotId, revB.snapshotId);
    assert.equal(await store.hasPublishedRevision(ws, we, 'fix-funnel-v1', revA.snapshotId), true);
    assert.equal(await store.hasPublishedRevision(ws, we, 'fix-funnel-v1', revB.snapshotId), true);
    // a same-window canonical revision that was stored but NEVER published is not published history
    await seedRuns(store, ['f7']);
    const revC = await genuineRow(store);
    await store.insertSnapshot(revC, revC.snapshotAt);
    assert.equal(await store.hasPublishedRevision(ws, we, 'fix-funnel-v1', revC.snapshotId), false);
    // an unknown revision of a published window is not history either
    assert.equal(await store.hasPublishedRevision(ws, we, 'fix-funnel-v1', 's_unknown_revision_0000000001'), false);
  });

  it('pointer update + publication history insert are atomic (review P1.1)', async () => {
    const { sql, raw } = migratedInMemoryDb();
    const store = new MetricStore(sql);
    await seedRuns(store, ['f1', 'f2', 'f3', 'f4', 'f5']);
    const revA = await genuineRow(store);
    await store.insertSnapshot(revA, revA.snapshotAt);
    assert.equal(await store.publishRevision(ws, we, 'fix-funnel-v1', revA.snapshotId, we, we), true);
    await seedRuns(store, ['f6']);
    const revB = await genuineRow(store);
    await store.insertSnapshot(revB, revB.snapshotAt);

    // A database whose transaction poisons the SECOND (history) statement of the batch (a storage
    // failure while binding the history row): the whole unit must roll back, leaving the pointer
    // on revA and no history row for revB — a partial failure must never leave a pointer without
    // its history row.
    const failingDb: SqlDatabase = {
      prepare: (s) => sql.prepare(s),
      transaction: async (statements: BatchStatement[]) => sql.transaction(statements.map((s, i) => (i === statements.length - 1 ? { sql: s.sql, params: [...s.params, 'poison', 'poison'] } : s))),
    };
    await assert.rejects(() => new MetricStore(failingDb).publishRevision(ws, we, 'fix-funnel-v1', revB.snapshotId, we, we));
    let pub = await store.getPublication(ws, we);
    assert.equal(pub?.publishedSnapshotId, revA.snapshotId);
    assert.equal(pub?.publicationGeneration, 0);
    assert.equal(await store.hasPublishedRevision(ws, we, 'fix-funnel-v1', revB.snapshotId), false);

    // Same guarantee on the FIRST-insert path: poisoning the history statement of a brand-new
    // window's publication must leave NO pointer at all (neither half of the write landed).
    const sepRow = await genuineRow(store, oct, {}, '2026-09-01T00:00:00.000Z', oct);
    await store.insertSnapshot(sepRow, sepRow.snapshotAt);
    // (the first-insert path resolves false through its race fallback — no partial state left)
    assert.equal(await new MetricStore(failingDb).publishRevision('2026-09-01T00:00:00.000Z', oct, 'fix-funnel-v1', sepRow.snapshotId, oct, oct), false);
    assert.equal(await store.getPublication('2026-09-01T00:00:00.000Z', oct), undefined);
    const pointerRows = raw.prepare('SELECT COUNT(*) AS n FROM fix_metric_snapshot_publication').get() as { n: number };
    assert.equal(Number(pointerRows.n), 1); // only the original window pointer

    // after the transient failure, a healthy retry publishes atomically: pointer AND history
    assert.equal(await store.publishRevision(ws, we, 'fix-funnel-v1', revB.snapshotId, we, we), true);
    pub = await store.getPublication(ws, we);
    assert.equal(pub?.publishedSnapshotId, revB.snapshotId);
    assert.equal(await store.hasPublishedRevision(ws, we, 'fix-funnel-v1', revA.snapshotId), true);
    assert.equal(await store.hasPublishedRevision(ws, we, 'fix-funnel-v1', revB.snapshotId), true);
  });

  it('rejects a skipped-month lineage gap and a corrupted grandparent (review P1.4)', async () => {
    const { store, raw } = newStore();
    await seedRuns(store, ['f1', 'f2', 'f3', 'f4', 'f5']);
    const nov = '2026-11-01T00:00:00.000Z';

    // continuous chain: root (Sep 1) -> child (Oct 1) -> grandchild (Nov 1) is accepted
    const root = await genuineRow(store, we);
    assert.equal(await store.insertSnapshot(root, root.snapshotAt), true);
    const child = await genuineRow(store, oct, { parentSnapshotId: root.snapshotId, rebuildTaskId: 'rebuild_ok_oct' });
    assert.equal(await store.insertSnapshot(child, child.snapshotAt), true);
    const grand = await genuineRow(store, nov, { parentSnapshotId: child.snapshotId, rebuildTaskId: 'rebuild_ok_nov' });
    assert.equal(await store.insertSnapshot(grand, grand.snapshotAt), true);

    // skipped-month gap: a November revision anchored directly to the September root (skipping
    // the October fixed point) is a broken chain and must be rejected
    const skipped = await genuineRow(store, nov, { parentSnapshotId: root.snapshotId, rebuildTaskId: 'rebuild_skipped_month' });
    await assert.rejects(() => store.insertSnapshot(skipped, nov), /snapshot_revision_mismatch/);

    // corrupted grandparent: recursive chain validation invalidates all DESCENDANTS of a forged
    // ancestor, not only its direct children
    raw.prepare("UPDATE fix_metric_snapshots SET response_json = '{\"forged\":true}' WHERE snapshot_id = ?").run(root.snapshotId);
    const afterCorruption = await genuineRow(store, nov, { parentSnapshotId: child.snapshotId, rebuildTaskId: 'rebuild_after_corruption' });
    await assert.rejects(() => store.insertSnapshot(afterCorruption, nov), /snapshot_revision_mismatch/);
    // the child itself is no longer a valid lineage anchor either (its chain reaches the root)
    const childAgain = await genuineRow(store, oct, { parentSnapshotId: root.snapshotId, rebuildTaskId: 'rebuild_child_again' });
    await assert.rejects(() => store.insertSnapshot(childAgain, oct), /snapshot_revision_mismatch/);
  });

  it('latestPublication picks the newest window', async () => {
    const { store } = newStore();
    await seedRuns(store, ['f1', 'f2', 'f3', 'f4', 'f5']);
    const aug = await genuineRow(store);
    const sep = await genuineRow(store, oct, {}, '2026-09-01T00:00:00.000Z', oct);
    await store.insertSnapshot(aug, aug.snapshotAt);
    await store.insertSnapshot(sep, sep.snapshotAt);
    await store.publishRevision(ws, we, 'fix-funnel-v1', aug.snapshotId, we, we);
    await store.publishRevision('2026-09-01T00:00:00.000Z', oct, 'fix-funnel-v1', sep.snapshotId, oct, oct);
    assert.equal((await store.latestPublication())?.publishedSnapshotId, sep.snapshotId);
  });
});
