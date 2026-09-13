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
function terminal(stopReason = "stop", extra: Record<string, unknown> = {}) { return { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason, ...extra } }; }

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

test("session validation parses every JSONL record and rejects a truncated second row", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-test-"));
  const file = path.join(root, "session.jsonl");
  await fs.writeFile(file, `${JSON.stringify(header())}\n{"type":"message_end","message":`);
  assert.equal(await validateSessionFile(file, "child-1", "/tmp/project"), false);
  await fs.writeFile(file, `${JSON.stringify(header())}\n${JSON.stringify({ type: "message_end", message: {} })}\n`);
  assert.equal(await validateSessionFile(file, "child-1", "/tmp/project"), true);
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
  const cases = [[], [null], [header(), null], [terminal()], [header()], [header(), { type: "message_end", message: { role: "assistant", content: [] } }],
    [header(), { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: {} }], stopReason: "toolUse" } }]];
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

test("stderr transient errors are classified by the runner", async () => {
  for (const value of ["fetch failed", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "explicit timeout", "HTTP 429", "status 502", "code 503", "response 504"]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-test-"));
    const attempt = await runPiAttempt(await options(root, [header(), terminal("error")], 1, value));
    assert.equal(attempt.failureKind, "transient_provider", value);
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
    headers: { Authorization: `Bearer ${secret}`, "x-api-key": secret },
    rawBody: { nested: { token: secret, value: "safe" } },
    cause: { details: { response: { body: `token=${secret}` } } },
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
    message: { role: "toolResult", content: [{ type: "text", text: "provider result" }], details: { headers: { Authorization: secret }, token: secret, rawBody: { secret } } },
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
  const attempt = await runPiAttempt({ ...(await options(root, [header(), terminal()])), model: undefined });
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
  }, { type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: secret }] } }, terminal("stop", {
    content: [{ type: "text", text: `assistant echoed: ${task}` }, { type: "toolCall", name: "request", arguments: { task, prompt: task, headers: { Cookie: secret } } }],
  })])), task, onUpdate: (value: unknown) => updates.push(value) });
  const serialized = JSON.stringify(attempt);
  assert.equal(JSON.stringify(updates).includes(task), false);
  assert.equal(JSON.stringify(updates).includes(secret), false);
  assert.equal(attempt.failureKind, "task_failure");
  assert.equal(serialized.includes(task), false);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("RAW_BODY_SENTINEL"), false);
  assert.equal(serialized.includes("headers"), false);
  assert.equal(serialized.includes("rawBody"), false);
  assert.deepEqual(attempt.toolResults[0].result, { type: "object", length: 5, hash: attempt.toolResults[0].resultHash });
  await fs.rm(root, { recursive: true, force: true });
});

test("raw child stderr participates in the closed transient allowlist", async () => {
  for (const [stderr, expected] of [["fetch failed; Authorization: secret", "fetch failed"], ["provider ETIMEDOUT while connecting", "ETIMEDOUT"]] as const) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-test-"));
    const attempt = await runPiAttempt(await options(root, [header(), terminal("error")], 1, stderr));
    assert.equal(attempt.failureKind, "transient_provider", stderr);
    assert.equal(attempt.errorMessage, expected);
    assert.equal(Object.prototype.hasOwnProperty.call(attempt, "stderr"), false);
    await fs.rm(root, { recursive: true, force: true });
  }
});
