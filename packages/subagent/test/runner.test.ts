import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runPiAttempt, sanitizeAttemptResult, validateSessionFile } from "../src/runner.ts";
import type { AgentConfig } from "../src/agents.ts";

const agent: AgentConfig = { name: "implementer", description: "test", source: "user", filePath: "/tmp/a.md", systemPrompt: "" };
function fakeProcess(lines: string[], code: number | null = 0, stderr = ""): any {
  const process = new EventEmitter() as any;
  process.pid = 12345;
  process.stdout = new PassThrough(); process.stderr = new PassThrough(); process.killed = false;
  process.kill = () => { process.killed = true; return true; };
  queueMicrotask(() => { for (const line of lines) process.stdout.write(`${JSON.stringify(line)}\n`); if (stderr) process.stderr.write(stderr); process.stdout.end(); process.stderr.end(); process.emit("close", code); });
  return process;
}
function fakeRawProcess(output: string, code: number | null = 0): any {
  const process = new EventEmitter() as any;
  process.pid = 12345;
  process.stdout = new PassThrough(); process.stderr = new PassThrough(); process.killed = false;
  process.kill = () => { process.killed = true; return true; };
  queueMicrotask(() => { process.stdout.write(output); process.stdout.end(); process.stderr.end(); process.emit("close", code); });
  return process;
}
async function options(root: string, lines: any[], code = 0, stderr = ""): Promise<any> {
  return {
    cwd: "/tmp/project", agent, task: "work", model: "m", attempt: 1, source: "initial", sessionDir: root, childSessionId: "child-1", firstLogicalChildSpawn: true, parentFastRequested: false,
    spawn: () => fakeProcess(lines, code, stderr),
  };
}
function header(cwd = "/tmp/project") { return { type: "session", version: 3, id: "child-1", cwd, timestamp: new Date().toISOString() }; }
function usage() { return { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }; }
function assistantMessage(stopReason = "stop", extra: Record<string, unknown> = {}) { return { role: "assistant", content: [{ type: "text", text: "done" }], api: "openai-completions", provider: "openai", model: "m", usage: usage(), stopReason, timestamp: Date.now(), ...extra }; }
function terminal(stopReason = "stop", extra: Record<string, unknown> = {}) { return { type: "message_end", message: assistantMessage(stopReason, extra) }; }
function toolResultMessage(extra: Record<string, unknown> = {}) { return { role: "toolResult", toolCallId: "1", toolName: "read", content: [{ type: "text", text: "provider result" }], isError: false, timestamp: Date.now(), ...extra }; }

test("attempt projection excludes task, cwd, stderr and preserves only a safe cwd scope", () => {
  const projected = sanitizeAttemptResult({
    agent: "implementer", agentSource: "user", task: "FULL PROMPT", cwd: "/Users/private/project", stderr: "Cookie: session=secret",
    exitCode: 0, messages: [], toolResults: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    requestedModel: "model-a", actualModel: "unknown", source: "initial", attempt: 1, failureKind: "success",
  } as any);
  assert.equal(Object.prototype.hasOwnProperty.call(projected, "task"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(projected, "cwd"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(projected, "stderr"), false);
  assert.equal(projected.cwdScope, "cwd:unknown");
  assert.equal(JSON.stringify(projected).includes("FULL PROMPT"), false);
});

test("diagnostic sanitizer allowlists counters and keeps missing legacy counters unknown", () => {
  const base = {
    agent: "implementer", agentSource: "user", exitCode: 0, messages: [], toolResults: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    requestedModel: "model-a", actualModel: "unknown", source: "initial", attempt: 1, failureKind: "success",
    phase: "finished", diagnostics: { toolErrorCount: 2, providerErrorCount: 1, leaked: "secret" },
    cwdScope: "cwd:unknown",
  } as any;
  const projected = sanitizeAttemptResult(base);
  assert.equal(projected.diagnostics, undefined);
  const legacy = sanitizeAttemptResult({ ...base, diagnostics: undefined });
  assert.equal(legacy.diagnostics, undefined);
});

test("session validation parses every JSONL record and rejects a truncated second row", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-test-"));
  const file = path.join(root, "session.jsonl");
  await fs.writeFile(file, `${JSON.stringify(header())}\n{"type":"message_end","message":`);
  assert.equal(await validateSessionFile(file, "child-1", "/tmp/project"), false);
  await fs.writeFile(file, `${JSON.stringify(header())}\n${JSON.stringify({ type: "message_end", message: {} })}\n`);
  assert.equal(await validateSessionFile(file, "child-1", "/tmp/project"), false);
  await fs.writeFile(file, `${JSON.stringify(header())}\n${JSON.stringify(terminal())}\n`);
  assert.equal(await validateSessionFile(file, "child-1", "/tmp/project"), false, "stdout message_end is not an on-disk SessionEntry");
  const validEntry = { type: "message", id: "entry-1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "resumable", timestamp: Date.now() } };
  await fs.writeFile(file, `${JSON.stringify(header())}\n${JSON.stringify(validEntry)}\n`);
  assert.equal(await validateSessionFile(file, "child-1", "/tmp/project"), true, "real SessionEntry remains resumable");
  const v1Header = { type: "session", id: "child-1", cwd: "/tmp/project", timestamp: new Date().toISOString() };
  await fs.writeFile(file, `${JSON.stringify(v1Header)}\n${JSON.stringify({ type: "message", timestamp: new Date().toISOString(), message: { role: "user", content: "historical", timestamp: Date.now() } })}\n`);
  assert.equal(await validateSessionFile(file, "child-1", "/tmp/project"), true, "historical on-disk version 1");
  const v2Entry = { type: "message", id: "entry-1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "historical", timestamp: Date.now() } };
  await fs.writeFile(file, `${JSON.stringify({ ...header(), version: 2 })}\n${JSON.stringify(v2Entry)}\n`);
  assert.equal(await validateSessionFile(file, "child-1", "/tmp/project"), true, "historical on-disk version 2");
  const legacyV1Header = { ...v1Header, provider: "openai", modelId: "m", thinkingLevel: "off", branchedFrom: "parent" };
  await fs.writeFile(file, `${JSON.stringify(legacyV1Header)}\n${JSON.stringify({ type: "message", timestamp: new Date().toISOString(), message: { role: "user", content: "legacy", timestamp: Date.now() } })}\n`);
  assert.equal(await validateSessionFile(file, "child-1", "/tmp/project"), true, "historical v1 header without version and with legacy fields");
  await fs.writeFile(file, `${JSON.stringify(header())}\n${JSON.stringify({ type: "tool_execution_end", toolCallId: "1", toolName: "read", isError: false })}\n`);
  assert.equal(await validateSessionFile(file, "child-1", "/tmp/project"), false);
  await fs.writeFile(file, `${JSON.stringify(header())}\n${JSON.stringify({ type: "tool_execution_end", toolCallId: "1", toolName: "read", result: {}, isError: false, status: 503 })}\n`);
  assert.equal(await validateSessionFile(file, "child-1", "/tmp/project"), false);
  const blank = path.join(root, "blank.jsonl");
  await fs.writeFile(blank, `${JSON.stringify(header())}\n\n`);
  assert.equal(await validateSessionFile(blank, "child-1", "/tmp/project"), false);
  const link = path.join(root, "link.jsonl");
  await fs.symlink(file, link);
  assert.equal(await validateSessionFile(link, "child-1", "/tmp/project"), false);
  assert.equal(await validateSessionFile(path.relative(process.cwd(), file), "child-1", "/tmp/project"), false);
  await fs.rm(root, { recursive: true, force: true });
});

test("session records accept Pi messages and reject schema-valid JSON with missing or mistyped required fields", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-test-"));
  const entry = (message: unknown, id = "entry-1") => ({ type: "message", id, parentId: null, timestamp: new Date().toISOString(), message });
  const user = { role: "user", content: "work", timestamp: Date.now() };
  const tool = toolResultMessage();
  const validFile = path.join(root, "valid-session.jsonl");
  await fs.writeFile(validFile, [header(), entry(user, "user-1"), entry(assistantMessage(), "assistant-1"), entry(tool, "tool-1")].map((record) => JSON.stringify(record)).join("\n") + "\n");
  assert.equal(await validateSessionFile(validFile, "child-1", "/tmp/project"), true);

  const invalidMessages = [
    { ...assistantMessage(), usage: undefined },
    { ...assistantMessage(), usage: { ...usage(), output: "2" } },
    { role: "user", content: "work" },
    { ...toolResultMessage(), isError: "false" },
    { ...toolResultMessage(), toolCallId: 1 },
  ];
  for (const [index, message] of invalidMessages.entries()) {
    const file = path.join(root, `invalid-${index}.jsonl`);
    await fs.writeFile(file, [header(), entry(message, `invalid-${index}`)].map((record) => JSON.stringify(record)).join("\n") + "\n");
    assert.equal(await validateSessionFile(file, "child-1", "/tmp/project"), false, `invalid message ${index} accepted`);
  }
  await fs.rm(root, { recursive: true, force: true });
});

test("real Pi v1, v2, and v3 session fixtures validate only under their own schema", async () => {
  const fixtureRoot = path.join(process.cwd(), "packages/subagent/test/fixtures");
  assert.equal(await validateSessionFile(path.join(fixtureRoot, "session-v1.jsonl"), "fixture-v1", "/tmp/pi-session-fixture"), true);
  assert.equal(await validateSessionFile(path.join(fixtureRoot, "session-v2.jsonl"), "fixture-v2", "/tmp/pi-session-fixture"), true);
  assert.equal(await validateSessionFile(path.join(fixtureRoot, "session-v3.jsonl"), "fixture-v3", "/tmp/pi-session-fixture"), true);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-test-"));
  const file = path.join(root, "mixed.jsonl");
  const v1Header = { type: "session", id: "child-1", cwd: "/tmp/project", timestamp: new Date().toISOString() };
  const v1WithTreeFields = { type: "message", id: "entry-1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "not v1", timestamp: Date.now() } };
  await fs.writeFile(file, [v1Header, v1WithTreeFields].map(JSON.stringify).join("\n") + "\n");
  assert.equal(await validateSessionFile(file, "child-1", "/tmp/project"), false);
  await fs.rm(root, { recursive: true, force: true });
});

test("runner rejects a truncated JSONL record after a valid header", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-test-"));
  const output = `${JSON.stringify(header())}\n{"type":"message_end","message":`;
  const attempt = await runPiAttempt({ ...(await options(root, [])), spawn: () => fakeRawProcess(output) });
  assert.equal(attempt.failureKind, "unknown_transport");
  await fs.rm(root, { recursive: true, force: true });
});

test("JSON mode accepts message_end and tool_execution_end protocol, not obsolete tool_result_end", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-test-"));
  const attempt = await runPiAttempt(await options(root, [header(), { type: "tool_execution_end", toolCallId: "1", toolName: "read", result: {}, isError: false }, terminal()]));
  assert.equal(attempt.failureKind, "success");
  assert.equal(attempt.messages.length, 1);
  assert.deepEqual(attempt.toolResults[0], { toolCallId: "1", toolName: "read", isError: false, result: { type: "object", length: 0, hash: attempt.toolResults[0].resultHash }, resultHash: attempt.toolResults[0].resultHash });
  assert.match(attempt.toolResults[0].resultHash, /^ref:[a-f0-9]{16}$/);
  await fs.rm(root, { recursive: true, force: true });
});

test("JSON mode retains Pi turn and update event protocol while validating complete messages", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-test-"));
  const attempt = await runPiAttempt(await options(root, [
    header(),
    { type: "agent_start" },
    { type: "turn_start" },
    { type: "message_start", message: { ...assistantMessage("pending"), content: [] } },
    { type: "message_update", usage: usage(), assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
    terminal(),
    { type: "turn_end", message: assistantMessage(), toolResults: [] },
    { type: "agent_end", messages: [assistantMessage()], willRetry: false },
    { type: "agent_settled" },
  ]));
  assert.equal(attempt.failureKind, "success");
  await fs.rm(root, { recursive: true, force: true });
});

test("JSON mode accepts the complete Pi 0.84.4 session event wire set", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-test-"));
  const entry = { type: "message", id: "entry-1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "queued", timestamp: Date.now() } };
  const compactionResult = {
    summary: "compacted", firstKeptEntryId: "entry-1", tokensBefore: 100, estimatedTokensAfter: 20,
    usage: usage(), details: {},
  };
  const attempt = await runPiAttempt(await options(root, [
    header(),
    { type: "agent_start" }, { type: "turn_start" },
    { type: "queue_update", steering: ["steer"], followUp: ["follow up"] },
    { type: "compaction_start", reason: "threshold" },
    { type: "entry_appended", entry },
    { type: "session_info_changed", name: "child" },
    { type: "thinking_level_changed", level: "high" },
    { type: "bash_execution_update", id: "bash-1", delta: "output" },
    { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "terminated" },
    { type: "auto_retry_end", success: true, attempt: 2 },
    { type: "summarization_retry_scheduled", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "terminated" },
    { type: "summarization_retry_attempt_start", source: "branchSummary" },
    { type: "summarization_retry_attempt_start", source: "compaction", reason: "threshold" },
    { type: "summarization_retry_finished" },
    { type: "compaction_end", reason: "threshold", result: compactionResult, aborted: false, willRetry: false },
    { type: "compaction_end", reason: "overflow", aborted: true, willRetry: false },
    { type: "session_info_changed" },
    terminal(), { type: "turn_end", message: assistantMessage(), toolResults: [] },
    { type: "agent_end", messages: [assistantMessage()], willRetry: false }, { type: "agent_settled" },
  ]));
  assert.equal(attempt.failureKind, "success");
  await fs.rm(root, { recursive: true, force: true });
});

test("JSON event validation fails closed for unknown, mixed, and malformed Pi records", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-test-"));
  const validEntry = { type: "message", id: "entry-1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "work", timestamp: Date.now() } };
  const malformedEvents = [
    { type: "extension_error", extensionPath: "/tmp/ext", event: "tool_call", error: "failed" },
    { type: "queue_update", steering: [], followUp: [], extra: true },
    { type: "thinking_level_changed", level: "invalid" },
    { type: "auto_retry_start", attempt: "1", maxAttempts: 3, delayMs: 10, errorMessage: "retry" },
    { type: "summarization_retry_attempt_start", source: "branchSummary", reason: "threshold" },
    { type: "compaction_end", reason: "threshold", result: null, aborted: true, willRetry: false },
    { type: "compaction_end", reason: "threshold", result: { summary: "missing fields" }, aborted: false, willRetry: false },
    { type: "entry_appended", entry: { ...validEntry, message: { role: "assistant", content: [], timestamp: Date.now() } } },
  ];
  for (const event of malformedEvents) {
    const attempt = await runPiAttempt(await options(root, [header(), event, terminal()]));
    assert.equal(attempt.failureKind, "unknown_transport", JSON.stringify(event));
  }
  const mixed = await runPiAttempt(await options(root, [header(), { type: "agent_start" }, validEntry, terminal()]));
  assert.equal(mixed.failureKind, "unknown_transport");
  const badHeaders = [
    { ...header(), version: undefined },
    { ...header(), version: 1 },
    { ...header(), version: 2 },
    { ...header(), timestamp: "1" },
    { ...header(), cwd: "tmp/project" },
    { ...header(), unknown: true },
  ];
  for (const badHeader of badHeaders) {
    const attempt = await runPiAttempt(await options(root, [badHeader, terminal()]));
    assert.equal(attempt.failureKind, "unknown_transport", JSON.stringify(badHeader));
  }
  await fs.rm(root, { recursive: true, force: true });
});

test("resumes with an absolute session path and never sends a missing session id", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-test-"));
  let invocation: string[] = [];
  const sessionFile = path.join(root, "child.jsonl");
  const attempt = await runPiAttempt({ ...(await options(root, [header(), terminal()])), sessionFile,
    spawn: (_command: string, args: string[]) => { invocation = args; return fakeProcess([header(), terminal()]); } });
  assert.equal(attempt.failureKind, "success");
  const sessionIndex = invocation.indexOf("--session");
  assert.ok(sessionIndex >= 0);
  assert.equal(invocation[sessionIndex + 1], path.resolve(sessionFile));
  assert.equal(invocation.includes("--session-id"), false);
  await fs.rm(root, { recursive: true, force: true });
});

test("signal, empty output, missing header, and missing terminal all fail closed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-test-"));
  const cases = [[], [null], [header(), null], [terminal()], [header()], [header(), { type: "message_end", message: { ...assistantMessage(), usage: {} } }],
    [header(), { type: "message_end", message: { ...assistantMessage("toolUse"), content: [{ type: "toolCall", name: "read", arguments: {} }] } }]];
  for (const lines of cases) {
    const attempt = await runPiAttempt(await options(root, lines));
    assert.equal(attempt.failureKind, "unknown_transport");
  }
  const controller = new AbortController(); controller.abort();
  let spawned = false;
  const cancelled = await runPiAttempt({ ...(await options(root, [header(), terminal()])), signal: controller.signal, spawn: () => { spawned = true; return fakeProcess([]); } });
  assert.equal(cancelled.failureKind, "cancelled");
  assert.equal(spawned, false);
  await fs.rm(root, { recursive: true, force: true });
});

test("tool execution events must carry the Pi result field", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-test-"));
  const attempt = await runPiAttempt(await options(root, [header(), { type: "tool_execution_end", isError: false }, terminal()]));
  assert.equal(attempt.failureKind, "unknown_transport");
  await fs.rm(root, { recursive: true, force: true });
});

test("a tool error is bounded process diagnostics and does not fail a normal return", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-test-"));
  const attempt = await runPiAttempt(await options(root, [
    header(),
    { type: "tool_execution_end", toolCallId: "1", toolName: "bash", result: { exitCode: 1 }, isError: true },
    terminal("stop", { content: [{ type: "text", text: "The report is complete." }] }),
  ]));
  assert.equal(attempt.failureKind, "success");
  assert.equal(attempt.phase, "finished");
  assert.deepEqual(attempt.diagnostics, { toolErrorCount: 1, providerErrorCount: 0 });
  assert.equal((attempt.messages[0] as any).content[0].text, "The report is complete.");
  assert.equal(attempt.errorMessage, undefined);
  await fs.rm(root, { recursive: true, force: true });
});

test("a later tool event invalidates an earlier stop candidate", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-test-"));
  const attempt = await runPiAttempt(await options(root, [
    header(), terminal("stop"),
    { type: "tool_execution_start", toolCallId: "1", toolName: "bash", args: {} },
    { type: "tool_execution_end", toolCallId: "1", toolName: "bash", result: {}, isError: false },
  ]));
  assert.equal(attempt.failureKind, "unknown_transport");
  assert.equal(attempt.phase, "finished");
  await fs.rm(root, { recursive: true, force: true });
});

test("an assistant message start after stop requires a new terminal", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-test-"));
  const attempt = await runPiAttempt(await options(root, [
    header(), terminal("stop"), { type: "message_start", message: { ...assistantMessage(), content: [] } },
  ]));
  assert.equal(attempt.failureKind, "unknown_transport");
  await fs.rm(root, { recursive: true, force: true });
});

test("an assistant toolUse message after stop is not a terminal", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-test-"));
  const attempt = await runPiAttempt(await options(root, [
    header(), terminal("stop"), terminal("toolUse", { content: [{ type: "toolCall", id: "1", name: "bash", arguments: {} }] }),
  ]));
  assert.equal(attempt.failureKind, "unknown_transport");
  await fs.rm(root, { recursive: true, force: true });
});

test("an aborted terminal with signal close is unknown transport, not cancelled", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-test-"));
  const attempt = await runPiAttempt(await options(root, [header(), terminal("aborted")], null));
  assert.equal(attempt.failureKind, "unknown_transport");
  await fs.rm(root, { recursive: true, force: true });
});

test("a tool 503 cannot override a final non-transient provider error", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-test-"));
  const attempt = await runPiAttempt(await options(root, [
    header(),
    { type: "tool_execution_end", toolCallId: "1", toolName: "request", result: {}, isError: true },
    terminal("error", { errorMessage: "authentication failed" }),
  ], 1, "HTTP 503 from an old tool result"));
  assert.equal(attempt.failureKind, "non_transient_provider");
  assert.equal(attempt.errorMessage, "provider request failed");
  assert.deepEqual(attempt.diagnostics, { toolErrorCount: 1, providerErrorCount: 1 });
  await fs.rm(root, { recursive: true, force: true });
});

test("a provider error followed by a new stop returns the new assistant report", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-test-"));
  const attempt = await runPiAttempt(await options(root, [
    header(),
    terminal("error", { errorMessage: "fetch failed" }),
    { type: "message_start", message: { ...assistantMessage(), content: [] } },
    terminal("stop", { content: [{ type: "text", text: "Recovered report" }] }),
  ]));
  assert.equal(attempt.failureKind, "success");
  assert.equal(attempt.errorMessage, undefined);
  assert.equal(attempt.diagnostics?.providerErrorCount, 1);
  assert.equal(finalAssistantText(attempt), "Recovered report");
  await fs.rm(root, { recursive: true, force: true });
});

test("length and aborted terminal messages are not normal success", async () => {
  for (const [stopReason, expected] of [["length", "incomplete"], ["aborted", "cancelled"]] as const) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-test-"));
    const attempt = await runPiAttempt(await options(root, [header(), terminal(stopReason)], 0));
    assert.equal(attempt.failureKind, expected);
    assert.equal(attempt.phase, "finished");
    assert.equal((attempt.messages[0] as any).content[0].text, "done");
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("diagnostic counts stay accurate when tool details are capped", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-test-"));
  const toolEvents = Array.from({ length: 101 }, (_, index) => ({
    type: "tool_execution_end", toolCallId: String(index), toolName: "bash", result: { index }, isError: true,
  }));
  const attempt = await runPiAttempt(await options(root, [header(), ...toolEvents, terminal()]));
  assert.equal(attempt.failureKind, "success");
  assert.equal(attempt.toolResults.length, 100);
  assert.equal(attempt.diagnostics?.toolErrorCount, 101);
  await fs.rm(root, { recursive: true, force: true });
});

function finalAssistantText(attempt: { messages: any[] }): string {
  for (let index = attempt.messages.length - 1; index >= 0; index -= 1) {
    const message = attempt.messages[index];
    if (message.role === "assistant") return message.content?.[0]?.text ?? "";
  }
  return "";
}

test("stderr alone cannot classify a provider error", async () => {
  for (const value of ["fetch failed", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "explicit timeout", "HTTP 429", "status 502", "code 503", "response 504"]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-test-"));
    const attempt = await runPiAttempt(await options(root, [header(), terminal("error")], 1, value));
    assert.equal(attempt.failureKind, "non_transient_provider", value);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("provider error is classified without returning raw stderr", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-test-"));
  const attempt = await runPiAttempt(await options(root, [header(), terminal("error", { errorMessage: "fetch failed; Authorization: secret" })]));
  assert.equal(attempt.failureKind, "transient_provider");
  assert.equal(attempt.errorMessage, "fetch failed");
  assert.equal((attempt.messages[0] as any).errorMessage, "fetch failed");
  assert.equal(Object.prototype.hasOwnProperty.call(attempt, "stderr"), false);
  await fs.rm(root, { recursive: true, force: true });
});

test("provider messages are allowlisted and deeply redact nested diagnostics", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-test-"));
  const secret = "super-secret-token-123";
  const message = terminal("stop", {
    model: "provider/actual-model",
    responseId: secret,
    diagnostics: [{ type: "provider", timestamp: Date.now(), details: { headers: { Authorization: `Bearer ${secret}` }, rawBody: { nested: secret } } }],
    content: [
      { type: "text", text: `completed; Authorization: Bearer ${secret}` },
      { type: "toolCall", id: "call-1", name: "request", arguments: { headers: { authorization: secret }, nested: { rawBody: secret, token: secret } } },
    ],
  });
  const attempt = await runPiAttempt(await options(root, [header(), {
    type: "tool_execution_end", toolCallId: "call-1", toolName: "request", isError: false,
    result: { output: `Cookie: session=${secret}`, headers: { "Set-Cookie": secret }, rawBody: { nested: secret }, nested: { value: "safe", cause: { token: secret } } },
  }, {
    type: "message_end",
    message: toolResultMessage({ details: { headers: { Authorization: secret }, token: secret, rawBody: { secret } } }),
  }, message]));
  const serialized = JSON.stringify(attempt);
  assert.equal(attempt.failureKind, "success");
  assert.equal(attempt.requestedModel, "m");
  assert.equal(attempt.actualModel, "provider/actual-model");
  assert.equal(Object.prototype.hasOwnProperty.call(attempt, "task"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(attempt, "cwd"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(attempt, "stderr"), false);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("rawBody"), false);
  assert.equal((attempt.messages[0] as any).details, undefined);
  assert.equal((attempt.messages[1] as any).headers, undefined);
  assert.equal((attempt.messages[1] as any).content[1].arguments.headers, undefined);
  assert.equal((attempt.messages[1] as any).content[1].arguments.ref.startsWith("ref:"), true);
  assert.equal(serialized.includes("/tmp/project"), false);
  assert.equal(attempt.toolResults.length, 1);
  const toolResult = JSON.stringify(attempt.toolResults[0]);
  assert.equal(toolResult.includes(secret), false);
  assert.equal(toolResult.includes("rawBody"), false);
  assert.equal(toolResult.includes("Set-Cookie"), false);
  await fs.rm(root, { recursive: true, force: true });
});

test("review probes redact Cookie= and arbitrary X-/Header assignments while keeping assistant output", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-test-"));
  const cookieSecret = "Cookie_EQUALS_SECRET";
  const setCookieSecret = "SET_COOKIE_EQUALS_SECRET";
  const cookieAttributeSecret = "COOKIE_ATTRIBUTE_SECRET";
  const traceSecret = "X_TRACE_HEADER_SECRET";
  const suffixHeaderSecret = "SUFFIX_HEADER_SECRET";
  const nestedSecret = "NESTED_HEADER_SECRET";
  const updateValues: unknown[] = [];
  const attempt = await runPiAttempt({ ...(await options(root, [header(), terminal("stop", {
    content: [{ type: "text", text: `completed normally; Set-Cookie=one; second=${cookieAttributeSecret}; Set-Cookie=${setCookieSecret}; Cookie=${cookieSecret}; X-Trace-Header: ${traceSecret}; traceHeader=${suffixHeaderSecret}; nested={"headers":{"X-Trace-Header":"${nestedSecret}"},"traceHeader":"${nestedSecret}"}` }],
  })])), onUpdate: (value: unknown) => updateValues.push(value) });
  const serialized = JSON.stringify(attempt);
  assert.equal(attempt.failureKind, "success");
  assert.match((attempt.messages[0] as any).content[0].text, /completed normally/);
  for (const secret of [cookieSecret, setCookieSecret, cookieAttributeSecret, traceSecret, suffixHeaderSecret, nestedSecret]) {
    assert.equal(serialized.includes(secret), false, secret);
    assert.equal(JSON.stringify(updateValues).includes(secret), false, secret);
  }
  assert.match((attempt.messages[0] as any).content[0].text, /Set-Cookie=\[REDACTED\]/);
  assert.match((attempt.messages[0] as any).content[0].text, /Cookie=\[REDACTED\]/);
  assert.match((attempt.messages[0] as any).content[0].text, /X-Trace-Header: \[REDACTED\]/);
  assert.match((attempt.messages[0] as any).content[0].text, /traceHeader=\[REDACTED\]/);
  await fs.rm(root, { recursive: true, force: true });
});

test("missing requested or terminal model is recorded as unknown", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-test-"));
  const attempt = await runPiAttempt({ ...(await options(root, [header(), terminal("stop", { model: undefined })])), model: undefined });
  assert.equal(attempt.requestedModel, "unknown");
  assert.equal(attempt.actualModel, "unknown");
  await fs.rm(root, { recursive: true, force: true });
});

test("task echoes, raw bodies, headers, and nested diagnostics never cross the result boundary", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-test-"));
  const task = "TASK_SENTINEL full prompt must not be echoed";
  const secret = "RAW_BODY_SENTINEL cookie-token";
  const updates: unknown[] = [];
  const attempt = await runPiAttempt({ ...(await options(root, [header(), {
    type: "tool_execution_end", toolCallId: "call-1", toolName: "request", isError: true,
    result: { task, prompt: task, headers: { Cookie: secret }, rawBody: { nested: { diagnostic: secret } }, unknown: { value: secret } },
  }, { type: "message_end", message: toolResultMessage({ content: [{ type: "text", text: secret }] }) }, terminal("stop", {
    content: [{ type: "text", text: `assistant echoed: ${task}` }, { type: "toolCall", id: "call-1", name: "request", arguments: { task, prompt: task, headers: { Cookie: secret } } }],
  })])), task, onUpdate: (value: unknown) => updates.push(value) });
  const serialized = JSON.stringify(attempt);
  assert.equal(JSON.stringify(updates).includes(task), false);
  assert.equal(JSON.stringify(updates).includes(secret), false);
  assert.equal(attempt.failureKind, "success");
  assert.deepEqual(attempt.diagnostics, { toolErrorCount: 1, providerErrorCount: 0 });
  assert.equal(serialized.includes(task), false);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("RAW_BODY_SENTINEL"), false);
  assert.equal(serialized.includes("headers"), false);
  assert.equal(serialized.includes("rawBody"), false);
  assert.deepEqual(attempt.toolResults[0].result, { type: "object", length: 5, hash: attempt.toolResults[0].resultHash });
  await fs.rm(root, { recursive: true, force: true });
});

test("raw child stderr is never used as terminal provider classification", async () => {
  for (const stderr of ["fetch failed; Authorization: secret", "provider ETIMEDOUT while connecting"] as const) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-test-"));
    const attempt = await runPiAttempt(await options(root, [header(), terminal("error")], 1, stderr));
    assert.equal(attempt.failureKind, "non_transient_provider", stderr);
    assert.equal(attempt.errorMessage, "provider request failed");
    assert.equal(Object.prototype.hasOwnProperty.call(attempt, "stderr"), false);
    await fs.rm(root, { recursive: true, force: true });
  }
});
