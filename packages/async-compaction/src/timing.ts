import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from 'node:crypto';
import { createMetricScope, noteMetricFailure, submitMetric } from '@pi/project-metrics/client';

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
  unknownReason?: UnknownReason;
};
export type TimingStamp = { monotonic: number; utc: number | null };
export type TimingClock = { monotonic: () => number; utc: () => number };
const safe = (fn: () => void) => { try { fn(); } catch { /* diagnostics never affect compaction */ } };
const validOutcomes: TimingOutcome[] = ["completed", "failed", "cancelled", "unknown"];

export class Timing {
  private scope = 0;
  private pi: ExtensionAPI;
  private clock: TimingClock;
  private idFactory: () => string;
  private enqueue: typeof submitMetric;
  private metricScope = createMetricScope();
  closeMetricScope() { this.metricScope.close(); }
  constructor(pi: ExtensionAPI, clock: TimingClock = { monotonic: () => performance.now(), utc: () => Date.now() }, dependencies: { idFactory?: () => string; submitMetric?: typeof submitMetric } = {}) {
    this.pi = pi; this.clock = clock; this.idFactory = dependencies.idFactory ?? randomUUID; this.enqueue = dependencies.submitMetric ?? submitMetric;
    pi.registerEntryRenderer<TimingSample>("async-compact-timing", (entry, _options, theme) => {
      const d = entry?.data;
      const kind: TimingKind | null = d?.kind === "background_generation" || d?.kind === "foreground_compaction" ? d.kind : null;
      const title = kind === "background_generation" ? "async-compact 后台生成耗时" : kind === "foreground_compaction" ? "async-compact 前台压缩阶段耗时" : "async-compact 耗时";
      const validUtc = typeof d?.startedAtUTC === "string" && Number.isFinite(Date.parse(d.startedAtUTC));
      const validUnknownUtc = d?.startedAtUTC === null && d?.durationMs === null && d?.outcome === "unknown";
      const valid = !!d && d.schemaVersion === 1 && kind !== null && validOutcomes.includes(d.outcome) && typeof d.sampleId === "string" && (validUtc || validUnknownUtc);
      const duration = valid && d.outcome !== "unknown" && typeof d.durationMs === "number" && Number.isFinite(d.durationMs) && d.durationMs >= 0 ? d.durationMs : null;
      const outcome = valid && duration !== null && d.outcome !== "unknown" ? d.outcome : "unknown";
      const value = duration === null ? "未知" : `${(duration / 1000).toFixed(3)}s`;
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
  begin(kind: TimingKind, model: string | null, provider: string | null, start = this.capture()) {
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
        const data: TimingSample = { schemaVersion: 1, sampleId: sampleId ?? 'unavailable', kind, startedAtUTC, durationMs, outcome, model, provider, ...(durationMs === null ? { unknownReason: unknownReason ?? "terminal_missing" } : {}) };
        safe(() => this.pi.appendEntry("async-compact-timing", data));
        let eventId: string | null = null;
        try { eventId = this.idFactory(); } catch { noteMetricFailure(); /* never synthesize a remote global identifier */ }
        if (eventId) safe(() => { void this.enqueue({ schemaVersion: 1, eventId, kind, occurredAt: startedAtUTC, durationMs, outcome, model, provider, ...(durationMs === null ? { unknownReason: unknownReason ?? "terminal_missing" } : {}), dataset: 'live' }, this.metricScope).catch(() => {}); });
      },
    };
  }
}
