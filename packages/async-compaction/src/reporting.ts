import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";

export type Metering = "reported" | "partial" | "unknown";
// SDK error/abort messages may carry a synthetic all-zero Usage. Only positive
// metering is evidence of a charge; error/abort cannot prove a final total.
export function metering(response: Pick<AssistantMessage, "stopReason" | "usage">): { status: Metering; usage: Usage | null } {
  const u = response.usage;
  if (!u || ![u.input, u.output, u.cacheRead, u.cacheWrite, u.totalTokens, u.cost?.input, u.cost?.output, u.cost?.cacheRead, u.cost?.cacheWrite, u.cost?.total].some(n => typeof n === "number" && Number.isFinite(n) && n > 0)) return { status: "unknown", usage: null };
  const usage: Usage = { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, totalTokens: u.totalTokens, cost: { input: u.cost.input, output: u.cost.output, cacheRead: u.cost.cacheRead, cacheWrite: u.cost.cacheWrite, total: u.cost.total } };
  if (u.cacheWrite1h !== undefined) usage.cacheWrite1h = u.cacheWrite1h;
  if (u.reasoning !== undefined) usage.reasoning = u.reasoning;
  return { status: ["stop", "length", "toolUse"].includes(response.stopReason) ? "reported" : "partial", usage };
}

export type Outcome = "adopted" | "discarded" | "failed" | "cancelled";
export type RecordData = { attemptId: string; model: string; provider: string; outcome: Outcome; metering: Metering; usage: Usage | null; includedInNativeTotals: boolean };
export type Phase = "generating" | "waiting" | "fallback";
export class Reporting {
  private active = new Map<string, { phase: Phase; revision: number }>();
  private recorded = new Set<string>();
  private pi: ExtensionAPI;
  private append(type: string, data: unknown) { try { this.pi.appendEntry(type, data); } catch { /* diagnostics are best-effort and never alter compaction */ } }
  constructor(pi: ExtensionAPI) {
    this.pi = pi;
    pi.registerEntryRenderer<{ attemptId: string; revision: number }>("async-compact-progress", entry => ({ render: width => {
      const state = this.active.get(entry.data?.attemptId ?? "");
      return state && state.revision === entry.data?.revision ? [`async-compact ${state.phase === "generating" ? "generating" : state.phase === "waiting" ? "waiting for background summary" : "native fallback"}`.slice(0, width)] : [];
    }, invalidate() {} }));
    pi.registerEntryRenderer<RecordData>("async-compact-usage", (entry, options, theme) => {
      const data = entry.data;
      const label = `async-compact ${data?.outcome ?? "unknown"}: ${data?.metering === "reported" ? "usage reported" : data?.metering === "partial" ? "usage partial (remainder unknown)" : "usage unknown"} (${data?.includedInNativeTotals ? "native totals" : "extra"})`;
      const u = data?.usage;
      const number = (n: number | undefined) => typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-US") : "?";
      const cost = (n: number | undefined) => typeof n === "number" && Number.isFinite(n) ? `$${n.toFixed(6)}` : "?";
      const totals = u ? `tokens ${number(u.totalTokens)} (input ${number(u.input)}, output ${number(u.output)}, cache read ${number(u.cacheRead)}, cache write ${number(u.cacheWrite)}); SDK estimated cost ${cost(u.cost?.total)}` : "";
      const detail = u && options?.expanded ? `\n  SDK estimated cost input ${cost(u.cost?.input)}, output ${cost(u.cost?.output)}, cache read ${cost(u.cost?.cacheRead)}, cache write ${cost(u.cost?.cacheWrite)}${u.reasoning !== undefined ? `; reasoning ${number(u.reasoning)} (included in output)` : ""}${u.cacheWrite1h !== undefined ? `; 1h cache write ${number(u.cacheWrite1h)} (included in cache write)` : ""}` : "";
      return new Text(theme.fg("muted", `${label}${totals ? ` — ${totals}` : ""}${detail}`), 0, 0);
    });
  }
  start(id: string) { this.phase(id, "generating"); }
  phase(id: string, phase: Phase) {
    const revision = (this.active.get(id)?.revision ?? 0) + 1;
    this.active.set(id, { phase, revision });
    this.append("async-compact-progress", { attemptId: id, revision });
  }
  finish(data: RecordData) {
    this.hide(data.attemptId);

    if (this.recorded.has(data.attemptId)) return;
    this.recorded.add(data.attemptId);
    this.append("async-compact-usage", data);
  }
  hide(id: string, refresh = false) {
    if (!this.active.delete(id)) return;
    // A context-free entry causes InteractiveMode to render immediately, even without another user event.
    if (refresh) this.append("async-compact-progress", { attemptId: id, revision: 0 });
  }
}
