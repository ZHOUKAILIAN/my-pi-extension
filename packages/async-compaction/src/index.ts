import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { buildSessionProjection, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readMachinePreference, readMachinePreferenceSync, readMachineBudget, updateMachinePreference, settingsFile } from './machine-settings.ts';
import { installCompactionDurationObserver } from './duration.ts';
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { Controller, type BudgetClock } from "./controller.ts";
import { committedFiles, settings } from "./compaction.ts";
import type { TimingClock } from "./timing.ts";
import { hasCompletedToolTurn } from "./tool-turn.ts";
import { drainLocal, noteMetricFailure, shutdownDeadline } from '@pi/project-metrics/client';

export function isolatedProfile(argv: string[] = process.argv): boolean {
  const flags = argv.slice(2);
  const paths = flags.flatMap((flag, i) => flag === "-e" || flag === "--extension" ? [flags[i + 1]] : []);
  return flags.some(f => f === "-ne" || f === "--no-extensions") && paths.length === 1 && !!paths[0] && /(?:^|\/)async-compaction\/src\/index\.ts$/.test(paths[0]);
}
// Resolve the actual launched CLI binary, not the extension's nested SDK dependency.
export function supportedHost(argv: string[] = process.argv): boolean {
  try {
    const cli = realpathSync(argv[1]);
    if (!cli.endsWith('/dist/cli.js') && !cli.endsWith('/dist/bundle/cli.js')) return false;
    const packageRoot = cli.split('/dist/')[0];
    const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
    if (pkg.name !== "@earendil-works/pi-coding-agent") return false;
    const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(String(pkg.version));
    if (!match) return false;
    const major = Number(match[1]), minor = Number(match[2]);
    const patch = Number(match[3]);
    return major === 1 && minor < 2 && (minor > 0 || patch >= 4);
  } catch { return false; }
}
export type ManagedExtensionContext = { settingsFile: string; agentType: 'main' | 'subagent' | 'unknown' };
type ManagedCleanup = { shutdown(deadline: number): Promise<void> };
type ManagedFactory = ((pi: ExtensionAPI) => void | Promise<void>) & { managedShutdown?: (deadline: number) => Promise<void> };
export function createManagedExtensionFactory(context: ManagedExtensionContext): ManagedFactory {
  const generations = new Set<ManagedCleanup>();
  const factory = ((pi: ExtensionAPI) => {
    const cleanup = extension(pi, { settingsFile: context.settingsFile, agentType: context.agentType });
    generations.add(cleanup);
  }) as ManagedFactory;
  factory.managedShutdown = async (deadline) => {
    let firstError: unknown;
    for (const cleanup of [...generations]) {
      try { await cleanup.shutdown(deadline); } catch (error) { firstError ??= error; }
    }
    if (firstError !== undefined) throw firstError;
  };
  return factory;
}
export default function extension(pi: ExtensionAPI, dependencies: { timingClock?: TimingClock; budgetClock?: BudgetClock; submitMetric?: typeof import('@pi/project-metrics/client').submitMetric; settingsFile?: string; agentType?: 'main' | 'subagent' | 'unknown' } = {}) {
  const control = new Controller(pi, dependencies.timingClock, { submitMetric: dependencies.submitMetric, agentType: dependencies.agentType }, dependencies.budgetClock);
  const duration = installCompactionDurationObserver(pi);
  const machinePreferenceFile = settingsFile(dependencies.settingsFile);
  let requested = false;
  let observed: boolean | undefined;
  let budgetNoticeShown = false;
  let preferenceQueue: Promise<unknown> = Promise.resolve();
  // Normal main TUI is the supported entry; this is not an isolated-profile
  // development hook. The command remains explicitly user-controlled.
  const preferenceGate = (_ctx: { mode: string }) => supportedHost();
  const applyPreference = (requested: boolean, ctx: any) => {
    let firstError: unknown;
    try { control.set(requested, ctx); } catch (error) { firstError = error; }
    try {
      if (!requested) { detachInput?.(); detachInput = undefined; }
      else if (!detachInput && ctx.mode === 'tui' && typeof ctx.ui.onTerminalInput === 'function') detachInput = ctx.ui.onTerminalInput((data: string) => { if (matchesKey(data, Key.escape) && control.isEnabled) control.stop(ctx, "user"); return undefined; });
    } catch (error) { firstError ??= error; }
    if (firstError !== undefined) throw firstError;
  };
  const refreshPreference = async (ctx: any, initialize = false) => {
    const result = await readMachinePreference('asyncCompaction', machinePreferenceFile);
    if (!result.valid) { requested = false; observed = undefined; applyPreference(false, ctx); return { requested: false, readFailed: true, changed: false, saved: false }; }
    const value = result.value ?? false;
    const changed = observed !== undefined && observed !== value;
    observed = value; requested = value;
    applyPreference(value, ctx);
    return { requested: value, readFailed: false, changed, saved: true };
  };
  const refreshPreferenceSync = (ctx: any): boolean => {
    const result = readMachinePreferenceSync('asyncCompaction', machinePreferenceFile);
    if (!result.valid) { requested = false; applyPreference(false, ctx); return false; }
    requested = result.value ?? false; observed = requested; applyPreference(requested, ctx); return true;
  };
  const notify = (ctx: { ui: { notify: (message: string, level: "info" | "warning") => void } }, message: string, level: "info" | "warning") => { try { ctx.ui.notify(message, level); } catch { /* diagnostics are best-effort */ } };
  let preflight = false, durationEnabled = false;
  let detachInput: (() => void) | undefined;
  let foreground: { finish: ReturnType<Controller["timing"]["begin"]>["finish"]; captureEnd: ReturnType<Controller["timing"]["begin"]>["captureEnd"]; session: string; epoch: number } | null = null;
  let closed = false;
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (deadline: number): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    closed = true;
    shutdownPromise = (async () => {
      try { if (lastContext) leave(undefined, lastContext); } catch { /* lifecycle fence is still applied below */ }
      control.shutdown(lastContext);
      duration.leave(lastContext);
      control.timing.closeMetricScope();
      await drainLocal(Math.max(0, deadline - performance.now()));
      if (performance.now() >= deadline) noteMetricFailure();
    })();
    return shutdownPromise;
  };
  let lastContext: any;
  pi.registerCommand("async-compact", {
    description: "Enable or disable background compaction for this main TUI session",
    handler: async (args, ctx) => {
      const value = args.trim();
      if (value !== "on" && value !== "off") { notify(ctx, "Usage: /async-compact on|off", "warning"); return; }
      if (ctx.mode !== 'tui') { notify(ctx, "async-compact can change the machine setting only from the main TUI", "warning"); return; }
      if (!supportedHost()) { notify(ctx, "async-compact is unavailable on this host; native compaction remains active", "warning"); return; }
      let firstError: unknown;
      await (preferenceQueue = preferenceQueue.then(async () => {
        const disk = await readMachinePreference('asyncCompaction', machinePreferenceFile);
        const before = requested;
        if (disk.valid) { requested = disk.value ?? false; observed = requested; applyPreference(requested, ctx); } else { requested = false; applyPreference(false, ctx); }
        const target = value === 'on';
        try { applyPreference(target, ctx); } catch (error) { firstError ??= error; }
        const saved = await updateMachinePreference('asyncCompaction', target, machinePreferenceFile);
        if (saved.saved) { requested = target; observed = target; }
        else notify(ctx, "async-compact is active only in this instance; local preference could not be confirmed", "warning");
        const unsupported = target && (!ctx.model || !settings(pi, ctx));
        notify(ctx, unsupported ? "async-compact preference is On; current model or automatic compaction is unsupported, native compaction remains active" : `async-compact ${value}`, unsupported ? "warning" : "info");
      }).catch((error) => { firstError ??= error; }));
      if (firstError !== undefined) throw firstError;
    },
  });
  const leave = (_event: unknown, ctx: Parameters<Controller["leave"]>[0]) => { lastContext = ctx; const old = foreground; foreground = null; if (old && old.session === ctx.sessionManager.getSessionId() && old.epoch === control.timing.epoch) old.finish("unknown", "scope_left"); duration.leave(ctx); preflight = false; control.leave(ctx); detachInput?.(); detachInput = undefined; };
  pi.on("session_shutdown", async (event, ctx) => {
    lastContext = ctx;
    await shutdown(shutdownDeadline(event as object, 1000));
  });
  pi.on("session_start", async (_event, ctx) => { foreground = null; preflight = false; durationEnabled = true; try { duration.setBranch(ctx, true); } catch {} control.reset(ctx); await refreshPreference(ctx, true); });
  pi.on("input", async (_event, ctx) => { await refreshPreference(ctx); preflight = true; });
  pi.on("session_tree", async (_event, ctx) => { try { duration.tree(ctx, durationEnabled); } catch { /* diagnostics cannot affect navigation */ } foreground = null; preflight = false; control.resetTree(ctx); await refreshPreference(ctx, true); });
  pi.on("agent_start", () => { preflight = false; });
  pi.on("turn_start", async (_event, ctx) => { await refreshPreference(ctx); });
  pi.on("agent_end", (event, ctx) => { if (event.messages.some(m => m.role === "assistant" && m.stopReason === "aborted")) control.stop(ctx, ctx.signal?.aborted ? "scope" : "host"); });
  pi.on("turn_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const reason = event.message.stopReason;
    const stopTurn = reason === "stop";
    const completedToolTurn = reason === "toolUse"
      && hasCompletedToolTurn(event as any, ctx.sessionManager.getBranch());
    const trigger = stopTurn ? "assistant_stop" : completedToolTurn ? "completed_tool_turn" : "unknown";
    const preference = await refreshPreference(ctx);
    if (preference.readFailed) { control.diagnoseSchedule("preference_read_failed", ctx, false, trigger); return; }
    if (!requested) { control.diagnoseSchedule("preference_off", ctx, false, trigger); return; }
    if (!preferenceGate(ctx) || ctx.mode !== "tui") { control.diagnoseSchedule("unsupported_entry", ctx, true, trigger); return; }
    if (reason === "aborted") { control.diagnoseSchedule("aborted_turn", ctx, true, trigger); return; }
    if (reason !== "stop" && reason !== "toolUse") { control.diagnoseSchedule("failed_turn", ctx, true, trigger); return; }
    if (!stopTurn && !completedToolTurn) { control.diagnoseSchedule("incomplete_turn", ctx, true, trigger); return; }
    const budget = await readMachineBudget(machinePreferenceFile);
    if (!budget.fileValid) {
      requested = false; observed = undefined;
      try { applyPreference(false, ctx); } catch { /* preserve Off/fence even if terminal input wiring fails */ }
      control.diagnoseSchedule("preference_read_failed", ctx, false, trigger); return;
    }
    if (!budget.enabledValid || budget.enabled !== true) {
      requested = false; observed = budget.enabledValid ? false : undefined;
      try { applyPreference(false, ctx); } catch { /* preserve Off/fence */ }
      control.diagnoseSchedule(budget.enabledValid ? "preference_off" : "preference_read_failed", ctx, false, trigger); return;
    }
    if (!budget.valid) {
      control.diagnoseSchedule("invalid_budget", ctx, true, trigger);
      if (!budgetNoticeShown) { budgetNoticeShown = true; notify(ctx, "async-compact timeout setting is invalid; native compaction remains available", "warning"); }
      return;
    }
    budgetNoticeShown = false;
    control.schedule(ctx, trigger, budget.milliseconds);
  });
  pi.on("session_before_compact", async (event, ctx) => {
    if (durationEnabled) { try { duration.before(event, ctx); } catch { /* diagnostic only */ } }
    let preferenceOk = false; try { preferenceOk = refreshPreferenceSync(ctx); } catch { preferenceOk = false; }
    const startStamp = event.reason === "threshold" && control.isEnabled && preferenceOk ? control.timing.capture() : null;
    const eligible = !!startStamp;
    const gateAtEntry = preferenceGate(ctx);
    const gateBeforeOffer = preferenceGate(ctx);
    const session = ctx.sessionManager.getSessionId(), epoch = control.timing.epoch;
    if (eligible && (!foreground || foreground.session !== session || foreground.epoch !== epoch)) {
      const started = control.timing.begin("foreground_compaction", ctx.model?.id ?? null, ctx.model?.provider ?? null, startStamp!);
      foreground = { finish: started.finish, captureEnd: started.captureEnd, session, epoch };
    }
    // The host skips fromHook details when preparing native fileOps. This public, non-context
    // preparation is mutable; the host still owns generation and the final session append.
    const previous = ctx.sessionManager.getBranch().filter(e => e.type === "compaction").at(-1);
    const files = committedFiles(previous);
    if (files) {
      for (const path of files.readFiles) event.preparation.fileOps.read.add(path);
      for (const path of files.modifiedFiles) event.preparation.fileOps.edited.add(path);
    }
    let preparedProjection: string | null = null;
    try {
      const preparedEntries = Array.isArray(event.branchEntries) ? event.branchEntries : ctx.sessionManager.getBranch();
      preparedProjection = JSON.stringify(buildSessionProjection(preparedEntries).messages);
    } catch { /* fail closed at the final hook result */ }
    const nativePreparationStale = () => {
      if (preparedProjection === null) return true;
      try { return JSON.stringify(ctx.sessionManager.buildSessionProjection().messages) !== preparedProjection; } catch { return true; }
    };
    if (event.reason !== "threshold") { control.stop(ctx, "native"); return; }
    if (!preferenceOk) { control.diagnoseSchedule("preference_read_failed", ctx, false, "threshold_offer"); return; }
    if (!requested) { control.diagnoseSchedule("preference_off", ctx, false, "threshold_offer"); return; }
    if (!gateAtEntry || !gateBeforeOffer || ctx.mode !== "tui") { control.diagnoseSchedule("unsupported_entry", ctx, true, "threshold_offer"); return; }
    if (event.signal.aborted || ctx.signal?.aborted) { control.diagnoseSchedule("aborted_context", ctx, true, "threshold_offer"); return { cancel: true }; }
    if (preflight) {
      control.diagnoseSchedule("preflight_input", ctx, true, "threshold_offer");
      if (!event.signal.aborted) control.fallback(ctx);
      return; // Unmaterialized input cannot be budgeted; Pi still owns native compaction.
    }
    const compaction = await control.offer(ctx, event.preparation, event.signal);
    if (compaction && "cancel" in compaction) return compaction;
    if (nativePreparationStale()) return { cancel: true };
    if (!compaction && !event.signal.aborted) control.fallback(ctx);
    if (!compaction) {
      // Keep the final preparation guard even when Async has no candidate. This
      // permits native fallback on unchanged history but rejects stale host input
      // if a later hook edits the live model projection.
      return { get cancel() { return nativePreparationStale(); } };
    }
    let decided = false;
    let decision: typeof compaction | undefined;
    return {
      // The runner reads `cancel` once after each handler and the host reads it again
      // after all handlers. Re-evaluate against the host's original branch snapshot so
      // a later context edit cannot fall through to native compaction with stale prep.
      get cancel() { return nativePreparationStale(); },
      get compaction() {
        if (nativePreparationStale()) return undefined;
        if (decided) return decision;
        decided = true;
        try {
          const can = refreshPreferenceSync(ctx) && requested && control.canAdopt?.(ctx, event.preparation, compaction); if (can) decision = compaction;
        } catch { decision = undefined; }
        return decision;
      },
    };
  });
  pi.on("session_compact", (event, ctx) => {
    const pending = foreground, end = pending?.captureEnd();
    const durationEnd = duration.captureEnd();
    let adoptedAttemptId: string | null = null;
    try { adoptedAttemptId = control.compact(ctx, event.compactionEntry) ?? null; } catch { /* controller bookkeeping is isolated from observer */ }
    try { duration.compact(event, ctx, adoptedAttemptId, durationEnd); } catch { /* diagnostic only */ }
    if (pending && pending.session === ctx.sessionManager.getSessionId() && pending.epoch === control.timing.epoch) { foreground = null; pending.finish("completed", undefined, end); }
  });
  pi.on("session_compact_failed", (event, ctx) => {
    const pending = foreground, end = pending?.captureEnd();
    const durationEnd = duration.captureEnd();
    control.failed(ctx);
    try { duration.failed(event, ctx, durationEnd); } catch { /* diagnostic only */ }
    if (pending && pending.session === ctx.sessionManager.getSessionId() && pending.epoch === control.timing.epoch) { foreground = null; pending.finish(event.aborted ? "cancelled" : "failed", undefined, end); }
  });
  return { shutdown };
}
