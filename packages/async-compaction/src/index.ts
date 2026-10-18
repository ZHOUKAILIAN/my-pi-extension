import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { Controller } from "./controller.ts";
import { committedFiles, settings } from "./compaction.ts";
import type { TimingClock } from "./timing.ts";
import { drainLocal } from '@pi/project-metrics/client';

export function isolatedProfile(argv: string[] = process.argv): boolean {
  const flags = argv.slice(2);
  const paths = flags.flatMap((flag, i) => flag === "-e" || flag === "--extension" ? [flags[i + 1]] : []);
  return flags.some(f => f === "-ne" || f === "--no-extensions") && paths.length === 1 && !!paths[0] && /(?:^|\/)async-compaction\/src\/index\.ts$/.test(paths[0]);
}
// Resolve the actual launched CLI binary, not the extension's nested SDK dependency.
export function supportedHost(argv: string[] = process.argv): boolean {
  try {
    const cli = realpathSync(argv[1]);
    const match = cli.match(/^(.*\/[@]earendil-works\/pi-coding-agent)\/dist\/(?:bundle\/)?cli\.js$/);
    if (!match) return false;
    const pkg = JSON.parse(readFileSync(join(match[1], "package.json"), "utf8"));
    return pkg.name === "@earendil-works/pi-coding-agent" && ["1.0.4", "1.1.0"].includes(pkg.version);
  } catch { return false; }
}
export default function extension(pi: ExtensionAPI, dependencies: { timingClock?: TimingClock } = {}) {
  const control = new Controller(pi, dependencies.timingClock);
  const notify = (ctx: { ui: { notify: (message: string, level: "info" | "warning") => void } }, message: string, level: "info" | "warning") => { try { ctx.ui.notify(message, level); } catch { /* diagnostics are best-effort */ } };
  let postRunWindow = false, preflight = false;
  let detachInput: (() => void) | undefined;
  let foreground: { finish: ReturnType<Controller["timing"]["begin"]>["finish"]; captureEnd: ReturnType<Controller["timing"]["begin"]>["captureEnd"]; session: string; epoch: number } | null = null;
  pi.registerCommand("async-compact", {
    description: "Enable or disable background compaction for this main TUI session",
    handler: async (args, ctx) => {
      const value = args.trim();
      if (value !== "on" && value !== "off") { notify(ctx, "Usage: /async-compact on|off", "warning"); return; }
      if (ctx.mode !== "tui" || !isolatedProfile() || !supportedHost()) { notify(ctx, "async-compact requires a supported Pi 1.0.4/1.1.0 main TUI launched with --no-extensions -e packages/async-compaction/src/index.ts; native compaction remains active", "warning"); return; }
      control.set(value === "on", ctx);
      if (value === "on" && !detachInput) detachInput = ctx.ui.onTerminalInput(data => { if (matchesKey(data, Key.escape) && control.isEnabled) control.stop(ctx); return undefined; });
      if (value === "off") { detachInput?.(); detachInput = undefined; }
      const unsupported = value === "on" && ctx.model && !settings(pi, ctx);
      notify(ctx, unsupported ? "async-compact on: current model or automatic compaction unsupported; native compaction remains active" : `async-compact ${value}`, unsupported ? "warning" : "info");
    },
  });
  const leave = (_event: unknown, ctx: Parameters<Controller["leave"]>[0]) => { const old = foreground; foreground = null; if (old && old.session === ctx.sessionManager.getSessionId() && old.epoch === control.timing.epoch) old.finish("unknown", "scope_left"); postRunWindow = false; preflight = false; control.leave(ctx); detachInput?.(); detachInput = undefined; };
  pi.on("session_before_switch", leave);
  pi.on("session_before_fork", leave);
  pi.on("session_before_tree", leave);
  pi.on("session_shutdown", async (event, ctx) => {
    const started = Date.now();
    try { leave(event, ctx); }
    finally {
      control.timing.closeMetricScope();
      await drainLocal(Math.max(0, 1000 - (Date.now() - started)));
    }
  });
  pi.on("session_start", (_event, ctx) => { foreground = null; postRunWindow = false; preflight = false; control.reset(ctx); });
  pi.on("input", () => { preflight = true; postRunWindow = false; });
  pi.on("agent_start", () => { preflight = false; postRunWindow = false; });
  pi.on("agent_end", (event, ctx) => { postRunWindow = true; if (event.messages.some(m => m.role === "assistant" && m.stopReason === "aborted")) control.stop(ctx); });
  pi.on("agent_settled", () => { postRunWindow = false; });
  pi.on("turn_end", (event, ctx) => { if (event.message.role === "assistant" && event.message.stopReason === "stop") control.schedule(ctx); });
  pi.on("session_before_compact", async (event, ctx) => {
    const startStamp = event.reason === "threshold" && control.isEnabled ? control.timing.capture() : null;
    const eligible = !!startStamp && ctx.mode === "tui" && isolatedProfile() && supportedHost();
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
    if (event.reason !== "threshold") { control.stop(ctx); return; }
    if (ctx.mode !== "tui" || !isolatedProfile() || !supportedHost()) return;
    if (!postRunWindow || preflight) {
      if (!event.signal.aborted) control.fallback(ctx);
      return; // Preflight cannot offer a candidate; Pi still owns native compaction.
    }
    const compaction = await control.offer(ctx, event.preparation, event.signal);
    if (!compaction && !event.signal.aborted) control.fallback(ctx);
    return compaction ? { compaction } : undefined;
  });
  pi.on("session_compact", (event, ctx) => {
    const pending = foreground, end = pending?.captureEnd();
    if (pending && pending.session === ctx.sessionManager.getSessionId() && pending.epoch === control.timing.epoch) { foreground = null; pending.finish("completed", undefined, end); }
    control.compact(ctx, event.compactionEntry);
  });
  pi.on("session_compact_failed", (event, ctx) => {
    const pending = foreground, end = pending?.captureEnd();
    if (pending && pending.session === ctx.sessionManager.getSessionId() && pending.epoch === control.timing.epoch) { foreground = null; pending.finish(event.aborted ? "cancelled" : "failed", undefined, end); }
    control.failed(ctx);
  });
}
