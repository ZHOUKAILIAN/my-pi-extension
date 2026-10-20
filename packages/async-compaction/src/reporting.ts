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
export type FailureStage = "response" | "stream_simple" | "result" | "response_processing";
export type FailureReason = "non_stop" | "empty_text" | "thinking_only" | "unexpected_content" | "sync_throw" | "promise_rejected" | "malformed_response" | "processing_error" | "unknown";
export type FailureDiagnostic = {
  schemaVersion: 1;
  attemptId: string;
  stage: FailureStage;
  reason: FailureReason;
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted" | "other" | "unknown";
  content: { count: number | null; types: Record<string, number>; textLength: number | null; truncated: boolean } | null;
  errorCategory: string | null;
  httpStatus: number | null;
};
function buildFailureDiagnostic(input: {
  attemptId: string; stage: FailureStage; reason: FailureReason; response?: unknown; error?: unknown;
}): FailureDiagnostic {
  const bounded = (value: unknown, max: number): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(Math.floor(value), max) : null;
  const read = (value: unknown, key: string): unknown => { try { return value != null ? (value as Record<string, unknown>)[key] : undefined; } catch { return undefined; } };
  const rawReason = read(input.response, "stopReason");
  const stopReason = (["stop", "length", "toolUse", "error", "aborted"] as unknown[]).includes(rawReason) ? rawReason as FailureDiagnostic["stopReason"] : input.response == null ? "unknown" : rawReason === undefined ? "unknown" : "other";
  let content: FailureDiagnostic["content"] = null;
  const rawContent = read(input.response, "content");
  if (Array.isArray(rawContent)) {
    try {
      const types: Record<string, number> = {};
      let totalText = 0, textKnown = true, textTruncated = false;
      for (let i = 0; i < Math.min(rawContent.length, 256); i++) {
        const block = rawContent[i], rawType = read(block, "type");
        const type = (["text", "thinking", "toolCall", "image", "audio", "video", "document", "custom"] as unknown[]).includes(rawType) ? rawType as string : "unknown";
        types[type] = Math.min((types[type] ?? 0) + 1, 256);
        if (type === "text") { const text = read(block, "text"); if (typeof text === "string") { if (totalText + text.length > 1_000_000) { textKnown = false; textTruncated = true; } else totalText += text.length; } else textKnown = false; }
      }
      const truncated = rawContent.length > 256 || textTruncated;
      content = { count: truncated ? null : bounded(rawContent.length, 256), types, textLength: textKnown && !truncated ? totalText : null, truncated };
    } catch { content = null; }
  }
  const rawName = read(input.error, "name"), rawCode = read(input.error, "code");
  const knownErrors = new Set(["AbortError", "TimeoutError", "NetworkError", "RateLimitError", "AuthenticationError", "InvalidRequestError", "ProviderError"]);
  const knownCodes = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"]);
  const rawStatus = read(input.error, "status") ?? read(input.error, "statusCode");
  const whitelistedStatus = typeof rawStatus === "number" && Number.isInteger(rawStatus) && (new Set([400, 401, 403, 404, 408, 409, 413, 422, 429]).has(rawStatus) || (rawStatus >= 500 && rawStatus <= 599));
  return {
    schemaVersion: 1, attemptId: input.attemptId, stage: input.stage, reason: input.reason, stopReason,
    content, errorCategory: typeof rawName === "string" && knownErrors.has(rawName) ? rawName : typeof rawCode === "string" && knownCodes.has(rawCode) ? rawCode : input.error == null ? null : "unknown",
    httpStatus: whitelistedStatus ? rawStatus as number : null,
  };
}
export function failureDiagnostic(input: Parameters<typeof buildFailureDiagnostic>[0]): FailureDiagnostic {
  try { return buildFailureDiagnostic(input); }
  catch {
    // Diagnostic extraction must never replace the physical result or interrupt finalization.
    return { schemaVersion: 1, attemptId: input.attemptId, stage: input.stage, reason: input.reason, stopReason: "unknown", content: null, errorCategory: input.error == null ? null : "unknown", httpStatus: null };
  }
}
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
    pi.registerEntryRenderer<FailureDiagnostic>("async-compact-failure", entry => ({ render: width => {
      const d = entry.data;
      if (!d || d.schemaVersion !== 1 || typeof d.attemptId !== "string") return [];
      const allowed = (values: readonly string[], value: unknown): string => typeof value === "string" && values.includes(value) ? value : "unknown";
      const stage = allowed(["response", "stream_simple", "result", "response_processing"], d.stage);
      const reason = allowed(["non_stop", "empty_text", "thinking_only", "unexpected_content", "sync_throw", "promise_rejected", "malformed_response", "processing_error", "unknown"], d.reason);
      const stop = allowed(["stop", "length", "toolUse", "error", "aborted", "other", "unknown"], d.stopReason);
      const text = `async-compact failure: ${stage}/${reason}; stop=${stop}`;
      return [text.slice(0, Math.max(0, width))];
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
  finish(data: RecordData, diagnostic?: FailureDiagnostic) {
    this.hide(data.attemptId);

    if (this.recorded.has(data.attemptId)) return;
    this.recorded.add(data.attemptId);
    this.append("async-compact-usage", data);
    if (diagnostic) this.append("async-compact-failure", diagnostic);
  }
  hide(id: string, refresh = false) {
    if (!this.active.delete(id)) return;
    // A context-free entry causes InteractiveMode to render immediately, even without another user event.
    if (refresh) this.append("async-compact-progress", { attemptId: id, revision: 0 });
  }
}
