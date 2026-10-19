import type { Dataset, Kind } from './contracts.ts';

// The CLI only prints this response contract, never an arbitrary HTTP JSON object.
type JsonObject = Record<string, unknown>;
const fail = (): never => { throw new Error('stats_failed'); };
function object(value: unknown, keys: string[]): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return fail();
  const record = value as JsonObject;
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) return fail();
  return record;
}
function finiteNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fail();
  return value;
}
function boundedNumber(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  const number = finiteNumber(value);
  if (Math.abs(number) > max) return fail();
  return number;
}
function count(value: unknown): number {
  const number = boundedNumber(value, 20000);
  if (!Number.isInteger(number) || number < 0) return fail();
  return number;
}
function day(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return fail();
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) return fail();
  return value;
}
function label(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 128 || /[\u0000-\u001f\u007f]/u.test(value)) return fail();
  return value;
}
function kind(value: unknown): Kind {
  if (value !== 'fast_enabled' && value !== 'background_generation' && value !== 'foreground_compaction') return fail();
  return value;
}
function agentType(value: unknown): string | null {
  const result = label(value);
  if (result !== null && result !== 'main' && result !== 'subagent' && result !== 'unknown') return fail();
  return result;
}
function metric(value: unknown): number | null {
  return value === null ? null : boundedNumber(value, 86400000);
}
function aggregate(value: unknown) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail();
  const record = value as JsonObject;
  const x = object(value, Object.hasOwn(record, 'agentType') ? ['day', 'kind', 'model', 'provider', 'agentType', 'eventCount', 'knownCount', 'unknownCount', 'meanDurationMs'] : ['day', 'kind', 'model', 'provider', 'eventCount', 'knownCount', 'unknownCount', 'meanDurationMs']);
  const eventKind = kind(x.kind);
  const result = { day: day(x.day), kind: eventKind, model: label(x.model), provider: label(x.provider), agentType: x.agentType === undefined ? null : agentType(x.agentType), eventCount: count(x.eventCount), knownCount: count(x.knownCount), unknownCount: count(x.unknownCount), meanDurationMs: metric(x.meanDurationMs) };
  if (eventKind === 'fast_enabled' ? result.model !== null || result.provider !== null || result.agentType !== null || result.knownCount !== 0 || result.unknownCount !== 0 || result.meanDurationMs !== null : result.eventCount !== 0 || (result.knownCount === 0) !== (result.meanDurationMs === null) || (result.meanDurationMs !== null && result.meanDurationMs < 0)) return fail();
  return result;
}
function comparison(value: unknown) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail();
  const record = value as JsonObject;
  const x = object(value, Object.hasOwn(record, 'agentType') ? ['day', 'kind', 'model', 'provider', 'agentType', 'currentValue', 'previousDay', 'previousValue', 'percentChange', 'comparable'] : ['day', 'kind', 'model', 'provider', 'currentValue', 'previousDay', 'previousValue', 'percentChange', 'comparable']);
  const eventKind = kind(x.kind);
  const result = { day: day(x.day), kind: eventKind, model: label(x.model), provider: label(x.provider), agentType: x.agentType === undefined ? null : agentType(x.agentType), currentValue: metric(x.currentValue), previousDay: day(x.previousDay), previousValue: metric(x.previousValue), percentChange: x.percentChange === null ? null : finiteNumber(x.percentChange), comparable: x.comparable };
  if (typeof result.comparable !== 'boolean' || (result.comparable !== (result.percentChange !== null)) || (result.comparable && (result.currentValue === null || result.previousValue === null || result.previousValue === 0)) || (eventKind === 'fast_enabled' && (result.model !== null || result.provider !== null || result.agentType !== null || result.currentValue === null || result.previousValue === null))) return fail();
  return result;
}
function list<T>(value: unknown, limit: number, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > limit) return fail();
  return value.map(parse);
}
function containsToken(value: unknown, token: string): boolean {
  if (typeof value === 'string') return value.includes(token);
  if (Array.isArray(value)) return value.some(item => containsToken(item, token));
  if (value && typeof value === 'object') return Object.values(value).some(item => containsToken(item, token));
  return false;
}
function validateAgentView(value: unknown, days: number) {
  const view = object(value, ['completeDays', 'unlocatedByReceivedDay', 'todayInProgress', 'truncated']);
  if (typeof view.truncated !== 'boolean') return fail();
  const complete = object(view.completeDays, ['aggregates', 'comparisons']);
  const today = object(view.todayInProgress, ['receivedAggregates']);
  const aggregates = list(complete.aggregates, 64, aggregate).map(item => {
    if (item.kind === 'fast_enabled' || item.model !== null || item.provider !== null || item.eventCount !== 0) return fail();
    return item;
  });
  const comparisons = list(complete.comparisons, 2 * days, comparison).map(item => {
    if (item.kind === 'fast_enabled' || item.model !== null || item.provider !== null) return fail();
    return item;
  });
  const unlocated = list(view.unlocatedByReceivedDay, 64, aggregate).map(item => {
    if (item.kind === 'fast_enabled' || item.model !== null || item.provider !== null || item.eventCount !== 0) return fail();
    return item;
  });
  const received = list(today.receivedAggregates, 2, aggregate).map(item => {
    if (item.kind === 'fast_enabled' || item.model !== null || item.provider !== null || item.eventCount !== 0) return fail();
    return item;
  });
  return { completeDays: { aggregates, comparisons }, unlocatedByReceivedDay: unlocated, todayInProgress: { receivedAggregates: received }, truncated: view.truncated };
}

export function validateStatsResponse(value: unknown, dataset: Dataset, days: number, readToken: string) {
  const x = object(value, ['coverage', 'status', 'watermark', 'asOf', 'dataset', 'days', 'completeDays', 'unlocatedByReceivedDay', 'unlocatedOverallByReceivedDay', 'todayInProgress', 'truncated']);
  if (x.coverage !== 'received_only' || (x.status !== 'no_received_data' && x.status !== 'partial_coverage') || x.dataset !== dataset || x.days !== days || typeof x.truncated !== 'boolean') return fail();
  const watermark = boundedNumber(x.watermark);
  if (!Number.isSafeInteger(watermark) || watermark < 0) return fail();
  const asOf = x.asOf;
  if (typeof asOf !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(asOf) || !Number.isFinite(Date.parse(asOf)) || new Date(asOf).toISOString() !== asOf) return fail();
  const complete = object(x.completeDays, ['from', 'to', 'baselineDay', 'overallAggregates', 'overallComparisons', 'aggregates', 'comparisons']);
  const today = object(x.todayInProgress, ['day', 'comparison', 'overallReceivedAggregates', 'receivedAggregates']);
  if (today.comparison !== false || day(today.day) !== asOf.slice(0, 10)) return fail();
  const report = {
    coverage: x.coverage, status: x.status, watermark, asOf, dataset, days,
    completeDays: {
      from: day(complete.from), to: day(complete.to), baselineDay: day(complete.baselineDay),
      overallAggregates: list(complete.overallAggregates, 32, aggregate), overallComparisons: list(complete.overallComparisons, 32 * days, comparison),
      aggregates: list(complete.aggregates, 32, aggregate), comparisons: list(complete.comparisons, 32 * days, comparison),
    },
    unlocatedByReceivedDay: list(x.unlocatedByReceivedDay, 32, aggregate),
    unlocatedOverallByReceivedDay: list(x.unlocatedOverallByReceivedDay, 32, aggregate),
    todayInProgress: { day: day(today.day), comparison: false, overallReceivedAggregates: list(today.overallReceivedAggregates, 32, aggregate), receivedAggregates: list(today.receivedAggregates, 32, aggregate) },
    truncated: x.truncated,
  };
  // Model/provider are legitimately user-provided strings. A server echoing a read credential
  // inside an otherwise valid aggregate must still be rejected before anything reaches stdout.
  if (containsToken(report, readToken)) return fail();
  return report;
}

export function validateStatsResponseV2(value: unknown, dataset: Dataset, days: number, readToken: string) {
  const x = object(value, ['schemaVersion', 'base', 'byAgentType']);
  if (x.schemaVersion !== 2 || x.byAgentType === null || typeof x.byAgentType !== 'object' || Array.isArray(x.byAgentType)) return fail();
  const groups = object(x.byAgentType, ['main', 'subagent', 'unknown']);
  const base = validateStatsResponse(x.base, dataset, days, readToken);
  const byAgentType = { main: validateAgentView(groups.main, days), subagent: validateAgentView(groups.subagent, days), unknown: validateAgentView(groups.unknown, days) };
  const report = { schemaVersion: 2 as const, base, byAgentType };
  if (containsToken(report, readToken)) return fail();
  return report;
}
