import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig } from "./agents.ts";
import { createChildEnvironment } from "./fast-inheritance.ts";
import { markRetryClassification, retryClassificationOf } from "./retry-classification.ts";

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
  onChildProcess?: (child: { pid: number; identity: string; sessionPath?: string }) => void | Promise<void>;
  spawn?: typeof nodeSpawn;
}

interface JsonProcess {
  pid?: number;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  on(event: "close", listener: (code: number | null, signal?: NodeJS.Signals | null) => void): JsonProcess;
  on(event: "error", listener: (error: Error) => void): JsonProcess;
  kill(signal?: NodeJS.Signals): boolean;
  killed?: boolean;
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

export async function validateSessionFile(file: string, sessionId: string, cwd: string): Promise<boolean> {
  try {
    const lines = (await fs.promises.readFile(file, "utf8")).split(/\r?\n/);
    let header: Record<string, unknown> | undefined;
    for (const line of lines) {
      if (!line.trim()) continue;
      const record: unknown = JSON.parse(line);
      if (!isRecord(record)) return false;
      if (!header) {
        header = record;
        if (header.type !== "session" || header.id !== sessionId || typeof header.cwd !== "string" || path.resolve(header.cwd) !== path.resolve(cwd)) return false;
      }
    }
    return header !== undefined;
  } catch {
    // Any truncated or otherwise invalid JSONL record makes the session
    // untrusted. Callers must quarantine it rather than resume or spawn.
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

function safeFailureMessage(value: unknown, kind: FailureKind): string | undefined {
  if (kind === "success") return undefined;
  if (kind === "incomplete") return "output truncated";
  if (kind === "cancelled") return "cancelled";
  if (value === "session cleanup pending" || value === "session cleanup state cannot be verified") return value;
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
  const args = ["--mode", "json", "-p"];
  if (options.sessionFile) args.push("--session", path.resolve(options.sessionFile));
  else args.push("--session-dir", options.sessionDir, "--session-id", options.childSessionId);
  if (options.model) args.push("--model", options.model);
  if (options.agent.tools?.length) args.push("--tools", options.agent.tools.join(","));
  let promptFile: { dir: string; file: string } | undefined;
  let stdout = "";
  let rawStderr = "";
  let sawHeader = false;
  let headerId: string | undefined;
  let headerCwd: string | undefined;
  let terminal: any;
  let malformed = false;
  let wasAborted = Boolean(options.signal?.aborted);

  const blockedTexts = [options.task, options.agent.systemPrompt];
  const notify = () => options.onUpdate?.(sanitizeAttemptResult(result, options.model, blockedTexts));
  const processLine = (line: string) => {
    if (!line.trim()) return;
    let event: any;
    try { event = JSON.parse(line); } catch { malformed = true; return; }
    if (!isRecord(event)) { malformed = true; return; }
    if (!sawHeader) {
      if (event.type !== "session" || typeof event.id !== "string" || typeof event.cwd !== "string") { malformed = true; return; }
      sawHeader = true;
      headerId = event.id;
      headerCwd = event.cwd;
      return;
    }
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
      // Pi 0.84.4 exposes the completed tool result on this event. Keep only
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
    args.push(options.task);
    const invocation = getPiInvocation(args);
    const spawnProcess = options.spawn ?? nodeSpawn;
    let proc: JsonProcess;
    try {
      proc = spawnProcess(invocation.command, invocation.args, {
        cwd: options.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: options.env ?? createChildEnvironment({
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
    await new Promise<void>((resolve) => {
      let buffer = "";
      let childRegistration = Promise.resolve();
      if (typeof proc.pid === "number" && proc.pid > 0) {
        childRegistration = Promise.resolve(options.onChildProcess?.({
          pid: proc.pid,
          identity: options.childSessionId,
          ...(options.sessionFile ? { sessionPath: path.resolve(options.sessionFile) } : {}),
        })).catch(() => {
          malformed = true;
          try { proc.kill("SIGTERM"); } catch { /* process already gone */ }
        });
      }
      proc.stdout.on("data", (data: Buffer | string) => {
        stdout += data.toString();
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });
      proc.stderr.on("data", (data: Buffer | string) => { rawStderr += data.toString(); });
      proc.on("error", () => { malformed = true; childRegistration.then(resolve); });
      proc.on("close", (code) => {
        childRegistration.then(() => {
          result.exitCode = code;
          if (buffer.trim()) processLine(buffer);
          resolve();
        });
      });
      const abort = () => {
        wasAborted = true;
        try { proc.kill("SIGTERM"); } catch { /* process already gone */ }
        setTimeout(() => { if (!proc.killed) try { proc.kill("SIGKILL"); } catch { /* ignore */ } }, 5000).unref();
      };
      if (options.signal) {
        if (options.signal.aborted) abort();
        else options.signal.addEventListener("abort", abort, { once: true });
      }
    });

    const validHeader = sawHeader && headerId === options.childSessionId && path.resolve(headerCwd!) === path.resolve(options.cwd);
    const finalErrorMessage = terminal?.stopReason === "error" && typeof terminal.errorMessage === "string" ? terminal.errorMessage : undefined;
    const finalStatus = terminal?.stopReason === "error" ? extractStatus(terminal) : undefined;
    if (wasAborted) result.failureKind = "cancelled";
    else if (stdout.trim().length === 0 || !validHeader || malformed || !terminal || result.exitCode === null) result.failureKind = "unknown_transport";
    else if (terminal.stopReason === "aborted") result.failureKind = "cancelled";
    else if (terminal.stopReason === "error") result.failureKind = classifyProviderError({ errorMessage: finalErrorMessage, status: finalStatus });
    else if (result.exitCode !== 0) result.failureKind = "unknown_transport";
    else if (terminal.stopReason === "length") result.failureKind = "incomplete";
    else result.failureKind = "success";
    const diagnostic = safeError(finalErrorMessage ?? "", finalStatus);
    result.phase = "finished";
    result.errorMessage = result.failureKind === "success" ? undefined : diagnostic ?? safeFailureMessage(undefined, result.failureKind);
    markRetryClassification(result, result.failureKind === "transient_provider" ? "transient_provider" : "not_retryable");
    return sanitizeAttemptResult(result, options.model, blockedTexts);
  } finally {
    if (promptFile) {
      await fs.promises.rm(promptFile.dir, { recursive: true, force: true });
    }
  }
}
