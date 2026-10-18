import { canonicalEvent, normalizeEvent, type Kind, type MetricEvent } from './contracts.ts';

type D1Result<T = unknown> = { results: T[]; meta: { changes: number } };
type D1Statement = {
  bind(...args: unknown[]): D1Statement;
  run(): Promise<D1Result>;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<D1Result<T>>;
};
type D1Database = { prepare(sql: string): D1Statement };
type Env = {
  DB: D1Database;
  TARGET_NAMESPACE: string;
  METRICS_WRITE_TOKEN?: string;
  METRICS_READ_TOKEN?: string;
  PROJECT_METRICS_ENABLED?: string;
};
const encoder = new TextEncoder();
const MAX_BODY_BYTES = 16 * 1024;
const MAX_QUERY_ROWS = 20_000;
const MAX_AGGREGATE_GROUPS = 32;

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});
function secretsValid(env: Env): boolean {
  return typeof env.METRICS_WRITE_TOKEN === 'string'
    && /^[!-~]{32,512}$/u.test(env.METRICS_WRITE_TOKEN)
    && typeof env.METRICS_READ_TOKEN === 'string'
    && /^[!-~]{32,512}$/u.test(env.METRICS_READ_TOKEN)
    && env.METRICS_WRITE_TOKEN !== env.METRICS_READ_TOKEN;
}
function tokenMatches(request: Request, token: string | undefined): boolean {
  if (!token) return false;
  const actual = encoder.encode(request.headers.get('authorization') ?? '');
  const expected = encoder.encode(`Bearer ${token}`);
  let mismatch = actual.length ^ expected.length;
  for (let i = 0; i < Math.max(actual.length, expected.length); i++) mismatch |= (actual[i] ?? 0) ^ (expected[i] ?? 0);
  return mismatch === 0;
}
async function namespaceMatches(env: Env): Promise<boolean> {
  if (typeof env.TARGET_NAMESPACE !== 'string' || !env.TARGET_NAMESPACE || env.TARGET_NAMESPACE.length > 128 || /[\u0000-\u001f\u007f]/u.test(env.TARGET_NAMESPACE)) return false;
  const row = await env.DB.prepare('SELECT namespace FROM project_metrics_meta WHERE singleton=1').first<{ namespace: string }>();
  return !!row && row.namespace === env.TARGET_NAMESPACE;
}
async function readBoundedBody(request: Request): Promise<string | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let body = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  } catch {
    return '';
  }
}
async function hashEvent(event: MetricEvent): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(canonicalEvent(event)));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
type StoredEvent = {
  kind: Kind;
  occurred_at: string | null;
  duration_ms: number | null;
  outcome: string | null;
  model: string | null;
  provider: string | null;
  received_at: string;
};
type DailyAggregate = {
  day: string;
  kind: Kind;
  model: string | null;
  provider: string | null;
  eventCount: number;
  knownCount: number;
  unknownCount: number;
  meanDurationMs: number | null;
};
type Bucket = { day: string; kind: Kind; model: string | null; provider: string | null; count: number; sum: number; known: number; unknown: number };
function aggregate(rows: StoredEvent[], dayFor: (event: StoredEvent) => string | null, byModel = true) {
  const buckets = new Map<string, Bucket>();
  for (const event of rows) {
    const day = dayFor(event);
    if (!day) continue;
    const key = JSON.stringify(byModel ? [day, event.kind, event.provider, event.model] : [day, event.kind]);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { day, kind: event.kind, model: byModel ? event.model : null, provider: byModel ? event.provider : null, count: 0, sum: 0, known: 0, unknown: 0 };
      buckets.set(key, bucket);
    }
    if (event.kind === 'fast_enabled') bucket.count++;
    else if (event.duration_ms === null) bucket.unknown++;
    else { bucket.sum += event.duration_ms; bucket.known++; }
  }
  const ordered = [...buckets.values()].sort((a, b) => a.day.localeCompare(b.day) || a.kind.localeCompare(b.kind) || String(a.provider).localeCompare(String(b.provider)) || String(a.model).localeCompare(String(b.model)));
  return {
    aggregates: ordered.slice(0, MAX_AGGREGATE_GROUPS).map((bucket): DailyAggregate => ({
      day: bucket.day,
      kind: bucket.kind,
      model: bucket.model,
      provider: bucket.provider,
      eventCount: bucket.count,
      knownCount: bucket.known,
      unknownCount: bucket.unknown,
      meanDurationMs: bucket.known ? bucket.sum / bucket.known : null,
    })),
    truncated: ordered.length > MAX_AGGREGATE_GROUPS,
  };
}
function utcDay(date: Date): string { return date.toISOString().slice(0, 10); }

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/healthz') return json({ service: 'project-metrics', schemaVersion: 1 });

    if (request.method === 'POST' && url.pathname === '/api/v1/project-events') {
      if (env.PROJECT_METRICS_ENABLED !== 'true' || !secretsValid(env) || !tokenMatches(request, env.METRICS_WRITE_TOKEN)) return json({ error: 'unauthorized' }, 401);
      if (!await namespaceMatches(env)) return json({ error: 'unauthorized' }, 401);
      const raw = await readBoundedBody(request);
      if (raw === null) return json({ error: 'too_large' }, 413);
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { return json({ error: 'invalid_json' }, 400); }
      if (!isPlainObject(parsed) || Object.keys(parsed).length !== 2 || !Object.hasOwn(parsed, 'namespace') || !Object.hasOwn(parsed, 'event') || parsed.namespace !== env.TARGET_NAMESPACE) return json({ error: 'invalid_target' }, 400);
      let event: MetricEvent;
      try { event = normalizeEvent(parsed.event); } catch { return json({ error: 'invalid_event' }, 400); }

      const hash = await hashEvent(event);
      const receivedAt = new Date().toISOString();
      const quotaStart = `${receivedAt.slice(0, 10)}T00:00:00.000Z`;
      const quotaEnd = new Date(`${receivedAt.slice(0, 10)}T00:00:00.000Z`);
      quotaEnd.setUTCDate(quotaEnd.getUTCDate() + 1);
      const insertion = await env.DB.prepare(`
        INSERT INTO project_metric_events(event_id,dataset,kind,occurred_at,duration_ms,outcome,model,provider,unknown_reason,canonical_hash,received_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?
        WHERE (SELECT COUNT(*) FROM project_metric_events WHERE received_at>=? AND received_at<?)<5000
          OR EXISTS(SELECT 1 FROM project_metric_events WHERE event_id=?)
        ON CONFLICT(event_id) DO NOTHING
      `).bind(
        event.eventId, event.dataset, event.kind, event.occurredAt,
        event.kind === 'fast_enabled' ? null : event.durationMs,
        event.kind === 'fast_enabled' ? null : event.outcome,
        event.kind === 'fast_enabled' ? null : event.model,
        event.kind === 'fast_enabled' ? null : event.provider,
        event.kind !== 'fast_enabled' && event.durationMs === null ? event.unknownReason ?? null : null,
        hash, receivedAt, quotaStart, quotaEnd.toISOString(), event.eventId,
      ).run();
      const stored = await env.DB.prepare('SELECT canonical_hash FROM project_metric_events WHERE event_id=?').bind(event.eventId).first<{ canonical_hash: string }>();
      if (!stored) return json({ error: 'quota' }, 429);
      if (stored.canonical_hash !== hash) return json({ error: 'conflict' }, 409);
      return json({ eventId: event.eventId, status: insertion.meta.changes ? 'accepted' : 'duplicate' }, 202);
    }

    if (request.method === 'GET' && url.pathname === '/api/v1/project-stats') {
      if (!secretsValid(env) || !tokenMatches(request, env.METRICS_READ_TOKEN)) return json({ error: 'unauthorized' }, 401);
      if (request.headers.get('x-project-namespace') !== env.TARGET_NAMESPACE || !await namespaceMatches(env)) return json({ error: 'unauthorized' }, 401);
      const daysText = url.searchParams.get('days') ?? '7';
      const days = Number(daysText);
      const dataset = url.searchParams.get('dataset');
      if (!/^\d{1,2}$/u.test(daysText) || !Number.isInteger(days) || days < 1 || days > 31 || (dataset !== 'live' && dataset !== 'validation') || [...url.searchParams.keys()].some((key) => key !== 'days' && key !== 'dataset')) return json({ error: 'invalid_query' }, 400);

      // Watermark, asOf and UTC today come from one SQLite read snapshot.
      const capture = await env.DB.prepare(`
        SELECT COALESCE(MAX(ingest_seq),0) AS watermark,
          strftime('%Y-%m-%dT%H:%M:%fZ','now') AS as_of,
          strftime('%Y-%m-%d','now') AS today
        FROM project_metric_events
      `).first<{ watermark: number; as_of: string; today: string }>();
      if (!capture) return json({ error: 'unavailable' }, 503);
      const baselineStart = new Date(`${capture.today}T00:00:00.000Z`);
      baselineStart.setUTCDate(baselineStart.getUTCDate() - days - 1);
      const query = await env.DB.prepare(`
        SELECT kind,occurred_at,duration_ms,outcome,model,provider,received_at
        FROM project_metric_events
        WHERE dataset=? AND ingest_seq<=? AND received_at<=? AND received_at>=?
        ORDER BY ingest_seq LIMIT ?
      `).bind(dataset, capture.watermark, capture.as_of, baselineStart.toISOString(), MAX_QUERY_ROWS + 1).all<StoredEvent>();
      const truncatedRows = query.results.length > MAX_QUERY_ROWS;
      const rows = query.results.slice(0, MAX_QUERY_ROWS);
      const today = capture.today;
      const firstDisplayed = new Date(`${today}T00:00:00.000Z`);
      firstDisplayed.setUTCDate(firstDisplayed.getUTCDate() - days);
      const baselineDay = new Date(firstDisplayed);
      baselineDay.setUTCDate(baselineDay.getUTCDate() - 1);
      const baseline = utcDay(baselineDay);
      const occurredRows = rows.filter((event) => event.occurred_at !== null && event.occurred_at >= `${baseline}T00:00:00` && event.occurred_at < `${today}T00:00:00`);
      const unlocatedRows = rows.filter((event) => event.occurred_at === null);
      const occurredDay = (event: StoredEvent) => event.occurred_at?.slice(0, 10) ?? null;
      const receivedDay = (event: StoredEvent) => event.received_at.slice(0, 10);
      const daily = aggregate(occurredRows, occurredDay);
      const dailyOverall = aggregate(occurredRows, occurredDay, false);
      const unlocated = aggregate(unlocatedRows, receivedDay);
      const unlocatedOverall = aggregate(unlocatedRows, receivedDay, false);
      const todayRows = rows.filter((event) => event.received_at.slice(0, 10) === today);
      const todayReceived = aggregate(todayRows, () => today);
      const todayOverall = aggregate(todayRows, () => today, false);
      const displayedDays = Array.from({ length: days }, (_, offset) => {
        const day = new Date(`${today}T00:00:00.000Z`);
        day.setUTCDate(day.getUTCDate() - days + offset);
        return utcDay(day);
      });
      const groupKey = (value: DailyAggregate) => JSON.stringify([value.kind, value.provider, value.model]);
      const makeComparisons = (aggregates: DailyAggregate[]) => {
        const byDay = new Map(aggregates.map((value) => [JSON.stringify([value.kind, value.provider, value.model, value.day]), value]));
        const metricGroups = new Map(aggregates.map((value) => [groupKey(value), value]));
        return [...metricGroups.values()].flatMap((group) => displayedDays.map((day, index) => {
        const current = byDay.get(JSON.stringify([group.kind, group.provider, group.model, day]));
        const previousDay = index === 0 ? baseline : displayedDays[index - 1];
        const previous = byDay.get(JSON.stringify([group.kind, group.provider, group.model, previousDay]));
        const metricValue = (value: DailyAggregate | undefined) => value ? (value.kind === 'fast_enabled' ? value.eventCount : value.meanDurationMs) : group.kind === 'fast_enabled' ? 0 : null;
        const currentValue = metricValue(current);
        const previousValue = metricValue(previous);
        const change = currentValue !== null && previousValue !== null && previousValue !== 0
          ? (currentValue - previousValue) / previousValue : null;
        const comparable = change !== null && Number.isFinite(change);
        return {
          day, kind: group.kind, model: group.model, provider: group.provider,
          currentValue, previousDay, previousValue,
          percentChange: comparable ? change : null,
          comparable,
        };
        }));
      };
      const comparisons = makeComparisons(daily.aggregates);
      const overallComparisons = makeComparisons(dailyOverall.aggregates);
      return json({
        coverage: 'received_only',
        status: rows.length ? 'partial_coverage' : 'no_received_data',
        watermark: capture.watermark,
        asOf: capture.as_of,
        dataset,
        days,
        completeDays: {
          from: utcDay(firstDisplayed),
          to: utcDay(new Date(new Date(`${today}T00:00:00.000Z`).getTime() - 86_400_000)),
          baselineDay: baseline,
          overallAggregates: dailyOverall.aggregates,
          overallComparisons,
          aggregates: daily.aggregates,
          comparisons,
        },
        unlocatedByReceivedDay: unlocated.aggregates,
        unlocatedOverallByReceivedDay: unlocatedOverall.aggregates,
        todayInProgress: { day: today, comparison: false, overallReceivedAggregates: todayOverall.aggregates, receivedAggregates: todayReceived.aggregates },
        truncated: truncatedRows || daily.truncated || dailyOverall.truncated || unlocated.truncated || unlocatedOverall.truncated || todayReceived.truncated || todayOverall.truncated,
      });
    }
    return json({ error: 'not_found' }, 404);
  },
};
