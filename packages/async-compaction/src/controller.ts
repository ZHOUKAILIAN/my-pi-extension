import type { ExtensionAPI, ExtensionContext, CompactionEntry } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { fits, plan, prompt, settings, valid, withFiles, type Snapshot } from "./compaction.ts";
import { Reporting, failureDiagnostic, metering, type FailureDiagnostic, type Metering, type Outcome, type ScheduleTrigger } from "./reporting.ts";
import { Timing } from "./timing.ts";
import type { TimingClock } from "./timing.ts";

const GENERATION_BUDGET_MS = 600_000;
export type BudgetClock = { monotonic: () => number; setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
const defaultBudgetClock: BudgetClock = { monotonic: () => performance.now(), setTimeout, clearTimeout };
type Attempt = { id: string; snapshot: Snapshot; provider: string; model: string; abort: AbortController; done: Promise<void>; summary?: string; usage?: Usage; metering: Metering; nativeFallback: boolean; settled: boolean; offered: boolean; cancelled: boolean; deadline: ReturnType<typeof setTimeout>; boundary: string | null; recorded: boolean; timing: ReturnType<Timing["begin"]>; diagnostic?: FailureDiagnostic; deadlineAt: number; cancelReason?: "deadline" | "user" | "host" | "off" | "scope" | "native" | "unknown" };
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
  private activeOfferId: string | null = null;
  private readonly budgetClock: BudgetClock;
  private budgetNow() { try { const value = this.budgetClock.monotonic(); if (Number.isFinite(value)) return value; } catch { /* use the runtime monotonic clock */ } return performance.now(); }
  private setBudgetTimer(callback: () => void, delay: number) { try { return this.budgetClock.setTimeout(callback, delay); } catch { return setTimeout(callback, delay); } }
  private clearBudgetTimer(timer: ReturnType<typeof setTimeout>) { try { this.budgetClock.clearTimeout(timer); } catch { /* native clear remains best effort */ } try { clearTimeout(timer); } catch { /* diagnostics cannot affect business state */ } }
  private sameSnapshotBranch(snapshot: Snapshot, ctx: ExtensionContext): boolean {
    if (!snapshot.leaf || snapshot.session !== ctx.sessionManager.getSessionId()) return false;
    try { return ctx.sessionManager.getBranch().some(entry => entry.id === snapshot.leaf); } catch { return false; }
  }
  private fence(ctx: ExtensionContext) {
    if (this.session !== ctx.sessionManager.getSessionId() || !this.attempt || !this.sameSnapshotBranch(this.attempt.snapshot, ctx)) return;
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
  constructor(pi: ExtensionAPI, clock?: TimingClock, metricDependencies?: { submitMetric?: typeof import('@pi/project-metrics/client').submitMetric; agentType?: 'main' | 'subagent' | 'unknown' }, budgetClock: BudgetClock = defaultBudgetClock) { this.pi = pi; this.budgetClock = budgetClock; this.report = new Reporting(pi); this.timing = new Timing(pi, clock, metricDependencies); }
  get isEnabled() { return this.enabled; }
  private record(a: Attempt, outcome: Outcome, ctx: ExtensionContext) {
    if (a.recorded || !this.sameSnapshotBranch(a.snapshot, ctx)) return;
    a.recorded = true;
    this.report.finish({ attemptId: a.id, model: a.model, provider: a.provider, outcome, metering: a.metering, usage: a.usage ?? null, includedInNativeTotals: outcome === "adopted" }, a.diagnostic);
  }
  reset(ctx: ExtensionContext) { this.activeOfferId = null; this.clearNative(ctx); this.cancel(ctx, "scope"); this.timing.invalidate(); this.enabled = false; this.generation++; this.session = null; this.attempt = null; this.observationNoticeSent = false; this.starts = 0; this.lastStart = 0; this.failedAt = 0; this.lastTokens = 0; this.lastCompactId = null; }
  shutdown(ctx?: ExtensionContext): void {
    this.generation++;
    this.enabled = false;
    const attempt = this.attempt;
    if (attempt && !attempt.cancelled) {
      attempt.cancelReason = "scope";
      attempt.cancelled = true;
      const live = !!ctx && this.sameSnapshotBranch(attempt.snapshot, ctx);
      if (live) try { this.report.cancellation(attempt.id, "scope"); } catch { /* diagnostic only */ }
      this.clearBudgetTimer(attempt.deadline);
      try { attempt.abort.abort(); } catch { /* cancellation is best effort */ }
      try { if (ctx) this.report.hide(attempt.id, live); } catch { /* diagnostic only */ }
    }
    if (attempt && !attempt.settled) {
      try { attempt.timing.finish('unknown', 'scope_left'); } catch { /* diagnostic only */ }
    }
    this.attempt = null;
    this.session = null;
    this.timing.invalidate();
    this.nativePhase = null;
  }
  resetTree(ctx: ExtensionContext) {
    const a = this.attempt;
    this.nativePhase = null;
    this.timing.invalidate();
    this.enabled = false; this.generation++; this.session = ctx.sessionManager.getSessionId();
    this.starts = 0; this.lastStart = 0; this.failedAt = 0; this.lastTokens = 0; this.lastCompactId = null;
    if (a && !a.cancelled) {
      const live = this.sameSnapshotBranch(a.snapshot, ctx);
      a.cancelReason = "scope"; a.cancelled = true;
      if (live) try { this.report.cancellation(a.id, "scope"); } catch { /* diagnostic only */ }
      this.clearBudgetTimer(a.deadline); a.abort.abort();
      this.report.hide(a.id, live);
    }
    if (a?.settled) { this.record(a, 'cancelled', ctx); this.attempt = null; }
  }
  set(on: boolean, ctx: ExtensionContext) { const session = ctx.sessionManager.getSessionId(); if (this.session !== session) this.reset(ctx); this.session = session; if (!on && this.enabled) { this.generation++; this.clearNative(ctx); this.cancel(ctx, "off"); } this.enabled = on; }
  cancel(ctx: ExtensionContext, reason: Attempt["cancelReason"] = "unknown") {
    const a = this.attempt;
    if (!a || a.cancelled) return;
    a.cancelReason ??= reason;
    a.cancelled = true; this.clearBudgetTimer(a.deadline); a.abort.abort();
    const live = this.sameSnapshotBranch(a.snapshot, ctx);
    if (live) try { this.report.cancellation(a.id, a.cancelReason); } catch { /* diagnostics only */ }
    this.report.hide(a.id, live);
    if (a.settled) { this.fence(ctx); this.record(a, "cancelled", ctx); }
  }
  stop(ctx: ExtensionContext, reason: Exclude<NonNullable<Attempt["cancelReason"]>, "deadline" | "off" | "unknown">) { const a = this.attempt; if (a && !a.cancelled) a.cancelReason = reason; this.generation++; this.clearNative(ctx); this.cancel(ctx, reason); }
  // On scope exit, a pending physical request cannot safely be attributed to a future session.
  leave(ctx: ExtensionContext) {
    this.cancel(ctx, "scope");
    const a = this.attempt;
    if (a && !a.settled) a.timing.finish("unknown", "scope_left");
    if (a && !a.recorded) this.record(a, "cancelled", ctx); // null usage denotes unknown
    this.reset(ctx);
  }
  diagnoseSchedule(reason: import("./reporting.ts").ScheduleReason, ctx: ExtensionContext, enabled = this.enabled, trigger: ScheduleTrigger = "unknown") {
    try {
      let usage: ReturnType<ExtensionContext["getContextUsage"]> | null | undefined;
      try { usage = ctx.getContextUsage(); } catch { usage = undefined; }
      let effective: ReturnType<typeof settings> = null;
      try { effective = settings(this.pi, ctx); } catch { /* invalid effective settings */ }
      const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? null;
      const reserve = effective?.reserveTokens ?? null;
      const hardLimit = window !== null && reserve !== null ? window - reserve : null;
      const threshold = window !== null && hardLimit !== null ? Math.min(.65 * window, .8 * hardLimit) : null;
      this.report.schedule({ reason, trigger, generation: this.generation, enabled, entry: typeof ctx.mode === "string" ? ctx.mode.slice(0, 16) : "unknown", tokens: usage?.tokens ?? null, window, reserve, threshold, hardLimit });
    } catch { /* diagnostics never affect scheduling */ }
  }
  schedule(ctx: ExtensionContext, trigger: ScheduleTrigger = "unknown") {
    const diagnose = (reason: import("./reporting.ts").ScheduleReason) => this.diagnoseSchedule(reason, ctx, this.enabled, trigger);
    if (!this.enabled) { diagnose("preference_off"); return; }
    if (ctx.mode !== "tui" || this.session !== ctx.sessionManager.getSessionId()) { diagnose("unsupported_entry"); return; }
    if (ctx.signal?.aborted) { diagnose("aborted_context"); return; }
    if (ctx.hasPendingMessages()) { diagnose("pending_input"); return; }
    const s = settings(this.pi, ctx), usage = ctx.getContextUsage();
    if (!ctx.model) { diagnose("no_model"); return; }
    if (!s) { diagnose("effective_settings_unavailable"); return; }
    if (!usage || usage.contextWindow !== ctx.model.contextWindow || usage.tokens === null) { diagnose("unknown_usage"); return; }
    const hard = ctx.model.contextWindow - s.reserveTokens;
    const tokens = usage.tokens;
    if (tokens < Math.min(.65 * ctx.model.contextWindow, .8 * hard)) { diagnose("below_threshold"); return; }
    if (this.attempt && !this.attempt.settled) { diagnose("slot_busy"); return; }
    if (this.attempt?.summary && !this.attempt.cancelled && valid(this.pi, ctx, this.attempt.snapshot)) { diagnose("ready_candidate"); return; }
    if (this.starts >= 2 || (this.lastStart && Date.now() - this.lastStart < 60_000)) { diagnose("cooldown"); return; }
    if (!Number.isFinite(this.lastTokens)) { this.lastTokens = tokens; diagnose("growth"); return; }
    if (this.lastStart && tokens - this.lastTokens < 8000) { diagnose("growth"); return; }
    const snapshot = plan(this.pi, ctx, this.generation);
    if (!snapshot) { diagnose("no_plan"); return; }
    diagnose("started");
    if (this.attempt && !this.attempt.recorded) this.record(this.attempt, "discarded", ctx);
    const abort = new AbortController(), id = crypto.randomUUID();
    const a: Attempt = { id, snapshot, provider: ctx.model.provider, model: ctx.model.id, abort, settled: false, offered: false, cancelled: false, metering: "unknown", nativeFallback: false, boundary: ctx.sessionManager.getLeafId(), recorded: false, deadline: undefined as never, done: Promise.resolve(), timing: undefined as never, deadlineAt: Number.NaN };
    this.attempt = a; this.starts++; this.lastStart = Date.now(); this.lastTokens = tokens;
    this.report.start(id);
    const model = ctx.model, thinking = ctx.thinkingLevel!;
    const message = { role: "user" as const, content: [{ type: "text" as const, text: prompt(snapshot) }], timestamp: Date.now() };
    const options = { reasoning: thinking as Parameters<typeof ctx.modelRegistry.streamSimple>[2] extends infer O ? NonNullable<O> extends { reasoning?: infer R } ? R : never : never, signal: abort.signal, cacheRetention: "none" as const };
    let result: Promise<import("@earendil-works/pi-ai").AssistantMessage>;
    a.timing = this.timing.begin("background_generation", model.id, model.provider);
    let expireDeadline = () => {};
    try {
      a.deadlineAt = this.budgetNow() + GENERATION_BUDGET_MS;
      expireDeadline = () => {
        if (a.settled || a.cancelled) return;
        a.cancelReason = "deadline"; a.cancelled = true;
        try { abort.abort(); } catch { /* best effort */ }
        let live = false;
        if (this.session === snapshot.session) try { live = this.sameSnapshotBranch(snapshot, ctx); } catch { /* disposed */ }
        if (live) try { this.report.cancellation(a.id, "deadline"); } catch { /* diagnostic only */ }
        this.report.hide(id, live);
      };
      a.deadline = this.setBudgetTimer(expireDeadline, GENERATION_BUDGET_MS);
      const stream = ctx.modelRegistry.streamSimple(model, { messages: [message] }, options);
      try { result = stream.result(); }
      catch (error) { a.diagnostic = failureDiagnostic({ attemptId: a.id, stage: "result", reason: "sync_throw", error }); this.observationFailed(ctx, a); return; }
    } catch (error) { a.diagnostic = failureDiagnostic({ attemptId: a.id, stage: "stream_simple", reason: "sync_throw", error }); this.observationFailed(ctx, a); return; }
    try { a.done = result.then(response => {
      // Capture the physical response terminal before inspecting provider-controlled fields.
      const end = a.timing.captureEnd();
      if (this.budgetNow() >= a.deadlineAt) expireDeadline();
      let physicalTimingFinished = false;
      try {
        const stopReason = response?.stopReason;
        const content = response?.content;
        const malformedText = Array.isArray(content) && content.some(c => c?.type === "text" && typeof c.text !== "string");
        const hasText = Array.isArray(content) && content.some(c => c?.type === "text" && typeof c.text === "string" && c.text.trim());
        const legal = Array.isArray(content) && content.every(c => c?.type === "thinking" || (c?.type === "text" && typeof c.text === "string"));
        const responseOutcome = stopReason === "aborted" ? "cancelled" : stopReason === "stop" && legal && hasText ? "completed" : "failed";
        a.timing.finish(responseOutcome, undefined, end);
        physicalTimingFinished = true;
        const measured = metering(response);
        a.metering = measured.status;
        a.usage = measured.usage ?? undefined;
        if (responseOutcome === "failed" || stopReason === "aborted") {
          const reason = stopReason !== "stop" ? "non_stop" : !Array.isArray(content) || malformedText ? "malformed_response" : content.some(c => c?.type !== "text" && c?.type !== "thinking") ? "unexpected_content" : !content.length || !hasText ? (content.some(c => c?.type === "thinking") ? "thinking_only" : "empty_text") : "unexpected_content";
          a.diagnostic = failureDiagnostic({ attemptId: a.id, stage: "response", reason, response });
        }
        if (!a.cancelled && this.enabled && this.generation === snapshot.generation && responseOutcome === "completed") {
          const text = content.map(c => c.type === "text" ? c.text : "").join("\n").trim();
          if (text) a.summary = withFiles(text, snapshot.files);
        }
      } catch (error) {
        // Once completed is recorded, it describes the physical response terminal; a later local
        // processing failure is diagnostic-only and cannot rewrite that already-finished interval.
        if (!physicalTimingFinished) a.timing.finish("failed", undefined, end);
        a.diagnostic = failureDiagnostic({ attemptId: a.id, stage: "response_processing", reason: "processing_error", response, error });
      }
    }, error => {
      // A rejection handler attached to the original result promise observes the physical
      // terminal before any later Promise reaction can be queued ahead of this callback.
      const end = a.timing.captureEnd();
      a.timing.finish("failed", undefined, end);
      a.diagnostic = failureDiagnostic({ attemptId: a.id, stage: "result", reason: "promise_rejected", error });
    }).finally(() => {
      this.clearBudgetTimer(a.deadline); a.settled = true;
      let live = false;
      if (this.session === snapshot.session) try { live = this.sameSnapshotBranch(snapshot, ctx); } catch { /* stale after disposal */ }
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
    }); } catch (error) {
      a.diagnostic = failureDiagnostic({ attemptId: a.id, stage: "result", reason: "sync_throw", error });
      this.observationFailed(ctx, a);
    }
  }
  private observationFailed(ctx: ExtensionContext, a: Attempt) {
    a.timing.finish("unknown", "observation_failed");
    a.cancelled = true;
    this.clearBudgetTimer(a.deadline);
    try { a.abort.abort(); } catch { /* preserve fail-closed slot */ }
    try { this.report.hide(a.id, this.sameSnapshotBranch(a.snapshot, ctx)); } catch { /* diagnostics cannot release or replace the physical slot */ }
    try { if (!a.recorded) this.record(a, "failed", ctx); } catch { /* keep the fail-closed physical slot and continue to the safety notice */ }
    if (!this.observationNoticeSent) {
      this.observationNoticeSent = true;
      this.notify(ctx, "async-compact 后台预生成已停止；原生压缩仍可用；新建/重开会话或 reload 后重新 on 可恢复。", "warning");
    }
  }
  private observationNoticeSent = false;
  async offer(ctx: ExtensionContext, preparation: { tokensBefore: number; firstKeptEntryId: string; isSplitTurn: boolean; settings: { enabled: boolean; reserveTokens: number; keepRecentTokens: number } }, signal: AbortSignal) {
    const a = this.attempt;
    const offerSignal = signal;
    const scopeSignal = ctx.signal;
    if (!this.enabled || !a || a.cancelled || a.offered || this.activeOfferId === a.id || this.session !== ctx.sessionManager.getSessionId() || this.generation !== a.snapshot.generation || offerSignal.aborted || scopeSignal?.aborted) return;
    const validityFailure = (): import("./reporting.ts").ScheduleReason | null => {
      try {
        const current = settings(this.pi, ctx);
        if (!current) return "effective_settings_unavailable";
        if (JSON.stringify(current) !== JSON.stringify(preparation.settings)) return "settings_changed";
        if (ctx.hasPendingMessages()) return "pending_input";
        if (!valid(this.pi, ctx, a.snapshot)) return "invalid_candidate";
        const candidate = a.summary ?? withFiles("x", a.snapshot.files);
        if (!fits(this.pi, ctx, a.snapshot, candidate, preparation.tokensBefore)) return "insufficient_fit";
        return null;
      } catch { return "invalid_candidate"; }
    };
    const initialFailure = validityFailure();
    if (initialFailure) { this.diagnoseSchedule(initialFailure, ctx, this.enabled, "threshold_offer"); return; }
    this.activeOfferId = a.id;
    if (!a.settled) {
      this.report.phase(a.id, "waiting");
      const remaining = Math.max(0, a.deadlineAt - this.budgetNow());
      let timer: ReturnType<typeof setTimeout> | undefined;
      let wakeAbort: (() => void) | undefined;
      const attemptSignal = a.abort.signal;
      const interrupted = new Promise<"interrupted">(resolve => {
        const wake = () => resolve("interrupted");
        wakeAbort = wake;
        offerSignal.addEventListener("abort", wake, { once: true });
        attemptSignal.addEventListener("abort", wake, { once: true });
        scopeSignal?.addEventListener("abort", wake, { once: true });
      });
      const expired = new Promise<"expired">(resolve => { timer = this.setBudgetTimer(() => resolve("expired"), remaining); });
      let result: "done" | "interrupted" | "expired";
      try { result = await Promise.race([a.done.then(() => "done" as const), interrupted, expired]); }
      finally {
        if (timer) this.clearBudgetTimer(timer);
        if (wakeAbort) {
          offerSignal.removeEventListener("abort", wakeAbort);
          attemptSignal.removeEventListener("abort", wakeAbort);
          scopeSignal?.removeEventListener("abort", wakeAbort);
        }
      }
      if (result !== "done" || !a.settled) {
        if (result === "expired") a.cancelReason = "deadline";
        else if (offerSignal.aborted) a.cancelReason = "host";
        else if (scopeSignal?.aborted) a.cancelReason = "scope";
        if (!a.cancelled) this.cancel(ctx, a.cancelReason ?? "unknown");
        if (!offerSignal.aborted && !scopeSignal?.aborted && result === "expired") this.notify(ctx, "async-compact wait budget expired; using native compaction", "info");
        this.activeOfferId = null;
        return a.cancelReason === "user" || a.cancelReason === "host" || a.cancelReason === "scope" ? { cancel: true as const } : undefined;
      }
    }
    const finalFailure = validityFailure();
    if (offerSignal.aborted || scopeSignal?.aborted || a.cancelled || !this.enabled || this.session !== ctx.sessionManager.getSessionId() || this.generation !== a.snapshot.generation || finalFailure || !a.summary) {
      if (finalFailure) this.diagnoseSchedule(finalFailure, ctx, this.enabled, "threshold_offer");
      this.activeOfferId = null; return;
    }
    a.offered = true;
    a.boundary = ctx.sessionManager.getLeafId();
    this.activeOfferId = null;
    return { summary: a.summary, firstKeptEntryId: a.snapshot.cut, tokensBefore: preparation.tokensBefore, usage: a.usage, details: { kind: "async-compact", version: 1, attemptId: a.id, ...a.snapshot.files } };
  }
  canAdopt(ctx: ExtensionContext, preparation: { tokensBefore: number; firstKeptEntryId: string; isSplitTurn: boolean; settings: { enabled: boolean; reserveTokens: number; keepRecentTokens: number } }, compaction: { summary: string; firstKeptEntryId: string }): boolean {
    const a = this.attempt;
    try { return !!a && this.enabled && !a.cancelled && a.offered && this.session === ctx.sessionManager.getSessionId() && this.generation === a.snapshot.generation && compaction.firstKeptEntryId === a.snapshot.cut && !!settings(this.pi, ctx) && JSON.stringify(settings(this.pi, ctx)) === JSON.stringify(preparation.settings) && !ctx.hasPendingMessages() && valid(this.pi, ctx, a.snapshot) && fits(this.pi, ctx, a.snapshot, compaction.summary, preparation.tokensBefore); } catch { return false; }
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
    const details = committed.details;
    const ownsAttempt = !!details && typeof details === "object"
      && (details as Record<string, unknown>).kind === "async-compact"
      && (details as Record<string, unknown>).version === 1
      && (details as Record<string, unknown>).attemptId === a.id
      && Array.isArray((details as Record<string, unknown>).readFiles)
      && ((details as Record<string, unknown>).readFiles as unknown[]).every((path: unknown) => typeof path === "string")
      && JSON.stringify((details as Record<string, unknown>).readFiles) === JSON.stringify(a.snapshot.files.readFiles)
      && Array.isArray((details as Record<string, unknown>).modifiedFiles)
      && ((details as Record<string, unknown>).modifiedFiles as unknown[]).every((path: unknown) => typeof path === "string")
      && JSON.stringify((details as Record<string, unknown>).modifiedFiles) === JSON.stringify(a.snapshot.files.modifiedFiles);
    const adopted = !a.cancelled && a.offered && ownsAttempt
      && committed.firstKeptEntryId === a.snapshot.cut
      && committed.summary === a.summary
      && a.snapshot.session === ctx.sessionManager.getSessionId()
      && a.snapshot.generation === this.generation
      && boundaryIndex >= 0 && fresh?.id === committed.id;
    if (!a.settled) { a.nativeFallback = true; this.cancel(ctx, "native"); } // Keep the physical slot and fence retries after settlement.
    else this.record(a, adopted ? "adopted" : "discarded", ctx);
    if (adopted) this.notify(ctx, "async-compact context updated", "info");
    if (a.settled) this.attempt = null;
    this.afterNative(ctx, !!adopted);
  }
  failed(ctx: ExtensionContext) {
    this.clearNative(ctx);
    const a = this.attempt;
    if (a?.offered) {
      if (!a.settled) this.cancel(ctx, "native");
      else {
        this.record(a, "discarded", ctx);
        this.fence(ctx);
      }
      this.notify(ctx, "async-compact native compaction failed; original context remains", "warning");
      if (a.settled) this.attempt = null;
    }
  }
}
