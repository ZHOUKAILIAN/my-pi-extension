// Migration upgrade-path tests (review P1.2): a deployment from migration 0001 keeps its
// already-published revisions readable after upgrading to 0002 — the existing pointer row is
// backfilled into the new publication-history table.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { buildSnapshotForWindow } from '../src/projection.ts';
import { MetricStore } from '../src/store.ts';
import { FIXED_NOW, applyMigration, makeAcceptedEvent, migratedInMemoryDb } from './helpers.ts';

const AUG_WS = '2026-08-01T00:00:00.000Z';
const SEP_WS = '2026-09-01T00:00:00.000Z';

describe('migration 0002 upgrade path', () => {
  it('backfills the existing pointer row into the publication history so pre-upgrade published revisions stay readable', async () => {
    // step 1: run migration 0001 ONLY (the pre-0002 deployment state)
    const { sql, raw } = migratedInMemoryDb(['0001_initial.sql']);
    const store = new MetricStore(sql);
    const historyTable = raw.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fix_metric_snapshot_publication_history'",
    ).get();
    assert.equal(historyTable, undefined); // the history table does not exist yet

    // step 2: create the pre-0002 state — a genuine canonical revision published through the
    // pointer (0001-era deployments had a pointer but no history table)
    for (const seed of ['f1', 'f2', 'f3', 'f4', 'f5']) {
      const ev = await makeAcceptedEvent(seed, 'run_started', {
        occurredAt: '2026-08-02T10:00:00.000Z',
        receivedAt: '2026-08-02T10:00:00.000Z',
        runId: `run-${seed}`,
        factId: `fact-${seed}`,
      });
      const out = await store.insertAccepted(ev, ev.receivedAt);
      if (out.status !== 'accepted') throw new Error(`seed insert rejected: ${out.status}`);
    }
    const built = await buildSnapshotForWindow(store, await store.allAcceptedEvents(), AUG_WS, SEP_WS, FIXED_NOW);
    assert.equal(await store.insertSnapshot(built.row, built.row.snapshotAt), true);
    raw.prepare(
      `INSERT INTO fix_metric_snapshot_publication (
         window_start, window_end, snapshot_at, definition_version, published_snapshot_id, publication_generation, published_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(AUG_WS, SEP_WS, built.row.snapshotAt, 'fix-funnel-v1', built.row.snapshotId, built.row.snapshotAt, built.row.snapshotAt);

    // step 3: apply the 0002 migration on top of the live data
    applyMigration(raw, '0002_publication_history.sql');

    // step 4: the pointer target must have been backfilled as a history row (same window,
    // definition, snapshot id and as-of point)
    const backfilled = raw
      .prepare('SELECT window_start, window_end, definition_version, snapshot_id, snapshot_at FROM fix_metric_snapshot_publication_history')
      .all() as { window_start: string; window_end: string; definition_version: string; snapshot_id: string; snapshot_at: string }[];
    assert.equal(backfilled.length, 1);
    assert.deepEqual({ ...backfilled[0] }, {
      window_start: AUG_WS,
      window_end: SEP_WS,
      definition_version: 'fix-funnel-v1',
      snapshot_id: built.row.snapshotId,
      snapshot_at: built.row.snapshotAt,
    });

    // step 5: the store-level visibility contract works after the upgrade — the pre-upgrade
    // published revision is readable published history; an unpublished revision is not
    assert.equal(await store.hasPublishedRevision(AUG_WS, SEP_WS, 'fix-funnel-v1', built.row.snapshotId), true);
    assert.equal(await store.hasPublishedRevision(AUG_WS, SEP_WS, 'fix-funnel-v1', 's_unknown_revision_0000000001'), false);
  });

  it('a fresh 0002 deployment (no pointer yet) backfills nothing', () => {
    const raw = new DatabaseSync(':memory:');
    applyMigration(raw, '0001_initial.sql');
    applyMigration(raw, '0002_publication_history.sql');
    const rows = raw.prepare('SELECT COUNT(*) AS n FROM fix_metric_snapshot_publication_history').get() as { n: number };
    assert.equal(Number(rows.n), 0);
  });
});
