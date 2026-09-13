import { createHash } from "node:crypto";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, getAgentDir, getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import { dispatchAgent, type DispatchResult } from "./dispatcher.ts";
import { garbageCollect } from "./gc.ts";
import { FastInheritanceConsumer } from "./fast-inheritance.ts";
import { sanitizeAttemptResult, type AttemptResult, type ToolResultProjection, type UsageStats } from "./runner.ts";

export * from "./agents.ts";
export * from "./dispatcher.ts";
export * from "./fast-inheritance.ts";
export * from "./gc.ts";
export * from "./runner.ts";
export * from "./session-identity.ts";
export * from "./session-lock.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
const DEFAULT_PERSISTENT = true;

export type SingleResult = AttemptResult & { step?: number; status?: DispatchResult["status"]; handle?: string; persistent?: boolean; attempts?: AttemptResult[] };
interface SubagentDetails {
  mode: "single" | "parallel" | "chain";
  agentScope: AgentScope;
  results: SingleResult[];
}

function finalOutput(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant") {
      const parts = Array.isArray((message as any).content) ? (message as any).content : [];
      const text = parts.find((part: any) => part?.type === "text")?.text;
      if (typeof text === "string" && text.length > 0) return text;
    }
  }
  return "";
}

function failed(result: SingleResult): boolean { return result.failureKind !== "success"; }
function output(result: SingleResult): string { return failed(result) ? result.errorMessage || "(no output)" : finalOutput(result.messages) || "(no output)"; }
function truncate(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= PER_TASK_OUTPUT_CAP) return value;
  let result = value.slice(0, PER_TASK_OUTPUT_CAP);
  while (Buffer.byteLength(result, "utf8") > PER_TASK_OUTPUT_CAP) result = result.slice(0, -1);
  return `${result}\n\n[Output truncated. Details contain bounded output.]`;
}
function usageText(usage: UsageStats, actualModel?: string, requestedModel?: string): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
  if (usage.input) parts.push(`↑${Math.round(usage.input / 1000)}k`);
  if (usage.output) parts.push(`↓${Math.round(usage.output / 1000)}k`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (actualModel) parts.push(`actual:${actualModel}`);
  if (requestedModel && requestedModel !== actualModel) parts.push(`requested:${requestedModel}`);
  return parts.join(" ");
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, unknown> } | { type: "toolResult"; result: ToolResultProjection };
function displayItems(messages: Message[], toolResults: ToolResultProjection[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const message of messages) if (message.role === "assistant") {
    for (const part of (message as any).content ?? []) {
      if (part.type === "text") items.push({ type: "text", text: part.text });
      else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
    }
  }
  for (const result of toolResults) items.push({ type: "toolResult", result });
  return items;
}
function formatToolCall(name: string, args: Record<string, unknown>, fg: (color: any, text: string) => string): string {
  const ref = typeof args.ref === "string" ? args.ref : "ref:unknown";
  return `${fg("muted", `${name} `)}${fg("accent", `args ${ref}`)}`;
}
function formatToolResult(item: ToolResultProjection, fg: (color: any, text: string) => string): string {
  const value = JSON.stringify(item.result).slice(0, 240);
  return `${fg(item.isError ? "error" : "muted", item.isError ? "tool error " : "tool result ")}${fg("toolOutput", `${item.toolName} ${value}`)}`;
}
function renderItems(items: DisplayItem[], expanded: boolean, fg: (color: any, text: string) => string, limit = COLLAPSED_ITEM_COUNT): string {
  const shown = expanded ? items : items.slice(-limit);
  let text = items.length > shown.length ? fg("muted", `... ${items.length - shown.length} earlier items\n`) : "";
  for (const item of shown) text += item.type === "text" ? `${fg("toolOutput", expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n"))}\n` : item.type === "toolCall" ? `${fg("muted", "→ ")}${formatToolCall(item.name, item.args, fg)}\n` : `${fg("muted", "← ")}${formatToolResult(item.result, fg)}\n`;
  return text.trimEnd();
}

const CallFields = {
  model: Type.Optional(Type.String({ description: "Model for this child call" })),
  persistent: Type.Optional(Type.Boolean({ description: "Override persistence for this call" })),
  session: Type.Optional(Type.String({ description: "Opaque logical session handle to resume" })),
};
const TaskItem = Type.Object({ agent: Type.String(), task: Type.String(), cwd: Type.Optional(Type.String()), ...CallFields });
const ChainItem = Type.Object({ agent: Type.String(), task: Type.String(), cwd: Type.Optional(Type.String()), ...CallFields });
const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, { default: "user" });
export const SubagentParams = Type.Object({
  agent: Type.Optional(Type.String()), task: Type.Optional(Type.String()),
  tasks: Type.Optional(Type.Array(TaskItem)), chain: Type.Optional(Type.Array(ChainItem)),
  agentScope: Type.Optional(AgentScopeSchema),
  confirmProjectAgents: Type.Optional(Type.Boolean({ default: false })),
  cwd: Type.Optional(Type.String()), model: Type.Optional(Type.String()),
  persistent: Type.Optional(Type.Boolean()), session: Type.Optional(Type.String()),
});

type Params = any;
function makeDetails(mode: SubagentDetails["mode"], agentScope: AgentScope, results: SingleResult[]): SubagentDetails {
  return { mode, agentScope, results };
}

function taskReference(task: unknown): string {
  const text = typeof task === "string" ? task : "";
  return `task:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
}

const SAFE_HANDLE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_STATUSES = new Set<DispatchResult["status"]>(["completed", "recoverable_failed", "failed", "cancelled", "session-busy", "cleanup-pending", "invalid"]);
function safeHandle(value: unknown): string | undefined { return typeof value === "string" && SAFE_HANDLE.test(value) ? value : undefined; }

function sanitizeSingleResult(result: SingleResult, blockedTexts: readonly string[] = []): SingleResult {
  return {
    ...sanitizeAttemptResult(result, undefined, blockedTexts),
    status: SAFE_STATUSES.has(result.status as DispatchResult["status"]) ? result.status : "invalid",
    handle: safeHandle(result.handle),
    persistent: typeof result.persistent === "boolean" ? result.persistent : undefined,
    attempts: result.attempts?.map((attempt) => sanitizeAttemptResult(attempt, undefined, blockedTexts)),
    step: Number.isInteger(result.step) && (result.step as number) >= 0 ? result.step : undefined,
  };
}

/** Parent-session metadata is an allowlisted mirror of the last details/registry attempt. */
export function subagentSessionMetadata(result: DispatchResult, agent: string): Record<string, unknown> {
  const attempt = sanitizeAttemptResult(result.attempt);
  const summary: Record<string, unknown> = {
    requestedModel: attempt.requestedModel,
    actualModel: attempt.actualModel,
    attempt: attempt.attempt,
    source: attempt.source,
    kind: attempt.failureKind,
  };
  if (attempt.errorMessage) summary.reason = attempt.errorMessage;
  return {
    version: 1,
    handle: safeHandle(result.handle),
    agent: SAFE_HANDLE.test(agent) ? agent : "unknown",
    cwdScope: attempt.cwdScope,
    persistent: result.persistent === true,
    childSessionId: attempt.sessionId,
    status: SAFE_STATUSES.has(result.status) ? result.status : "invalid",
    requestedModel: attempt.requestedModel,
    actualModel: attempt.actualModel,
    attempt: summary,
  };
}

/** Run maintenance without delaying session startup or a tool call. */
export function scheduleGarbageCollection(rootDir: string, collect: () => Promise<unknown> = () => garbageCollect({ rootDir })): void {
  void Promise.resolve().then(collect).catch(() => {
    // GC is best effort; a failed maintenance pass must not affect dispatch.
  });
}
function toResult(dispatch: DispatchResult, step?: number, blockedTexts: readonly string[] = []): SingleResult {
  const attempt = sanitizeAttemptResult(dispatch.attempt, undefined, blockedTexts);
  return {
    ...attempt,
    status: SAFE_STATUSES.has(dispatch.status) ? dispatch.status : "invalid",
    handle: safeHandle(dispatch.handle),
    persistent: dispatch.persistent === true,
    attempts: dispatch.attempts.map((item) => sanitizeAttemptResult(item, undefined, blockedTexts)),
    step: Number.isInteger(step) && (step as number) >= 0 ? step : undefined,
  };
}

export interface SubagentModeCall {
  agent: string;
  task: string;
  cwd?: string;
  model?: string;
  persistent?: boolean;
  session?: string;
}

export async function runSubagentModes(
  input: { single?: SubagentModeCall; tasks?: SubagentModeCall[]; chain?: SubagentModeCall[] },
  runOne: (item: SubagentModeCall, step?: number) => Promise<SingleResult>,
  details: (results: SingleResult[]) => SubagentDetails,
): Promise<{ content: [{ type: "text"; text: string }]; details: SubagentDetails; isError?: boolean }> {
  if (input.chain?.length) {
    const results: SingleResult[] = [];
    let previous = "";
    for (let index = 0; index < input.chain.length; index += 1) {
      const item = input.chain[index];
      const nextItem = { ...item, task: item.task.replace(/\{previous\}/g, previous) };
      const result = sanitizeSingleResult(await runOne(nextItem, index + 1), [nextItem.task]);
      results.push(result);
      if (failed(result)) return { content: [{ type: "text", text: `Chain stopped at step ${index + 1} (${item.agent}): ${output(result)}` }], details: details(results), isError: true };
      previous = finalOutput(result.messages);
    }
    return { content: [{ type: "text", text: previous || "(no output)" }], details: details(results) };
  }
  if (input.tasks?.length) {
    if (input.tasks.length > MAX_PARALLEL_TASKS) return { content: [{ type: "text", text: `Too many parallel tasks (${input.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }], details: details([]) };
    const results = await mapLimit(input.tasks, MAX_CONCURRENCY, async (item) => sanitizeSingleResult(await runOne(item), [item.task]));
    const success = results.filter((result) => !failed(result)).length;
    return { content: [{ type: "text", text: `Parallel: ${success}/${results.length} succeeded\n\n${results.map((result) => `### [${result.agent}] ${failed(result) ? "failed" : "completed"}\n\n${truncate(output(result))}`).join("\n\n---\n\n")}` }], details: details(results) };
  }
  if (!input.single) return { content: [{ type: "text", text: "Invalid parameters. Provide exactly one mode." }], details: details([]), isError: true };
  const result = sanitizeSingleResult(await runOne(input.single), [input.single.task]);
  return { content: [{ type: "text", text: failed(result) ? `Agent ${result.failureKind}: ${output(result)}` : finalOutput(result.messages) || "(no output)" }], details: details([result]), isError: failed(result) };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(new Array(Math.min(limit, Math.max(1, items.length))).fill(null).map(async () => {
    while (true) { const index = next++; if (index >= items.length) return; results[index] = await fn(items[index], index); }
  }));
  return results;
}

export default function subagentExtension(pi: ExtensionAPI): void {
  // Start the optional interop subscription while the extension is loading so
  // a producer that runs earlier in session_start cannot be missed. The
  // consumer only applies buffered events after its public adapter resolves.
  const fastConsumer = new FastInheritanceConsumer(pi.events);
  const stateRoot = path.join(getAgentDir(), "subagent");
  pi.on("session_start", (_event, ctx) => {
    fastConsumer.bind(ctx.sessionManager.getSessionId());
    scheduleGarbageCollection(stateRoot);
  });
  pi.on("session_shutdown", () => fastConsumer.dispose());

  pi.registerTool({
    name: "subagent", label: "Subagent",
    description: "Delegate isolated single, parallel, or chained tasks. Agents are discovered from the configured user/project scopes; project agents require explicit scope and trust. Persistent child sessions default to true.",
    parameters: SubagentParams,
    async execute(_toolCallId, params: Params, signal, onUpdate, ctx) {
      const scope: AgentScope = params.agentScope ?? "user";
      const discovery = discoverAgents(ctx.cwd, scope);
      const agents = discovery.agents;
      const hasChain = (params.chain?.length ?? 0) > 0;
      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);
      const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);
      const mode: SubagentDetails["mode"] = hasChain ? "chain" : hasTasks ? "parallel" : "single";
      const details = (results: SingleResult[]) => makeDetails(mode, scope, results);
      if (modeCount !== 1) return { content: [{ type: "text", text: "Invalid parameters. Provide exactly one mode." }], details: details([]) };

      if (scope === "project" || scope === "both") {
        const names = new Set<string>();
        if (params.agent) names.add(params.agent);
        for (const item of params.tasks ?? params.chain ?? []) names.add(item.agent);
        const project = [...names].map((name) => agents.find((agent) => agent.name === name)).filter((agent): agent is AgentConfig => agent?.source === "project");
        if (project.length > 0 && !ctx.isProjectTrusted()) {
          if (!(params.confirmProjectAgents ?? false) || !ctx.hasUI) {
            return { content: [{ type: "text", text: "Project-local agents require a trusted project or explicit UI approval." }], details: details([]), isError: true };
          }
          if (!await ctx.ui.confirm("Run project-local agents?", `Agents: ${project.map((agent) => agent.name).join(", ")}\nScope: project-local`)) {
            return { content: [{ type: "text", text: "Canceled: project-local agents not approved." }], details: details([]) };
          }
        }
      }

      const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      fastConsumer.bind(ctx.sessionManager.getSessionId());
      const runOne = async (item: { agent: string; task: string; cwd?: string; model?: string; persistent?: boolean; session?: string }, step?: number): Promise<SingleResult> => {
        const agent = agents.find((candidate) => candidate.name === item.agent);
        if (!agent) {
          const fake: DispatchResult = { ...({} as DispatchResult), attempt: { agent: item.agent, agentSource: "unknown", exitCode: null, messages: [], toolResults: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }, requestedModel: "unknown", actualModel: "unknown", source: "initial", attempt: 0, failureKind: "unknown_transport", errorMessage: "Unknown agent", cwdScope: "cwd:unknown" }, attempts: [], persistent: item.persistent ?? DEFAULT_PERSISTENT, status: "invalid", failureKind: "unknown_transport", error: "unknown agent" };
          return toResult(fake, step, [item.task]);
        }
        const result = await dispatchAgent({ parentSessionId: ctx.sessionManager.getSessionId(), parentModel, agent, task: item.task, cwd: path.resolve(item.cwd ?? ctx.cwd), model: item.model, session: item.session, persistent: item.persistent, defaultPersistent: params.persistent ?? DEFAULT_PERSISTENT, signal, fast: fastConsumer, onUpdate: (attempt) => onUpdate?.({ content: [{ type: "text", text: finalOutput(attempt.messages) || "(running...)" }], details: details([toResult({ attempt, attempts: [attempt], persistent: item.persistent ?? agent.persistent ?? DEFAULT_PERSISTENT, status: "failed", failureKind: attempt.failureKind }, step, [item.task])]) }) }, { rootDir: stateRoot });
        if (result.persistent && result.handle) pi.appendEntry("subagent-session", subagentSessionMetadata(result, agent.name));
        return toResult(result, step, [item.task]);
      };

      return runSubagentModes({
        single: hasSingle ? { agent: params.agent, task: params.task, cwd: params.cwd, model: params.model, persistent: params.persistent, session: params.session } : undefined,
        tasks: hasTasks ? params.tasks : undefined,
        chain: hasChain ? params.chain : undefined,
      }, runOne, details);
    },
    renderCall(args, theme) {
      const scope = args.agentScope ?? "user";
      if (args.chain?.length) return new Text(`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", `chain (${args.chain.length} steps)`)}${theme.fg("muted", ` [${scope}]`)}`, 0, 0);
      if (args.tasks?.length) return new Text(`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", `parallel (${args.tasks.length} tasks)`)}${theme.fg("muted", ` [${scope}]`)}`, 0, 0);
      return new Text(`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.agent ?? "...")}${theme.fg("muted", ` [${scope}]`)}\n  ${theme.fg("dim", taskReference(args.task))}`, 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const data = result.details as SubagentDetails | undefined;
      if (!data?.results.length) return new Text(result.content[0]?.type === "text" ? result.content[0].text : "(no output)", 0, 0);
      const renderOne = (item: SingleResult): string => `${failed(item) ? theme.fg("error", "✗") : theme.fg("success", "✓")} ${theme.fg("accent", item.agent)}${item.status === "recoverable_failed" ? theme.fg("warning", " (可继续)") : ""}\n${renderItems(displayItems(item.messages, item.toolResults), expanded, theme.fg.bind(theme))}${usageText(item.usage, item.actualModel, item.requestedModel) ? `\n${theme.fg("dim", usageText(item.usage, item.actualModel, item.requestedModel))}` : ""}`;
      if (data.mode === "single") {
        const item = data.results[0];
        if (expanded) { const container = new Container(); container.addChild(new Text(renderOne(item), 0, 0)); const text = finalOutput(item.messages); if (text) { container.addChild(new Spacer(1)); container.addChild(new Markdown(text, 0, 0, getMarkdownTheme())); } return container; }
        return new Text(renderOne(item), 0, 0);
      }
      return new Text(`${data.mode} ${data.results.filter((item) => !failed(item)).length}/${data.results.length} succeeded\n\n${data.results.map(renderOne).join("\n\n")}`, 0, 0);
    },
  });
}
