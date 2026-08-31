import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateEvent } from '../src/events.ts';
import { buildSnapshotForWindow, ensurePublishedSnapshots, monthWindow, verifyStoredSnapshot } from '../src/projection.ts';
import { MetricStore } from '../src/store.ts';
import { FIXED_NOW, fixedNow, makeAcceptedEvent, migratedInMemoryDb, syntheticRunEvents } from './helpers.ts';

const AUG_WS = '2026-08-01T00:00:00.000Z';
const SEP_WS = '2026-09-01T00:00:00.000Z';

async function ingestWire(store: MetricStore, wireEvents: Record<string, unknown>[]): Promise<void> {
  for (const wire of wireEvents) {
    const outcome = await validateEvent(wire, { now: fixedNow(), futureSkewMs: 5 * 60 * 1000, lateEventWindowMs: 24 * 60 * 60 * 1000 });
    if (outcome.kind !== 'ok') throw new Error(`wire event rejected: ${outcome.errorCode}`);
    const { status } = await store.insertAccepted(outcome.event, outcome.event.receivedAt);
    if (status !== 'accepted') throw new Error(`wire insert rejected: ${status}`);
  }
}

describe('monthWindow', () => {
  it('buckets UTC months correctly', () => {
    assert.deepEqual(monthWindow('2026-08-02T12:00:00.000Z'), { windowStart: AUG_WS, windowEnd: SEP_WS });
    assert.deepEqual(monthWindow('2026-08-31T23:59:59.000Z'), { windowStart: AUG_WS, windowEnd: SEP_WS });
    assert.deepEqual(monthWindow('2026-09-01T00:00:00.000Z'), { windowStart: SEP_WS, windowEnd: '2026-10-01T00:00:00.000Z' });
  });
});

describe('buildSnapshotForWindow', () => {
  async function dataset(augSeeds: string[], sepSeeds: string[]) {
    const { sql, raw } = migratedInMemoryDb();
    const store = new MetricStore(sql);
    for (const seed of augSeeds) await ingestWire(store, syntheticRunEvents({ seed, reached: 5 }));
    for (const seed of sepSeeds) {
      const events = syntheticRunEvents({ seed, reached: 5 });
      const overlapped = events.map((e) => ({ ...e, occurredAt: e.occurredAt.replace('2026-08-01', '2026-09-05') }));
      await ingestWire(store, overlapped);
    }
    return { store, raw };
  }

  it('full runs produce a 100%-completion funnel with per-branch counts', async () => {
    const { store, raw } = await dataset(['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8'], []);
    const built = await buildSnapshotForWindow(store, await store.allAcceptedEvents(), AUG_WS, SEP_WS, fixedNow());
    assert.equal(built.payload.totalRuns, 8);
    assert.deepEqual(
      built.payload.steps.map((s) => s.runs),
      [8, 8, 8, 8, 8],
    );
    assert.deepEqual(built.payload.resolutionTypes, { code_change: 8 });
    assert.deepEqual(built.payload.dataQuality, { incompleteRuns: 0, lateEvents: 0, invalidEvents: 0, lateEventRuns: 0, invalidEventRuns: 0, lowSampleProtected: false });
    assert.equal(built.payload.windowEnd, SEP_WS);
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM fix_metric_events').get()?.n, 40);
  });

  it('drops, branches and mixed completion shape the funnel exactly', async () => {
    const { sql } = migratedInMemoryDb();
    const store = new MetricStore(sql);
    // 5 full, 3 dropping at review, 2 reaching resolution with distinct branches
    for (const seed of ['f1', 'f2', 'f3', 'f4', 'f5']) await ingestWire(store, syntheticRunEvents({ seed, reached: 5 }));
    for (const seed of ['r1', 'r2', 'r3']) await ingestWire(store, syntheticRunEvents({ seed, reached: 2 }));
    await ingestWire(store, syntheticRunEvents({ seed: 'd1', reached: 3, resolutionType: 'no_change_expected_behavior' }));
    await ingestWire(store, syntheticRunEvents({ seed: 'd2', reached: 3, resolutionType: 'versioned_config_change' }));

    const built = await buildSnapshotForWindow(store, await store.allAcceptedEvents(), AUG_WS, SEP_WS, fixedNow());
    assert.equal(built.payload.totalRuns, 10);
    assert.deepEqual(
      built.payload.steps.map((s) => s.runs),
      [10, 10, 7, 5, 5],
    );
    assert.deepEqual(built.payload.resolutionTypes, {
      code_change: 5,
      no_change_expected_behavior: 1,
      versioned_config_change: 1,
    });
    assert.equal(built.payload.dataQuality.incompleteRuns, 5);
    // quarantine probe adds to invalidEvents for the window
    await store.insertQuarantine({
      eventId: 'q-x',
      factId: 'fact-q',
      eventBusinessKey: 'k-q',
      eventCanonicalHash: 'h-q',
      reasonCode: 'late_event',
      receivedAt: FIXED_NOW.toISOString(),
      occurredAt: '2026-08-15T00:00:00.000Z',
      eventJson: '{}',
    });
    const rebuilt = await buildSnapshotForWindow(store, await store.allAcceptedEvents(), AUG_WS, SEP_WS, fixedNow());
    assert.equal(rebuilt.payload.dataQuality.invalidEvents, 1);
  });

  it('data-quality run units deduplicate repeated quarantine records for one run and suppress unattributable ones', async () => {
    const { store } = await dataset(['f1', 'f2', 'f3', 'f4', 'f5'], []);
    const quarantine = (eventId: string, runId?: string) =>
      store.insertQuarantine({
        eventId,
        factId: `fact-${eventId}`,
        eventBusinessKey: `k-${eventId}`,
        eventCanonicalHash: `h-${eventId}`,
        reasonCode: 'late_event',
        receivedAt: FIXED_NOW.toISOString(),
        occurredAt: '2026-08-15T00:00:00.000Z',
        eventJson: '{}',
        ...(runId ? { runId } : {}),
      });
    // five invalid events: three for ONE cohort-attributed safe run, two without any safe run
    // identity (sample units are restricted to the snapshot cohort — review P2)
    await quarantine('q-a1', 'run-f1');
    await quarantine('q-a2', 'run-f1');
    await quarantine('q-a3', 'run-f1');
    await quarantine('q-b1');
    await quarantine('q-b2');
    const built = await buildSnapshotForWindow(store, await store.allAcceptedEvents(), AUG_WS, SEP_WS, fixedNow());
    assert.equal(built.payload.dataQuality.invalidEvents, 5); // event/row diagnostic count is unchanged
    assert.equal(built.payload.dataQuality.invalidEventRuns, 1); // one deduplicated runId sample unit
  });

  it('multiple runs with quality records form multiple deduplicated sample units', async () => {
    const { store } = await dataset(['f1', 'f2', 'f3', 'f4', 'f5'], []);
    for (const runId of ['run-f1', 'run-f2', 'run-f3', 'run-f4', 'run-f5']) {
      await store.insertQuarantine({
        eventId: `q-${runId}`,
        factId: `fact-${runId}`,
        eventBusinessKey: `k-${runId}`,
        eventCanonicalHash: `h-${runId}`,
        reasonCode: 'late_event',
        receivedAt: FIXED_NOW.toISOString(),
        occurredAt: '2026-08-15T00:00:00.000Z',
        eventJson: '{}',
        runId,
      });
    }
    const built = await buildSnapshotForWindow(store, await store.allAcceptedEvents(), AUG_WS, SEP_WS, fixedNow());
    assert.equal(built.payload.dataQuality.invalidEventRuns, 5);
  });

  it('quarantine sample units are restricted to the snapshot cohort (cross-cohort runs never count, review P2)', async () => {
    const { store } = await dataset(['f1', 'f2', 'f3', 'f4', 'f5'], []);
    // quarantines attributed to runs OUTSIDE the August cohort: they keep the row diagnostic
    // count but never create data-quality sample units for this snapshot
    for (const runId of ['run-x1', 'run-x2', 'run-x3']) {
      await store.insertQuarantine({
        eventId: `q-${runId}`, factId: `fact-${runId}`, runId, eventBusinessKey: `k-${runId}`,
        eventCanonicalHash: `h-${runId}`, reasonCode: 'late_event', receivedAt: FIXED_NOW.toISOString(),
        occurredAt: '2026-08-15T00:00:00.000Z', eventJson: '{}',
      });
    }
    // one cohort-attributed quarantine DOES create a sample unit
    await store.insertQuarantine({
      eventId: 'q-cohort', factId: 'fact-cohort', runId: 'run-f2', eventBusinessKey: 'k-cohort',
      eventCanonicalHash: 'h-cohort', reasonCode: 'late_event', receivedAt: FIXED_NOW.toISOString(),
      occurredAt: '2026-08-15T00:00:00.000Z', eventJson: '{}',
    });
    const built = await buildSnapshotForWindow(store, await store.allAcceptedEvents(), AUG_WS, SEP_WS, fixedNow());
    assert.equal(built.payload.dataQuality.invalidEvents, 4); // row diagnostic counts all records
    assert.equal(built.payload.dataQuality.invalidEventRuns, 1); // only the cohort run counts
  });

  it('late accepted events count deduplicated runs, not rows', async () => {
    const { sql } = migratedInMemoryDb();
    const store = new MetricStore(sql);
    // five accepted events 3h late (past the 2h late label, within the 24h quarantine window),
    // all belonging to a single run: 5 event rows but exactly 1 sample unit
    for (let i = 0; i < 5; i += 1) {
      const ev = await makeAcceptedEvent(`late-${i}`, 'run_started', {
        occurredAt: new Date(FIXED_NOW.getTime() - 3 * 60 * 60 * 1000).toISOString(),
        runId: 'run-late',
        factId: `fact-late-${i}`,
      });
      await store.insertAccepted(ev, ev.receivedAt);
    }
    const built = await buildSnapshotForWindow(store, await store.allAcceptedEvents(), AUG_WS, SEP_WS, fixedNow());
    assert.equal(built.payload.dataQuality.lateEvents, 5);
    assert.equal(built.payload.dataQuality.lateEventRuns, 1);
  });

  it('is deterministic for a fixed event set and changes when events change', async () => {
    const { store } = await dataset(['a1'], []);
    const events = await store.allAcceptedEvents();
    const one = await buildSnapshotForWindow(store, events, AUG_WS, SEP_WS, fixedNow());
    const two = await buildSnapshotForWindow(store, events, AUG_WS, SEP_WS, fixedNow());
    assert.equal(one.row.snapshotId, two.row.snapshotId);
    assert.equal(one.row.revisionHash, two.row.revisionHash);

    await ingestWire(store, syntheticRunEvents({ seed: 'a2', reached: 5 }));
    const three = await buildSnapshotForWindow(store, await store.allAcceptedEvents(), AUG_WS, SEP_WS, fixedNow());
    assert.notEqual(three.row.snapshotId, one.row.snapshotId);
  });

  // --- adversarial canonical-determinism coverage (review P1.3/P1.4) ---

  it('input array order never changes identity, hash or response bytes', async () => {
    const { store } = await dataset(['f1', 'f2', 'f3', 'f4', 'f5'], []);
    const events = await store.allAcceptedEvents();
    const forward = await buildSnapshotForWindow(store, events, AUG_WS, SEP_WS, fixedNow());
    const reversed = await buildSnapshotForWindow(store, [...events].reverse(), AUG_WS, SEP_WS, fixedNow());
    assert.equal(forward.row.snapshotId, reversed.row.snapshotId);
    assert.equal(forward.row.revisionHash, reversed.row.revisionHash);
    assert.equal(forward.row.responseJson, reversed.row.responseJson);
  });

  it('the build clock never changes identity or content: freshness derives from the as-of point', async () => {
    const { store } = await dataset(['f1', 'f2', 'f3', 'f4', 'f5'], []);
    const events = await store.allAcceptedEvents();
    const atBoundary = await buildSnapshotForWindow(store, events, AUG_WS, SEP_WS, new Date('2026-09-01T00:00:00.000Z'));
    const monthsLater = await buildSnapshotForWindow(store, events, AUG_WS, SEP_WS, new Date('2026-12-15T08:00:00.000Z'));
    assert.equal(atBoundary.row.snapshotId, monthsLater.row.snapshotId);
    assert.equal(atBoundary.row.revisionHash, monthsLater.row.revisionHash);
    assert.equal(atBoundary.row.responseJson, monthsLater.row.responseJson);
    assert.equal(monthsLater.payload.dataFreshnessSeconds, atBoundary.payload.dataFreshnessSeconds);
    assert.equal(atBoundary.payload.dataFreshnessSeconds, Math.round((Date.parse(SEP_WS) - FIXED_NOW.getTime()) / 1000));
  });

  it('lineage ids are bound into the revision identity (no snapshotId collision across parents)', async () => {
    const { store } = await dataset(['f1', 'f2', 'f3', 'f4', 'f5'], []);
    const events = await store.allAcceptedEvents();
    const root = await buildSnapshotForWindow(store, events, AUG_WS, SEP_WS, fixedNow());
    const child = await buildSnapshotForWindow(store, events, AUG_WS, SEP_WS, fixedNow(), {
      parentSnapshotId: root.row.snapshotId, rebuildTaskId: 'rebuild_20261001T000000000Z',
    });
    const otherChild = await buildSnapshotForWindow(store, events, AUG_WS, SEP_WS, fixedNow(), {
      parentSnapshotId: 's_other_parent_aaaaaaaaaaaaaaaa', rebuildTaskId: 'rebuild_other',
    });
    assert.notEqual(child.row.revisionHash, root.row.revisionHash);
    assert.notEqual(child.row.snapshotId, root.row.snapshotId);
    assert.notEqual(otherChild.row.revisionHash, child.row.revisionHash);
    assert.notEqual(otherChild.row.snapshotId, child.row.snapshotId);
  });

  it('quarantine sample-unit data is bound: runId presence changes the revision identity', async () => {
    const { store } = await dataset(['f1', 'f2', 'f3', 'f4', 'f5'], []);
    const events = await store.allAcceptedEvents();
    const base = await buildSnapshotForWindow(store, events, AUG_WS, SEP_WS, fixedNow());
    await store.insertQuarantine({
      eventId: 'q-run', factId: 'fact-q', runId: 'run-f1', eventBusinessKey: 'k-run',
      eventCanonicalHash: 'h-run', reasonCode: 'late_event', receivedAt: FIXED_NOW.toISOString(),
      occurredAt: '2026-08-15T00:00:00.000Z', eventJson: '{}',
    });
    const withRun = await buildSnapshotForWindow(store, events, AUG_WS, SEP_WS, fixedNow());
    await store.insertQuarantine({
      eventId: 'q-norun', factId: 'fact-q2', eventBusinessKey: 'k-norun',
      eventCanonicalHash: 'h-norun', reasonCode: 'late_event', receivedAt: FIXED_NOW.toISOString(),
      occurredAt: '2026-08-15T00:00:00.000Z', eventJson: '{}',
    });
    const withoutRun = await buildSnapshotForWindow(store, events, AUG_WS, SEP_WS, fixedNow());
    assert.notEqual(withRun.row.revisionHash, base.row.revisionHash);
    assert.notEqual(withoutRun.row.revisionHash, withRun.row.revisionHash);
    assert.equal(withRun.payload.dataQuality.invalidEventRuns, 1);
    assert.equal(withoutRun.payload.dataQuality.invalidEventRuns, 1);
  });

  it('repeated resolution cycles pick the latest valid cycle per run without inflating run counts, in any input order', async () => {
    const { sql } = migratedInMemoryDb();
    const storeM = new MetricStore(sql);
    const run = syntheticRunEvents({ seed: 'cyc', reached: 5 });
    // rework: a SECOND resolution cycle for the same run, later occurredAt, different branch —
    // ingested BEFORE the original resolution event so the input array order is adversarial
    const rework = {
      ...run[2],
      eventId: 'evt-cyc-rework',
      factId: 'fact-cyc-rework',
      resolutionCycleId: 'rc-cyc-2',
      resolutionType: 'versioned_config_change',
      payload: { resolutionEvidenceRef: 'rev-cyc-2' },
      occurredAt: new Date(FIXED_NOW.getTime() - 20 * 60 * 1000).toISOString(),
    };
    await ingestWire(storeM, [run[0], run[1], rework, run[2], run[3], run[4]]);
    const events = await storeM.allAcceptedEvents();
    const forward = await buildSnapshotForWindow(storeM, events, AUG_WS, SEP_WS, fixedNow());
    const reversed = await buildSnapshotForWindow(storeM, [...events].reverse(), AUG_WS, SEP_WS, fixedNow());
    // the LATEST valid cycle (the rework) decides the branch, regardless of array order
    assert.deepEqual(forward.payload.resolutionTypes, { versioned_config_change: 1 });
    assert.deepEqual(reversed.payload.resolutionTypes, { versioned_config_change: 1 });
    assert.equal(forward.row.responseJson, reversed.row.responseJson);
    assert.equal(forward.row.snapshotId, reversed.row.snapshotId);
    // rework history stays in the immutable event store but never inflates public run counts
    assert.equal(forward.payload.steps[2].runs, 1);
    assert.equal(forward.payload.totalRuns, 1);
    assert.equal(events.filter((e) => e.eventType === 'resolution_completed').length, 2);
  });

  it('same-time cycles across multiple runs are resolved by cycle id deterministically, in any input order (review P1.6)', async () => {
    const { sql } = migratedInMemoryDb();
    const storeM = new MetricStore(sql);
    // two runs, EACH with two same-time resolution cycles; the later cycle id wins per run.
    // The later cycles also carry the lexically SMALLER eventIds, and the input order is fully
    // adversarial — the projection must never depend on either.
    const runA = syntheticRunEvents({ seed: 'mra', reached: 5 });
    const runB = syntheticRunEvents({ seed: 'mrb', reached: 5 });
    const lateA = {
      ...runA[2],
      eventId: 'evt-mra-aaa',
      factId: 'fact-mra-late',
      resolutionCycleId: 'rc-mra-2',
      resolutionType: 'versioned_config_change',
      payload: { resolutionEvidenceRef: 'rev-mra-2' },
    };
    const lateB = {
      ...runB[2],
      eventId: 'evt-mrb-aaa',
      factId: 'fact-mrb-late',
      resolutionCycleId: 'rc-mrb-2',
      resolutionType: 'no_change_expected_behavior',
      payload: { resolutionEvidenceRef: 'rev-mrb-2' },
    };
    await ingestWire(storeM, [runB[0], lateA, runB[2], lateB, runA[0], runA[2], runB[1], runA[1]]);
    const events = await storeM.allAcceptedEvents();
    const forward = await buildSnapshotForWindow(storeM, events, AUG_WS, SEP_WS, fixedNow());
    const reversed = await buildSnapshotForWindow(storeM, [...events].reverse(), AUG_WS, SEP_WS, fixedNow());
    assert.deepEqual(forward.payload.resolutionTypes, { versioned_config_change: 1, no_change_expected_behavior: 1 });
    assert.equal(forward.row.responseJson, reversed.row.responseJson);
    assert.equal(forward.row.snapshotId, reversed.row.snapshotId);
    assert.equal(forward.row.revisionHash, reversed.row.revisionHash);
    // rework history stays but never inflates public run counts
    assert.equal(forward.payload.totalRuns, 2);
    assert.equal(forward.payload.steps[2].runs, 2);
  });

  it('verifyStoredSnapshot binds quarantine receivedAt even when the visible aggregates are unchanged (review P1.3)', async () => {
    const { store, raw } = await dataset(['f1', 'f2', 'f3', 'f4', 'f5'], []);
    await store.insertQuarantine({
      eventId: 'q-rx', factId: 'fact-q', runId: 'run-q', eventBusinessKey: 'k-rx',
      eventCanonicalHash: 'h-rx', reasonCode: 'late_event', receivedAt: FIXED_NOW.toISOString(),
      occurredAt: '2026-08-15T00:00:00.000Z', eventJson: '{}',
    });
    const built = await buildSnapshotForWindow(store, await store.allAcceptedEvents(), AUG_WS, SEP_WS, fixedNow());
    assert.equal(await verifyStoredSnapshot(store, built.row), true);
    // transport-only mutation INSIDE the as-of window: invalidEvents/invalidEventRuns and the
    // whole response are unchanged, but the revision hash binds quarantine receivedAt, so the
    // recompute must diverge
    raw.prepare("UPDATE fix_metric_quarantine SET received_at = '2026-08-20T00:00:00.000Z' WHERE event_id = 'q-rx'").run();
    assert.equal(await verifyStoredSnapshot(store, built.row), false);
    // a mutation that moves the record OUT of the as-of window changes the visible response too
    raw.prepare("UPDATE fix_metric_quarantine SET received_at = '2026-09-15T00:00:00.000Z' WHERE event_id = 'q-rx'").run();
    assert.equal(await verifyStoredSnapshot(store, built.row), false);
  });

  it('same-time resolution cycles pick the LATER cycle id by explicit code-point order, not input order or eventId (review P1.4)', async () => {
    const { sql } = migratedInMemoryDb();
    const storeM = new MetricStore(sql);
    const run = syntheticRunEvents({ seed: 'st', reached: 3 });
    const cycleB = {
      ...run[2],
      // lexically SMALLER eventId but the LATER resolution cycle: the cycle id must win
      eventId: 'evt-st-aaa',
      factId: 'fact-st-b',
      resolutionCycleId: 'rc-st-b',
      resolutionType: 'versioned_config_change',
      payload: { resolutionEvidenceRef: 'rev-st-b' },
    };
    // adversarial input order: the later cycle first, plus fully reversed sets below
    await ingestWire(storeM, [run[0], run[1], cycleB, run[2]]);
    const events = await storeM.allAcceptedEvents();
    const forward = await buildSnapshotForWindow(storeM, events, AUG_WS, SEP_WS, fixedNow());
    const reversed = await buildSnapshotForWindow(storeM, [...events].reverse(), AUG_WS, SEP_WS, fixedNow());
    assert.deepEqual(forward.payload.resolutionTypes, { versioned_config_change: 1 });
    assert.equal(forward.row.responseJson, reversed.row.responseJson);
    assert.equal(forward.row.snapshotId, reversed.row.snapshotId);
    assert.equal(forward.row.revisionHash, reversed.row.revisionHash);
    // rework history stays in the event store but the run is never double-counted
    assert.equal(forward.payload.steps[2].runs, 1);
    assert.equal(forward.payload.totalRuns, 1);
    assert.equal(events.filter((e) => e.eventType === 'resolution_completed').length, 2);
  });

  it('verifyStoredSnapshot binds receivedAt even when the visible aggregates are unchanged', async () => {
    const { store, raw } = await dataset(['f1', 'f2', 'f3', 'f4', 'f5'], []);
    const built = await buildSnapshotForWindow(store, await store.allAcceptedEvents(), AUG_WS, SEP_WS, fixedNow());
    assert.equal(await verifyStoredSnapshot(store, built.row), true);
    // mutate a transport field outside the semantic envelope: aggregates stay identical, but the
    // revision hash binds receivedAt, so the recompute must diverge
    raw.prepare('UPDATE fix_metric_events SET received_at = ? WHERE event_id = ?').run('2026-08-01T11:30:00.000Z', 'evt-f1-1');
    assert.equal(await verifyStoredSnapshot(store, built.row), false);
  });
});

describe('ensurePublishedSnapshots', () => {
  it('returns no-data when no run_started exists', async () => {
    const { sql } = migratedInMemoryDb();
    assert.equal(await ensurePublishedSnapshots(new MetricStore(sql), fixedNow()), 'no-data');
  });

  it('later fixed monthly snapshots include late eligible events without mutating the first revision', async () => {
    const { sql } = migratedInMemoryDb();
    const store = new MetricStore(sql);
    const started = await makeAcceptedEvent('progress', 'run_started', {
      occurredAt: '2026-08-02T10:00:00.000Z', receivedAt: '2026-08-02T10:00:00.000Z', runId: 'run-progress', factId: 'fact-progress',
    });
    await store.insertAccepted(started, started.receivedAt);
    const accepted = await makeAcceptedEvent('progress-accepted', 'run_accepted', {
      occurredAt: '2026-09-05T10:00:00.000Z', receivedAt: '2026-09-05T10:00:00.000Z', runId: 'run-progress', factId: 'fact-progress-accepted',
      controlRef: 'ctl-progress', terminalOutcome: 'accepted',
    });
    await store.insertAccepted(accepted, accepted.receivedAt);

    await ensurePublishedSnapshots(store, new Date('2026-11-01T12:00:00.000Z'));
    const first = await store.getSnapshotForWindowAt('2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    const later = await store.getSnapshotForWindowAt('2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    assert.ok(first && later);
    assert.equal(JSON.parse(first.responseJson).steps[4].runs, 0);
    assert.equal(JSON.parse(later.responseJson).steps[4].runs, 1);
    assert.notEqual(first.snapshotId, later.snapshotId);
    assert.equal(JSON.parse(later.responseJson).parentSnapshotId, first.snapshotId);
    assert.equal(JSON.parse(later.responseJson).rebuildTaskId, 'rebuild_20261001T000000000Z');
    assert.equal((await store.getSnapshot(first.snapshotId))?.responseJson, first.responseJson);
  });
  it('does not create or publish a fixed point before its UTC boundary (no future data)', async () => {
    const { sql, raw } = migratedInMemoryDb();
    const store = new MetricStore(sql);
    for (const seed of ['f1', 'f2', 'f3', 'f4', 'f5']) await ingestWire(store, syntheticRunEvents({ seed, reached: 5 }));
    // FIXED_NOW is 2026-08-01: the August windowEnd boundary (2026-09-01) has not been reached,
    // so nothing may be created or published for the August cohort yet.
    assert.equal(await ensurePublishedSnapshots(store, fixedNow()), 'no-data');
    assert.equal(await store.getPublication(AUG_WS, SEP_WS), undefined);
    assert.equal(Number(raw.prepare('SELECT COUNT(*) AS n FROM fix_metric_snapshots').get()?.n), 0);
    // exactly at the boundary the revision is created and published
    const atBoundary = await ensurePublishedSnapshots(store, new Date('2026-09-01T00:00:00.000Z'));
    assert.ok(atBoundary !== 'no-data');
    assert.equal(atBoundary.payload.snapshotAt, SEP_WS);
    assert.equal((await store.getPublication(AUG_WS, SEP_WS))?.publishedSnapshotId, atBoundary.row.snapshotId);
  });

  it('a later fixed point never silently becomes a root when its previous anchor is missing or unverifiable (review P1.6)', async () => {
    const { sql, raw } = migratedInMemoryDb();
    const store = new MetricStore(sql);
    for (const seed of ['f1', 'f2', 'f3', 'f4', 'f5']) await ingestWire(store, syntheticRunEvents({ seed, reached: 5 }));
    assert.ok(await ensurePublishedSnapshots(store, new Date('2026-09-01T00:00:00.000Z')) !== 'no-data');
    // corrupt the stored windowEnd revision outside insertSnapshot: it no longer verifies
    raw.prepare("UPDATE fix_metric_snapshots SET response_json = '{\"forged\":true}'").run();
    // the NEXT fixed point must fail closed instead of publishing a forged root
    await assert.rejects(
      () => ensurePublishedSnapshots(store, new Date('2026-10-02T12:00:00.000Z')),
      /missing_lineage_anchor/,
    );
    // no October revision exists for the August window at all (the earlier August pointer from
    // the first run remains untouched — the later point was never created or published)
    assert.equal(await store.getSnapshotForWindowAt(AUG_WS, SEP_WS, '2026-10-01T00:00:00.000Z'), undefined);
  });

  it('publishes every cohort window and advances the pointer, replacing revisions via generation CAS', async () => {
    const { sql } = migratedInMemoryDb();
    const store = new MetricStore(sql);
    for (const seed of ['f1', 'f2', 'f3']) await ingestWire(store, syntheticRunEvents({ seed, reached: 5 }));
    const sepRun = await makeAcceptedEvent('sep1', 'run_started', {
      occurredAt: '2026-09-05T10:00:00.000Z', receivedAt: '2026-09-05T10:00:00.000Z',
    });
    const sepInsert = await store.insertAccepted(sepRun, sepRun.receivedAt);
    assert.deepEqual(sepInsert, { status: 'accepted' });

    // at FIXED_NOW the September window is still open (windowEnd in the future): pending history
    assert.equal(await ensurePublishedSnapshots(store, fixedNow()), 'no-data');
    assert.equal(await store.getPublication(SEP_WS, '2026-10-01T00:00:00.000Z'), undefined);

    const latest = await ensurePublishedSnapshots(store, new Date('2026-10-02T12:00:00.000Z'));
    assert.ok(latest !== 'no-data');
    if (latest === 'no-data') assert.fail('expected data');
    assert.equal(latest.payload.windowStart, SEP_WS);
    const aug = await store.getPublication(AUG_WS, SEP_WS);
    const sep = await store.getPublication(SEP_WS, '2026-10-01T00:00:00.000Z');
    assert.ok(aug && sep);
    assert.equal(aug.snapshotAt, '2026-10-01T00:00:00.000Z'); // advanced to the latest reached point

    // a new revision at the SAME fixed snapshotAt (new content arrived) replaces the pointer
    // through the generation CAS regardless of snapshotId lexical order
    const beforeRevision = await store.getSnapshot(aug.publishedSnapshotId);
    await ingestWire(store, syntheticRunEvents({ seed: 'f4', reached: 5 }));
    const republished = await ensurePublishedSnapshots(store, new Date('2026-10-02T12:00:00.000Z'));
    assert.ok(republished !== 'no-data');
    const augAfter = await store.getPublication(AUG_WS, SEP_WS);
    assert.ok(augAfter);
    assert.notEqual(augAfter.publishedSnapshotId, beforeRevision?.snapshotId);
    assert.notEqual(augAfter.publishedSnapshotId, aug.publishedSnapshotId);
    assert.equal(augAfter.publicationGeneration, (aug?.publicationGeneration ?? 0) + 1);
    assert.equal(augAfter.snapshotAt, '2026-10-01T00:00:00.000Z');

    const latestAgain = await ensurePublishedSnapshots(store, new Date('2026-10-02T12:00:00.000Z'));
    assert.ok(latestAgain !== 'no-data');
    if (latestAgain === 'no-data') assert.fail('expected data');
    assert.equal(latestAgain.payload.snapshotId, republished.payload.snapshotId);
  });
});
