import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig } from "./agents.ts";
import { createChildEnvironment } from "./fast-inheritance.ts";
import { markRetryClassification, retryClassificationOf } from "./retry-classification.ts";
import { readStableOwnerFileSync } from "./secure-fs.ts";
import { SIDE_EFFECT_FENCE_TIMEOUT_MS, sideEffectFenceClientProofValid, sideEffectFenceEnvironment, type SideEffectFenceClientConfig } from "./side-effect-fence.ts";
// Runner is shared by v1 and gated v2; keep its retry bound policy-neutral.
export const MAX_RETRIES_PER_MODEL = 2;
export const DEFAULT_RETRY_DELAY_MS = 50;

export type FailureKind = "success" | "incomplete" | "transient_provider" | "non_transient_provider" | "task_failure" | "cancelled" | "unknown_transport";
export type AttemptPhase = "running" | "finished";
export type AttemptSource = "initial" | "retry" | "fallback" | "user_override";

export interface AttemptDiagnostics {
  toolErrorCount: number;
  providerErrorCount: number;
}

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface ToolResultProjection {
  toolCallId: string;
  toolName: string;
  isError: boolean;
  /** Finite type/size/hash summary; the original result never crosses this boundary. */
  result: SafeProjection;
  resultHash: string;
}

type SafeProjection = string | number | boolean | null | SafeProjection[] | { [key: string]: SafeProjection };

export interface AttemptResult {
  agent: string;
  agentSource: "user" | "project" | "unknown";
  exitCode: number | null;
  messages: Message[];
  toolResults: ToolResultProjection[];
  usage: UsageStats;
  requestedModel: string;
  /** Model reported by the terminal assistant message, or `unknown`. */
  actualModel: string;
  source: AttemptSource;
  attempt: number;
  stopReason?: string;
  /** Attempt lifecycle only; it does not represent task acceptance. */
  phase?: AttemptPhase;
  /** Bounded process diagnostics; raw provider/tool values never cross this boundary. */
  diagnostics?: AttemptDiagnostics;
  /** Classification-only diagnostic; raw provider errors never cross this boundary. */
  errorMessage?: string;
  failureKind: FailureKind;
  sessionId?: string;
  /** A non-reversible display reference, never the configured absolute cwd. */
  cwdScope: string;
}

export interface RunAttemptOptions {
  cwd: string;
  agent: AgentConfig;
  task: string;
  model?: string;
  attempt: number;
  source: AttemptSource;
  sessionDir: string;
  childSessionId: string;
  sessionFile?: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  firstLogicalChildSpawn: boolean;
  parentFastRequested: boolean;
  onUpdate?: (result: AttemptResult) => void;
  onChildProcess?: (child: { pid: number; identity: string; sessionPath?: string }) => void | boolean | Promise<void | boolean>;
  spawn?: typeof nodeSpawn;
  /** Internal v2-only CLI fence; absent means the v1 argv path is untouched. */
  sideEffectFence?: SideEffectFenceClientConfig;
}

interface JsonProcess {
  pid?: number;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  on(event: "close", listener: (code: number | null, signal?: NodeJS.Signals | null) => void): JsonProcess;
  on(event: "error", listener: (error: Error) => void): JsonProcess;
  kill(signal?: NodeJS.Signals): boolean;
  killed?: boolean;
  stdin?: NodeJS.WritableStream;
}

function emptyUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeError(raw: string, status?: number): string | undefined {
  const lower = raw.toLowerCase();
  if (status && [429, 502, 503, 504].includes(status)) return `HTTP ${status}`;
  if (lower.includes("fetch failed")) return "fetch failed";
  for (const code of ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT"]) if (raw.toUpperCase().includes(code)) return code;
  if (/\b(?:timed?\s*out|timeout)\b/i.test(raw)) return "timeout";
  const httpStatus = raw.match(/\b(?:HTTP|status(?:Code)?|code|response)\s*(?:status\s*)?(?:[:=]?\s*)\b(429|502|503|504)\b/i);
  if (httpStatus) return `HTTP ${httpStatus[1]}`;
  if (raw.trim()) return "provider request failed";
  return undefined;
}

type ProviderFailureClassification = "transient_provider" | "non_transient_provider";

/** Closed allowlist. This raw-input classifier is intentionally not exported. */
function classifyProviderError(value: { errorMessage?: string; status?: number }): ProviderFailureClassification {
  if (value.status !== undefined) return [429, 502, 503, 504].includes(value.status) ? "transient_provider" : "non_transient_provider";
  const text = value.errorMessage ?? "";
  return /fetch failed|\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT)\b|\b(?:timed?\s*out|timeout)\b|\b(?:HTTP|status(?:Code)?|code|response)\s*(?:status\s*)?(?:[:=]?\s*)\b(?:429|502|503|504)\b/i.test(text)
    ? "transient_provider" : "non_transient_provider";
}

function extractStatus(value: any): number | undefined {
  for (const candidate of [value?.status, value?.statusCode, value?.response?.status, value?.error?.status]) {
    if (typeof candidate === "number") return candidate;
  }
  return undefined;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  if (currentScript && !currentScript.startsWith("/$bunfs/root/") && fs.existsSync(currentScript)) return { command: process.execPath, args: [currentScript, ...args] };
  const runtime = path.basename(process.execPath).toLowerCase();
  return /^(node|bun)(\.exe)?$/.test(runtime) ? { command: "pi", args } : { command: process.execPath, args };
}

async function writeSystemPrompt(agent: AgentConfig): Promise<{ dir: string; file: string } | undefined> {
  if (!agent.systemPrompt.trim()) return undefined;
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-prompt-"));
  const file = path.join(dir, "system.md");
  await fs.promises.writeFile(file, agent.systemPrompt, { encoding: "utf8", mode: 0o600 });
  return { dir, file };
}

export async function findSessionFile(sessionDir: string, sessionId: string): Promise<string | undefined> {
  const pending = [sessionDir];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) { pending.push(candidate); continue; }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      try {
        const firstLine = (await fs.promises.readFile(candidate, "utf8")).split("\n")[0];
        const header = JSON.parse(firstLine);
        if (header?.type === "session" && header.id === sessionId) return path.resolve(candidate);
      } catch {
        // Ignore unrelated or partially written files.
      }
    }
  }
  return undefined;
}

function exactKeys(record: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(record, key)) && Object.keys(record).every((key) => allowed.has(key));
}

function validString(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function validSessionId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value);
}
function validTimestamp(value: unknown): boolean {
  // Pi writes Date#toISOString() for session and entry timestamps. Date.parse()
  // alone also accepts non-wire strings such as "1", so keep the boundary to
  // the actual JSONL timestamp representation.
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
}

function validNumber(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function validNonNegativeInteger(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function validDuration(value: unknown): value is number { return validNumber(value) && value >= 0; }
function validThinkingLevel(value: unknown): boolean { return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value as string); }
function validRetryMessage(value: unknown): boolean { return typeof value === "string" && value.length > 0; }

function validJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (validNumber(value)) return true;
  if (Array.isArray(value)) return value.every(validJsonValue);
  return isRecord(value) && Object.values(value).every(validJsonValue);
}

function validContentPart(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "text") return exactKeys(value, ["type", "text"], ["textSignature"]) && typeof value.text === "string" && (value.textSignature === undefined || typeof value.textSignature === "string");
  if (value.type === "thinking") return exactKeys(value, ["type", "thinking"], ["thinkingSignature", "redacted"]) && typeof value.thinking === "string" && (value.thinkingSignature === undefined || typeof value.thinkingSignature === "string") && (value.redacted === undefined || typeof value.redacted === "boolean");
  if (value.type === "toolCall") return exactKeys(value, ["type", "id", "name", "arguments"], ["thoughtSignature", "namespace"]) && validString(value.id) && validString(value.name) && isRecord(value.arguments) && validJsonValue(value.arguments) && (value.thoughtSignature === undefined || typeof value.thoughtSignature === "string") && (value.namespace === undefined || typeof value.namespace === "string");
  if (value.type === "image") return exactKeys(value, ["type", "data", "mimeType"]) && typeof value.data === "string" && typeof value.mimeType === "string";
  return false;
}

function validUserContent(value: unknown): boolean {
  return typeof value === "string" || (Array.isArray(value) && value.every((part) => isRecord(part) && (part.type === "text" || part.type === "image") && validContentPart(part)));
}

function validUsage(value: unknown): boolean {
  if (!isRecord(value) || !exactKeys(value, ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"], ["cacheWrite1h", "reasoning"])) return false;
  if (!["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cacheWrite1h", "reasoning"].every((key) => value[key] === undefined || validNumber(value[key]))) return false;
  return isRecord(value.cost) && exactKeys(value.cost, ["input", "output", "cacheRead", "cacheWrite", "total"]) && ["input", "output", "cacheRead", "cacheWrite", "total"].every((key) => validNumber(value.cost[key]));
}

function validDeferred(value: unknown): boolean {
  return isRecord(value) && exactKeys(value, ["provider", "modelId", "api", "id"], ["expiresAt", "pollAfterMs", "data"]) && validString(value.provider) && validString(value.modelId) && validString(value.api) && validString(value.id) && (value.expiresAt === undefined || validNumber(value.expiresAt)) && (value.pollAfterMs === undefined || validNumber(value.pollAfterMs)) && (value.data === undefined || validJsonValue(value.data));
}

function validDiagnostic(value: unknown): boolean {
  if (!isRecord(value) || !exactKeys(value, ["type", "timestamp"], ["error", "details"]) || !validString(value.type) || !validNumber(value.timestamp)) return false;
  if (value.error !== undefined) {
    if (!isRecord(value.error) || !exactKeys(value.error, ["message"], ["name", "stack", "code"]) || typeof value.error.message !== "string") return false;
    if (value.error.name !== undefined && typeof value.error.name !== "string") return false;
    if (value.error.stack !== undefined && typeof value.error.stack !== "string") return false;
    if (value.error.code !== undefined && typeof value.error.code !== "string" && !validNumber(value.error.code)) return false;
  }
  return value.details === undefined || isRecord(value.details);
}

function validAssistantMessage(value: Record<string, unknown>): boolean {
  return exactKeys(value, ["role", "content", "api", "provider", "model", "usage", "stopReason", "timestamp"], ["responseModel", "responseId", "providerThinkingLevel", "thinkingLevel", "diagnostics", "deferred", "errorMessage", "rawStopReason", "endTurn", "durationMs"]) && value.role === "assistant" && Array.isArray(value.content) && value.content.every(validContentPart) && validString(value.api) && validString(value.provider) && validString(value.model) && validUsage(value.usage) && ["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"].includes(value.stopReason as string) && validNumber(value.timestamp) && (value.responseModel === undefined || typeof value.responseModel === "string") && (value.responseId === undefined || typeof value.responseId === "string") && (value.providerThinkingLevel === undefined || typeof value.providerThinkingLevel === "string") && (value.thinkingLevel === undefined || validThinkingLevel(value.thinkingLevel)) && (value.durationMs === undefined || validDuration(value.durationMs)) && (value.diagnostics === undefined || (Array.isArray(value.diagnostics) && value.diagnostics.every(validDiagnostic))) && (value.deferred === undefined || validDeferred(value.deferred)) && (value.errorMessage === undefined || typeof value.errorMessage === "string") && (value.rawStopReason === undefined || typeof value.rawStopReason === "string") && (value.endTurn === undefined || typeof value.endTurn === "boolean");
}

function validUserMessage(value: Record<string, unknown>): boolean {
  return exactKeys(value, ["role", "content", "timestamp"]) && value.role === "user" && validUserContent(value.content) && validNumber(value.timestamp);
}

function validConstrainedSampling(value: unknown): boolean {
  if (value === false) return true;
  if (!isRecord(value)) return false;
  if (value.type === "json_schema") return exactKeys(value, ["type", "strict"]) && ["prefer", "require"].includes(value.strict as string);
  if (value.type === "grammar") return exactKeys(value, ["type", "variants"]) && isRecord(value.variants) && Object.keys(value.variants).every((key) => ["openai_lark", "openai_regex"].includes(key) && typeof value.variants![key] === "string");
  return false;
}

function validSystemTool(value: unknown): boolean {
  return isRecord(value) && exactKeys(value, ["name", "description", "parameters"], ["constrainedSampling"]) && validString(value.name) && validString(value.description) && isRecord(value.parameters) && validJsonValue(value.parameters) && (value.constrainedSampling === undefined || validConstrainedSampling(value.constrainedSampling));
}

function validNestedToolCalls(value: unknown): boolean {
  if (!isRecord(value) || !exactKeys(value, ["calls", "complete"]) || !Array.isArray(value.calls) || typeof value.complete !== "boolean") return false;
  return value.calls.every((call) => isRecord(call) && exactKeys(call, ["id", "name", "status"], ["arguments", "argumentsBytes", "durationMs", "error"]) && validString(call.id) && validString(call.name) && ["ok", "error", "unfinished"].includes(call.status as string) && (call.arguments === undefined || isRecord(call.arguments) && validJsonValue(call.arguments)) && (call.argumentsBytes === undefined || validNonNegativeInteger(call.argumentsBytes)) && (call.durationMs === undefined || validDuration(call.durationMs)) && (call.error === undefined || typeof call.error === "string"));
}

function validToolResultMessage(value: Record<string, unknown>): boolean {
  return exactKeys(value, ["role", "toolCallId", "toolName", "content", "isError", "timestamp"], ["details", "usage", "nestedCalls", "durationMs", "addedToolNames"]) && value.role === "toolResult" && validString(value.toolCallId) && validString(value.toolName) && Array.isArray(value.content) && value.content.every((part) => isRecord(part) && (part.type === "text" || part.type === "image") && validContentPart(part)) && typeof value.isError === "boolean" && validNumber(value.timestamp) && (value.details === undefined || validJsonValue(value.details)) && (value.usage === undefined || validUsage(value.usage)) && (value.nestedCalls === undefined || validNestedToolCalls(value.nestedCalls)) && (value.durationMs === undefined || validDuration(value.durationMs)) && (value.addedToolNames === undefined || (Array.isArray(value.addedToolNames) && value.addedToolNames.every(validString)));
}

/** Pi AgentMessage schema shared by JSON mode and session records. */
function validAgentMessage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.role === "assistant") return validAssistantMessage(value);
  if (value.role === "system") return exactKeys(value, ["role", "content", "timestamp"], ["sections", "toolsAdded", "toolsRemoved"]) && (typeof value.content === "string" || Array.isArray(value.content) && value.content.every((part) => isRecord(part) && part.type === "text" && validContentPart(part))) && validNumber(value.timestamp) && (value.sections === undefined || isRecord(value.sections) && Object.values(value.sections).every((section) => typeof section === "string" || section === null)) && (value.toolsAdded === undefined || Array.isArray(value.toolsAdded) && value.toolsAdded.every(validSystemTool)) && (value.toolsRemoved === undefined || Array.isArray(value.toolsRemoved) && value.toolsRemoved.every((tool) => isRecord(tool) && exactKeys(tool, ["name"]) && validString(tool.name)));
  if (value.role === "user") return validUserMessage(value);
  if (value.role === "toolResult") return validToolResultMessage(value);
  if (value.role === "custom") return exactKeys(value, ["role", "customType", "content", "display", "timestamp"], ["details"]) && validString(value.customType) && validUserContent(value.content) && typeof value.display === "boolean" && validNumber(value.timestamp) && (value.details === undefined || validJsonValue(value.details));
  if (value.role === "branchSummary") return exactKeys(value, ["role", "summary", "fromId", "timestamp"]) && typeof value.summary === "string" && validString(value.fromId) && validNumber(value.timestamp);
  if (value.role === "compactionSummary") return exactKeys(value, ["role", "summary", "tokensBefore", "timestamp"]) && typeof value.summary === "string" && validNumber(value.tokensBefore) && validNumber(value.timestamp);
  if (value.role === "bashExecution") return exactKeys(value, ["role", "command", "output", "cancelled", "truncated", "timestamp"], ["exitCode", "fullOutputPath", "excludeFromContext"]) && typeof value.command === "string" && typeof value.output === "string" && typeof value.cancelled === "boolean" && typeof value.truncated === "boolean" && validNumber(value.timestamp) && (value.exitCode === undefined || validNumber(value.exitCode)) && (value.fullOutputPath === undefined || typeof value.fullOutputPath === "string") && (value.excludeFromContext === undefined || typeof value.excludeFromContext === "boolean");
  return false;
}

function validAssistantMessageEvent(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "start": return exactKeys(value, ["type"]);
    case "text_start": case "thinking_start": case "toolcall_start": return exactKeys(value, ["type", "contentIndex"], value.type === "toolcall_start" ? ["id", "toolName"] : []) && Number.isInteger(value.contentIndex) && (value.type !== "toolcall_start" || (validString(value.id) && validString(value.toolName)));
    case "text_delta": case "thinking_delta": case "toolcall_delta": return exactKeys(value, ["type", "contentIndex", "delta"]) && Number.isInteger(value.contentIndex) && typeof value.delta === "string";
    case "text_end": case "thinking_end": return exactKeys(value, ["type", "contentIndex", "content"]) && Number.isInteger(value.contentIndex) && typeof value.content === "string";
    case "toolcall_end": return exactKeys(value, ["type", "contentIndex", "toolCall"]) && Number.isInteger(value.contentIndex) && validContentPart(value.toolCall);
    case "done": return exactKeys(value, ["type", "reason", "message"]) && ["stop", "length", "toolUse", "deferred"].includes(value.reason as string) && isRecord(value.message) && validAssistantMessage(value.message);
    case "error": return exactKeys(value, ["type", "reason", "error"]) && ["aborted", "error"].includes(value.reason as string) && isRecord(value.error) && validAssistantMessage(value.error);
    default: return false;
  }
}

const JSON_EVENT_TYPES = new Set([
  "agent_start", "agent_end", "agent_settled",
  "turn_start", "turn_end",
  "message_start", "message_update", "message_end",
  "tool_execution_start", "tool_execution_update", "tool_execution_end",
  "queue_update", "compaction_start", "compaction_end", "entry_appended",
  "session_info_changed", "thinking_level_changed", "bash_execution_update",
  "auto_retry_start", "auto_retry_end",
  "summarization_retry_scheduled", "summarization_retry_attempt_start", "summarization_retry_finished",
]);

function validCompactionResult(value: unknown): boolean {
  return isRecord(value) && exactKeys(value, ["summary", "firstKeptEntryId", "tokensBefore"], ["estimatedTokensAfter", "usage", "details"]) && typeof value.summary === "string" && validString(value.firstKeptEntryId) && validNumber(value.tokensBefore) && (value.estimatedTokensAfter === undefined || validNumber(value.estimatedTokensAfter)) && (value.usage === undefined || validUsage(value.usage)) && (value.details === undefined || validJsonValue(value.details));
}

function validRetryStartEvent(event: Record<string, unknown>): boolean {
  return exactKeys(event, ["type", "attempt", "maxAttempts", "delayMs", "errorMessage"]) && validNonNegativeInteger(event.attempt) && validNonNegativeInteger(event.maxAttempts) && validNonNegativeInteger(event.delayMs) && validRetryMessage(event.errorMessage);
}

/** Strict Pi 1.1.0 JSON event validator. Unknown event types and fields fail closed. */
function validJsonEvent(event: Record<string, unknown>): boolean {
  if (typeof event.type !== "string" || !JSON_EVENT_TYPES.has(event.type)) return false;
  switch (event.type) {
    case "agent_start": return exactKeys(event, ["type"]);
    case "agent_settled": return exactKeys(event, ["type", "aborted"]) && typeof event.aborted === "boolean";
    case "agent_end": return exactKeys(event, ["type", "messages", "willRetry"]) && Array.isArray(event.messages) && event.messages.every(validAgentMessage) && typeof event.willRetry === "boolean";
    // Pi's JSON stdout maps AgentEvent directly; turn_start has no metadata.
    case "turn_start": return exactKeys(event, ["type"]);
    case "turn_end": return exactKeys(event, ["type", "message", "toolResults"]) && validAgentMessage(event.message) && Array.isArray(event.toolResults) && event.toolResults.every((message) => isRecord(message) && validToolResultMessage(message));
    case "message_start": case "message_end": return exactKeys(event, ["type", "message"]) && validAgentMessage(event.message);
    case "message_update": return exactKeys(event, ["type", "usage", "assistantMessageEvent"]) && validUsage(event.usage) && validAssistantMessageEvent(event.assistantMessageEvent);
    case "tool_execution_start": return exactKeys(event, ["type", "toolCallId", "toolName", "args"], ["parentToolCallId"]) && validString(event.toolCallId) && validString(event.toolName) && validJsonValue(event.args) && (event.parentToolCallId === undefined || validString(event.parentToolCallId));
    case "tool_execution_update": return exactKeys(event, ["type", "toolCallId", "toolName", "args", "partialResult"], ["parentToolCallId"]) && validString(event.toolCallId) && validString(event.toolName) && validJsonValue(event.args) && validJsonValue(event.partialResult) && (event.parentToolCallId === undefined || validString(event.parentToolCallId));
    case "tool_execution_end": return exactKeys(event, ["type", "toolCallId", "toolName", "result", "isError"], ["durationMs", "parentToolCallId"]) && validString(event.toolCallId) && validString(event.toolName) && validJsonValue(event.result) && typeof event.isError === "boolean" && (event.durationMs === undefined || validDuration(event.durationMs)) && (event.parentToolCallId === undefined || validString(event.parentToolCallId));
    case "queue_update": return exactKeys(event, ["type", "steering", "followUp"]) && Array.isArray(event.steering) && event.steering.every((value) => typeof value === "string") && Array.isArray(event.followUp) && event.followUp.every((value) => typeof value === "string");
    case "compaction_start": return exactKeys(event, ["type", "reason"]) && ["manual", "threshold", "overflow"].includes(event.reason as string);
    // result is omitted by JSON.stringify when its typed value is undefined.
    // The current Pi event type is `CompactionResult | undefined`; a
    // JSON null is not the wire representation and is rejected here.
    case "compaction_end": return exactKeys(event, ["type", "reason", "aborted", "willRetry"], ["result", "errorMessage"]) && ["manual", "threshold", "overflow"].includes(event.reason as string) && (event.result === undefined || validCompactionResult(event.result)) && typeof event.aborted === "boolean" && typeof event.willRetry === "boolean" && (event.errorMessage === undefined || validRetryMessage(event.errorMessage));
    case "entry_appended": return exactKeys(event, ["type", "entry"]) && isRecord(event.entry) && validWireSessionEntry(event.entry);
    case "session_info_changed": return exactKeys(event, ["type"], ["name"]) && (event.name === undefined || typeof event.name === "string");
    case "thinking_level_changed": return exactKeys(event, ["type", "level"]) && validThinkingLevel(event.level);
    case "bash_execution_update": return exactKeys(event, ["type", "delta"], ["id"]) && (event.id === undefined || typeof event.id === "string") && typeof event.delta === "string";
    case "auto_retry_start": case "summarization_retry_scheduled": return validRetryStartEvent(event);
    case "auto_retry_end": return exactKeys(event, ["type", "success", "attempt"], ["finalError"]) && typeof event.success === "boolean" && validNonNegativeInteger(event.attempt) && (event.finalError === undefined || typeof event.finalError === "string");
    case "summarization_retry_attempt_start":
      return (exactKeys(event, ["type", "source"]) && event.source === "branchSummary") || (exactKeys(event, ["type", "source", "reason"]) && event.source === "compaction" && ["manual", "threshold", "overflow"].includes(event.reason as string));
    case "summarization_retry_finished": return exactKeys(event, ["type"]);
    default: return false;
  }
}

type DiskSessionVersion = 1 | 2 | 3;

function persistedStopReason(value: unknown): boolean {
  // `pending` is a streaming-only StopReason. Pi never writes it to a
  // SessionEntry, although it is valid in the stdout message_start protocol.
  return ["stop", "length", "toolUse", "error", "aborted", "deferred"].includes(value as string);
}

function validHookMessage(value: unknown): boolean {
  return isRecord(value) && exactKeys(value, ["role", "customType", "content", "display", "timestamp"], ["details"]) &&
    value.role === "hookMessage" && validString(value.customType) && validUserContent(value.content) &&
    typeof value.display === "boolean" && validNumber(value.timestamp) &&
    (value.details === undefined || validJsonValue(value.details));
}

function validPersistedBashMessage(value: unknown, version: DiskSessionVersion): boolean {
  if (!isRecord(value) || !exactKeys(value, ["role", "command", "output", "cancelled", "truncated", "timestamp"], ["exitCode", "fullOutputPath", "excludeFromContext"]) ||
      value.role !== "bashExecution" || typeof value.command !== "string" || typeof value.output !== "string" ||
      typeof value.cancelled !== "boolean" || typeof value.truncated !== "boolean" || !validNumber(value.timestamp) ||
      (value.fullOutputPath !== undefined && typeof value.fullOutputPath !== "string") ||
      (value.excludeFromContext !== undefined && typeof value.excludeFromContext !== "boolean")) return false;
  return value.exitCode === undefined || validNumber(value.exitCode) || (version === 1 && value.exitCode === null);
}

function validPersistedAgentMessage(value: unknown, version: DiskSessionVersion): boolean {
  if (!isRecord(value)) return false;
  if (value.role === "hookMessage") return version < 3 && validHookMessage(value);
  if (value.role === "system") return version === 3 && validAgentMessage(value);
  if (value.role === "custom") return version === 3 && validAgentMessage(value);
  if (value.role === "bashExecution") return validPersistedBashMessage(value, version);
  if (value.role !== "user" && value.role !== "assistant" && value.role !== "toolResult") return false;
  if (!validAgentMessage(value)) return false;
  if (value.role === "assistant" && !persistedStopReason(value.stopReason)) return false;
  // responseModel/diagnostics/deferred and added tool-result metadata were
  // introduced after the v2 on-disk format. Keep the historical branches
  // explicit rather than accepting the current v3 object for every version.
  if (version < 3) {
    const legacyAssistantKeys = new Set(["role", "content", "api", "provider", "model", "usage", "stopReason", "timestamp", "errorMessage"]);
    const legacyToolKeys = new Set(["role", "toolCallId", "toolName", "content", "details", "isError", "timestamp"]);
    const keys = value.role === "assistant" ? legacyAssistantKeys : value.role === "toolResult" ? legacyToolKeys : new Set(["role", "content", "timestamp"]);
    if (Object.keys(value).some((key) => !keys.has(key))) return false;
  }
  return true;
}

function validV1Entry(entry: Record<string, unknown>): boolean {
  if (!validTimestamp(entry.timestamp) || typeof entry.type !== "string") return false;
  // v1 was linear. It deliberately has no id/parentId, and compaction used an
  // array index until the v1 -> v2 migration.
  switch (entry.type) {
    case "message": return exactKeys(entry, ["type", "timestamp", "message"]) && validPersistedAgentMessage(entry.message, 1);
    case "thinking_level_change": return exactKeys(entry, ["type", "timestamp", "thinkingLevel"]) && validString(entry.thinkingLevel);
    case "model_change": return exactKeys(entry, ["type", "timestamp", "provider", "modelId"]) && validString(entry.provider) && validString(entry.modelId);
    case "compaction": return exactKeys(entry, ["type", "timestamp", "summary", "firstKeptEntryIndex", "tokensBefore"]) && typeof entry.summary === "string" && validNonNegativeInteger(entry.firstKeptEntryIndex) && validNumber(entry.tokensBefore);
    default: return false;
  }
}

function validTreeEntry(entry: Record<string, unknown>, version: 2 | 3): boolean {
  if (!validString(entry.id) || (typeof entry.parentId !== "string" && entry.parentId !== null) || !validTimestamp(entry.timestamp) || typeof entry.type !== "string") return false;
  switch (entry.type) {
    case "message": return exactKeys(entry, ["type", "id", "parentId", "timestamp", "message"]) && validPersistedAgentMessage(entry.message, version);
    case "thinking_level_change": return exactKeys(entry, ["type", "id", "parentId", "timestamp", "thinkingLevel"]) && validString(entry.thinkingLevel);
    case "model_change": return exactKeys(entry, ["type", "id", "parentId", "timestamp", "provider", "modelId"]) && validString(entry.provider) && validString(entry.modelId);
    case "compaction": {
      const optional = version === 3 ? ["details", "usage", "fromHook", "systemMessage"] : ["details", "fromHook"];
      return exactKeys(entry, ["type", "id", "parentId", "timestamp", "summary", "firstKeptEntryId", "tokensBefore"], optional) &&
        typeof entry.summary === "string" && validString(entry.firstKeptEntryId) && validNumber(entry.tokensBefore) &&
        (entry.details === undefined || validJsonValue(entry.details)) &&
        (entry.fromHook === undefined || typeof entry.fromHook === "boolean") &&
        (version === 3 ? entry.usage === undefined || validUsage(entry.usage) : entry.usage === undefined) &&
        (entry.systemMessage === undefined || version === 3 && validAgentMessage(entry.systemMessage) && (entry.systemMessage as Record<string, unknown>).role === "system");
    }
    case "branch_summary": {
      const optional = version === 3 ? ["details", "usage", "fromHook"] : ["details", "fromHook"];
      return exactKeys(entry, ["type", "id", "parentId", "timestamp", "fromId", "summary"], optional) && validString(entry.fromId) && typeof entry.summary === "string" &&
        (entry.details === undefined || validJsonValue(entry.details)) && (entry.fromHook === undefined || typeof entry.fromHook === "boolean") &&
        (version === 3 ? entry.usage === undefined || validUsage(entry.usage) : entry.usage === undefined);
    }
    case "usage": return version === 3 && exactKeys(entry, ["type", "id", "parentId", "timestamp", "kind", "provider", "model", "usage"], ["note"]) && validString(entry.kind) && validString(entry.provider) && validString(entry.model) && validUsage(entry.usage) && (entry.note === undefined || typeof entry.note === "string");
    case "context_edit": return version === 3 && exactKeys(entry, ["type", "id", "parentId", "timestamp", "targetId", "replacement"]) && validString(entry.targetId) && (entry.replacement === null || isRecord(entry.replacement) && exactKeys(entry.replacement, ["content"]) && (typeof entry.replacement.content === "string" || Array.isArray(entry.replacement.content) && entry.replacement.content.every(validContentPart)));
    case "custom": return exactKeys(entry, ["type", "id", "parentId", "timestamp", "customType"], ["data"]) && validString(entry.customType) && (entry.data === undefined || validJsonValue(entry.data));
    case "custom_message": return exactKeys(entry, ["type", "id", "parentId", "timestamp", "customType", "content", "display"], ["details"]) && validString(entry.customType) && validUserContent(entry.content) && typeof entry.display === "boolean" && (entry.details === undefined || validJsonValue(entry.details));
    case "label": return exactKeys(entry, ["type", "id", "parentId", "timestamp", "targetId"], ["label"]) && validString(entry.targetId) && (entry.label === undefined || typeof entry.label === "string");
    case "session_info": return version === 3 && exactKeys(entry, ["type", "id", "parentId", "timestamp"], ["name"]) && (entry.name === undefined || typeof entry.name === "string");
    default: return false;
  }
}

/** Strictly validate a Pi session-record JSONL entry for its header version. */
function validSessionEntry(entry: Record<string, unknown>, version: DiskSessionVersion): boolean {
  return version === 1 ? validV1Entry(entry) : validTreeEntry(entry, version);
}

/** The stdout `entry_appended` event uses the current v3 entry shape. */
function validWireSessionEntry(entry: Record<string, unknown>): boolean {
  return validTreeEntry(entry, 3);
}

function validSessionHeader(header: Record<string, unknown>, sessionId: string, cwd: string, version: DiskSessionVersion, wire = false): boolean {
  const hasVersion = Object.prototype.hasOwnProperty.call(header, "version");
  if (wire && (!hasVersion || header.version !== 3)) return false;
  if (!wire && hasVersion && (!validNonNegativeInteger(header.version) || header.version !== version)) return false;
  const required = ["type", "id", "timestamp", "cwd", ...(wire || version > 1 || hasVersion ? ["version"] : [])];
  const optional = version === 1 ? ["version", "parentSession", "branchedFrom", "provider", "modelId", "thinkingLevel"] : version === 2 ? ["parentSession", "branchedFrom"] : ["parentSession"];
  if (!exactKeys(header, required, optional) || header.type !== "session" || !validSessionId(header.id) || header.id !== sessionId || !validTimestamp(header.timestamp) || typeof header.cwd !== "string" || !path.isAbsolute(header.cwd) || path.resolve(header.cwd) !== path.resolve(cwd)) return false;
  for (const key of ["parentSession", "branchedFrom", "provider", "modelId", "thinkingLevel"]) {
    if (header[key] !== undefined && !validString(header[key])) return false;
  }
  // The old v1 header carried a complete model snapshot. If any part is
  // present, require the whole snapshot; otherwise a random extra field could
  // masquerade as a historical header.
  const legacyModelFields = [header.provider, header.modelId, header.thinkingLevel].some((value) => value !== undefined);
  if (version === 1 && legacyModelFields && ![header.provider, header.modelId, header.thinkingLevel].every(validString)) return false;
  if (header.parentSession !== undefined && header.branchedFrom !== undefined) return false;
  return true;
}

/** Current Pi 1.1.0 JSON stdout wire header. Never accept a legacy version. */
function validWireSessionHeader(header: Record<string, unknown>, sessionId: string, cwd: string): boolean {
  return validSessionHeader(header, sessionId, cwd, 3, true);
}

/** Persisted session header compatibility, deliberately not usable for stdout. */
function validOnDiskSessionHeader(header: Record<string, unknown>, sessionId: string, cwd: string): DiskSessionVersion | undefined {
  const version = !Object.prototype.hasOwnProperty.call(header, "version") ? 1 : header.version;
  if (version !== 1 && version !== 2 && version !== 3) return undefined;
  return validSessionHeader(header, sessionId, cwd, version) ? version : undefined;
}

export async function validateSessionFile(file: string, sessionId: string, cwd: string): Promise<boolean> {
  try {
    // A session path is a capability. Prove ownership, regular-file identity,
    // link count, non-writable mode, and stable contents before parsing it.
    if (!path.isAbsolute(file) || path.resolve(file) !== file) return false;
    const stable = readStableOwnerFileSync(file);
    // macOS may expose /tmp through /private/tmp, so compare the resolved
    // parent while still rejecting a final-component symlink.
    const expectedRealpath = path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
    if (!stable || stable.realpath !== expectedRealpath) return false;
    const lines = stable.content.split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    if (lines.length === 0 || lines.some((line) => !line.trim())) return false;
    const records = lines.map((line) => JSON.parse(line) as unknown);
    if (!isRecord(records[0])) return false;
    const version = validOnDiskSessionHeader(records[0], sessionId, cwd);
    if (version === undefined) return false;
    if (records.length === 1) return true;
    const rest = records.slice(1);
    // Resumable on-disk sessions contain only SessionEntry records. The JSON
    // event protocol is validated separately by the stdout runner below.
    return rest.every((record) => isRecord(record) && validSessionEntry(record, version));
  } catch {
    // Any truncated, blank, mixed, or otherwise invalid JSONL record makes the
    // session untrusted. Callers must quarantine it rather than resume.
    return false;
  }
}

const SAFE_STOP_REASONS = new Set(["stop", "length", "error", "aborted", "toolUse"]);
// Header-shaped text can occur inside an otherwise valid assistant result.
// Consume the complete value, including semicolon-delimited cookie attributes.
// Stop only before another recognizable header assignment so a normal result
// containing multiple headers can still retain the surrounding text.
const HEADER_NAME = `(?:set[-_ ]?cookie|cookie|x-[a-z0-9][a-z0-9._-]*|[a-z][a-z0-9._-]*header)`;
const HEADER_ASSIGNMENT = new RegExp(
  `((?:["']?${HEADER_NAME}["']?)[ \\t]*[=:][ \\t]*)(?:[^;\\r\\n]|;(?![ \\t]*(?:["']?${HEADER_NAME}["']?)[ \\t]*[=:]))+`,
  "gi",
);

function hashReference(value: unknown): string {
  let serialized: string;
  try { serialized = JSON.stringify(value) ?? String(value); } catch { serialized = String(value); }
  return `ref:${createHash("sha256").update(serialized).digest("hex").slice(0, 16)}`;
}

function safeScope(value: unknown): string {
  return typeof value === "string" && value.trim() ? `cwd:${hashReference(path.resolve(value)).slice(4)}` : "cwd:unknown";
}

function redactSensitiveText(value: string): string {
  return value
    .replace(HEADER_ASSIGNMENT, "$1[REDACTED]")
    .replace(/\bBearer\s+[^\s,;}]+/gi, "Bearer [REDACTED]")
    .replace(/\bBasic\s+[^\s,;}]+/gi, "Basic [REDACTED]")
    .replace(/((?:authorization|x-api-key|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|password|secret|token)\s*[=:]\s*[\"']?)[^\s,;}\"']+/gi, "$1[REDACTED]")
    .replace(/((?:cookie|set[-_ ]?cookie)\s*:\s*)[^\n]+/gi, "$1[REDACTED]")
    .replace(/(\"(?:authorization|x-api-key|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|password|secret|token|cookie|set-cookie)\"\s*:\s*\")[^\"]*(\")/gi, "$1[REDACTED]$2")
    .replace(/(^|[\s(\"'=])(?:\/(?![\/\s])|[A-Za-z]:\\)[^\s\"'`,;)}]+/g, "$1[PATH]");
}

/** Strictly project provider/tool values; unsafe fields and nested diagnostics are omitted. */
function projectSafeValue(value: unknown): SafeProjection {
  // Tool output has no package-level schema. Do not recursively expose unknown
  // objects: a diagnostic can be hidden at any nesting level or in a string.
  // The hash is only a correlation reference and is not a reversible payload.
  let type: string;
  let length = 0;
  if (value === null) type = "null";
  else if (Array.isArray(value)) { type = "array"; length = value.length; }
  else if (typeof value === "string") { type = "string"; length = value.length; }
  else if (typeof value === "number") type = "number";
  else if (typeof value === "boolean") type = "boolean";
  else if (typeof value === "undefined") type = "undefined";
  else if (typeof value === "bigint") type = "bigint";
  else { type = "object"; try { length = Object.keys(value as object).length; } catch { length = 0; } }
  return { type, length, hash: hashReference(value) };
}

function safeResultProjection(value: unknown): SafeProjection | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => !["type", "length", "hash"].includes(key))) return undefined;
  const type = value.type;
  const length = value.length;
  const hash = value.hash;
  if (typeof type !== "string" || !["null", "array", "string", "number", "boolean", "undefined", "bigint", "object"].includes(type) ||
      !Number.isInteger(length) || (length as number) < 0 || typeof hash !== "string" || !/^ref:[a-f0-9]{16}$/.test(hash)) return undefined;
  return { type, length, hash };
}

function projectToolArguments(value: unknown): SafeProjection {
  if (!isRecord(value)) return { kind: "value", ref: hashReference(value) };
  // Field names can themselves disclose diagnostic/task vocabulary. Keep only
  // bounded cardinality plus a reference; never expose argument values or keys.
  return { kind: "structured", fieldCount: Object.keys(value).length, ref: hashReference(value) };
}

function safeModel(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const model = value.trim();
  // Model IDs are identifiers, not provider diagnostics or free-form text.
  return /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/.test(model) ? model : undefined;
}

function safeIdentifier(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/.test(value)) return fallback;
  return value;
}

function safeText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? redactSensitiveText(value).slice(0, 16_384) : fallback;
}

function scrubBlockedText(value: string, blockedTexts: readonly string[]): string {
  let scrubbed = value;
  for (const blocked of blockedTexts) {
    if (blocked.trim()) scrubbed = scrubbed.split(blocked).join("[TASK_OR_PROMPT_OMITTED]");
  }
  return redactSensitiveText(scrubbed).slice(0, 16_384);
}

function projectContentPart(part: unknown, blockedTexts: readonly string[]): Record<string, unknown> | undefined {
  if (typeof part === "string") return { type: "text", text: scrubBlockedText(part, blockedTexts) };
  if (!isRecord(part) || typeof part.type !== "string") return undefined;
  if (part.type === "text" && typeof part.text === "string") return { type: "text", text: scrubBlockedText(part.text, blockedTexts) };
  if (part.type === "toolCall") {
    const projected: Record<string, unknown> = { type: "toolCall" };
    if (typeof part.id === "string") projected.id = safeIdentifier(part.id, "unknown");
    if (typeof part.name === "string") projected.name = safeIdentifier(part.name, "unknown");
    projected.arguments = projectToolArguments(part.arguments ?? {});
    return projected;
  }
  return undefined;
}

function projectToolResult(event: Record<string, unknown>): ToolResultProjection {
  const rawResult = event.result;
  return {
    toolCallId: typeof event.toolCallId === "string" ? safeIdentifier(event.toolCallId, "unknown") : "unknown",
    toolName: typeof event.toolName === "string" ? safeIdentifier(event.toolName, "unknown") : "unknown",
    isError: event.isError === true,
    result: projectSafeValue(rawResult),
    resultHash: hashReference(rawResult),
  };
}

function projectMessage(message: unknown, blockedTexts: readonly string[] = []): Message {
  const raw = isRecord(message) ? message : {};
  const role = raw.role === "assistant" || raw.role === "user" || raw.role === "toolResult" ? raw.role : "assistant";
  const projected: Record<string, unknown> = { role };
  // Non-assistant messages are protocol material, not child output. Keeping
  // their content would make tool/provider payloads a side door into details.
  if (role !== "assistant") return projected as unknown as Message;
  if (typeof raw.content === "string") projected.content = scrubBlockedText(raw.content, blockedTexts);
  else if (Array.isArray(raw.content)) projected.content = raw.content.map((part) => projectContentPart(part, blockedTexts)).filter(Boolean);
  if (projected.role === "assistant") {
    const model = safeModel(raw.model);
    if (model) projected.model = model;
    if (typeof raw.stopReason === "string" && SAFE_STOP_REASONS.has(raw.stopReason)) projected.stopReason = raw.stopReason;
    if (typeof raw.errorMessage === "string") projected.errorMessage = safeError(raw.errorMessage);
    if (isRecord(raw.usage)) {
      const usage: Record<string, unknown> = {};
      for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
        if (typeof raw.usage[key] === "number" && Number.isFinite(raw.usage[key])) usage[key] = raw.usage[key];
      }
      if (isRecord(raw.usage.cost) && typeof raw.usage.cost.total === "number" && Number.isFinite(raw.usage.cost.total)) usage.cost = { total: raw.usage.cost.total };
      projected.usage = usage;
    }
  }
  return projected as unknown as Message;
}

function safeLifecycleFailureReason(reason: string): string {
  switch (reason) {
    case "child graceful shutdown cannot be proven":
    case "child pid cannot be proven":
    case "child callback rejected binding":
    case "side-effect fence child binding rejected":
    case "side-effect fence handshake cannot be proven":
    case "child lifecycle binding timeout":
    case "side-effect fence watchdog failed":
    case "fenced task delivery failed":
      return reason;
    default:
      return "child lifecycle binding failed";
  }
}

function safeFailureMessage(value: unknown, kind: FailureKind): string | undefined {
  if (kind === "success") return undefined;
  if (kind === "incomplete") return "output truncated";
  if (kind === "cancelled") return "cancelled";
  if (typeof value === "string" && [
    "session cleanup pending", "session cleanup state cannot be verified", "Pi protocol validation failed",
    "cancelled", "child process error", "child lifecycle binding failed", "child graceful shutdown cannot be proven",
    "child pid cannot be proven", "child callback rejected binding", "side-effect fence child binding rejected",
    "side-effect fence handshake cannot be proven", "child lifecycle binding timeout", "side-effect fence watchdog failed",
    "fenced task delivery failed",
  ].includes(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const classified = safeError(value);
    if (classified) return classified;
  }
  if (kind === "task_failure") return "task failure";
  if (kind === "non_transient_provider" || kind === "transient_provider") return "provider request failed";
  return "child process failed";
}

function safeDiagnostics(value: unknown): AttemptDiagnostics | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => !["toolErrorCount", "providerErrorCount"].includes(key))) return undefined;
  const toolErrorCount = value.toolErrorCount;
  const providerErrorCount = value.providerErrorCount;
  if (!Number.isSafeInteger(toolErrorCount) || (toolErrorCount as number) < 0 ||
      !Number.isSafeInteger(providerErrorCount) || (providerErrorCount as number) < 0) return undefined;
  return { toolErrorCount: toolErrorCount as number, providerErrorCount: providerErrorCount as number };
}

function safeUsage(value: unknown): UsageStats {
  const raw = isRecord(value) ? value : {};
  const number = (key: string) => typeof raw[key] === "number" && Number.isFinite(raw[key]) ? raw[key] as number : 0;
  return { input: number("input"), output: number("output"), cacheRead: number("cacheRead"), cacheWrite: number("cacheWrite"), cost: number("cost"), contextTokens: number("contextTokens"), turns: number("turns") };
}

/** Project an attempt through an allowlist; callers use this at every result/details boundary. */
export function sanitizeAttemptResult(value: AttemptResult, requestedModel?: string, blockedTexts: readonly string[] = []): AttemptResult {
  const failureKind: FailureKind = ["success", "incomplete", "transient_provider", "non_transient_provider", "task_failure", "cancelled", "unknown_transport"].includes(value.failureKind) ? value.failureKind : "unknown_transport";
  const requested = safeModel(requestedModel ?? value.requestedModel) ?? "unknown";
  const actual = safeModel(value.actualModel) ?? "unknown";
  const projected: AttemptResult = {
    agent: safeIdentifier(value.agent, "unknown"),
    agentSource: value.agentSource === "user" || value.agentSource === "project" ? value.agentSource : "unknown",
    exitCode: typeof value.exitCode === "number" || value.exitCode === null ? value.exitCode : null,
    messages: Array.isArray(value.messages) ? value.messages.map((message) => projectMessage(message, blockedTexts)) : [],
    toolResults: Array.isArray(value.toolResults) ? value.toolResults.slice(0, 100).map((item) => ({
      toolCallId: safeIdentifier(item?.toolCallId, "unknown"),
      toolName: safeIdentifier(item?.toolName, "unknown"),
      isError: item?.isError === true,
      result: safeResultProjection(item?.result) ?? projectSafeValue(item?.result),
      resultHash: typeof item?.resultHash === "string" && /^ref:[a-f0-9]{16}$/.test(item.resultHash) ? item.resultHash : hashReference(item?.result),
    })) : [],
    usage: safeUsage(value.usage),
    requestedModel: requested,
    actualModel: actual,
    source: value.source === "retry" || value.source === "fallback" || value.source === "user_override" ? value.source : "initial",
    attempt: Number.isInteger(value.attempt) && value.attempt >= 0 ? value.attempt : 0,
    phase: value.phase === "running" || value.phase === "finished" ? value.phase : undefined,
    diagnostics: safeDiagnostics(value.diagnostics),
    stopReason: typeof value.stopReason === "string" && SAFE_STOP_REASONS.has(value.stopReason) ? value.stopReason : undefined,
    errorMessage: safeFailureMessage(value.errorMessage, failureKind),
    failureKind,
    sessionId: typeof value.sessionId === "string" ? safeIdentifier(value.sessionId, "unknown") : undefined,
    cwdScope: typeof value.cwdScope === "string" && /^cwd:[a-f0-9]{16}$/.test(value.cwdScope) ? value.cwdScope : "cwd:unknown",
  };
  markRetryClassification(projected, retryClassificationOf(value));
  return projected;
}

function appendMessage(result: AttemptResult, message: Message, blockedTexts: readonly string[]): void {
  result.messages.push(projectMessage(message, blockedTexts));
  if (message.role !== "assistant") return;
  result.usage.turns += 1;
  const usage = (message as any).usage;
  if (usage) {
    result.usage.input += usage.input || 0;
    result.usage.output += usage.output || 0;
    result.usage.cacheRead += usage.cacheRead || 0;
    result.usage.cacheWrite += usage.cacheWrite || 0;
    result.usage.cost += usage.cost?.total || 0;
    result.usage.contextTokens = usage.totalTokens || 0;
  }
  result.stopReason = SAFE_STOP_REASONS.has((message as any).stopReason) ? (message as any).stopReason : undefined;
}

export async function runPiAttempt(options: RunAttemptOptions): Promise<AttemptResult> {
  const result: AttemptResult = {
    agent: options.agent.name,
    agentSource: options.agent.source,
    exitCode: null,
    messages: [],
    toolResults: [],
    usage: emptyUsage(),
    requestedModel: options.model ?? "unknown",
    actualModel: "unknown",
    source: options.source,
    attempt: options.attempt,
    phase: "running",
    diagnostics: { toolErrorCount: 0, providerErrorCount: 0 },
    failureKind: "unknown_transport",
    sessionId: options.childSessionId,
    cwdScope: safeScope(options.cwd),
  };
  const failClosed = (reason: string): AttemptResult => { result.phase = "finished"; result.failureKind = "unknown_transport"; result.errorMessage = reason; return sanitizeAttemptResult(result, options.model, [options.task, options.agent.systemPrompt]); };
  if (options.sideEffectFence && !sideEffectFenceClientProofValid(options.sideEffectFence)) return failClosed("side-effect fence deployment proof is unavailable");
  if (options.sideEffectFence && typeof options.onChildProcess !== "function") return failClosed("side-effect fence child callback is unavailable");
  const args = ["--mode", "json", "-p"];
  if (options.sessionFile) args.push("--session", path.resolve(options.sessionFile));
  else args.push("--session-dir", options.sessionDir, "--session-id", options.childSessionId);
  if (options.model) args.push("--model", options.model);
  if (options.agent.tools?.length && !options.sideEffectFence) args.push("--tools", options.agent.tools.join(","));
  if (options.sideEffectFence) {
    args.push("--no-tools");
    // Pi's CLI contract is explicit: --no-tools disables every active tool;
    // repeated -e flags are loaded in argument order. The fence is appended
    // last and the task is sent over stdin so private prompt text is absent
    // from argv. The v1 path above remains byte-for-byte unchanged.
    args.push("--no-extensions");
    for (const extension of options.sideEffectFence.extensions) args.push("-e", extension);
    args.push("-e", options.sideEffectFence.interceptor);
  }
  let promptFile: { dir: string; file: string } | undefined;
  let stdout = "";
  let rawStderr = "";
  let sawHeader = false;
  let headerId: string | undefined;
  let headerCwd: string | undefined;
  let terminal: any;
  let malformed = false;
  let lifecycleFailureReason: string | undefined;
  let processFailure = false;
  let wasAborted = Boolean(options.signal?.aborted);
  let settledAborted = false;

  const blockedTexts = [options.task, options.agent.systemPrompt];
  const notify = () => options.onUpdate?.(sanitizeAttemptResult(result, options.model, blockedTexts));
  const processLine = (line: string) => {
    if (!line.trim()) return;
    let event: any;
    try { event = JSON.parse(line); } catch { malformed = true; return; }
    if (!isRecord(event)) { malformed = true; return; }
    if (!sawHeader) {
      if (!validWireSessionHeader(event, options.childSessionId, options.cwd)) { malformed = true; return; }
      sawHeader = true;
      headerId = event.id;
      headerCwd = event.cwd;
      return;
    }
    if (!validJsonEvent(event)) { malformed = true; return; }
    if (event.type === "agent_settled" && event.aborted) settledAborted = true;
    if (event.type === "message_start" && event.message?.role === "assistant") {
      terminal = undefined;
    }
    if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
      terminal = undefined;
    }
    if (event.type === "message_end") {
      if (!isRecord(event.message) || typeof event.message.role !== "string") { malformed = true; return; }
      if (event.message.role === "assistant" && !Array.isArray(event.message.content)) { malformed = true; return; }
      appendMessage(result, event.message as Message, blockedTexts);
      // A tool-use assistant message is an intermediate turn, not terminal JSON.
      if (event.message.role === "assistant") {
        if (["stop", "length", "error", "aborted"].includes(event.message.stopReason)) {
          terminal = event.message;
          result.actualModel = safeModel(event.message.model) ?? "unknown";
          if (event.message.stopReason === "error") result.diagnostics!.providerErrorCount += 1;
        } else {
          terminal = undefined;
        }
      }
      notify();
    }
    if (event.type === "tool_execution_end") {
      if (event.isError === true) result.diagnostics!.toolErrorCount += 1;
      // Pi exposes the completed tool result on this event. Keep only
      // its bounded projection; presence alone is not enough for reviewable output.
      if (!Object.prototype.hasOwnProperty.call(event, "result")) malformed = true;
      else {
        result.toolResults.push(projectToolResult(event));
        notify();
      }
    }
  };

  try {
    if (options.signal?.aborted) {
      result.phase = "finished";
      result.failureKind = "cancelled";
      result.errorMessage = "cancelled";
      return sanitizeAttemptResult(result, options.model, blockedTexts);
    }
    promptFile = await writeSystemPrompt(options.agent);
    if (promptFile) args.push("--append-system-prompt", promptFile.file);
    if (!options.sideEffectFence) args.push(options.task);
    const invocation = getPiInvocation(args);
    const spawnProcess = options.spawn ?? nodeSpawn;
    let proc: JsonProcess;
    try {
      proc = spawnProcess(invocation.command, invocation.args, {
        cwd: options.cwd,
        shell: false,
        stdio: options.sideEffectFence ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
        env: options.sideEffectFence ? { ...(options.env ?? createChildEnvironment({ agent: options.agent, firstLogicalChildSpawn: options.firstLogicalChildSpawn, parentSessionRequestedFast: options.parentFastRequested })), ...sideEffectFenceEnvironment(options.sideEffectFence) } : options.env ?? createChildEnvironment({
          agent: options.agent,
          firstLogicalChildSpawn: options.firstLogicalChildSpawn,
          parentSessionRequestedFast: options.parentFastRequested,
        }),
      }) as unknown as JsonProcess;
    } catch {
      result.phase = "finished";
      result.failureKind = "unknown_transport";
      result.errorMessage = "child process could not be started";
      return sanitizeAttemptResult(result, options.model, blockedTexts);
    }
    let fencedLifecycleFailed = false;
    const fenceTimeoutMs = options.sideEffectFence?.timeoutMs ?? SIDE_EFFECT_FENCE_TIMEOUT_MS;
    await new Promise<void>((resolve) => {
      let buffer = "";
      let processClosed = false;
      let registrationFailed = false;
      let settled = false;
      let forceSettleTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (code: number | null = null) => {
        if (settled) return;
        settled = true;
        if (forceSettleTimer) clearTimeout(forceSettleTimer);
        result.exitCode = code;
        if (buffer.trim()) processLine(buffer);
        resolve();
      };
      const finishAfterGracefulTeardown = async (code: number | null) => {
        if (!options.sideEffectFence || !options.sideEffectFence.awaitGraceful) { finish(code); return; }
        const graceful = await options.sideEffectFence.awaitGraceful(fenceTimeoutMs);
        if (!graceful) {
          fencedLifecycleFailed = true;
          lifecycleFailureReason = "child graceful shutdown cannot be proven";
        }
        finish(code);
      };
      const terminate = (reason: string, cancelled = false) => {
        if (cancelled) wasAborted = true;
        if (options.sideEffectFence) fencedLifecycleFailed = true;
        registrationFailed = true;
        lifecycleFailureReason = cancelled ? "cancelled" : safeLifecycleFailureReason(reason);
        try { (proc.stdin as any)?.destroy?.(); } catch { /* already closed */ }
        try { proc.kill("SIGTERM"); } catch { /* process already gone */ }
        forceSettleTimer = setTimeout(() => {
          try { if (!proc.killed) proc.kill("SIGKILL"); } catch { /* process already gone */ }
          finish(null);
        }, 5_000);
        forceSettleTimer.unref();
      };
      const lifecycle = async (): Promise<void> => {
        if (typeof proc.pid !== "number" || proc.pid <= 0) {
          if (options.sideEffectFence) throw new Error("child pid cannot be proven");
          return;
        }
        const child = { pid: proc.pid, identity: options.childSessionId, ...(options.sessionFile ? { sessionPath: path.resolve(options.sessionFile) } : {}) };
        const callbackResult = await options.onChildProcess?.(child);
        if (callbackResult === false) throw new Error("child callback rejected binding");
        if (options.sideEffectFence) {
          const client = options.sideEffectFence;
          const bindResult = await client.bindChild!(child.pid, child.identity);
          if (bindResult === false) throw new Error("side-effect fence child binding rejected");
          if (!await client.awaitHandshake!(fenceTimeoutMs)) throw new Error("side-effect fence handshake cannot be proven");
        }
      };
      const lifecycleTimeout = options.sideEffectFence ? new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("child lifecycle binding timeout")), fenceTimeoutMs);
        timer.unref();
      }) : undefined;
      let childRegistration = (options.sideEffectFence ? Promise.race([lifecycle(), lifecycleTimeout!]) : lifecycle()).catch(() => {
        terminate("child lifecycle binding failed");
      });
      if (options.sideEffectFence?.failure) {
        void options.sideEffectFence.failure.then(() => terminate("side-effect fence watchdog failed"), () => terminate("side-effect fence watchdog failed"));
      }
      proc.stdout.on("data", (data: Buffer | string) => {
        stdout += data.toString();
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });
      proc.stderr.on("data", (data: Buffer | string) => { rawStderr += data.toString(); });
      proc.on("error", () => { processClosed = true; processFailure = true; finish(null); });
      proc.on("close", (code) => {
        processClosed = true;
        childRegistration.then(() => { void finishAfterGracefulTeardown(code); });
      });
      // A fenced child receives no task bytes until the durable child binding,
      // the client-owned channel bind, and the client-owned hello/ACK have all
      // completed. The runner owns this sequence; the callback only persists
      // the generic child binding and cannot satisfy the fence by itself.
      childRegistration.then(() => {
        if (registrationFailed || processClosed || proc.killed || !proc.stdin || fencedLifecycleFailed) return;
        if (options.sideEffectFence) {
          try { proc.stdin.write(options.task); proc.stdin.end(); } catch { terminate("fenced task delivery failed"); }
        } else {
          proc.stdin?.end();
        }
      });
      const abort = () => terminate("cancelled", true);
      if (options.signal) {
        if (options.signal.aborted) abort();
        else options.signal.addEventListener("abort", abort, { once: true });
      }
    });
    if (fencedLifecycleFailed) {
      try { await options.sideEffectFence?.close?.("runner_fenced_lifecycle_failure"); } catch { /* cleanup remains fail closed */ }
    }

    const validHeader = sawHeader && headerId === options.childSessionId && path.resolve(headerCwd!) === path.resolve(options.cwd);
    const finalErrorMessage = terminal?.stopReason === "error" && typeof terminal.errorMessage === "string" ? terminal.errorMessage : undefined;
    const finalStatus = terminal?.stopReason === "error" ? extractStatus(terminal) : undefined;
    if (wasAborted) result.failureKind = "cancelled";
    else if (stdout.trim().length === 0 || !validHeader || malformed || lifecycleFailureReason !== undefined || processFailure || !terminal || result.exitCode === null) result.failureKind = "unknown_transport";
    else if (settledAborted) result.failureKind = result.exitCode === 0 ? "cancelled" : "unknown_transport";
    else if (terminal.stopReason === "aborted") result.failureKind = "cancelled";
    else if (terminal.stopReason === "error") result.failureKind = classifyProviderError({ errorMessage: finalErrorMessage, status: finalStatus });
    else if (result.exitCode !== 0) result.failureKind = "unknown_transport";
    else if (terminal.stopReason === "length") result.failureKind = "incomplete";
    else result.failureKind = "success";
    const diagnostic = safeError(finalErrorMessage ?? "", finalStatus);
    result.phase = "finished";
    result.errorMessage = result.failureKind === "success" ? undefined : wasAborted ? "cancelled" : lifecycleFailureReason ?? (processFailure ? "child process error" : undefined) ?? (malformed ? "Pi protocol validation failed" : diagnostic ?? safeFailureMessage(undefined, result.failureKind));
    markRetryClassification(result, result.failureKind === "transient_provider" ? "transient_provider" : "not_retryable");
    return sanitizeAttemptResult(result, options.model, blockedTexts);
  } finally {
    if (promptFile) {
      await fs.promises.rm(promptFile.dir, { recursive: true, force: true });
    }
  }
}
