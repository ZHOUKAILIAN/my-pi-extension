import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MetricStore } from '../src/store.ts';
import { buildSnapshotForWindow } from '../src/projection.ts';
import { validateEvent } from '../src/events.ts';
import { createWorker } from '../src/worker.ts';
import type { RuntimeConfig } from '../src/config.ts';
import { FIXED_TOKEN, FIXED_NOW, fixedNow, migratedInMemoryDb, syntheticRunEvents, testConfig } from './helpers.ts';

interface TestWorker {
  fetch(request: Request): Promise<Response>;
  raw: import('node:sqlite').DatabaseSync;
  clock: { value: Date };
  store: MetricStore;
}

function makeWorker(overrides?: Partial<Pick<RuntimeConfig, 'syntheticOnly'>>): TestWorker {
  const { sql, raw } = migratedInMemoryDb();
  const cfg = testConfig({ ...(overrides ?? {}) });
  // Mutable test clock: ingest happens at FIXED_NOW; tests that need published fixed snapshots
  // advance the clock to the window's UTC boundary before calling the read APIs.
  const clock = { value: fixedNow() };
  const store = new MetricStore(sql);
  const worker = createWorker({ store, cfg, now: () => new Date(clock.value.getTime()) });
  return { fetch: (r) => worker.fetch(r), raw, clock, store };
}

// The August window closes exactly at this UTC boundary; fixed snapshots for the synthetic
// August cohort become publishable only from this instant on.
const AUG_BOUNDARY = new Date('2026-09-01T00:00:00.000Z');
// dataFreshnessSeconds for a cohort fully received at FIXED_NOW, observed at the boundary.
const FRESHNESS_AT_BOUNDARY = Math.round((AUG_BOUNDARY.getTime() - FIXED_NOW.getTime()) / 1000);

async function post(
  w: TestWorker,
  path: string,
  body: unknown,
  opts: { token?: string | null; rawBody?: string } = {},
): Promise<{ status: number; bodyJson: unknown }> {
  const token = opts.token === null ? null : opts.token ?? FIXED_TOKEN;
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  headers['content-type'] = 'application/json';
  const request = new Request(`https://fix-metrics.test${path}`, {
    method: 'POST',
    headers,
    body: opts.rawBody !== undefined ? opts.rawBody : JSON.stringify(body),
  });
  const res = await w.fetch(request);
  return { status: res.status, bodyJson: await res.json() };
}

async function get(w: TestWorker, path: string): Promise<{ status: number; bodyJson: unknown }> {
  const res = await w.fetch(new Request(`https://fix-metrics.test${path}`));
  return { status: res.status, bodyJson: await res.json() };
}

// Controlled publish path (review P1.8): GET endpoints are read-only, so tests drive snapshot
// generation through POST /api/v1/snapshots/publish (same guard + auth as ingest).
async function publish(w: TestWorker, opts: { token?: string | null } = {}): Promise<{ status: number; bodyJson: unknown }> {
  return post(w, '/api/v1/snapshots/publish', {}, opts);
}

type AckBody = { items: { eventId: string; status: string; retryable: boolean; errorCode?: string }[] };

describe('worker — auth, bounds and guard', () => {
  it('healthz reports synthetic-only mode', async () => {
    const w = makeWorker();
    const res = await w.fetch(new Request('https://fix-metrics.test/healthz'));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, service: 'fix-metrics', mode: 'synthetic-only' });
  });

  it('unmatched routes fall through to the assets binding; an asset 404 falls through to the JSON 404', async () => {
    const { sql } = migratedInMemoryDb();
    const cfg = testConfig();
    const dashboard = createWorker({
      store: new MetricStore(sql),
      cfg,
      now: fixedNow,
      assets: { fetch: async () => new Response('<html>dashboard</html>', { status: 200, headers: { 'content-type': 'text/html' } }) },
    });
    const asset = await dashboard.fetch(new Request('https://fix-metrics.test/dashboard'));
    assert.equal(asset.status, 200);
    assert.equal(await asset.text(), '<html>dashboard</html>');

    const missing = createWorker({
      store: new MetricStore(sql),
      cfg,
      now: fixedNow,
      assets: { fetch: async () => new Response(null, { status: 404 }) },
    });
    const fallback = await missing.fetch(new Request('https://fix-metrics.test/nope'));
    assert.equal(fallback.status, 404);
    assert.deepEqual(await fallback.json(), { error: { code: 'not_found' } });
  });

  it('POST without token -> 401', async () => {
    const w = makeWorker();
    const { status } = await post(w, '/api/v1/events', {}, { token: null });
    assert.equal(status, 401);
  });

  it('POST with wrong token -> 401', async () => {
    const w = makeWorker();
    const { status } = await post(w, '/api/v1/events', {}, { token: 'wrong' });
    assert.equal(status, 401);
  });

  it('POST when no token is configured -> 503 server_misconfigured', async () => {
    const cfg = testConfig({ ingestTokens: new Set() });
    const { sql } = migratedInMemoryDb();
    const worker = createWorker({ store: new MetricStore(sql), cfg, now: fixedNow });
    const res = await worker.fetch(
      new Request('https://fix-metrics.test/api/v1/events', { method: 'POST', body: '{}' }),
    );
    assert.equal(res.status, 503);
  });

  it('synthetic-only guard fails closed on the ingest path', async () => {
    const w = makeWorker({ syntheticOnly: false });
    const { status, bodyJson } = await post(w, '/api/v1/events', syntheticRunEvents({ seed: 'x' })[0]);
    assert.equal(status, 503);
    const body = bodyJson as { error: { code: string } };
    assert.equal(body.error.code, 'synthetic_only_guard');
    const count = w.raw.prepare('SELECT COUNT(*) AS n FROM fix_metric_events').get() as { n: number };
    assert.equal(Number(count.n), 0);
  });

  it('invalid JSON -> 400', async () => {
    const w = makeWorker();
    const { status } = await post(w, '/api/v1/events', '{}', { rawBody: '{"not json' });
    assert.equal(status, 400);
  });

  it('oversized body -> 413 before parse', async () => {
    const w = makeWorker();
    const { status } = await post(w, '/api/v1/events', {}, { rawBody: JSON.stringify({ filler: 'x'.repeat(300 * 1024) }) });
    assert.equal(status, 413);
  });

  it('batch over 100 events -> 413, nothing stored', async () => {
    const w = makeWorker();
    const events = syntheticRunEvents({ seed: 'b0' });
    const batch = Array.from({ length: 101 }, (_, i) => ({ ...events[0], eventId: `evt-b-${i}` }));
    const { status } = await post(w, '/api/v1/events', batch);
    assert.equal(status, 413);
    const count = w.raw.prepare('SELECT COUNT(*) AS n FROM fix_metric_events').get() as { n: number };
    assert.equal(Number(count.n), 0);
  });
});

describe('worker — ingest and aggregation semantics', () => {
  it('insufficient_history before any accepted run', async () => {
    const w = makeWorker();
    const latest = await get(w, '/api/v1/snapshots/latest');
    assert.equal(latest.status, 200);
    assert.equal((latest.bodyJson as { status: string }).status, 'insufficient_history');
  });

  it('accepted history before the window boundary is pending: no future snapshot is published', async () => {
    const w = makeWorker();
    for (const seed of ['f1', 'f2', 'f3', 'f4', 'f5']) {
      await post(w, '/api/v1/events', syntheticRunEvents({ seed, reached: 5 }));
    }
    // GET is read-only (review P1.8): before the controlled publish path runs, latest must return
    // pending history and NOTHING may be created or published at all.
    const before = await get(w, '/api/v1/snapshots/latest');
    assert.equal((before.bodyJson as { status: string }).status, 'insufficient_history');
    assert.equal(w.raw.prepare('SELECT COUNT(*) AS n FROM fix_metric_snapshots').get()?.n, 0);
    assert.equal(w.raw.prepare('SELECT COUNT(*) AS n FROM fix_metric_snapshot_publication').get()?.n, 0);

    // the controlled publish path never creates a future fixed point either: the August boundary
    // (2026-09-01) has not been reached at the ingest clock
    const pending = await publish(w);
    assert.equal(pending.status, 200);
    assert.equal((pending.bodyJson as { status: string }).status, 'no-data');
    assert.equal(w.raw.prepare('SELECT COUNT(*) AS n FROM fix_metric_snapshots').get()?.n, 0);

    w.clock.value = AUG_BOUNDARY;
    assert.equal((await publish(w)).status, 200);
    const after = await get(w, '/api/v1/snapshots/latest');
    assert.equal((after.bodyJson as { status: string }).status, 'calculable');
    assert.equal((after.bodyJson as { snapshotAt: string }).snapshotAt, AUG_BOUNDARY.toISOString());
  });

  it('GET endpoints are read-only and the publish path is controlled (auth + synthetic-only)', async () => {
    const w = makeWorker();
    for (const seed of ['ro1', 'ro2', 'ro3', 'ro4', 'ro5']) {
      await post(w, '/api/v1/events', syntheticRunEvents({ seed, reached: 5 }));
    }
    w.clock.value = AUG_BOUNDARY;
    // GET /latest must not rebuild or publish anything itself
    assert.equal((await get(w, '/api/v1/snapshots/latest')).status, 200);
    assert.equal(w.raw.prepare('SELECT COUNT(*) AS n FROM fix_metric_snapshots').get()?.n, 0);
    assert.equal(w.raw.prepare('SELECT COUNT(*) AS n FROM fix_metric_snapshot_publication').get()?.n, 0);
    // publish is a controlled write: same auth as ingest
    assert.equal((await publish(w, { token: null })).status, 401);
    assert.equal((await publish(w, { token: 'wrong' })).status, 401);
    assert.equal((await publish(w)).status, 200);
    assert.equal(w.raw.prepare('SELECT COUNT(*) AS n FROM fix_metric_snapshot_publication').get()?.n, 1);
    // a second publish is idempotent
    assert.equal((await publish(w)).status, 200);
    assert.equal(w.raw.prepare('SELECT COUNT(*) AS n FROM fix_metric_snapshot_publication').get()?.n, 1);
  });

  it('publish path fails closed behind the synthetic-only guard', async () => {
    const w = makeWorker({ syntheticOnly: false });
    const res = await publish(w);
    assert.equal(res.status, 503);
    assert.equal((res.bodyJson as { error: { code: string } }).error.code, 'synthetic_only_guard');
  });

  it('retained old revisions stay readable by snapshotId while /latest follows the publication pointer', async () => {
    const w = makeWorker();
    for (const seed of ['f1', 'f2', 'f3', 'f4', 'f5']) {
      await post(w, '/api/v1/events', syntheticRunEvents({ seed, reached: 5 }));
    }
    w.clock.value = AUG_BOUNDARY;
    await publish(w);
    const firstLatest = (await get(w, '/api/v1/snapshots/latest')).bodyJson as { status: string; snapshotId: string; snapshotAt: string };
    assert.equal(firstLatest.status, 'calculable');
    assert.equal(firstLatest.snapshotAt, AUG_BOUNDARY.toISOString());

    // advance two monthly fixed points: the August publication pointer moves to a newer revision
    w.clock.value = new Date('2026-11-02T12:00:00.000Z');
    await publish(w);
    const secondLatest = (await get(w, '/api/v1/snapshots/latest')).bodyJson as { status: string; snapshotId: string; snapshotAt: string };
    assert.equal(secondLatest.status, 'calculable');
    assert.notEqual(secondLatest.snapshotId, firstLatest.snapshotId);
    assert.equal(secondLatest.snapshotAt, '2026-11-01T00:00:00.000Z');

    // the old revision is retained and still readable by its snapshotId (aggregate-only body)
    const oldRes = await get(w, `/api/v1/funnel?snapshotId=${firstLatest.snapshotId}`);
    assert.equal(oldRes.status, 200);
    const oldFunnel = oldRes.bodyJson as { status: string; snapshotId: string; totalRuns: number; snapshotAt: string };
    assert.equal(oldFunnel.snapshotId, firstLatest.snapshotId);
    assert.equal(oldFunnel.snapshotAt, AUG_BOUNDARY.toISOString());
    assert.equal(oldFunnel.totalRuns, 5);
    assert.ok(!JSON.stringify(oldRes.bodyJson).includes('run-'));
  });

  it('a same-window stored-but-never-published revision stays invisible while the published one is readable (explicit publication history)', async () => {
    const w = makeWorker();
    for (const seed of ['f1', 'f2', 'f3', 'f4', 'f5']) {
      await post(w, '/api/v1/events', syntheticRunEvents({ seed, reached: 5 }));
    }
    w.clock.value = AUG_BOUNDARY;
    await publish(w);
    const latest = (await get(w, '/api/v1/snapshots/latest')).bodyJson as { status: string; snapshotId: string };
    assert.equal(latest.status, 'calculable');

    // a canonical revision for the SAME window at a LATER as-of point, stored directly and NEVER
    // published: explicit publication history (pointer + recorded history) is the visibility
    // boundary, so it must not become readable just because its window has a publication
    w.clock.value = new Date('2026-11-02T12:00:00.000Z');
    const unpublished = await buildSnapshotForWindow(
      w.store,
      await w.store.allAcceptedEvents(),
      '2026-08-01T00:00:00.000Z',
      '2026-09-01T00:00:00.000Z',
      w.clock.value,
      { snapshotAt: '2026-10-01T00:00:00.000Z', parentSnapshotId: latest.snapshotId, rebuildTaskId: 'rebuild_20261001T000000000Z' },
    );
    assert.notEqual(unpublished.row.snapshotId, latest.snapshotId);
    assert.equal(await w.store.insertSnapshot(unpublished.row, w.clock.value.toISOString()), true);
    const invisible = await get(w, `/api/v1/funnel?snapshotId=${unpublished.row.snapshotId}`);
    assert.equal(invisible.status, 404);
    assert.equal((invisible.bodyJson as { error: { code: string } }).error.code, 'snapshot_not_published');
    // the published revision of the same window stays readable
    const visible = await get(w, `/api/v1/funnel?snapshotId=${latest.snapshotId}`);
    assert.equal(visible.status, 200);
  });

  it('a stored revision whose window was never published stays invisible (fail closed)', async () => {
    const w = makeWorker();
    for (const seed of ['f1', 'f2', 'f3', 'f4', 'f5']) {
      await post(w, '/api/v1/events', syntheticRunEvents({ seed, reached: 5 }));
    }
    w.clock.value = new Date('2026-10-02T12:00:00.000Z');
    // a canonical revision for the SEPTEMBER window (no run_started there): inserted directly,
    // never part of any published lineage — ensurePublishedSnapshots never creates a pointer
    // for a window without a run_started cohort, so it stays invisible
    const built = await buildSnapshotForWindow(
      w.store,
      await w.store.allAcceptedEvents(),
      '2026-09-01T00:00:00.000Z',
      '2026-10-01T00:00:00.000Z',
      w.clock.value,
    );
    await w.store.insertSnapshot(built.row, w.clock.value.toISOString());
    const res = await get(w, `/api/v1/funnel?snapshotId=${built.row.snapshotId}`);
    assert.equal(res.status, 404);
    assert.equal((res.bodyJson as { error: { code: string } }).error.code, 'snapshot_not_published');
  });

  it('serving rejects a stored snapshot whose content no longer recomputes from canonical inputs', async () => {
    const w = makeWorker();
    for (const seed of ['f1', 'f2', 'f3', 'f4', 'f5']) {
      await post(w, '/api/v1/events', syntheticRunEvents({ seed, reached: 5 }));
    }
    w.clock.value = AUG_BOUNDARY;
    await publish(w);
    const latestRes = await get(w, '/api/v1/snapshots/latest');
    const latest = latestRes.bodyJson as { status: string; snapshotId: string };
    assert.equal(latest.status, 'calculable');

    // mutate the stored payload content outside insertSnapshot (forged/mutated row)
    const stored = w.raw.prepare('SELECT response_json AS responseJson FROM fix_metric_snapshots WHERE snapshot_id = ?').get(latest.snapshotId) as { responseJson: string };
    const payload = JSON.parse(stored.responseJson) as Record<string, unknown>;
    payload.totalRuns = 999;
    w.raw.prepare('UPDATE fix_metric_snapshots SET response_json = ? WHERE snapshot_id = ?').run(JSON.stringify(payload), latest.snapshotId);

    const tamperedLatest = await get(w, '/api/v1/snapshots/latest');
    assert.equal(tamperedLatest.status, 500);
    assert.equal((tamperedLatest.bodyJson as { error: { code: string } }).error.code, 'snapshot_revision_mismatch');
    const tamperedFunnel = await get(w, `/api/v1/funnel?snapshotId=${latest.snapshotId}`);
    assert.equal(tamperedFunnel.status, 500);
    assert.equal((tamperedFunnel.bodyJson as { error: { code: string } }).error.code, 'snapshot_revision_mismatch');
  });

  it('accepts one fully-completed synthetic run', async () => {
    const w = makeWorker();
    const { status, bodyJson } = await post(w, '/api/v1/events', syntheticRunEvents({ seed: 'run1' }));
    assert.equal(status, 202);
    const acks = (bodyJson as AckBody).items;
    assert.deepEqual(acks.map((a) => a.status), ['accepted', 'accepted', 'accepted', 'accepted', 'accepted']);
  });

  it('a cohort of 10 runs with 5 accepted is calculable, aggregate-only', async () => {
    const w = makeWorker();
    for (const seed of ['f1', 'f2', 'f3', 'f4', 'f5']) {
      await post(w, '/api/v1/events', syntheticRunEvents({ seed, reached: 5 }));
    }
    for (const seed of ['r1', 'r2', 'r3', 'r4', 'r5']) {
      await post(w, '/api/v1/events', syntheticRunEvents({ seed, reached: 2 }));
    }
    // resolution branch buckets are homogeneous on purpose: the approved low-sample rule hides
    // the WHOLE response when ANY branch bucket has < k=5 runs, so a calculable fixture must
    // keep every exposed bucket at >= 5 (multi-branch distribution is covered at the projection
    // layer in projection.test.ts, not through the public API).
    for (const seed of ['p1', 'p2', 'p3', 'p4', 'p5']) {
      await post(w, '/api/v1/events', syntheticRunEvents({ seed, reached: 3 }));
    }

    // advance to the window boundary and run the controlled publish path before reading
    w.clock.value = AUG_BOUNDARY;
    await publish(w);
    const latestRes = await get(w, '/api/v1/snapshots/latest');
    const latest = latestRes.bodyJson as { status: string; snapshotId: string; definitionVersion: string; windowStart: string; windowEnd: string; snapshotAt: string };
    assert.equal(latest.status, 'calculable');
    assert.match(latest.snapshotId, /^s_[A-Za-z0-9_-]+$/);
    assert.equal(latest.definitionVersion, 'fix-funnel-v1');
    assert.equal(latest.windowStart, '2026-08-01T00:00:00.000Z');
    assert.equal(latest.windowEnd, '2026-09-01T00:00:00.000Z');

    const funnelRes = await get(w, `/api/v1/funnel?snapshotId=${latest.snapshotId}`);
    assert.equal(funnelRes.status, 200);
    const funnel = funnelRes.bodyJson as {
      status: string;
      totalRuns: number;
      steps: { eventType: string; runs: number; fromPreviousRate: number | null }[];
      resolutionTypes: Record<string, number>;
    };
    assert.equal(funnel.status, 'calculable');
    assert.equal(funnel.totalRuns, 15);
    assert.deepEqual(funnel.steps.map((s) => s.runs), [15, 15, 10, 5, 5]);
    assert.deepEqual(funnel.resolutionTypes, { code_change: 10 });

    // aggregate-only: no run/fact ids, no payload text anywhere in the response
    const rawLatest = JSON.stringify(latestRes.bodyJson);
    const rawFunnel = JSON.stringify(funnelRes.bodyJson);
    assert.ok(!rawLatest.includes('run-'));
    assert.ok(!rawFunnel.includes('run-'));
    assert.ok(!rawFunnel.includes('fact-'));
    assert.ok(!rawFunnel.includes('rev-'));
    assert.ok(!rawFunnel.includes('ctl-'));
  });

  it('funnel param validation', async () => {
    const w = makeWorker();
    const missing = await get(w, '/api/v1/funnel');
    assert.equal(missing.status, 400);
    const malformed = await get(w, '/api/v1/funnel?snapshotId=../../etc%2Fpasswd');
    assert.equal(malformed.status, 400);
    const unknown = await get(w, '/api/v1/funnel?snapshotId=s_NopeThisSnapshotIdDoesNotExistAnywhere12345678');
    assert.equal(unknown.status, 404);
  });

  it('low-sample protection hides the funnel below k=5', async () => {
    const w = makeWorker();
    await post(w, '/api/v1/events', syntheticRunEvents({ seed: 'small1', reached: 5 }));
    await post(w, '/api/v1/events', syntheticRunEvents({ seed: 'small2', reached: 5 }));
    w.clock.value = AUG_BOUNDARY;
    await publish(w);

    const latestRes = await get(w, '/api/v1/snapshots/latest');
    assert.deepEqual(latestRes.bodyJson, {
      definitionVersion: 'fix-funnel-v1',
      windowStart: '2026-08-01T00:00:00.000Z',
      windowEnd: '2026-09-01T00:00:00.000Z',
      snapshotAt: '2026-09-01T00:00:00.000Z',
      status: 'low_sample_protected',
      dataFreshnessSeconds: FRESHNESS_AT_BOUNDARY,
    });

    const stored = w.raw.prepare('SELECT snapshot_id AS snapshotId FROM fix_metric_snapshots LIMIT 1').get() as { snapshotId: string };
    const funnelRes = await get(w, `/api/v1/funnel?snapshotId=${stored.snapshotId}`);
    assert.equal(funnelRes.status, 200);
    assert.deepEqual(funnelRes.bodyJson, latestRes.bodyJson);
  });

  it('replay of the same run is fully duplicate', async () => {
    const w = makeWorker();
    await post(w, '/api/v1/events', syntheticRunEvents({ seed: 'rep', reached: 5 }));
    const { bodyJson } = await post(w, '/api/v1/events', syntheticRunEvents({ seed: 'rep', reached: 5 }));
    assert.deepEqual((bodyJson as AckBody).items.map((a) => a.status), [
      'duplicate',
      'duplicate',
      'duplicate',
      'duplicate',
      'duplicate',
    ]);
  });

  it('accepts only typed envelope fields', async () => {
    const [event] = syntheticRunEvents({ seed: 'typed' });
    for (const [field, value] of [['workflowDefinitionVersion', 1], ['stage', 42], ['eventBusinessKey', 42], ['runId', false]] as const) {
      const outcome = await validateEvent({ ...event, [field]: value }, { now: fixedNow(), futureSkewMs: 5 * 60 * 1000, lateEventWindowMs: 24 * 60 * 60 * 1000 });
      assert.deepEqual(outcome, { kind: 'permanent', errorCode: 'invalid_field_type' });
    }
  });

  it('same fact re-confirmed with a different resolution branch is a conflict', async () => {
    const w = makeWorker();
    await post(w, '/api/v1/events', syntheticRunEvents({ seed: 'conf', reached: 5 }));
    const { bodyJson } = await post(w, '/api/v1/events', syntheticRunEvents({ seed: 'conf', reached: 5, resolutionType: 'runtime_or_data_action' }));
    const acks = (bodyJson as AckBody).items;
    assert.equal(acks[2].status, 'permanent_error');
    assert.equal(acks[2].errorCode, 'event_id_or_business_key_conflict');
    assert.deepEqual(acks.filter((a) => a.status === 'duplicate').length, 4);
  });


  it('late and unsafe events are quarantined, never projected', async () => {
    const w = makeWorker();
    await post(w, '/api/v1/events', syntheticRunEvents({ seed: 'q1', reached: 5 }));
    const late = syntheticRunEvents({ seed: 'late1', reached: 5 }).map((e) => ({
      ...e,
      occurredAt: new Date(FIXED_NOW.getTime() - 25 * 60 * 60 * 1000).toISOString(),
    }));
    const lateRes = await post(w, '/api/v1/events', late);
    assert.deepEqual(
      (lateRes.bodyJson as AckBody).items.map((a) => a.status),
      ['quarantined', 'quarantined', 'quarantined', 'quarantined', 'quarantined'],
    );

    // advance to the boundary before reading the protected public shape
    w.clock.value = AUG_BOUNDARY;
    await publish(w);
    const latestRes = await get(w, '/api/v1/snapshots/latest');
    const latest = latestRes.bodyJson as { status: string; snapshotId?: string };
    assert.notEqual(latest.status, 'insufficient_history'); // only the accepted run exists
    assert.equal(latest.snapshotId, undefined); // protected shape does not leak an identifier

    const qcount = w.raw.prepare('SELECT COUNT(*) AS n FROM fix_metric_quarantine').get() as { n: number };
    assert.equal(Number(qcount.n), 5);
  });

  it('unrelated invalid events are each durably quarantined with unique server-side identities', async () => {
    const w = makeWorker();
    // identical safe metadata (same factId), different unsafe eventId/runId content per event
    const mk = (n: number) =>
      syntheticRunEvents({ seed: 'same', reached: 1 }).map((e) => ({
        ...e,
        eventId: `evt\u4e2d\u6587-${n}`,
        runId: `run\u4e2d-${n}`,
      }));
    const res = await post(w, '/api/v1/events', [...mk(1), ...mk(2), ...mk(3)]);
    assert.equal(res.status, 202);
    assert.deepEqual((res.bodyJson as AckBody).items.map((a) => a.status), ['quarantined', 'quarantined', 'quarantined']);
    const rows = w.raw.prepare('SELECT event_id, event_business_key, event_canonical_hash FROM fix_metric_quarantine ORDER BY event_id').all() as { event_id: string; event_business_key: string; event_canonical_hash: string }[];
    assert.equal(rows.length, 3);
    assert.equal(new Set(rows.map((r) => r.event_id)).size, 3);
    assert.ok(rows.every((r) => r.event_id !== '[redacted]'));
    assert.ok(rows.every((r) => r.event_business_key !== '[unkeyed]'));
    assert.ok(rows.every((r) => r.event_canonical_hash !== '[unkeyed]'));
    // retry of the exact same batch: same bytes -> same identity -> duplicates, never a second insert
    const retry = await post(w, '/api/v1/events', [...mk(1), ...mk(2), ...mk(3)]);
    assert.deepEqual((retry.bodyJson as AckBody).items.map((a) => a.status), ['quarantined', 'quarantined', 'quarantined']);
    const count = w.raw.prepare('SELECT COUNT(*) AS n FROM fix_metric_quarantine').get() as { n: number };
    assert.equal(Number(count.n), 3);
  });

  it('public funnel output never exposes quarantine run identity', async () => {
    const w = makeWorker();
    for (const seed of ['f1', 'f2', 'f3', 'f4', 'f5']) {
      await post(w, '/api/v1/events', syntheticRunEvents({ seed, reached: 5 }));
    }
    // five future-skewed invalid runs with safe runIds OUTSIDE the accepted cohort: their run
    // identities are retained internally but cross-cohort records never create sample units
    // (invalidEventRuns=0), and no run identity may ever appear in the public body
    for (const seed of ['q1', 'q2', 'q3', 'q4', 'q5']) {
      await post(w, '/api/v1/events', syntheticRunEvents({ seed, reached: 1, overrides: { occurredAt: new Date(FIXED_NOW.getTime() + 10 * 60 * 1000).toISOString() } }));
    }
    // advance to the boundary and publish before reading
    w.clock.value = AUG_BOUNDARY;
    await publish(w);
    const latestRes = await get(w, '/api/v1/snapshots/latest');
    const latest = latestRes.bodyJson as { status: string; snapshotId?: string };
    assert.equal(latest.status, 'calculable');
    const funnelRes = await get(w, `/api/v1/funnel?snapshotId=${latest.snapshotId}`);
    assert.equal(funnelRes.status, 200);
    const body = JSON.stringify(funnelRes.bodyJson);
    assert.ok(!body.includes('run-q'));
    assert.ok(!body.includes('fact-q'));
    assert.ok(!body.includes('evt-q'));
    assert.ok(!body.includes('runId'));
    const funnel = funnelRes.bodyJson as { dataQuality: { invalidEvents: number; invalidEventRuns: number } };
    assert.equal(funnel.dataQuality.invalidEvents, 5); // row diagnostic keeps all window records
    assert.equal(funnel.dataQuality.invalidEventRuns, 0); // cross-cohort runs create no sample units (review P2)
  });

  it('verification_passed must bind to the actual resolution of its cycle (review P1.2)', async () => {
    const w = makeWorker();
    await post(w, '/api/v1/events', syntheticRunEvents({ seed: 'bind', reached: 5 }));
    const [,, , ver] = syntheticRunEvents({ seed: 'bind', reached: 4 });
    // unrelated cycle: no resolution_completed exists for it -> unbound evidence is permanent
    const unknownCycle = { ...ver, eventId: 'evt-bind-evil1', factId: 'fact-bind-evil1', resolutionCycleId: 'rc-nowhere' };
    const r1 = await post(w, '/api/v1/events', unknownCycle);
    assert.deepEqual((r1.bodyJson as AckBody).items[0], { eventId: unknownCycle.eventId, status: 'permanent_error', retryable: false, errorCode: 'unbound_verification_evidence' });
    // matching cycle but UNRELATED evidence ref -> permanent
    const unrelated = { ...ver, eventId: 'evt-bind-evil2', factId: 'fact-bind-evil2', payload: { resolutionEvidenceRef: 'rev-someone-else' } };
    const r2 = await post(w, '/api/v1/events', unrelated);
    assert.equal((r2.bodyJson as AckBody).items[0].errorCode, 'unbound_verification_evidence');
    // arbitrary candidateRevision the resolution never carried -> permanent
    const forgedRevision = { ...ver, eventId: 'evt-bind-evil3', factId: 'fact-bind-evil3', candidateRevision: 'rev-forged', payload: {} };
    const r3 = await post(w, '/api/v1/events', forgedRevision);
    assert.equal((r3.bodyJson as AckBody).items[0].errorCode, 'unbound_verification_evidence');
    // matching evidence for the real cycle is accepted (new fact, coherent binding)
    const coherent = { ...ver, eventId: 'evt-bind-ok', factId: 'fact-bind-ok' };
    const r4 = await post(w, '/api/v1/events', coherent);
    assert.deepEqual((r4.bodyJson as AckBody).items[0], { eventId: coherent.eventId, status: 'accepted', retryable: false });
    // nothing of the rejected events was durably accepted
    const count = w.raw.prepare("SELECT COUNT(*) AS n FROM fix_metric_events WHERE fact_id LIKE 'fact-bind-evil%'").get() as { n: number };
    assert.equal(Number(count.n), 0);
  });

  it('a future-dated pointer target is rejected on ALL public read paths (review P1.3)', async () => {
    const w = makeWorker();
    // five September-cohort runs (ingested when fresh in September)
    w.clock.value = new Date('2026-09-05T12:00:00.000Z');
    for (const seed of ['s1', 's2', 's3', 's4', 's5']) {
      const mapped = syntheticRunEvents({ seed, reached: 5 }).map((e) => ({ ...e, occurredAt: e.occurredAt.replace('2026-08-01', '2026-09-05') }));
      const res = await post(w, '/api/v1/events', mapped);
      assert.deepEqual((res.bodyJson as AckBody).items.map((a) => a.status), ['accepted', 'accepted', 'accepted', 'accepted', 'accepted']);
    }
    // publish in November: the September pointer advances to the November fixed point
    w.clock.value = new Date('2026-11-02T12:00:00.000Z');
    await publish(w);
    const latest = (await get(w, '/api/v1/snapshots/latest')).bodyJson as { status: string; snapshotId: string; snapshotAt: string };
    assert.equal(latest.status, 'calculable');
    assert.equal(latest.snapshotAt, '2026-11-01T00:00:00.000Z');

    // rewind the server clock BEFORE the pointer target's as-of point: the pointer target is now
    // future data and must fail closed on EVERY public read path (pointer target and latest
    // included — not only retained revisions)
    w.clock.value = new Date('2026-10-15T12:00:00.000Z');
    const latestRewound = await get(w, '/api/v1/snapshots/latest');
    assert.equal(latestRewound.status, 404);
    assert.equal((latestRewound.bodyJson as { error: { code: string } }).error.code, 'future_snapshot');
    const funnel = await get(w, `/api/v1/funnel?snapshotId=${latest.snapshotId}`);
    assert.equal(funnel.status, 404);
    assert.equal((funnel.bodyJson as { error: { code: string } }).error.code, 'future_snapshot');
    // the pointer row itself is untouched (fail closed serving, not corruption handling)
    w.clock.value = new Date('2026-11-02T12:00:00.000Z');
    const recovered = (await get(w, '/api/v1/snapshots/latest')).bodyJson as { status: string; snapshotId: string };
    assert.equal(recovered.status, 'calculable');
    assert.equal(recovered.snapshotId, latest.snapshotId);
  });

  it('run_accepted requires prior accepted Acceptance evidence for the same run (review P1.5)', async () => {
    const w = makeWorker();
    const events = syntheticRunEvents({ seed: 'acc' });
    // a bare valid-shape run_accepted (no verification_passed for this run yet) is permanent
    const bare = await post(w, '/api/v1/events', events[4]);
    assert.deepEqual((bare.bodyJson as AckBody).items[0], {
      eventId: 'evt-acc-5',
      status: 'permanent_error',
      retryable: false,
      errorCode: 'run_accepted_without_verification',
    });
    // another run's verification evidence does NOT unlock this run
    await post(w, '/api/v1/events', syntheticRunEvents({ seed: 'accother', reached: 4 }));
    const crossRun = await post(w, '/api/v1/events', { ...events[4], eventId: 'evt-acc-5b', factId: 'fact-acc-5b' });
    assert.equal((crossRun.bodyJson as AckBody).items[0].errorCode, 'run_accepted_without_verification');
    // nothing of the rejected facts was durably accepted
    const count = w.raw.prepare("SELECT COUNT(*) AS n FROM fix_metric_events WHERE event_type = 'run_accepted'").get() as { n: number };
    assert.equal(Number(count.n), 0);
    // once the run's OWN resolution + verification are accepted, run_accepted is accepted
    const full = await post(w, '/api/v1/events', events);
    assert.deepEqual((full.bodyJson as AckBody).items.map((a) => a.status), ['accepted', 'accepted', 'accepted', 'accepted', 'accepted']);
    // a replay of the same run_accepted stays a duplicate (the evidence is in the store)
    const replay = await post(w, '/api/v1/events', [events[4]]);
    assert.deepEqual((replay.bodyJson as AckBody).items[0].status, 'duplicate');
  });

  it('verification binding enforces resolution.occurredAt <= verification.occurredAt (review P2)', async () => {
    const w = makeWorker();
    await post(w, '/api/v1/events', syntheticRunEvents({ seed: 'bind2', reached: 5 }));
    const ver = syntheticRunEvents({ seed: 'bind2', reached: 4 })[3];
    // same cycle + same evidence, but occurredAt BEFORE its resolution (start + 20min) -> permanent
    const early = {
      ...ver,
      eventId: 'evt-bind2-early',
      factId: 'fact-bind2-early',
      occurredAt: new Date(Date.parse(ver.occurredAt) - 25 * 60 * 1000).toISOString(),
    };
    const res = await post(w, '/api/v1/events', early);
    assert.deepEqual((res.bodyJson as AckBody).items[0], {
      eventId: early.eventId,
      status: 'permanent_error',
      retryable: false,
      errorCode: 'unbound_verification_evidence',
    });
    // an equal-or-later verification for the same cycle is accepted (control)
    const ok = { ...ver, eventId: 'evt-bind2-ok', factId: 'fact-bind2-ok' };
    const okRes = await post(w, '/api/v1/events', ok);
    assert.deepEqual((okRes.bodyJson as AckBody).items[0], { eventId: ok.eventId, status: 'accepted', retryable: false });
  });

  it('ACKs never echo an unvalidated/unsafe eventId (review P2.9)', async () => {
    const w = makeWorker();
    const unsafeId = 'evt\u4e2d\u6587-unsafe';
    // permanent error with an unsafe eventId: fixed safe placeholder, never the raw value
    const permanent = await post(w, '/api/v1/events', {
      eventId: unsafeId,
      eventType: 'nuke_all',
      schemaVersion: 1,
    });
    const permanentAck = (permanent.bodyJson as AckBody).items[0];
    assert.equal(permanentAck.status, 'permanent_error');
    assert.equal(permanentAck.eventId, '[unknown]');
    // quarantined unsafe event: the ACK carries the server-generated SAFE quarantine identity
    const quarantined = await post(w, '/api/v1/events', {
      ...syntheticRunEvents({ seed: 'acksafe' })[0],
      eventId: unsafeId,
      occurredAt: new Date(FIXED_NOW.getTime() - 25 * 60 * 60 * 1000).toISOString(),
    });
    const quarantineAck = (quarantined.bodyJson as AckBody).items[0];
    assert.equal(quarantineAck.status, 'quarantined');
    assert.notEqual(quarantineAck.eventId, unsafeId);
    assert.match(quarantineAck.eventId, /^qz_[A-Za-z0-9_-]+$/);
    // oversized (non-id-shaped) eventId in a permanent-error item is also never echoed
    const oversized = await post(w, '/api/v1/events', { ...syntheticRunEvents({ seed: 'ackbig' })[0], eventId: 'evt-' + 'x'.repeat(200), eventType: 'nuke_all' });
    assert.equal((oversized.bodyJson as AckBody).items[0].eventId, '[unknown]');
    // nothing anywhere in the response echoes the unsafe raw id
    assert.ok(!JSON.stringify(quarantined.bodyJson).includes('\u4e2d\u6587'));
  });

  it('quarantine identity for uncanonicalizable bytes is deterministic (never a random UUID)', async () => {
    const w = makeWorker();
    // a lone surrogate in eventId makes canonical JSON impossible; the identity must still be a
    // deterministic function of the raw bytes
    const rawBatch = (n: number) =>
      JSON.stringify(
        syntheticRunEvents({ seed: 'ls', reached: 1 }).map((e) => ({ ...e, eventId: `\ud800-${n}` })),
      );
    const first = await post(w, '/api/v1/events', {}, { rawBody: rawBatch(1) });
    assert.equal((first.bodyJson as AckBody).items[0].status, 'quarantined');
    // exact same bytes: same identity -> durable duplicate, still ACKed quarantined
    const retry = await post(w, '/api/v1/events', {}, { rawBody: rawBatch(1) });
    assert.equal((retry.bodyJson as AckBody).items[0].status, 'quarantined');
    assert.equal(Number((w.raw.prepare('SELECT COUNT(*) AS n FROM fix_metric_quarantine').get() as { n: number }).n), 1);
    // different bytes: distinct durable identity, independently ACKed
    const other = await post(w, '/api/v1/events', {}, { rawBody: rawBatch(2) });
    assert.equal((other.bodyJson as AckBody).items[0].status, 'quarantined');
    assert.equal(Number((w.raw.prepare('SELECT COUNT(*) AS n FROM fix_metric_quarantine').get() as { n: number }).n), 2);
    const rows = w.raw.prepare('SELECT event_id FROM fix_metric_quarantine ORDER BY event_id').all() as { event_id: string }[];
    assert.equal(new Set(rows.map((r) => r.event_id)).size, 2);
  });
});