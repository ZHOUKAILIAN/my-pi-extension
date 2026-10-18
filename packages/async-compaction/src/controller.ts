import type { ExtensionAPI, ExtensionContext, CompactionEntry } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { fits, plan, prompt, settings, valid, withFiles, type Snapshot } from "./compaction.ts";
import { Reporting, metering, type Metering, type Outcome } from "./reporting.ts";
import { Timing } from "./timing.ts";
import type { TimingClock } from "./timing.ts";

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
type Attempt = { id: string; snapshot: Snapshot; provider: string; model: string; abort: AbortController; done: Promise<void>; summary?: string; usage?: Usage; metering: Metering; nativeFallback: boolean; settled: boolean; offered: boolean; cancelled: boolean; deadline: ReturnType<typeof setTimeout>; boundary: string | null; recorded: boolean; timing: ReturnType<Timing["begin"]> };
export class Controller {
  private enabled = false;
  private generation = 0;
  private session: string | null = null;
  private attempt: Attempt | null = null;
  private lastStart = 0;
  private lastTokens = 0;
  private failedAt = 0;
  private lastCompactId: string | null = null;
  private starts = 0;
  private fence(ctx: ExtensionContext) {
    if (this.session !== ctx.sessionManager.getSessionId()) return;
    this.failedAt = this.lastStart = Date.now();
    this.lastTokens = ctx.getContextUsage()?.tokens ?? Number.NaN;
  }
  private afterNative(ctx: ExtensionContext, adopted: boolean) {
    this.generation++; this.starts = 0;
    if (adopted || !this.failedAt) { this.failedAt = 0; this.lastStart = 0; this.lastTokens = 0; }
    else this.lastTokens = ctx.getContextUsage()?.tokens ?? Number.NaN;
  }
  private report: Reporting;
  readonly timing: Timing;
  private nativePhase: string | null = null;
  private clearNative(ctx: ExtensionContext) { if (this.nativePhase) { this.report.hide(this.nativePhase, this.session === ctx.sessionManager.getSessionId()); this.nativePhase = null; } }
  fallback(ctx: ExtensionContext) {
    if (!this.enabled || this.nativePhase || this.session !== ctx.sessionManager.getSessionId()) return;
    this.nativePhase = crypto.randomUUID();
    this.report.phase(this.nativePhase, "fallback");
  }
  private pi: ExtensionAPI;
  private notify(ctx: ExtensionContext, message: string, level: "info" | "warning") { try { ctx.ui.notify(message, level); } catch { /* diagnostic notices never affect compaction */ } }
  constructor(pi: ExtensionAPI, clock?: TimingClock) { this.pi = pi; this.report = new Reporting(pi); this.timing = new Timing(pi, clock); }
  get isEnabled() { return this.enabled; }
  private record(a: Attempt, outcome: Outcome, ctx: ExtensionContext) {
    if (a.recorded || a.snapshot.session !== ctx.sessionManager.getSessionId()) return;
    a.recorded = true;
    this.report.finish({ attemptId: a.id, model: a.model, provider: a.provider, outcome, metering: a.metering, usage: a.usage ?? null, includedInNativeTotals: outcome === "adopted" });
  }
  reset(ctx: ExtensionContext) { this.clearNative(ctx); this.cancel(ctx); this.timing.invalidate(); this.enabled = false; this.generation++; this.session = null; this.attempt = null; this.observationNoticeSent = false; this.starts = 0; this.lastStart = 0; this.failedAt = 0; this.lastTokens = 0; this.lastCompactId = null; }
  set(on: boolean, ctx: ExtensionContext) { const session = ctx.sessionManager.getSessionId(); if (this.session !== session) this.reset(ctx); this.session = session; if (!on && this.enabled) { this.generation++; this.clearNative(ctx); this.cancel(ctx); } this.enabled = on; }
  cancel(ctx: ExtensionContext) {
    const a = this.attempt;
    if (!a || a.cancelled) return;
    a.cancelled = true; clearTimeout(a.deadline); a.abort.abort();
    this.report.hide(a.id, a.snapshot.session === ctx.sessionManager.getSessionId());
    if (a.settled) { this.fence(ctx); this.record(a, "cancelled", ctx); }
  }
  stop(ctx: ExtensionContext) { this.generation++; this.clearNative(ctx); this.cancel(ctx); }
  // On scope exit, a pending physical request cannot safely be attributed to a future session.
  leave(ctx: ExtensionContext) {
    this.cancel(ctx);
    const a = this.attempt;
    if (a && !a.settled) a.timing.finish("unknown", "scope_left");
    if (a && !a.recorded) this.record(a, "cancelled", ctx); // null usage denotes unknown
    this.reset(ctx);
  }
  schedule(ctx: ExtensionContext) {
    if (!this.enabled || ctx.mode !== "tui" || this.session !== ctx.sessionManager.getSessionId() || ctx.signal?.aborted || ctx.hasPendingMessages()) return;
    const s = settings(this.pi, ctx), usage = ctx.getContextUsage();
    if (!s || !ctx.model || !usage || usage.contextWindow !== ctx.model.contextWindow) return;
    const hard = ctx.model.contextWindow - s.reserveTokens;
    const tokens = usage.tokens;
    if (tokens === null || tokens < Math.min(.65 * ctx.model.contextWindow, .8 * hard)) return;
    if (this.attempt && !this.attempt.settled) return;
    if (this.attempt?.summary && !this.attempt.cancelled && valid(this.pi, ctx, this.attempt.snapshot)) return;
    if (this.starts >= 2 || (this.lastStart && Date.now() - this.lastStart < 60_000)) return;
    if (!Number.isFinite(this.lastTokens)) { this.lastTokens = tokens; return; }
    if (this.lastStart && tokens - this.lastTokens < 8000) return;
    const snapshot = plan(this.pi, ctx, this.generation);
    if (!snapshot) return;
    if (this.attempt && !this.attempt.recorded) this.record(this.attempt, "discarded", ctx);
    const abort = new AbortController(), id = crypto.randomUUID();
    const a: Attempt = { id, snapshot, provider: ctx.model.provider, model: ctx.model.id, abort, settled: false, offered: false, cancelled: false, metering: "unknown", nativeFallback: false, boundary: ctx.sessionManager.getLeafId(), recorded: false, deadline: undefined as never, done: Promise.resolve(), timing: undefined as never };
    a.deadline = setTimeout(() => {
      a.cancelled = true; abort.abort();
      let live = false;
      if (this.session === snapshot.session) try { live = snapshot.session === ctx.sessionManager.getSessionId(); } catch { /* disposed without a session event */ }
      this.report.hide(id, live);
    }, 120_000);
    this.attempt = a; this.starts++; this.lastStart = Date.now(); this.lastTokens = tokens;
    this.report.start(id);
    const model = ctx.model, thinking = ctx.thinkingLevel!;
    const message = { role: "user" as const, content: [{ type: "text" as const, text: prompt(snapshot) }], timestamp: Date.now() };
    const options = { reasoning: thinking as Parameters<typeof ctx.modelRegistry.streamSimple>[2] extends infer O ? NonNullable<O> extends { reasoning?: infer R } ? R : never : never, signal: abort.signal, cacheRetention: "none" as const };
    let result: Promise<import("@earendil-works/pi-ai").AssistantMessage>;
    a.timing = this.timing.begin("background_generation", model.id, model.provider);
    try {
      const stream = ctx.modelRegistry.streamSimple(model, { messages: [message] }, options);
      try { result = stream.result(); }
      catch { this.observationFailed(ctx, a); return; }
    } catch { this.observationFailed(ctx, a); return; }
    a.done = result.then(response => {
      const end = a.timing.captureEnd();
      try {
        const outcome = response.stopReason === "stop" && Array.isArray(response.content) && response.content.some(c => c.type === "text" && c.text.trim()) && response.content.every(c => c.type === "text" || c.type === "thinking") ? "completed" : response.stopReason === "aborted" ? "cancelled" : "failed";
        a.timing.finish(outcome, undefined, end);
        const measured = metering(response);
        a.metering = measured.status;
        a.usage = measured.usage ?? undefined;
        if (!a.cancelled && this.enabled && this.generation === snapshot.generation && response.stopReason === "stop" && response.content.length && response.content.every(c => c.type === "text" || c.type === "thinking") && response.content.some(c => c.type === "text" && c.text.trim())) {
          const text = response.content.map(c => c.type === "text" ? c.text : "").join("\n").trim();
          if (text) a.summary = withFiles(text, snapshot.files);
        }
      } catch { a.timing.finish("failed", undefined, end); }
    }, _error => {
      // A rejection handler attached to the original result promise observes the physical
      // terminal before any later Promise reaction can be queued ahead of this callback.
      const end = a.timing.captureEnd();
      a.timing.finish("failed", undefined, end);
    }).finally(() => {
      clearTimeout(a.deadline); a.settled = true;
      let live = false;
      if (this.session === snapshot.session) try { live = snapshot.session === ctx.sessionManager.getSessionId(); } catch { /* stale after disposal */ }
      const same = live && this.generation === snapshot.generation;
      if (live && (a.nativeFallback || !a.summary || a.cancelled)) {
        // Every failed physical attempt is fenced from settlement, not request start.
        // Native compaction may have reset the context while the request was in flight.
        this.fence(ctx);
      }
      this.report.hide(id, live);
      if ((!a.summary || a.cancelled) && live) {
        this.record(a, a.cancelled ? "cancelled" : "failed", ctx);
        if (!a.cancelled && same) this.notify(ctx, "async-compact background summary failed; native compaction remains active", "warning");
      }
      // Only guarded, non-context custom entries are appended; no active session state is changed.
    });
  }
  private observationFailed(ctx: ExtensionContext, a: Attempt) {
    a.timing.finish("unknown", "observation_failed");
    a.cancelled = true;
    clearTimeout(a.deadline);
    try { a.abort.abort(); } catch { /* preserve fail-closed slot */ }
    try { this.report.hide(a.id, this.session === a.snapshot.session); } catch { /* diagnostics cannot release or replace the physical slot */ }
    try { if (!a.recorded) this.record(a, "failed", ctx); } catch { /* keep the fail-closed physical slot and continue to the safety notice */ }
    if (!this.observationNoticeSent) {
      this.observationNoticeSent = true;
      this.notify(ctx, "async-compact 后台预生成已停止；原生压缩仍可用；新建/重开会话或 reload 后重新 on 可恢复。", "warning");
    }
  }
  private observationNoticeSent = false;
  async offer(ctx: ExtensionContext, preparation: { tokensBefore: number; firstKeptEntryId: string; isSplitTurn: boolean; settings: { enabled: boolean; reserveTokens: number; keepRecentTokens: number } }, signal: AbortSignal) {
    const a = this.attempt;
    if (!this.enabled || !a || a.cancelled || a.offered || this.session !== ctx.sessionManager.getSessionId() || this.generation !== a.snapshot.generation) return;
    if (!a.settled) {
      this.report.phase(a.id, "waiting");
      await Promise.race([a.done, sleep(2000), new Promise<void>(r => signal.addEventListener("abort", () => r(), { once: true }))]);
      if (!a.settled) { this.cancel(ctx); if (!signal.aborted) this.notify(ctx, "async-compact still generating; using native compaction", "info"); return; }
    }
    const s = settings(this.pi, ctx);
    if (!a.summary || signal.aborted || !s || JSON.stringify(s) !== JSON.stringify(preparation.settings) || ctx.hasPendingMessages() || !valid(this.pi, ctx, a.snapshot) || !fits(this.pi, ctx, a.snapshot, a.summary, preparation.tokensBefore)) return;
    a.offered = true;
    a.boundary = ctx.sessionManager.getLeafId();
    return { summary: a.summary, firstKeptEntryId: a.snapshot.cut, tokensBefore: preparation.tokensBefore, usage: a.usage, details: { kind: "async-compact", version: 1, attemptId: a.id, ...a.snapshot.files } };
  }
  compact(ctx: ExtensionContext, _entry: CompactionEntry) {
    // The host event can reference an older entry with identical summary text.
    // Deduplicate by the latest committed entry on the active branch instead.
    const branch = ctx.sessionManager.getBranch();
    const committed = branch.filter(e => e.type === "compaction").at(-1);
    if (committed?.id && this.lastCompactId === committed.id) return;
    if (committed?.id) this.lastCompactId = committed.id;
    this.clearNative(ctx);
    if (!committed) return;
    const a = this.attempt;
    if (!a || a.nativeFallback) { this.afterNative(ctx, false); return; }
    const boundaryIndex = branch.findIndex(e => e.id === a.boundary);
    const fresh = branch.slice(boundaryIndex + 1).filter(e => e.type === "compaction").at(-1);
    const adopted = !a.cancelled && boundaryIndex >= 0 && fresh?.details && typeof fresh.details === "object" && "attemptId" in fresh.details && fresh.details.attemptId === a.id && fresh.firstKeptEntryId === a.snapshot.cut && a.snapshot.session === ctx.sessionManager.getSessionId() && a.snapshot.generation === this.generation;
    if (!a.settled) { a.nativeFallback = true; this.cancel(ctx); } // Keep the physical slot and fence retries after settlement.
    else this.record(a, adopted ? "adopted" : "discarded", ctx);
    if (adopted) this.notify(ctx, "async-compact context updated", "info");
    if (a.settled) this.attempt = null;
    this.afterNative(ctx, !!adopted);
  }
  failed(ctx: ExtensionContext) {
    this.clearNative(ctx);
    const a = this.attempt;
    if (a?.offered) {
      if (!a.settled) this.cancel(ctx);
      else {
        this.record(a, "discarded", ctx);
        this.fence(ctx);
      }
      this.notify(ctx, "async-compact native compaction failed; original context remains", "warning");
      if (a.settled) this.attempt = null;
    }
  }
}
