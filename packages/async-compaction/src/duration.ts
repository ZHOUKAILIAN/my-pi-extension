import { randomUUID } from 'node:crypto';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createDurationRecord, formatCompactionDuration, type CompactionReason, unknownDurationRecord, validateCompactionDuration } from './duration-schema.ts';
import { Text } from '@earendil-works/pi-tui';

type Entry = { id?: string; type?: string };
type Branch = { valid: boolean; ids: Set<string>; compactionIds: Set<string>; leafId: string | null };
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
    return { valid: true, ids, compactionIds: new Set(branch.filter(entry => entry.type === 'compaction' && typeof entry.id === 'string').map(entry => entry.id!)), leafId: typeof branch.at(-1)?.id === 'string' ? branch.at(-1)!.id! : null };
  } catch { return { valid: false, ids: new Set(), compactionIds: new Set(), leafId: null }; }
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
          const associated = record?.outcome !== 'completed' || this.activeCompactionIds.has(record.compactionEntryId!);
          return new Text(theme.fg('muted', formatCompactionDuration(entry?.data, associated)), 0, 0);
        } catch { try { return new Text('压缩阶段耗时：未知', 0, 0); } catch { return undefined; } }
      });
    } catch { /* renderer registration is optional diagnostics, never extension startup */ }
  }
  setBranch(ctx: ExtensionContext, enabled = ctx.mode === 'tui'): void { this.active = enabled && ctx.mode === 'tui'; this.activeCompactionIds = this.active ? branchOf(ctx).compactionIds : new Set(); }
  before(event: unknown, ctx: ExtensionContext): void {
    try {
      if (eventObject(event)) { if (this.seenBefore.has(event)) return; this.seenBefore.add(event); }
      let monotonic = Number.NaN;
      try { monotonic = this.monotonic(); } catch { /* terminal record becomes unknown */ }
      const reason = (event as { reason?: unknown } | null)?.reason;
      const scope = scopeOf(ctx, this.epoch);
      if (!reason || !REASONS.has(reason) || ctx.mode !== 'tui' || !scope) return;
      let operationId: string;
      try { operationId = this.idFactory(); } catch { return; }
      const branch = branchOf(ctx);
      const start: Start = { operationId, scope, reason: reason as CompactionReason, monotonic, branchIds: branch.ids, branchValid: branch.valid, leafId: branch.leafId };
      if (this.pending) this.pending.ambiguous = true;
      else this.pending = start;
    } catch { /* diagnostic observation cannot affect the native hook */ }
  }
  private terminal(event: unknown, ctx: ExtensionContext, outcome: 'completed' | 'failed' | 'cancelled', end: number): void {
    try {
      const start = this.pending;
      if (!start) return;
      this.pending = null; // Consume before branch inspection or append; duplicates cannot retry.
      const currentScope = scopeOf(ctx, this.epoch);
      if (!currentScope || start.scope !== currentScope) return;
      const terminalReason = (event as { reason?: unknown } | null)?.reason;
      let record;
      if (start.ambiguous || terminalReason !== start.reason) {
        record = unknownDurationRecord(start.operationId, start.reason, 'ambiguous_terminal');
      } else {
        const branch = branchOf(ctx);
        if (branch.valid) this.activeCompactionIds = branch.compactionIds;
        if (!start.branchValid || !branch.valid || !start.leafId || !branch.ids.has(start.leafId)) {
          record = unknownDurationRecord(start.operationId, start.reason, 'ambiguous_terminal');
        } else {
          const delta = [...branch.ids].filter(id => !start.branchIds.has(id)).map(id => ({ id, type: branch.compactionIds.has(id) ? 'compaction' : undefined }));
          const result = createDurationRecord(start, currentScope, start.reason, outcome, end, delta, this.idFactory);
          record = result;
        }
      }
      if (!record || this.consumed.has(record.operationId)) return;
      this.consumed.add(record.operationId);
      if (this.consumed.size > 2048) this.consumed.delete(this.consumed.values().next().value!);
      const encoded = JSON.stringify(record);
      if (encoded.length <= 4096 && validateCompactionDuration(JSON.parse(encoded))) this.pi.appendEntry('compaction-duration', record);
    } catch { /* diagnostic observation/append never changes native compaction */ }
  }
  compact(event: unknown, ctx: ExtensionContext): void {
    let end = Number.NaN; try { end = this.monotonic(); } catch { /* unknown clock */ }
    this.terminal(event, ctx, 'completed', end);
  }
  failed(event: unknown, ctx: ExtensionContext): void {
    let end = Number.NaN; try { end = this.monotonic(); } catch { /* unknown clock */ }
    const aborted = (event as { aborted?: unknown } | null)?.aborted === true;
    this.terminal(event, ctx, aborted ? 'cancelled' : 'failed', end);
  }
  leave(ctx?: ExtensionContext): void {
    this.active = false;
    try {
      const start = this.pending;
      this.pending = null;
      if (start && ctx && start.scope === scopeOf(ctx, this.epoch) && !this.consumed.has(start.operationId)) {
        const branch = branchOf(ctx);
        if (branch.valid && start.branchValid && start.leafId && branch.ids.has(start.leafId)) {
          this.consumed.add(start.operationId);
          this.pi.appendEntry('compaction-duration', unknownDurationRecord(start.operationId, start.reason, 'scope_left'));
        }
      }
    } catch { /* best effort only in the original session scope */ }
    this.epoch++;
  }
  tree(ctx?: ExtensionContext, enabled?: boolean): void { this.epoch++; this.pending = null; if (ctx) this.setBranch(ctx, enabled); }
}

const installed = new WeakMap<ExtensionAPI, CompactionDurationObserver>();
export function installCompactionDurationObserver(pi: ExtensionAPI, clock?: () => number): CompactionDurationObserver {
  const existing = installed.get(pi);
  if (existing) return existing;
  const observer = new CompactionDurationObserver(pi, clock);
  installed.set(pi, observer);
  return observer;
}
