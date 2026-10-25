export type CompactionReason = 'manual' | 'threshold' | 'overflow';
export type CompactionOutcome = 'completed' | 'failed' | 'cancelled' | 'unknown';
export type UnknownReason = 'start_missing' | 'clock_invalid' | 'scope_left' | 'ambiguous_terminal';
export type CompactionSource = 'async' | 'native' | 'other' | 'unknown';
export type DurationRecordV1 = {
  schemaVersion: 1; operationId: string; compactionEntryId: string | null; reason: CompactionReason;
  outcome: CompactionOutcome; durationMs: number | null; unknownReason?: UnknownReason;
};
export type DurationRecordV2 = {
  schemaVersion: 2; operationId: string; compactionEntryId: string; reason: CompactionReason;
  outcome: 'completed'; durationMs: number; source: CompactionSource; backgroundGenerationMs: number | null;
  tokensBefore: number | null; tokensAfter: number | null; releasedTokens: number | null; reductionPercent: number | null;
};
export type DurationRecord = DurationRecordV1 | DurationRecordV2;
export type DurationStart = { operationId: string; scope: string; reason: CompactionReason; monotonic: number; branchIds: ReadonlySet<string>; branchValid: boolean; leafId: string | null };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REASONS = new Set(['manual', 'threshold', 'overflow']);
const UNKNOWN = new Set(['start_missing', 'clock_invalid', 'scope_left', 'ambiguous_terminal']);
const SOURCES = new Set(['async', 'native', 'other', 'unknown']);
const nullableSafeInteger = (value: unknown): value is number | null => value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
const nullableFiniteNumber = (value: unknown): value is number | null => value === null || (typeof value === 'number' && Number.isFinite(value));
const closeEnough = (actual: number, expected: number) => Math.abs(actual - expected) <= Number.EPSILON * Math.max(1, Math.abs(expected)) * 4;
export function validateCompactionDuration(value: unknown): DurationRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const x = value as Record<string, unknown>;
  const common = ['schemaVersion','operationId','compactionEntryId','reason','outcome','durationMs','unknownReason'];
  const extended = ['source','backgroundGenerationMs','tokensBefore','tokensAfter','releasedTokens','reductionPercent'];
  const allowed = new Set([...common, ...extended]);
  if (Object.keys(x).some(key => !allowed.has(key)) || Object.keys(x).length < 6 || (x.schemaVersion !== 1 && x.schemaVersion !== 2) || typeof x.operationId !== 'string' || !UUID.test(x.operationId) || typeof x.reason !== 'string' || !REASONS.has(x.reason) || typeof x.outcome !== 'string' || !['completed','failed','cancelled','unknown'].includes(x.outcome)) return undefined;
  if (x.schemaVersion === 1) {
    if (Object.keys(x).some(key => extended.includes(key))) return undefined;
    if (x.compactionEntryId !== null && (typeof x.compactionEntryId !== 'string' || x.compactionEntryId.length < 1 || x.compactionEntryId.length > 128)) return undefined;
    if (x.durationMs !== null && (typeof x.durationMs !== 'number' || !Number.isFinite(x.durationMs) || x.durationMs < 0)) return undefined;
    if (x.outcome === 'completed' && typeof x.compactionEntryId !== 'string') return undefined;
    if (x.outcome === 'unknown') { if (x.durationMs !== null || typeof x.unknownReason !== 'string' || !UNKNOWN.has(x.unknownReason)) return undefined; }
    else if (typeof x.durationMs !== 'number' || Object.hasOwn(x, 'unknownReason')) return undefined;
    return x as unknown as DurationRecordV1;
  }
  if (x.outcome !== 'completed' || typeof x.compactionEntryId !== 'string' || x.compactionEntryId.length < 1 || x.compactionEntryId.length > 128 ||
      typeof x.durationMs !== 'number' || !Number.isFinite(x.durationMs) || x.durationMs < 0 || Object.hasOwn(x, 'unknownReason') || typeof x.source !== 'string' || !SOURCES.has(x.source) ||
      !Object.hasOwn(x, 'backgroundGenerationMs') || !Object.hasOwn(x, 'tokensBefore') || !Object.hasOwn(x, 'tokensAfter') || !Object.hasOwn(x, 'releasedTokens') || !Object.hasOwn(x, 'reductionPercent')) return undefined;
  if (!(x.backgroundGenerationMs === null || (typeof x.backgroundGenerationMs === 'number' && Number.isFinite(x.backgroundGenerationMs) && x.backgroundGenerationMs >= 0)) ||
      !nullableSafeInteger(x.tokensBefore) || !nullableSafeInteger(x.tokensAfter) || !nullableFiniteNumber(x.releasedTokens) || !nullableFiniteNumber(x.reductionPercent)) return undefined;
  if (x.source !== 'async' && x.backgroundGenerationMs !== null) return undefined;
  if (x.tokensBefore === null || x.tokensAfter === null) {
    if (x.tokensBefore !== null || x.tokensAfter !== null || x.releasedTokens !== null || x.reductionPercent !== null) return undefined;
  } else {
    const released = x.tokensBefore - x.tokensAfter;
    if (x.releasedTokens !== released) return undefined;
    const percent = x.tokensBefore > 0 ? released / x.tokensBefore * 100 : null;
    if (percent === null ? x.reductionPercent !== null : typeof x.reductionPercent !== 'number' || !closeEnough(x.reductionPercent, percent)) return undefined;
  }
  return x as unknown as DurationRecordV2;
}
export function unknownDurationRecord(operationId: string, reason: CompactionReason, unknownReason: UnknownReason): DurationRecordV1 { return { schemaVersion: 1, operationId, compactionEntryId: null, reason, outcome: 'unknown', durationMs: null, unknownReason }; }
export function createDurationRecord(start: DurationStart | undefined, scope: string, reason: CompactionReason, outcome: Exclude<CompactionOutcome,'unknown'>, end: number, entries: readonly { id?: string; type?: string }[], idFactory: () => string): DurationRecordV1 {
  if (!start || start.scope !== scope || start.reason !== reason) return unknownDurationRecord(start?.operationId ?? idFactory(), reason, 'ambiguous_terminal');
  const compactions = entries.filter(entry => entry.type === 'compaction' && typeof entry.id === 'string');
  const ambiguous = !start.branchValid || (outcome === 'completed' ? compactions.length !== 1 : compactions.length !== 0);
  const elapsed = end - start.monotonic;
  if (ambiguous) return unknownDurationRecord(start.operationId, reason, 'ambiguous_terminal');
  if (!Number.isFinite(start.monotonic) || !Number.isFinite(end) || !Number.isFinite(elapsed) || elapsed < 0) return unknownDurationRecord(start.operationId, reason, 'clock_invalid');
  return { schemaVersion: 1, operationId: start.operationId, compactionEntryId: outcome === 'completed' ? compactions[0].id! : null, reason, outcome, durationMs: elapsed };
}
export function formatElapsed(value: number): string {
  if (value < 1) return '<1ms';
  if (value < 1000) return `${Math.floor(value)}ms`;
  if (value < 59_950) return `${(value / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(value / 1000);
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}
export function formatCompactionDuration(value: unknown, associated = true, phaseLabel = '压缩阶段'): string {
  const record = validateCompactionDuration(value);
  if (!record) return `${phaseLabel}耗时：未知`;
  if (record.outcome === 'completed' && !associated) return `${phaseLabel}耗时：未知 (关联压缩不可用)`;
  if (record.durationMs === null) return `${phaseLabel}耗时：未知 (${record.schemaVersion === 1 ? record.unknownReason : '关联压缩不可用'})`;
  const duration = formatElapsed(record.durationMs);
  if (record.outcome === 'failed') return `${phaseLabel}失败，耗时：${duration}`;
  if (record.outcome === 'cancelled') return `${phaseLabel}已取消，耗时：${duration}`;
  return `${phaseLabel}耗时：${duration}`;
}
