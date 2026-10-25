import { randomUUID } from 'node:crypto';
import { buildSessionProjection, convertToLlm, estimateTokens } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI, ExtensionContext, SessionEntry } from '@earendil-works/pi-coding-agent';
import { getCurrentSystemMessage } from '@earendil-works/pi-ai';
import { createDurationRecord, formatCompactionDuration, formatElapsed, type CompactionReason, type CompactionSource, type DurationRecord, type DurationRecordV1, type DurationRecordV2, unknownDurationRecord, validateCompactionDuration } from './duration-schema.ts';
import { validateTimingSample } from './timing.ts';
import { Text } from '@earendil-works/pi-tui';

type Entry = SessionEntry;
type Branch = { valid: boolean; ids: Set<string>; compactionIds: Set<string>; entries: Entry[]; leafId: string | null };
type Start = { operationId: string; scope: string; reason: CompactionReason; monotonic: number; branchIds: Set<string>; branchValid: boolean; leafId: string | null; ambiguous?: boolean };
const REASONS = new Set<unknown>(['manual', 'threshold', 'overflow']);
const safe = <T>(fn: () => T): T | undefined => { try { return fn(); } catch { return undefined; } };
const eventObject = (event: unknown): event is object => event !== null && (typeof event === 'object' || typeof event === 'function');
function scopeOf(ctx: ExtensionContext, epoch: number): string | undefined {
  const id = safe(() => ctx.sessionManager.getSessionId());
  return typeof id === 'string' && id.trim().length > 0 ? `${id}\0${epoch}` : undefined;
}
function branchOf(ctx: ExtensionContext): Branch {
  try {
    const branch = ctx.sessionManager.getBranch();
    if (!Array.isArray(branch)) throw new Error('invalid branch');
    const ids = new Set(branch.flatMap(entry => typeof entry.id === 'string' ? [entry.id] : []));
    return { valid: true, ids, entries: branch, compactionIds: new Set(branch.filter(entry => entry.type === 'compaction' && typeof entry.id === 'string').map(entry => entry.id!)), leafId: typeof branch.at(-1)?.id === 'string' ? branch.at(-1)!.id! : null };
  } catch { return { valid: false, ids: new Set(), entries: [], compactionIds: new Set(), leafId: null }; }
}
function estimateCanonical(pi: ExtensionAPI, ctx: ExtensionContext, entries: readonly SessionEntry[]): number | null {
  try {
    const messages = buildSessionProjection([...entries]).messages;
    const currentSystem = getCurrentSystemMessage(messages);
    const system = currentSystem ?? {
      role: 'system' as const,
      content: ctx.getSystemPrompt(),
      toolsAdded: pi.getAllTools().filter(tool => pi.getActiveTools().includes(tool.name)),
      timestamp: 0,
    };
    const conversation = convertToLlm(messages).filter(message => message.role !== 'system');
    const total = estimateTokens(system) + conversation.reduce((sum, message) => sum + estimateTokens(message), 0);
    return Number.isSafeInteger(total) && total >= 0 ? total : null;
  } catch { return null; }
}
export function formatCompactionPresentation(value: unknown, associated = true): string {
  const record = validateCompactionDuration(value);
  if (!record) return '压缩阶段耗时：未知';
  if (record.schemaVersion === 2 && record.outcome === 'completed' && !associated) return '前台压缩阶段耗时：未知 (关联压缩不可用)';
  const label = record.schemaVersion === 2 ? '前台压缩阶段' : '压缩阶段';
  let line = formatCompactionDuration(record, associated, label);
  if (record.schemaVersion !== 2) return line;
  const v2 = record;
  const source = v2.source === 'async' ? '已采用后台摘要' : v2.source === 'native' ? '由原生压缩完成' : v2.source === 'other' ? '由其他扩展完成' : '压缩来源未知';
  line = `${source}；${line}`;
  if (v2.source === 'async') line += `；后台摘要生成：${v2.backgroundGenerationMs === null ? '未知' : formatElapsed(v2.backgroundGenerationMs)}`;
  if (v2.tokensBefore === null || v2.tokensAfter === null || v2.releasedTokens === null) line += '；上下文变化：未知';
  else if (v2.releasedTokens > 0) line += `；上下文估算 ${v2.tokensBefore}→${v2.tokensAfter}，释放 ${v2.releasedTokens} tokens${v2.reductionPercent === null ? '（比例未知）' : `（减少 ${v2.reductionPercent.toFixed(1)}%）`}`;
  else if (v2.releasedTokens === 0) line += `；上下文估算 ${v2.tokensBefore}→${v2.tokensAfter}，未减少（${v2.reductionPercent === null ? '比例未知' : '0%'}）`;
  else line += `；上下文估算 ${v2.tokensBefore}→${v2.tokensAfter}，增加 ${Math.abs(v2.releasedTokens)} tokens${v2.reductionPercent === null ? '（比例未知）' : `（${Math.abs(v2.reductionPercent).toFixed(1)}%）`}`;
  return line;
}
export class CompactionDurationObserver {
  private epoch = 0;
  private pending: Start | null = null;
  private consumed = new Set<string>();
  private seenBefore = new WeakSet<object>();
  private activeCompactionIds = new Set<string>();
  private active = false;
  private readonly pi: ExtensionAPI;
  private readonly monotonic: () => number;
  private readonly idFactory: () => string;
  constructor(pi: ExtensionAPI, monotonic = () => performance.now(), idFactory = randomUUID) {
    this.pi = pi; this.monotonic = monotonic; this.idFactory = idFactory;
    try {
      pi.registerEntryRenderer('compaction-duration', (entry: any, _options: any, theme: any) => {
        try {
          if (!this.active) return undefined;
          const record = validateCompactionDuration(entry?.data);
          const associated = record?.outcome !== 'completed' || (typeof record.compactionEntryId === 'string' && this.activeCompactionIds.has(record.compactionEntryId));
          return new Text(theme.fg('muted', formatCompactionPresentation(record, associated)), 0, 0);
        } catch { try { return new Text('压缩阶段耗时：未知', 0, 0); } catch { return undefined; } }
      });
    } catch { /* optional diagnostic renderer */ }
  }
  setBranch(ctx: ExtensionContext, enabled = ctx.mode === 'tui'): void { this.active = enabled && ctx.mode === 'tui'; this.activeCompactionIds = this.active ? branchOf(ctx).compactionIds : new Set(); }
  captureEnd(): number { try { return this.monotonic(); } catch { return Number.NaN; } }
  before(event: unknown, ctx: ExtensionContext): void {
    try {
      if (eventObject(event)) { if (this.seenBefore.has(event)) return; this.seenBefore.add(event); }
      let monotonic = Number.NaN; try { monotonic = this.monotonic(); } catch { /* terminal unknown */ }
      const reason = (event as { reason?: unknown } | null)?.reason;
      const scope = scopeOf(ctx, this.epoch);
      if (!reason || !REASONS.has(reason) || ctx.mode !== 'tui' || !scope) return;
      let operationId: string; try { operationId = this.idFactory(); } catch { return; }
      const branch = branchOf(ctx);
      const start: Start = { operationId, scope, reason: reason as CompactionReason, monotonic, branchIds: branch.ids, branchValid: branch.valid, leafId: branch.leafId };
      if (this.pending) this.pending.ambiguous = true; else this.pending = start;
    } catch { /* observation cannot affect the native hook */ }
  }
  private terminal(event: unknown, ctx: ExtensionContext, outcome: 'completed' | 'failed' | 'cancelled', end: number, adoptedAttemptId?: string | null): void {
    try {
      const start = this.pending; if (!start) return;
      this.pending = null;
      const currentScope = scopeOf(ctx, this.epoch); if (!currentScope || start.scope !== currentScope) return;
      const terminalReason = (event as { reason?: unknown } | null)?.reason;
      let record: DurationRecord;
      const branch = branchOf(ctx);
      if (start.ambiguous || terminalReason !== start.reason) record = unknownDurationRecord(start.operationId, start.reason, 'ambiguous_terminal');
      else if (!start.branchValid || !branch.valid || !start.leafId || !branch.ids.has(start.leafId)) record = unknownDurationRecord(start.operationId, start.reason, 'ambiguous_terminal');
      else {
        const delta = [...branch.ids].filter(id => !start.branchIds.has(id)).map(id => ({ id, type: branch.compactionIds.has(id) ? 'compaction' : undefined }));
        record = createDurationRecord(start, currentScope, start.reason, outcome, end, delta, this.idFactory);
        if (record.outcome === 'completed' && typeof record.compactionEntryId === 'string' && typeof record.durationMs === 'number') {
          let committedIndex = -1;
          for (let index = branch.entries.length - 1; index >= 0; index--) {
            const entry = branch.entries[index];
            if (entry.type === 'compaction' && typeof entry.id === 'string' && !start.branchIds.has(entry.id)) { committedIndex = index; break; }
          }
          const committedEntry = committedIndex >= 0 ? branch.entries[committedIndex] : undefined;
          const committed = committedEntry?.type === 'compaction' ? committedEntry : undefined;
          const isMatchingCommit = committed?.id === record.compactionEntryId;
          const beforeEntries = committedIndex >= 0 ? branch.entries.slice(0, committedIndex) : [];
          const submittedEntries = committedIndex >= 0 ? branch.entries.slice(0, committedIndex + 1) : [];
          const before = isMatchingCommit ? estimateCanonical(this.pi, ctx, beforeEntries) : null;
          const after = isMatchingCommit ? estimateCanonical(this.pi, ctx, submittedEntries) : null;
          const asyncDetails = committed?.details && typeof committed.details === 'object' ? committed.details as Record<string, unknown> : undefined;
          const isAsync = isMatchingCommit && typeof adoptedAttemptId === 'string' && adoptedAttemptId.length > 0 && asyncDetails?.kind === 'async-compact' && asyncDetails.version === 1 && asyncDetails.attemptId === adoptedAttemptId;
          const source: CompactionSource = isAsync ? 'async' : committed?.fromHook === false ? 'native' : committed?.fromHook === true ? 'other' : 'unknown';
          const effectsKnown = before !== null && after !== null;
          const tokensBefore = effectsKnown ? before : null;
          const tokensAfter = effectsKnown ? after : null;
          const released = effectsKnown && before !== null && after !== null ? before - after : null;
          const percent = before !== null && before > 0 && released !== null ? released / before * 100 : null;
          const timingCandidates = isAsync ? branch.entries.filter(entry => {
            if (entry.type !== 'custom' || entry.customType !== 'async-compact-timing' || !entry.data || typeof entry.data !== 'object') return false;
            const data = entry.data as Record<string, unknown>;
            return data.kind === 'background_generation' && data.attemptId === adoptedAttemptId;
          }) : [];
          const timingSample = timingCandidates.length === 1 ? validateTimingSample(timingCandidates[0].type === 'custom' ? timingCandidates[0].data : undefined) : undefined;
          const background = timingSample?.kind === 'background_generation' && timingSample.attemptId === adoptedAttemptId && timingSample.outcome === 'completed' ? timingSample.durationMs : null;
          record = { schemaVersion: 2, operationId: record.operationId, compactionEntryId: record.compactionEntryId, reason: record.reason, outcome: 'completed', durationMs: record.durationMs, source, backgroundGenerationMs: background, tokensBefore, tokensAfter, releasedTokens: released, reductionPercent: percent } satisfies DurationRecordV2;
        }
      }
      if (!record || this.consumed.has(record.operationId)) return;
      this.consumed.add(record.operationId); if (this.consumed.size > 2048) this.consumed.delete(this.consumed.values().next().value!);
      let persist: DurationRecord = record;
      let persistable = false;
      try {
        const encoded = JSON.stringify(record);
        persistable = encoded.length <= 4096 && validateCompactionDuration(JSON.parse(encoded)) !== undefined;
      } catch { /* preserve completed phase below */ }
      if (!persistable && record.schemaVersion === 2) {
        const fallback: DurationRecordV1 = { schemaVersion: 1, operationId: record.operationId, compactionEntryId: record.compactionEntryId, reason: record.reason, outcome: 'completed', durationMs: record.durationMs };
        if (validateCompactionDuration(fallback)) persist = fallback;
      }
      try {
        const encoded = JSON.stringify(persist);
        if (encoded.length <= 4096 && validateCompactionDuration(JSON.parse(encoded))) this.pi.appendEntry('compaction-duration', persist);
      } catch { /* diagnostics cannot alter native compaction */ }
      if (branch.valid) this.activeCompactionIds = branch.compactionIds;
    } catch { /* diagnostic failure never changes native result */ }
  }
  compact(event: unknown, ctx: ExtensionContext, adoptedAttemptId?: string | null, end?: number): void {
    if (end === undefined) { end = Number.NaN; try { end = this.monotonic(); } catch { /* unknown clock */ } }
    this.terminal(event, ctx, 'completed', end, adoptedAttemptId);
  }
  failed(event: unknown, ctx: ExtensionContext, end?: number): void {
    if (end === undefined) { end = Number.NaN; try { end = this.monotonic(); } catch { /* unknown clock */ } }
    const aborted = (event as { aborted?: unknown } | null)?.aborted === true;
    this.terminal(event, ctx, aborted ? 'cancelled' : 'failed', end);
  }
  leave(ctx?: ExtensionContext): void {
    this.active = false;
    try {
      const start = this.pending; this.pending = null;
      if (start && ctx && start.scope === scopeOf(ctx, this.epoch) && !this.consumed.has(start.operationId)) {
        const branch = branchOf(ctx);
        if (branch.valid && start.branchValid && start.leafId && branch.ids.has(start.leafId)) { this.consumed.add(start.operationId); this.pi.appendEntry('compaction-duration', unknownDurationRecord(start.operationId, start.reason, 'scope_left')); }
      }
    } catch { /* best effort in original scope */ }
    this.epoch++;
  }
  tree(ctx?: ExtensionContext, enabled?: boolean): void { this.epoch++; this.pending = null; if (ctx) this.setBranch(ctx, enabled); }
}
const installed = new WeakMap<ExtensionAPI, CompactionDurationObserver>();
export function installCompactionDurationObserver(pi: ExtensionAPI, clock?: () => number): CompactionDurationObserver {
  const existing = installed.get(pi); if (existing) return existing;
  const observer = new CompactionDurationObserver(pi, clock); installed.set(pi, observer); return observer;
}
