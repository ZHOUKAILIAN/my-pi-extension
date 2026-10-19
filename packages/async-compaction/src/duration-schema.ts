export type CompactionReason = 'manual' | 'threshold' | 'overflow';
export type CompactionOutcome = 'completed' | 'failed' | 'cancelled' | 'unknown';
export type UnknownReason = 'start_missing' | 'clock_invalid' | 'scope_left' | 'ambiguous_terminal';
export type DurationRecord = { schemaVersion: 1; operationId: string; compactionEntryId: string | null; reason: CompactionReason; outcome: CompactionOutcome; durationMs: number | null; unknownReason?: UnknownReason };
export type DurationStart = { operationId: string; scope: string; reason: CompactionReason; monotonic: number; branchIds: ReadonlySet<string>; branchValid: boolean; leafId: string | null };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REASONS = new Set(['manual', 'threshold', 'overflow']);
const UNKNOWN = new Set(['start_missing', 'clock_invalid', 'scope_left', 'ambiguous_terminal']);
export function validateCompactionDuration(value: unknown): DurationRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const x = value as Record<string, unknown>;
  const keys = Object.keys(x); const allowed = new Set(['schemaVersion','operationId','compactionEntryId','reason','outcome','durationMs','unknownReason']);
  if (keys.some(key => !allowed.has(key)) || keys.length < 6 || x.schemaVersion !== 1 || typeof x.operationId !== 'string' || !UUID.test(x.operationId) || !REASONS.has(String(x.reason)) || !['completed','failed','cancelled','unknown'].includes(String(x.outcome))) return undefined;
  if (x.compactionEntryId !== null && (typeof x.compactionEntryId !== 'string' || x.compactionEntryId.length < 1 || x.compactionEntryId.length > 128)) return undefined;
  if (x.durationMs !== null && (typeof x.durationMs !== 'number' || !Number.isFinite(x.durationMs) || x.durationMs < 0)) return undefined;
  if (x.outcome === 'completed' && typeof x.compactionEntryId !== 'string') return undefined;
  if (x.outcome === 'unknown') { if (x.durationMs !== null || typeof x.unknownReason !== 'string' || !UNKNOWN.has(String(x.unknownReason))) return undefined; }
  else if (typeof x.durationMs !== 'number' || Object.hasOwn(x, 'unknownReason')) return undefined;
  return x as DurationRecord;
}
export function unknownDurationRecord(operationId: string, reason: CompactionReason, unknownReason: UnknownReason): DurationRecord { return { schemaVersion: 1, operationId, compactionEntryId: null, reason, outcome: 'unknown', durationMs: null, unknownReason }; }
export function createDurationRecord(start: DurationStart | undefined, scope: string, reason: CompactionReason, outcome: Exclude<CompactionOutcome,'unknown'>, end: number, entries: readonly { id?: string; type?: string }[], idFactory: () => string): DurationRecord {
  if (!start || start.scope !== scope || start.reason !== reason) return unknownDurationRecord(start?.operationId ?? idFactory(), reason, 'ambiguous_terminal');
  const compactions = entries.filter(entry => entry.type === 'compaction' && typeof entry.id === 'string');
  const ambiguous = !start.branchValid || (outcome === 'completed' ? compactions.length !== 1 : compactions.length !== 0);
  const elapsed = end - start.monotonic;
  if (ambiguous) return unknownDurationRecord(start.operationId, reason, 'ambiguous_terminal');
  if (!Number.isFinite(start.monotonic) || !Number.isFinite(end) || !Number.isFinite(elapsed) || elapsed < 0) return unknownDurationRecord(start.operationId, reason, 'clock_invalid');
  return { schemaVersion: 1, operationId: start.operationId, compactionEntryId: outcome === 'completed' ? compactions[0].id! : null, reason, outcome, durationMs: elapsed };
}
export function formatCompactionDuration(value: unknown, associated = true): string {
  const record = validateCompactionDuration(value); if (!record) return '压缩阶段耗时：未知';
  if (record.outcome === 'completed' && !associated) return '压缩阶段耗时：未知 (关联压缩不可用)';
  if (record.durationMs === null) return `压缩阶段耗时：未知 (${record.unknownReason})`;
  const duration = `${(record.durationMs / 1000).toFixed(2)}s`;
  if (record.outcome === 'failed') return `压缩阶段失败，耗时：${duration}`;
  if (record.outcome === 'cancelled') return `压缩阶段已取消，耗时：${duration}`;
  return `压缩阶段耗时：${duration}`;
}
