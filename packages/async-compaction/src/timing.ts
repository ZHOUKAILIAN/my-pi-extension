import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from 'node:crypto';
import { createMetricScope, noteMetricFailure, submitMetric } from '@pi/project-metrics/client';

import { formatElapsed } from './duration-schema.ts';

export type TimingKind = "background_generation" | "foreground_compaction";
export type TimingOutcome = "completed" | "failed" | "cancelled" | "unknown";
export type UnknownReason = "clock_invalid" | "observation_failed" | "scope_left" | "terminal_missing";
export type TimingSample = {
  schemaVersion: 1;
  sampleId: string;
  kind: TimingKind;
  startedAtUTC: string | null;
  durationMs: number | null;
  outcome: TimingOutcome;
  model: string | null;
  provider: string | null;
  agentType?: 'main' | 'subagent' | 'unknown';
  attemptId?: string;
  unknownReason?: UnknownReason;
};
export type TimingStamp = { monotonic: number; utc: number | null };
export type TimingClock = { monotonic: () => number; utc: () => number };
const safe = (fn: () => void) => { try { fn(); } catch { /* diagnostics never affect compaction */ } };
const validOutcomes: readonly TimingOutcome[] = ["completed", "failed", "cancelled", "unknown"];
const validKinds: readonly TimingKind[] = ["background_generation", "foreground_compaction"];
const validUnknownReasons: readonly UnknownReason[] = ["clock_invalid", "observation_failed", "scope_left", "terminal_missing"];
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCanonicalUTC = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
};
export function validateTimingSample(value: unknown): TimingSample | undefined {
  if (!isRecord(value)) return undefined;
  const allowed = new Set(['schemaVersion', 'sampleId', 'kind', 'startedAtUTC', 'durationMs', 'outcome', 'model', 'provider', 'agentType', 'attemptId', 'unknownReason']);
  if (Object.keys(value).some(key => !allowed.has(key)) || value.schemaVersion !== 1 || typeof value.sampleId !== 'string' || value.sampleId.length === 0 || value.sampleId.length > 128 ||
      typeof value.kind !== 'string' || !validKinds.includes(value.kind as TimingKind) || typeof value.outcome !== 'string' || !validOutcomes.includes(value.outcome as TimingOutcome) ||
      !(value.model === null || typeof value.model === 'string') || !(value.provider === null || typeof value.provider === 'string') ||
      (value.agentType !== undefined && value.agentType !== 'main' && value.agentType !== 'subagent' && value.agentType !== 'unknown') ||
      (value.attemptId !== undefined && (typeof value.attemptId !== 'string' || value.attemptId.length === 0 || value.attemptId.length > 128))) return undefined;
  if (value.outcome === 'unknown') {
    if (value.durationMs !== null || !(value.startedAtUTC === null || isCanonicalUTC(value.startedAtUTC)) || typeof value.unknownReason !== 'string' || !validUnknownReasons.includes(value.unknownReason as UnknownReason)) return undefined;
  } else if (!isCanonicalUTC(value.startedAtUTC) || typeof value.durationMs !== 'number' || !Number.isFinite(value.durationMs) || value.durationMs < 0 || Object.hasOwn(value, 'unknownReason')) return undefined;
  return value as unknown as TimingSample;
}

export class Timing {
  private scope = 0;
  private pi: ExtensionAPI;
  private clock: TimingClock;
  private idFactory: () => string;
  private enqueue: typeof submitMetric;
  private metricScope = createMetricScope();
  private readonly agentType: 'main' | 'subagent' | 'unknown';
  closeMetricScope() { this.metricScope.close(); }
  constructor(pi: ExtensionAPI, clock: TimingClock = { monotonic: () => performance.now(), utc: () => Date.now() }, dependencies: { idFactory?: () => string; submitMetric?: typeof submitMetric; agentType?: 'main' | 'subagent' | 'unknown' } = {}) {
    this.pi = pi; this.clock = clock; this.idFactory = dependencies.idFactory ?? randomUUID; this.enqueue = dependencies.submitMetric ?? submitMetric; this.agentType = dependencies.agentType ?? (process.env.PI_MY_EXTENSIONS_AGENT_TYPE === 'main' || process.env.PI_MY_EXTENSIONS_AGENT_TYPE === 'subagent' ? process.env.PI_MY_EXTENSIONS_AGENT_TYPE : 'unknown');
    pi.registerEntryRenderer<TimingSample>("async-compact-timing", (entry, _options, theme) => {
      const d = entry?.data;
      const kind: TimingKind | null = d?.kind === "background_generation" || d?.kind === "foreground_compaction" ? d.kind : null;
      const title = kind === "background_generation" ? "async-compact 后台生成耗时" : kind === "foreground_compaction" ? "async-compact 前台压缩阶段耗时" : "async-compact 耗时";
      const sample = validateTimingSample(d);
      const valid = sample !== undefined;
      const duration = valid && sample.outcome !== "unknown" ? sample.durationMs : null;
      const outcome = valid && duration !== null && sample.outcome !== "unknown" ? sample.outcome : "unknown";
      const value = duration === null ? "未知" : formatElapsed(duration);
      try { return new Text(theme.fg("muted", `${title}: ${value} (${outcome})`), 0, 0); }
      catch { return new Text(`${title}: ${value} (${outcome})`, 0, 0); }
    });
  }
  get epoch() { return this.scope; }
  invalidate() { this.scope++; this.metricScope.close(); this.metricScope = createMetricScope(); }
  capture(): TimingStamp {
    let monotonic = Number.NaN, utc: number | null = null;
    try { monotonic = this.clock.monotonic(); } catch { /* invalid stamp remains unknown */ }
    try { const value = this.clock.utc(); if (Number.isFinite(value)) utc = value; } catch { /* UTC is optional, but missing UTC makes sample unknown */ }
    return { monotonic, utc };
  }
  begin(kind: TimingKind, model: string | null, provider: string | null, start = this.capture(), attemptId?: string) {
    const epoch = this.scope;
    let sampleId = 'unavailable';
    try { sampleId = randomUUID(); } catch { /* local diagnostic ID is optional */ }
    let finished = false;
    return {
      sampleId, epoch,
      captureEnd: () => this.capture(),
      finish: (outcome: TimingOutcome, reason?: UnknownReason, end = this.capture()) => {
        if (finished) return; finished = true;
        if (epoch !== this.scope) return;
        let durationMs: number | null = null, unknownReason = reason;
        if (!reason && outcome !== "unknown" && start.utc !== null && Number.isFinite(start.monotonic) && Number.isFinite(end.monotonic) && end.monotonic >= start.monotonic) durationMs = end.monotonic - start.monotonic;
        else if (!reason) unknownReason ??= outcome === "unknown" ? "terminal_missing" : "clock_invalid";
        if (durationMs === null || reason || outcome === "unknown") { durationMs = null; outcome = "unknown"; }
        let startedAtUTC: string | null = null;
        if (start.utc !== null && Number.isFinite(start.utc)) {
          try { startedAtUTC = new Date(start.utc).toISOString(); } catch { unknownReason ??= "clock_invalid"; }
        } else unknownReason ??= "clock_invalid";
        if (startedAtUTC === null) { durationMs = null; outcome = "unknown"; }
        const data: TimingSample = { schemaVersion: 1, sampleId: sampleId ?? 'unavailable', kind, startedAtUTC, durationMs, outcome, model, provider, agentType: this.agentType, ...(attemptId ? { attemptId } : {}), ...(durationMs === null ? { unknownReason: unknownReason ?? "terminal_missing" } : {}) };
        safe(() => this.pi.appendEntry("async-compact-timing", data));
        let eventId: string | null = null;
        try { eventId = this.idFactory(); } catch { noteMetricFailure(); /* never synthesize a remote global identifier */ }
        if (eventId) safe(() => { void this.enqueue({ schemaVersion: 1, eventId, kind, occurredAt: startedAtUTC, durationMs, outcome, model, provider, agentType: this.agentType, ...(durationMs === null ? { unknownReason: unknownReason ?? "terminal_missing" } : {}), dataset: 'live' }, this.metricScope).catch(() => {}); });
      },
    };
  }
}
