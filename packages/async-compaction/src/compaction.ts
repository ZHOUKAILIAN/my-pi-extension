import { createHash } from "node:crypto";
import { SettingsManager, SessionManager, convertToLlm, estimateTokens, serializeConversation } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, ExtensionAPI, SessionProjection } from "@earendil-works/pi-coding-agent";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const content = (messages: SessionProjection["messages"]) => messages.map(m => ({ role: m.role, content: ("content" in m ? m.content : null), ...(m.role === "toolResult" ? { toolCallId: m.toolCallId, toolName: m.toolName, isError: m.isError, nestedCalls: m.nestedCalls } : {}) }));
export type FileLists = { readFiles: string[]; modifiedFiles: string[] };
// Only our committed, versioned hook details may bridge the host's fromHook fileOps gap.
export function committedFiles(entry: { fromHook?: boolean; details?: unknown } | undefined): FileLists | null {
  if (!entry?.fromHook || !entry.details || typeof entry.details !== "object") return null;
  const d = entry.details as Record<string, unknown>;
  if (d.kind !== "async-compact" || d.version !== 1 || typeof d.attemptId !== "string" || !d.attemptId ||
      !Array.isArray(d.readFiles) || !d.readFiles.every(p => typeof p === "string" && !!p) ||
      !Array.isArray(d.modifiedFiles) || !d.modifiedFiles.every(p => typeof p === "string" && !!p)) return null;
  return { readFiles: d.readFiles, modifiedFiles: d.modifiedFiles };
}
export type Snapshot = { session: string; generation: number; cut: string; ids: string[]; hash: string; previous: string | null; environment: string; messages: SessionProjection["messages"]; files: FileLists; tokens: number };
export function environment(pi: ExtensionAPI, ctx: ExtensionContext): string | null {
  if (!ctx.model || !ctx.thinkingLevel) return null;
  const tools = pi.getAllTools().filter(t => pi.getActiveTools().includes(t.name));
  return digest({ model: ctx.model, thinking: ctx.thinkingLevel, system: ctx.getSystemPrompt(), tools, compaction: pi.getSettings().compaction });
}
export function settings(pi: ExtensionAPI, ctx: ExtensionContext) {
  const model = ctx.model;
  if (!model || model.api === "pi-virtual" || !Number.isFinite(model.contextWindow)) return null;
  try {
    const effective = SettingsManager.inMemory(pi.getSettings()).getCompactionSettings(model);
    if (!effective.enabled || !Number.isSafeInteger(effective.reserveTokens) || !Number.isSafeInteger(effective.keepRecentTokens) || effective.reserveTokens <= 0 || effective.keepRecentTokens < 0 || effective.reserveTokens >= model.contextWindow) return null;
    return effective;
  } catch { return null; }
}
// Operate on the effective projection: edits and earlier compactions have already been applied.
// Previous file lists are carried even when the previous summary was supplied by a hook.
export function filesIn(messages: SessionProjection["messages"], previous?: unknown): FileLists {
  const read = new Set<string>(), modified = new Set<string>();
  const details = previous && typeof previous === "object" ? previous as Partial<FileLists> : null;
  for (const p of details && Array.isArray(details.readFiles) ? details.readFiles : []) if (typeof p === "string") read.add(p);
  for (const p of details && Array.isArray(details.modifiedFiles) ? details.modifiedFiles : []) if (typeof p === "string") modified.add(p);
  const add = (name: unknown, args: unknown) => {
    const path = args && typeof args === "object" && "path" in args ? args.path : null;
    if (typeof path !== "string" || !path) return;
    if (name === "read") read.add(path);
    if (name === "write" || name === "edit") modified.add(path);
  };
  for (const m of messages) {
    if (m.role === "assistant") for (const block of m.content) if (block.type === "toolCall") add(block.name, block.arguments);
    if (m.role === "toolResult") for (const call of m.nestedCalls?.calls ?? []) add(call.name, call.arguments);
  }
  return { readFiles: [...read].filter(p => !modified.has(p)).sort(), modifiedFiles: [...modified].sort() };
}
export function plan(pi: ExtensionAPI, ctx: ExtensionContext, generation: number): Snapshot | null {
  const s = settings(pi, ctx), env = environment(pi, ctx);
  if (!s || !env || ctx.hasPendingMessages()) return null;
  const branch = ctx.sessionManager.getBranch(), projection = ctx.sessionManager.buildSessionProjection();
  const entries = projection.entries;
  if (!textOnly(projection.messages) || !entries.length || !ctx.model) return null;
  const last = branch.filter(e => e.type === "compaction").at(-1);
  const weights = entries.map(e => e.messages.reduce((n, m) => n + estimateTokens(m), 0));
  const total = weights.reduce((n, value) => n + value, 0);
  const overhead = contextOverhead(pi, ctx);
  // A compaction carries the current system checkpoint forward even when its
  // source entry precedes the cut. Other system entries in the tail are omitted.
  const retainedSystem = [...projection.messages].reverse().find(m => m.role === "system");
  const systemTokens = retainedSystem ? estimateTokens(retainedSystem) : 0;
  let tailSystemTokens = projection.messages.filter(m => m.role === "system").reduce((n, m) => n + estimateTokens(m), 0);
  const minimumSummaryTokens = summaryTokens("x");
  const tokensBefore = ctx.getContextUsage()?.tokens;
  if (tokensBefore == null || !Number.isFinite(tokensBefore)) return null;
  let covered = 0, seenUser = false, seenAssistant = false, tailAssistants = entries.reduce((n, e) => n + e.messages.filter(m => m.role === "assistant").length, 0);
  let safe = true, end: SessionProjection["messages"][number] | undefined;
  let selected = -1, selectedTokens = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const tail = total - covered;
    // The smallest non-empty summary still has the host's fixed wrapper. Include
    // the retained system checkpoint instead of treating it as reclaimed space.
    const minimumAfter = tail - tailSystemTokens + systemTokens + minimumSummaryTokens + overhead;
    if (i && i < entries.length - 1 && safe && seenUser && seenAssistant && tailAssistants &&
        e.sourceEntry.type === "message" && e.messages[0]?.role === "user" &&
        tail >= s.keepRecentTokens && end && !(end.role === "assistant" && end.content.some(c => c.type === "toolCall")) &&
        minimumAfter * 1.1 < ctx.model.contextWindow - s.reserveTokens &&
        tokensBefore - minimumAfter >= Math.max(256, covered / 4)) {
      selected = i; selectedTokens = covered;
    }
    covered += weights[i];
    for (const m of e.messages) {
      if (m.role === "system") tailSystemTokens -= estimateTokens(m);
      if (m.role === "user") seenUser = true;
      if (m.role === "assistant") { seenAssistant = true; tailAssistants--; }
      if (m.role === "toolResult" && m.nestedCalls?.complete === false) safe = false;
      end = m;
    }
  }
  if (selected < 0) return null;
  const prefix = entries.slice(0, selected), messages = prefix.flatMap(p => p.messages);
  const snapshot: Snapshot = { session: ctx.sessionManager.getSessionId(), generation, cut: entries[selected].sourceEntry.id, ids: prefix.map(p => p.sourceEntry.id), hash: digest(prefix.map(p => ({ id: p.sourceEntry.id, messages: content(p.messages) }))), previous: last?.id ?? null, environment: env, messages, files: filesIn(messages, last?.fromHook ? committedFiles(last) : last?.details), tokens: selectedTokens };
  // One bounded simulation, not one history copy per cut: catches fixed file
  // labels, context edits and any projection detail missed by the lower bound.
  return fits(pi, ctx, snapshot, withFiles("x", snapshot.files), tokensBefore) ? snapshot : null;
}
export function valid(pi: ExtensionAPI, ctx: ExtensionContext, snapshot: Snapshot): boolean {
  if (snapshot.session !== ctx.sessionManager.getSessionId() || snapshot.environment !== environment(pi, ctx)) return false;
  const branch = ctx.sessionManager.getBranch();
  if ((branch.filter(e => e.type === "compaction").at(-1)?.id ?? null) !== snapshot.previous) return false;
  const entries = ctx.sessionManager.buildSessionProjection().entries;
  const cut = entries.findIndex(e => e.sourceEntry.id === snapshot.cut);
  if (cut < 0 || cut !== snapshot.ids.length || entries[cut]?.messages[0]?.role !== "user") return false;
  return digest(entries.slice(0, cut).map(p => ({ id: p.sourceEntry.id, messages: content(p.messages) }))) === snapshot.hash && snapshot.ids.every((id, i) => entries[i]?.sourceEntry.id === id);
}
export function withFiles(summary: string, files: FileLists): string {
  const sections = [files.readFiles.length && `<read-files>\n${files.readFiles.join("\n")}\n</read-files>`, files.modifiedFiles.length && `<modified-files>\n${files.modifiedFiles.join("\n")}\n</modified-files>`].filter(Boolean);
  return sections.length ? `${summary}\n\n${sections.join("\n\n")}` : summary;
}
export function prompt(snapshot: Snapshot): string {
  return `Summarize the following effective conversation. Preserve goals, constraints, decisions, file operations, evidence, unfinished work and uncertainty. Do not claim unverified work is done. This summary replaces only the covered prefix; do not continue the conversation.\n\n<conversation>\n${serializeConversation(convertToLlm(snapshot.messages))}\n</conversation>\n\n${withFiles("File operations in the covered history:", snapshot.files)}`;
}
const contextOverhead = (pi: ExtensionAPI, ctx: ExtensionContext) => {
  const tools = pi.getAllTools().filter(t => pi.getActiveTools().includes(t.name));
  return Math.ceil((ctx.getSystemPrompt().length + JSON.stringify(tools).length) / 3);
};
// The model receives a wrapped compactionSummary, not the bare summary string.
const summaryTokens = (summary: string) => estimateTokens(convertToLlm([{ role: "compactionSummary", summary, tokensBefore: 0, timestamp: 0 }])[0]);
const textOnly = (messages: SessionProjection["messages"]) => messages.every(m => {
  if (m.role === "user" || m.role === "toolResult") return typeof m.content === "string" || m.content.every(c => c.type === "text");
  if (m.role === "assistant") return m.content.every(c => c.type === "text" || c.type === "thinking" || c.type === "toolCall");
  if (m.role === "custom") return typeof m.content === "string" || m.content.every(c => c.type === "text");
  return m.role === "system" || m.role === "compactionSummary" || m.role === "branchSummary" || m.role === "bashExecution";
});
export function fits(pi: ExtensionAPI, ctx: ExtensionContext, snapshot: Snapshot, summary: string, tokensBefore: number): boolean {
  const s = settings(pi, ctx);
  if (!s || ctx.hasPendingMessages() || !valid(pi, ctx, snapshot)) return false;
  const projection = ctx.sessionManager.buildSessionProjection();
  if (!textOnly(projection.messages)) return false;
  // Copy only the active branch, with the same leaf, into a non-persistent SessionManager.
  const branch = ctx.sessionManager.getBranch();
  const header = ctx.sessionManager.getHeader();
  if (!header) return false;
  const clone = SessionManager.inMemory(ctx.sessionManager.getCwd(), undefined, [header, ...branch]);
  clone.appendCompaction(summary, snapshot.cut, tokensBefore, { ...snapshot.files }, true);
  const after = clone.buildSessionProjection().messages;
  if (!textOnly(after)) return false;
  const estimated = after.reduce((n, m) => n + (m.role === "compactionSummary" ? summaryTokens(m.summary) : estimateTokens(m)), 0) + contextOverhead(pi, ctx);
  return estimated * 1.1 < ctx.model!.contextWindow - s.reserveTokens && tokensBefore - estimated >= Math.max(256, snapshot.tokens / 4);
}
