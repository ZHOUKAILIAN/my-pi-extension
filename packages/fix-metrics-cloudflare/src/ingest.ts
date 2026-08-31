// POST /api/v1/events — bounded JSON batch ingest for the five public funnel events.
//
// Semantics (approved design §6.8):
//   - one event or an array of at most MAX_EVENTS_PER_BATCH events; body capped at
//     MAX_REQUEST_BODY_BYTES; oversized requests are request-level 413, never partial ACKs
//   - auth: Bearer token checked against INGEST_TOKEN_CURRENT / INGEST_TOKEN_PREVIOUS
//   - valid JSON requests always answer 202 with per-item ACKs
//     { eventId, status, retryable, errorCode? }
//       accepted-duration    durable in fix_metric_events
//       duplicate            same eventId or eventBusinessKey with identical canonical hash
//       quarantined          durable in fix_metric_quarantine; not projected, not retried
//       permanent_error      schema/enum/union/definition-version/business-key mismatch or
//                            event_id_or_business_key_conflict; never retried
//       retryable_error      storage failure; client keeps the outbox item
//   - synthetic-only guard: assertSyntheticOnly is called first; a non-synthetic worker refuses
//     the whole request with 503 and accepts nothing
//   - responses never echo tokens, event bodies or business text

import { MAX_EVENTS_PER_BATCH, MAX_REQUEST_BODY_BYTES, assertSyntheticOnly, type RuntimeConfig } from './config.ts';
import { validateEvent, type AcceptedEvent } from './events.ts';
import { json, jsonError } from './http.ts';
import type { MetricStore } from './store.ts';

export interface IngestDeps {
  store: MetricStore;
  cfg: RuntimeConfig;
  now: () => Date;
}

export interface ItemAck {
  eventId: string;
  status: 'accepted' | 'duplicate' | 'quarantined' | 'retryable_error' | 'permanent_error';
  retryable: boolean;
  errorCode?: string;
}

export async function handleEvents(request: Request, deps: IngestDeps): Promise<Response> {
  const { store, cfg } = deps;

  try {
    assertSyntheticOnly(cfg);
  } catch {
    return jsonError(503, 'synthetic_only_guard', 'this PoC slice only serves synthetic data');
  }

  if (cfg.ingestTokens.size === 0) {
    return jsonError(503, 'server_misconfigured', 'no ingest token configured');
  }
  const token = bearerToken(request);
  if (!token || !cfg.ingestTokens.has(token)) {
    return jsonError(401, 'unauthorized');
  }

  const text = await request.text();
  // This slice intentionally has no request limiter; per-IP/client rate limiting is a later
  // slice and must be added before any non-synthetic/public production deployment.
  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BODY_BYTES) {
    return jsonError(413, 'request_too_large');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return jsonError(400, 'invalid_json');
  }

  let items: unknown[];
  if (Array.isArray(parsed)) {
    items = parsed;
  } else if (typeof parsed === 'object' && parsed !== null) {
    items = [parsed];
  } else {
    return jsonError(400, 'invalid_request_body');
  }
  if (items.length > MAX_EVENTS_PER_BATCH) {
    return jsonError(413, 'batch_too_large');
  }

  // one now() for the whole batch: receivedAt is a single server-side observation
  const now = deps.now();
  const acks: ItemAck[] = [];
  for (const item of items) {
    acks.push(await processItem(item, store, cfg, now));
  }
  return json({ items: acks }, 202);
}

// Verification binding coherence (review P1.2): a verification_passed fact must be bound to the
// ACTUAL resolution of this slice — not merely name an arbitrary revision/evidence value. The
// minimum coherent contract this slice can enforce at ingest time:
//   - a resolution_completed for the SAME runId AND resolutionCycleId must already be accepted
//     (the verification cycle must match the resolution cycle it verifies);
//   - payload resolutionEvidenceRef, when present, must EQUAL the resolution's own evidence ref;
//   - candidateRevision / sourceVersion, when present, must be present and equal on the
//     resolution_completed (candidateRevision must stay consistent across implementation, review
//     and verification per the L2 design).
// An empty or unrelated binding is a permanent error (unbound_verification_evidence), never a
// silently unbound verification fact. Slice limitation (fail closed, documented): the binding is
// checked against already-accepted events, so a verification arriving before its resolution in
// wire order is rejected — the correct order is a contract requirement in this slice.
async function verificationBindingIsCoherent(event: AcceptedEvent, store: MetricStore): Promise<boolean> {
  if (event.eventType !== 'verification_passed') return true;
  if (!event.resolutionCycleId) return false; // schema-required; absent means a malformed path
  const resolution = await store.latestResolutionCompleted(event.runId, event.resolutionCycleId);
  if (!resolution) return false;
  let payload: unknown;
  let resolutionPayload: unknown;
  try {
    payload = JSON.parse(event.payloadJson) as unknown;
    resolutionPayload = JSON.parse(resolution.payloadJson) as unknown;
  } catch {
    return false;
  }
  const ev = isPlainObject(payload) ? payload : {};
  const res = isPlainObject(resolutionPayload) ? resolutionPayload : {};
  if (Object.hasOwn(ev, 'resolutionEvidenceRef')) {
    if (!Object.hasOwn(res, 'resolutionEvidenceRef') || ev.resolutionEvidenceRef !== res.resolutionEvidenceRef) return false;
  }
  if (event.candidateRevision !== undefined && (resolution.candidateRevision === undefined || resolution.candidateRevision !== event.candidateRevision)) return false;
  if (event.sourceVersion !== undefined && (resolution.sourceVersion === undefined || resolution.sourceVersion !== event.sourceVersion)) return false;
  return true;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function processItem(item: unknown, store: MetricStore, cfg: RuntimeConfig, now: Date): Promise<ItemAck> {
  const id =
    typeof item === 'object' && item !== null && typeof (item as Record<string, unknown>).eventId === 'string'
      ? ((item as Record<string, unknown>).eventId as string)
      : '[unknown]';

  const outcome = await validateEvent(item, {
    now,
    futureSkewMs: cfg.futureSkewWindowMs,
    lateEventWindowMs: cfg.lateEventWindowMs,
  });

  if (outcome.kind === 'permanent') {
    return { eventId: id, status: 'permanent_error', retryable: false, errorCode: outcome.errorCode };
  }

  // Coherence gate for verification_passed (review P1.2): the fact must bind to the actual
  // resolution of its run + resolution cycle already accepted in this slice. A storage failure
  // during the binding lookup stays retryable; an incoherent binding is permanent.
  if (outcome.kind === 'ok' && outcome.event.eventType === 'verification_passed') {
    try {
      if (!(await verificationBindingIsCoherent(outcome.event, store))) {
        return { eventId: outcome.event.eventId, status: 'permanent_error', retryable: false, errorCode: 'unbound_verification_evidence' };
      }
    } catch {
      return { eventId: outcome.event.eventId, status: 'retryable_error', retryable: true, errorCode: 'storage_error' };
    }
  }

  if (outcome.kind === 'quarantine') {
    try {
      const result = await store.insertQuarantine(outcome.record);
      // ACK quarantined only when this record is now durably present (fresh insert) or the exact
      // same durable fact already exists. An id/key collision with different content is NOT a
      // quarantine ACK: the incoming event was not persisted, so it is a permanent error.
      if (result.status === 'inserted' || result.status === 'duplicate') {
        return { eventId: id, status: 'quarantined', retryable: false, errorCode: outcome.errorCode };
      }
      return { eventId: id, status: 'permanent_error', retryable: false, errorCode: 'quarantine_id_or_key_conflict' };
    } catch {
      return { eventId: id, status: 'retryable_error', retryable: true, errorCode: 'storage_error' };
    }
  }

  return insertAcceptedItem(outcome.event, store);
}

async function insertAcceptedItem(event: AcceptedEvent, store: MetricStore): Promise<ItemAck> {
  try {
    const result = await store.insertAccepted(event, event.receivedAt);
    switch (result.status) {
      case 'accepted':
        return { eventId: event.eventId, status: 'accepted', retryable: false };
      case 'duplicate':
        return { eventId: event.eventId, status: 'duplicate', retryable: false };
      case 'conflict':
        return {
          eventId: event.eventId,
          status: 'permanent_error',
          retryable: false,
          errorCode: 'event_id_or_business_key_conflict',
        };
    }
  } catch {
    return { eventId: event.eventId, status: 'retryable_error', retryable: true, errorCode: 'storage_error' };
  }
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/.exec(header.trim());
  return match ? match[1].trim() : null;
}

export { bearerToken };