// Public read-only API: GET /api/v1/snapshots/latest and GET /api/v1/funnel?snapshotId=...
// Aggregate-only; never returns runId, raw events, or free text. Low-sample protection (k=5):
// when any funnel group (total, step or branch bucket) has fewer than k effective runs, the whole
// response is `low_sample_protected` and all diffable fields are omitted — no zeros, no totals
// that would let a client derive hidden groups.

import { assertSyntheticOnly, FIX_FUNNEL_DEFINITION_VERSION, type RuntimeConfig } from './config.ts';
import type { FunnelSnapshotPayload } from './snapshot-contract.ts';
import { validateSnapshotPayload } from './snapshot-contract.ts';
import { ensurePublishedSnapshots, verifyStoredSnapshot } from './projection.ts';
import { verifySnapshotLineage } from './snapshot-contract.ts';
import type { MetricStore, PublicationRow, SnapshotRow } from './store.ts';
import { json, jsonError } from './http.ts';
import { bearerToken } from './ingest.ts';

export interface PublicDeps {
  store: MetricStore;
  cfg: RuntimeConfig;
  now: () => Date;
}

const SNAPSHOT_ID_PATTERN = /^s_[A-Za-z0-9_-]{20,}$/;

// Low-sample protection (k=5) applies to every funnel group: the cohort total, each step count
// AND each resolutionTypes branch bucket (plus drop-off reason cohorts in later slices). If ANY
// group has fewer than k effective runs the whole response is low_sample_protected — a hidden
// 1-run bucket must never leak through a "calculable" status.
// Data-quality groups are judged on their deduplicated safe-runId sample units
// (lateEventRuns / invalidEventRuns), never on raw event/row counts; quarantine records without
// a safe runId are suppressed from those units and never expose run identity here.
export function derivePublicStatus(payload: FunnelSnapshotPayload, k: number): 'calculable' | 'low_sample_protected' {
  const groups = [
    payload.totalRuns,
    ...payload.steps.map((s) => s.runs),
    ...Object.values(payload.resolutionTypes),
    ...payload.dropOffReasons.map((reason) => reason.runs),
    payload.dataQuality.incompleteRuns,
    payload.dataQuality.lateEventRuns,
    payload.dataQuality.invalidEventRuns,
  ];
  return groups.every((n) => n === 0 || n >= k) ? 'calculable' : 'low_sample_protected';
}

// The publication pointer is the only source of truth for "latest": the returned snapshot must
// be the pointer target, the target row must exist, and row + pointer must agree on window and
// definition version before any content is served.
function publicationMatchesSnapshot(pub: PublicationRow, row: SnapshotRow): boolean {
  // The row is immutable and the pointer carries the same metadata. Keeping this check explicit
  // prevents serving a valid payload through a pointer aimed at a different as-of revision.
  return (
    pub.publishedSnapshotId === row.snapshotId &&
    pub.definitionVersion === row.definitionVersion &&
    pub.windowStart === row.windowStart &&
    pub.windowEnd === row.windowEnd &&
    pub.snapshotAt === row.snapshotAt
  );
}

// GET /api/v1/snapshots/latest — READ-ONLY: read the published pointer (newest window), validate
// its target, and return the immutable snapshot metadata of the target. GET never builds,
// rebuilds or publishes (review P1.8): publishing happens only on the controlled
// POST /api/v1/snapshots/publish path, so a read can never mutate storage.
export async function handleLatest(_request: Request, deps: PublicDeps): Promise<Response> {
  const pub = await deps.store.latestPublication();
  if (!pub) {
    return json({ status: 'insufficient_history', definitionVersion: FIX_FUNNEL_DEFINITION_VERSION });
  }
  const row = await deps.store.getSnapshot(pub.publishedSnapshotId);
  if (!row) {
    return jsonError(500, 'publication_pointer_missing_target');
  }
  if (!publicationMatchesSnapshot(pub, row)) {
    return jsonError(500, 'publication_pointer_mismatch');
  }
  // The future-as-of gate applies to the pointer target too (review P1.3): /latest follows the
  // pointer only and never falls back, so a target whose fixed as-of point lies ahead of the
  // validated server clock fails closed instead of being served. The NaN-safe negated form
  // rejects non-ISO/invalid timestamps as well (a NaN comparison is always false).
  if (!(Date.parse(row.snapshotAt) <= deps.now().getTime())) {
    return jsonError(404, 'future_snapshot');
  }
  const payload = parsePayload(row);
  if (!payload) return jsonError(500, 'invalid_snapshot_payload');
  // Defense in depth on the serving path: the served revision must still recompute from the
  // canonical inputs (snapshotId/revisionHash bound to content, no forged metadata) and its
  // declared lineage must be coherent. A row that was forged or mutated outside insertSnapshot
  // is never served.
  if (!(await verifyStoredSnapshot(deps.store, row)) || !(await verifySnapshotLineage(deps.store, row))) {
    return jsonError(500, 'snapshot_revision_mismatch');
  }
  const status = derivePublicStatus(payload, deps.cfg.lowSampleK);
  const common = {
    definitionVersion: payload.definitionVersion,
    windowStart: payload.windowStart,
    windowEnd: payload.windowEnd,
    snapshotAt: payload.snapshotAt,
    status,
    dataFreshnessSeconds: payload.dataFreshnessSeconds,
  };
  return status === 'low_sample_protected'
    ? json(publicProtectedBody(payload))
    : json({ ...common, snapshotId: payload.snapshotId, parentSnapshotId: payload.parentSnapshotId, rebuildTaskId: payload.rebuildTaskId });
}

// POST /api/v1/snapshots/publish — the CONTROLLED publish/rebuild path (review P1.8). Public GET
// endpoints are strictly read-only, so the PoC's snapshot generation runs only here: the same
// synthetic-only guard and bearer-token auth as ingest, and the same server-controlled clock.
// This is the only caller of ensurePublishedSnapshots on the HTTP surface.
export async function handlePublish(request: Request, deps: PublicDeps): Promise<Response> {
  try {
    assertSyntheticOnly(deps.cfg);
  } catch {
    return jsonError(503, 'synthetic_only_guard', 'this PoC slice only serves synthetic data');
  }
  if (deps.cfg.ingestTokens.size === 0) {
    return jsonError(503, 'server_misconfigured', 'no ingest token configured');
  }
  const token = bearerToken(request);
  if (!token || !deps.cfg.ingestTokens.has(token)) {
    return jsonError(401, 'unauthorized');
  }
  const result = await ensurePublishedSnapshots(deps.store, deps.now());
  if (result === 'no-data') {
    return json({ status: 'no-data', definitionVersion: FIX_FUNNEL_DEFINITION_VERSION });
  }
  return json({
    status: 'published',
    definitionVersion: result.payload.definitionVersion,
    windowStart: result.payload.windowStart,
    windowEnd: result.payload.windowEnd,
    snapshotAt: result.payload.snapshotAt,
    snapshotId: result.payload.snapshotId,
  });
}

// GET /api/v1/funnel?snapshotId=<id> — READ-ONLY: serve the immutable aggregate of a snapshotId.
// Two read paths, both aggregate-only (never run details):
//   1. current publication pointer target for its window — the pointer grants visibility and
//      must agree with the row metadata;
//   2. retained earlier revision of a published window — after the pointer moves to a newer
//      as-of revision, the old revision remains readable by its snapshotId, subject to the same
//      canonical verification (payload validity, content recompute, lineage) as the pointer
//      target. The pointer is still the ONLY source of truth for /snapshots/latest.
// Arbitrary stored rows that never belonged to a published window, and future-dated rows, stay
// invisible (fail closed).
export async function handleFunnel(request: Request, deps: PublicDeps): Promise<Response> {
  const url = new URL(request.url);
  const snapshotId = url.searchParams.get('snapshotId');
  if (!snapshotId) {
    return jsonError(400, 'missing_snapshot_id');
  }
  if (!SNAPSHOT_ID_PATTERN.test(snapshotId)) {
    return jsonError(400, 'invalid_snapshot_id');
  }

  const nowMs = deps.now().getTime();

  const row = await deps.store.getSnapshot(snapshotId);
  if (!row) {
    return jsonError(404, 'snapshot_not_found');
  }
  const pub = await deps.store.getPublication(row.windowStart, row.windowEnd);
  if (pub && publicationMatchesSnapshot(pub, row)) {
    // current pointer target: pointer + row already agree on all metadata — and the same future
    // gate applies as on the retained path (review P1.3): a pointer target ahead of the server
    // clock is never served, so ALL public read paths fail closed on future data.
    if (!(Date.parse(row.snapshotAt) <= nowMs)) {
      return jsonError(404, 'future_snapshot');
    }
  } else {
    // retained-revision read path: this revision must be EXPLICITLY published history for its
    // window (pointer target or recorded publication history — review P1.5), its definition must
    // match, and it must not be future data. A same-window stored-but-never-published row has
    // neither pointer nor history and stays invisible (fail closed).
    const published = await deps.store.hasPublishedRevision(row.windowStart, row.windowEnd, row.definitionVersion, snapshotId);
    if (!published) {
      return jsonError(404, 'snapshot_not_published');
    }
    if (Date.parse(row.snapshotAt) > nowMs) {
      return jsonError(404, 'snapshot_not_published');
    }
  }
  const payload = parsePayload(row);
  if (!payload) return jsonError(500, 'invalid_snapshot_payload');
  // Same canonical revision recompute + lineage coherence as /latest (defense in depth) on BOTH
  // read paths: a forged or mutated row is never served.
  if (!(await verifyStoredSnapshot(deps.store, row)) || !(await verifySnapshotLineage(deps.store, row))) {
    return jsonError(500, 'snapshot_revision_mismatch');
  }
  return json(publicFunnelBody(payload, deps.cfg.lowSampleK));
}

function publicProtectedBody(payload: FunnelSnapshotPayload): Record<string, unknown> {
  // Keep /latest and /funnel identical when protected. Window metadata is not a diffable
  // aggregate; identity, lineage, counts, branches and quality counts are all omitted.
  return {
    definitionVersion: payload.definitionVersion,
    windowStart: payload.windowStart,
    windowEnd: payload.windowEnd,
    snapshotAt: payload.snapshotAt,
    status: 'low_sample_protected',
    dataFreshnessSeconds: payload.dataFreshnessSeconds,
  };
}

function publicFunnelBody(payload: FunnelSnapshotPayload, k: number): Record<string, unknown> {
  if (derivePublicStatus(payload, k) === 'low_sample_protected') return publicProtectedBody(payload);
  const common = {
    definitionVersion: payload.definitionVersion,
    windowStart: payload.windowStart,
    windowEnd: payload.windowEnd,
    snapshotAt: payload.snapshotAt,
    dataFreshnessSeconds: payload.dataFreshnessSeconds,
  };
  return {
    snapshotId: payload.snapshotId,
    parentSnapshotId: payload.parentSnapshotId,
    rebuildTaskId: payload.rebuildTaskId,
    ...common,
    status: 'calculable',
    totalRuns: payload.totalRuns,
    steps: payload.steps,
    resolutionTypes: payload.resolutionTypes,
    dropOffReasons: payload.dropOffReasons,
    dataQuality: payload.dataQuality,
  };
}

function parsePayload(row: SnapshotRow): FunnelSnapshotPayload | null {
  let value: unknown;
  try {
    value = JSON.parse(row.responseJson) as unknown;
  } catch {
    return null;
  }
  return validateSnapshotPayload(value, row) ? value : null;
}