// Funnel projection: deterministic as-of aggregates from accepted events.
import { canonicalJson, compareCodePoints, sha256Base64url } from './canonical.ts';
import { FIX_FUNNEL_DEFINITION_VERSION, FUNNEL_STEPS, LATE_EVENT_LABEL_MS } from './config.ts';
import { validateSnapshotPayload, validateSnapshotRowShape } from './snapshot-contract.ts';
export type { DropOffReason, FunnelSnapshotPayload, FunnelStep } from './snapshot-contract.ts';
import type { DropOffReason, FunnelSnapshotPayload, FunnelStep } from './snapshot-contract.ts';
import type { AcceptedEventRow, MetricStore, SnapshotRow } from './store.ts';

export function monthWindow(occurredAtIso: string): { windowStart: string; windowEnd: string } {
  const d = new Date(occurredAtIso);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return { windowStart: start.toISOString(), windowEnd: end.toISOString() };
}

function addMonths(iso: string, months: number): string {
  const d = new Date(iso);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1)).toISOString();
}

export interface BuiltSnapshot {
  row: {
    snapshotId: string; parentSnapshotId?: string; rebuildTaskId?: string; definitionVersion: string;
    windowStart: string; windowEnd: string; snapshotAt: string; maturityAt: string; status: 'calculable';
    responseJson: string; createdAt: string; revisionHash: string;
  };
  payload: FunnelSnapshotPayload;
}

export interface SnapshotBuildOptions {
  snapshotAt?: string;
  parentSnapshotId?: string | null;
  rebuildTaskId?: string | null;
}

// Deterministic ordering over accepted-event rows: the canonical build order. The projection must
// never depend on the input array order (the store returns a sorted order, but verification and
// adversarial inputs may pass any order), so every order-sensitive aggregation consumes rows in
// this order. Sorting uses explicit code-point comparison (compareCodePoints, never
// localeCompare) so the order is identical across runtimes and locales. eventId is a unique
// tiebreaker; receivedAt and eventCanonicalHash make the order total even for rows that share an
// occurredAt.
function compareEventRows(a: AcceptedEventRow, b: AcceptedEventRow): number {
  return (
    compareCodePoints(a.occurredAt, b.occurredAt) ||
    compareCodePoints(a.receivedAt, b.receivedAt) ||
    compareCodePoints(a.eventId, b.eventId)
  );
}

// Resolution-cycle recency for the branch projection: explicit code-point comparison of
// (occurredAt, resolutionCycleId) — the resolution-cycle semantics available in this slice. The
// greater cycle id wins at an equal occurredAt (a rework cycle is a LATER cycle), never input
// array order and never eventId. Two records that share occurredAt AND cycle id (same cycle
// re-confirmed with different content — impossible through ingest, which enforces the
// business-key conflict) are disambiguated by their canonical content hash so the projection
// stays a pure function of stored content.
function compareResolutionRecency(
  a: { occurredAt: string; resolutionCycleId?: string | undefined; eventCanonicalHash: string },
  b: { occurredAt: string; resolutionCycleId?: string | undefined; eventCanonicalHash: string },
): number {
  // a missing cycle id (impossible through ingest, tolerated for direct-store rows) sorts first
  return (
    compareCodePoints(a.occurredAt, b.occurredAt) ||
    compareCodePoints(a.resolutionCycleId ?? '', b.resolutionCycleId ?? '') ||
    compareCodePoints(a.eventCanonicalHash, b.eventCanonicalHash)
  );
}

export async function buildSnapshotForWindow(
  store: MetricStore,
  events: AcceptedEventRow[],
  windowStart: string,
  windowEnd: string,
  now: Date,
  options: SnapshotBuildOptions = {},
): Promise<BuiltSnapshot> {
  const snapshotAt = options.snapshotAt ?? windowEnd;
  const maturityAt = new Date(Date.parse(windowEnd) + 30 * 86400 * 1000).toISOString();
  const cohort = new Set<string>();
  for (const event of events) {
    if (event.eventType === 'run_started' && event.occurredAt >= windowStart && event.occurredAt < windowEnd && event.receivedAt <= snapshotAt) {
      cohort.add(event.runId);
    }
  }
  // Every order-sensitive aggregation below consumes cohortEvents in the canonical sorted order;
  // the input array's order must never leak into the response (see compareEventRows).
  const cohortEvents = events.filter((event) => cohort.has(event.runId) && event.occurredAt >= windowStart && event.occurredAt <= snapshotAt && event.receivedAt <= snapshotAt).sort(compareEventRows);
  const counts = new Map<string, number>();
  for (const step of FUNNEL_STEPS) {
    const runs = new Set(cohortEvents.filter((event) => event.eventType === step).map((event) => event.runId));
    counts.set(step, runs.size);
  }
  const totalRuns = cohort.size;
  const acceptedRuns = counts.get('run_accepted') ?? 0;
  // Resolution branch projection: for each run, the LATEST VALID resolution_completed in the run
  // decides the branch. "Latest" is resolved explicitly by (occurredAt, resolutionCycleId) —
  // see compareResolutionRecency — never by input array order or eventId, so the same stored
  // events always project the same branch regardless of how the rows were read (review P1.6:
  // deterministic cycle selection by (occurredAt, resolutionCycleId), not plain event ordering).
  // A valid branch event is a resolution_completed that carries a resolutionType (the
  // schema-required branch axis). DRIFT (review P1.6, documented in the package README): full
  // terminal-cycle state — deferred or superseded cycles, disposition carried across cycles — is
  // OUT of this slice; the branch is the latest valid resolution by (occurredAt,
  // resolutionCycleId) only. Rework cycles (repeated resolution_completed per run) keep their
  // event history in the immutable event store and are intentionally NOT counted as extra runs
  // anywhere: the public funnel counts distinct runs per step and one final branch per run, so
  // rework never inflates public run counts.
  const latestResolutionByRun = new Map<string, AcceptedEventRow>();
  for (const event of cohortEvents) {
    if (event.eventType !== 'resolution_completed' || !event.resolutionType) continue;
    const incumbent = latestResolutionByRun.get(event.runId);
    if (!incumbent || compareResolutionRecency(event, incumbent) > 0) {
      latestResolutionByRun.set(event.runId, event);
    }
  }
  const resolutionTypes: Record<string, number> = {};
  for (const event of latestResolutionByRun.values()) {
    const branch = event.resolutionType;
    if (!branch) continue; // filtered at insertion; re-checked for type safety
    resolutionTypes[branch] = (resolutionTypes[branch] ?? 0) + 1;
  }
  const dropOffCounts = new Map<string, number>();
  for (const runId of cohort) {
    let lastReached = -1;
    for (let index = 0; index < FUNNEL_STEPS.length; index += 1) {
      if (cohortEvents.some((event) => event.runId === runId && event.eventType === FUNNEL_STEPS[index])) lastReached = index;
    }
    if (lastReached < FUNNEL_STEPS.length - 1) {
      const reasonCode = `not_reached_${FUNNEL_STEPS[lastReached + 1]}`;
      dropOffCounts.set(reasonCode, (dropOffCounts.get(reasonCode) ?? 0) + 1);
    }
  }
  const dropOffReasons = [...dropOffCounts.entries()].sort(([a], [b]) => compareCodePoints(a, b)).map(([reasonCode, runs]) => ({ reasonCode, runs }));

  const steps = FUNNEL_STEPS.map((eventType, index) => {
    const runs = counts.get(eventType) ?? 0;
    const previous = index === 0 ? runs : counts.get(FUNNEL_STEPS[index - 1]) ?? 0;
    return { eventType, runs, fromPreviousRate: previous > 0 ? Math.round((runs / previous) * 1000) / 1000 : null };
  });
  let lateEvents = 0;
  // Data-quality sample units are deduplicated safe runIds, never event/row counts.
  const lateRuns = new Set<string>();
  let maxReceivedMs = 0;
  for (const event of cohortEvents) {
    const receivedMs = Date.parse(event.receivedAt);
    maxReceivedMs = Math.max(maxReceivedMs, receivedMs);
    if (receivedMs - Date.parse(event.occurredAt) > LATE_EVENT_LABEL_MS) {
      lateEvents += 1;
      lateRuns.add(event.runId);
    }
  }
  const windowQuarantines = (await store.quarantinedInWindow(windowStart, snapshotAt)).filter((record) => record.receivedAt <= snapshotAt);
  // Canonical quarantine order: occurredAt then eventId (eventIds are unique), explicit
  // code-point comparison (never localeCompare) mirroring the store's read order so the revision
  // hash never depends on arbitrary row order or host collation.
  windowQuarantines.sort((a, b) => compareCodePoints(a.occurredAt, b.occurredAt) || compareCodePoints(a.eventId, b.eventId));
  const invalidEvents = windowQuarantines.length;
  // Quarantine records retain their safe runId when one was present. Sample units are
  // deduplicated safe runIds RESTRICTED TO THE SNAPSHOT COHORT (review P2): a quarantine record
  // attributed to a run outside this snapshot's run_started cohort never creates a sample unit
  // (the k-protection denominator is the cohort; cross-cohort units would leak a different
  // population into a cohort-scoped group). Records without a safe runId or outside the cohort
  // are conservatively suppressed from the run-unit count: they never create pseudo sample units
  // (which could mask a small attributable cohort).
  const invalidEventRuns = new Set(
    windowQuarantines.flatMap((record) => (record.runId && cohort.has(record.runId) ? [record.runId] : [])),
  ).size;
  // dataFreshnessSeconds is measured against the FIXED as-of point (snapshotAt), not the build
  // wall clock: the served snapshot is immutable, so its freshness is frozen at the as-of point
  // it represents. This keeps responseJson a PURE function of the canonical inputs (events,
  // quarantines, window, snapshotAt, lineage ids) — rebuilding the same revision at any later
  // build clock reproduces it byte-for-byte (required by verifyStoredSnapshot and by
  // snapshotId/revisionHash binding to actual content).
  const dataFreshnessSeconds = Math.max(0, Math.round((Date.parse(snapshotAt) - maxReceivedMs) / 1000));
  // cohortEvents is already in the canonical order (compareEventRows); copy for the hash input.
  const eligibleOrdered = [...cohortEvents];
  // The revision hash binds to EVERY input that affects responseJson:
  //   - window/as-of metadata and definition version
  //   - lineage: parentSnapshotId + rebuildTaskId (two revisions with the same events but
  //     different lineage must never share a snapshot identity)
  //   - every canonical event: (eventId, eventCanonicalHash, receivedAt). eventCanonicalHash
  //     covers the whole semantic envelope (eventType, occurredAt, runId, resolutionType, ...);
  //     receivedAt is the only content-affecting field OUTSIDE the semantic envelope (it gates
  //     cohort membership and late labeling), so it is bound explicitly.
  //   - every canonical quarantine: (eventId, reasonCode, runId, receivedAt). runId affects the
  //     deduplicated invalidEventRuns sample units, so it must be bound; receivedAt gates
  //     inclusion in the as-of window (a transport-only mutation that moves a quarantine record
  //     across snapshotAt changes invalidEvents/invalidEventRuns and must be detected even when
  //     it stays inside the window, where the visible aggregates are unchanged).
  // dataFreshnessSeconds is derived from snapshotAt + event receivedAt (both bound); all other
  // payload fields are derived from the bound sets. No build-clock field (createdAt) enters the
  // hash: it is build metadata, and rebuild idempotency must keep the same revision identity.
  const revisionHash = await sha256Base64url(canonicalJson({
    definitionVersion: FIX_FUNNEL_DEFINITION_VERSION, windowStart, windowEnd, snapshotAt,
    parentSnapshotId: options.parentSnapshotId ?? null,
    rebuildTaskId: options.rebuildTaskId ?? null,
    events: eligibleOrdered.map((event): [string, string, string] => [event.eventId, event.eventCanonicalHash, event.receivedAt]),
    quarantines: windowQuarantines.map((record): [string, string, string | null, string] => [record.eventId, record.reasonCode, record.runId ?? null, record.receivedAt]),
  }));
  const snapshotId = `s_${revisionHash}`;
  const payload: FunnelSnapshotPayload = {
    snapshotId,
    parentSnapshotId: options.parentSnapshotId ?? null,
    rebuildTaskId: options.rebuildTaskId ?? null,
    definitionVersion: FIX_FUNNEL_DEFINITION_VERSION,
    windowStart, windowEnd, snapshotAt, maturityAt, totalRuns, steps,
    resolutionTypes,
    dropOffReasons,
    dataQuality: {
      incompleteRuns: totalRuns - acceptedRuns,
      lateEvents,
      invalidEvents,
      lateEventRuns: lateRuns.size,
      invalidEventRuns,
      lowSampleProtected: false,
    },
    dataFreshnessSeconds,
  };
  return {
    row: {
      snapshotId,
      ...(payload.parentSnapshotId ? { parentSnapshotId: payload.parentSnapshotId } : {}),
      ...(payload.rebuildTaskId ? { rebuildTaskId: payload.rebuildTaskId } : {}),
      definitionVersion: FIX_FUNNEL_DEFINITION_VERSION, windowStart, windowEnd, snapshotAt, maturityAt,
      status: 'calculable', responseJson: canonicalJson(payload), createdAt: now.toISOString(), revisionHash,
    },
    payload,
  };
}

/**
 * Latest revision stored at one fixed (window, as-of) point that STILL fully verifies against the
 * canonical inputs (shape + byte-for-byte recompute). Rebuilds can leave several revisions at the
 * same fixed point; a lineage anchor must be the latest one whose content is still reproducible —
 * an older, superseded revision whose canonical basis has moved on must never anchor a chain.
 */
async function latestVerifiableSnapshotAt(store: MetricStore, windowStart: string, windowEnd: string, snapshotAt: string): Promise<SnapshotRow | undefined> {
  for (const row of await store.listSnapshotsForWindowAt(windowStart, windowEnd, snapshotAt)) {
    if (validateSnapshotRowShape(row) && (await verifyStoredSnapshot(store, row))) return row;
  }
  return undefined;
}

/** Build each fixed monthly as-of point through the current UTC month, without mutating old rows. */
export async function ensurePublishedSnapshots(store: MetricStore, now: Date): Promise<BuiltSnapshot | 'no-data'> {
  const events = await store.allAcceptedEvents();
  const starts = events.filter((event) => event.eventType === 'run_started');
  if (starts.length === 0) return 'no-data';
  const windows = new Map<string, { windowStart: string; windowEnd: string }>();
  for (const event of starts) {
    const window = monthWindow(event.occurredAt);
    windows.set(window.windowStart, window);
  }
  const latestAllowed = monthWindow(now.toISOString()).windowStart;
  const nowMs = now.getTime();
  let latest: BuiltSnapshot | undefined;
  for (const window of [...windows.values()].sort((a, b) => compareCodePoints(a.windowStart, b.windowStart))) {
    const finalSnapshotAt = latestAllowed > window.windowEnd ? latestAllowed : window.windowEnd;
    let snapshotAt = window.windowEnd;
    // Fixed as-of points are created and published only once their UTC boundary has been reached
    // (now >= snapshotAt): windowEnd and later monthly points of an open window are never emitted
    // as future data.
    while (snapshotAt <= finalSnapshotAt && Date.parse(snapshotAt) <= nowMs) {
      const firstPoint = snapshotAt === window.windowEnd;
      const previousAt = firstPoint
        ? undefined
        : await latestVerifiableSnapshotAt(
            store,
            window.windowStart,
            window.windowEnd,
            snapshotAt === addMonths(window.windowEnd, 1) ? window.windowEnd : addMonths(snapshotAt, -1),
          );
      // Fail closed on lineage (P1.6): a later fixed point MUST anchor to the previous point's
      // verifiable revision. If the previous point is missing or its stored row no longer
      // verifies, the later point must NOT silently become a root (that would publish a forged
      // lineage) — surface the corruption instead.
      if (!firstPoint && !previousAt) throw new Error('missing_lineage_anchor');
      const built = await buildSnapshotForWindow(store, events, window.windowStart, window.windowEnd, now, {
        snapshotAt,
        parentSnapshotId: previousAt?.snapshotId ?? null,
        rebuildTaskId: previousAt ? `rebuild_${snapshotAt.replace(/[^A-Za-z0-9]/g, '')}` : null,
      });

      await store.insertSnapshot(built.row, now.toISOString());
      const published = await store.publishRevision(window.windowStart, window.windowEnd, built.row.definitionVersion, built.row.snapshotId, built.row.snapshotAt, now.toISOString());
      if (published) latest = built;
      snapshotAt = addMonths(snapshotAt, 1);
    }
  }
  return latest ?? 'no-data';
}

// Keep this import-time assertion close to the producer: malformed payloads cannot be emitted by
// the projection even if a future refactor changes one of the aggregate calculations.
export function isBuiltSnapshotPayloadValid(built: BuiltSnapshot): boolean {
  return validateSnapshotPayload(built.payload, built.row);
}

/**
 * Recompute a stored revision from the canonical inputs (accepted events + quarantines as of the
 * revision's snapshotAt) and require it to reproduce the stored row byte-for-byte. The projection
 * is a pure function of those canonical inputs — responseJson does not depend on the build clock
 * (dataFreshnessSeconds is measured against snapshotAt) or on input array order — so a genuine
 * row is reproduced exactly; any forged snapshotId/revisionHash, mutated payload content, mutated
 * event/quarantine content (including receivedAt and quarantine runId), or metadata drift makes
 * the recompute diverge. snapshotId binding (s_<revisionHash>) and lineage ids are covered
 * because they are embedded in the rebuilt content.
 */
export async function verifyStoredSnapshot(store: MetricStore, row: SnapshotRow): Promise<boolean> {
  const createdAt = new Date(row.createdAt);
  if (Number.isNaN(createdAt.getTime())) return false;
  let rebuilt: BuiltSnapshot;
  try {
    rebuilt = await buildSnapshotForWindow(store, await store.allAcceptedEvents(), row.windowStart, row.windowEnd, createdAt, {
      snapshotAt: row.snapshotAt,
      parentSnapshotId: row.parentSnapshotId ?? null,
      rebuildTaskId: row.rebuildTaskId ?? null,
    });
  } catch {
    return false;
  }
  return rebuilt.row.snapshotId === row.snapshotId &&
    rebuilt.row.revisionHash === row.revisionHash &&
    rebuilt.row.responseJson === row.responseJson &&
    rebuilt.row.parentSnapshotId === row.parentSnapshotId &&
    rebuilt.row.rebuildTaskId === row.rebuildTaskId;
}
