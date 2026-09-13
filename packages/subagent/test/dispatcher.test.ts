import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { dispatchAgent, type DispatchDependencies } from "../src/dispatcher.ts";
import { DEFAULT_RETENTION_MS, garbageCollect } from "../src/gc.ts";
import { runPiAttempt } from "../src/runner.ts";
import { makeSessionIdentity } from "../src/session-identity.ts";
import type { AgentConfig } from "../src/agents.ts";
import type { AttemptResult } from "../src/runner.ts";

const agent = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  name: "implementer", description: "test", source: "user", filePath: "/tmp/agent.md", systemPrompt: "", model: "model-a", fallbackModels: ["model-b"], ...overrides,
});
async function tempRoot(): Promise<string> { return fs.mkdtemp(path.join(os.tmpdir(), "subagent-test-")); }
async function writeSession(options: { sessionDir: string; id: string; cwd: string; suffix?: string }): Promise<string> {
  await fs.mkdir(options.sessionDir, { recursive: true });
  const file = path.join(options.sessionDir, `${options.suffix ?? "session"}.jsonl`);
  await fs.writeFile(file, `${JSON.stringify({ type: "session", version: 3, id: options.id, cwd: options.cwd, timestamp: new Date().toISOString() })}\n`);
  return file;
}
function result(options: { cwd: string; id: string; kind: AttemptResult["failureKind"]; model?: string; actualModel?: string; attempt: number; source: AttemptResult["source"] }): AttemptResult {
  return { agent: "implementer", agentSource: "user", exitCode: options.kind === "success" ? 0 : 1, messages: [], toolResults: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }, sessionId: options.id, requestedModel: options.model ?? "unknown", actualModel: options.actualModel ?? "unknown", attempt: options.attempt, source: options.source, failureKind: options.kind, errorMessage: options.kind === "transient_provider" ? "provider request failed" : undefined, cwdScope: "cwd:0000000000000000" };
}

function fakeProcess(lines: unknown[], stderr: string): any {
  const process = new EventEmitter() as any;
  process.pid = 23456; process.stdout = new PassThrough(); process.stderr = new PassThrough(); process.killed = false;
  process.kill = () => { process.killed = true; return true; };
  queueMicrotask(() => { for (const line of lines) process.stdout.write(`${JSON.stringify(line)}\n`); process.stderr.write(stderr); process.stdout.end(); process.stderr.end(); process.emit("close", 1); });
  return process;
}

async function dispatchWithMock(rootDir: string, behavior: (options: Parameters<NonNullable<DispatchDependencies["runAttempt"]>>[0], count: number) => Promise<AttemptResult>, request: Partial<Parameters<typeof dispatchAgent>[0]> = {}) {
  let count = 0;
  return dispatchAgent({ parentSessionId: "parent-1", cwd: "/tmp/project", task: "work", agent: agent(), ...request }, {
    rootDir, sleep: async () => {}, runAttempt: async (options) => behavior(options, ++count),
  });
}

test("model retry budget is exactly initial+2 per model, then ordered fallback", async () => {
  const root = await tempRoot();
  const calls: Array<{ model?: string; source: string; sessionFile?: string }> = [];
  const response = await dispatchWithMock(root, async (options, count) => {
    calls.push({ model: options.model, source: options.source, sessionFile: options.sessionFile });
    const file = await writeSession({ sessionDir: options.sessionDir, id: options.childSessionId, cwd: options.cwd });
    return result({ cwd: options.cwd, id: options.childSessionId, kind: count === 4 ? "success" : "transient_provider", model: options.model, attempt: options.attempt, source: options.source });
  });
  assert.equal(response.status, "completed");
  assert.deepEqual(calls.map((call) => call.model), ["model-a", "model-a", "model-a", "model-b"]);
  assert.deepEqual(calls.map((call) => call.source), ["initial", "retry", "retry", "fallback"]);
  assert.deepEqual(response.attempts.map((attempt) => ({ requested: attempt.requestedModel, actual: attempt.actualModel })), [
    { requested: "model-a", actual: "unknown" }, { requested: "model-a", actual: "unknown" },
    { requested: "model-a", actual: "unknown" }, { requested: "model-b", actual: "unknown" },
  ]);
  assert.equal(calls.slice(1).every((call) => call.sessionFile !== undefined), true);
  await fs.rm(root, { recursive: true, force: true });
});

test("stderr alone does not receive a retry budget", async () => {
  for (const stderr of ["fetch failed", "ETIMEDOUT"] as const) {
    const root = await tempRoot();
    const calls: Array<{ model?: string; source: string }> = [];
    const response = await dispatchWithMock(root, async (options) => {
      calls.push({ model: options.model, source: options.source });
      await writeSession({ sessionDir: options.sessionDir, id: options.childSessionId, cwd: options.cwd });
      const header = { type: "session", version: 3, id: options.childSessionId, cwd: options.cwd };
      const terminal = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "failed" }], stopReason: "error" } };
      return runPiAttempt({ ...options, spawn: () => fakeProcess([header, terminal], stderr) });
    });
    assert.equal(response.status, "recoverable_failed", stderr);
    assert.deepEqual(calls, [{ model: "model-a", source: "initial" }], stderr);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("non-allowlisted and compatibility task failures do not retry or fallback", async () => {
  for (const kind of ["non_transient_provider", "task_failure", "unknown_transport", "incomplete"] as const) {
    const root = await tempRoot(); let calls = 0;
    const response = await dispatchWithMock(root, async (options) => {
      calls += 1;
      await writeSession({ sessionDir: options.sessionDir, id: options.childSessionId, cwd: options.cwd });
      return result({ cwd: options.cwd, id: options.childSessionId, kind, model: options.model, attempt: options.attempt, source: options.source });
    });
    assert.equal(calls, 1, kind);
    assert.equal(response.status, "recoverable_failed", kind);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("normal child return with a tool error remains completed and retains diagnostics", async () => {
  const root = await tempRoot();
  let calls = 0;
  const response = await dispatchWithMock(root, async (options) => {
    calls += 1;
    await writeSession({ sessionDir: options.sessionDir, id: options.childSessionId, cwd: options.cwd });
    return {
      ...result({ cwd: options.cwd, id: options.childSessionId, kind: "success", model: options.model, attempt: options.attempt, source: options.source }),
      messages: [{ role: "assistant", content: [{ type: "text", text: "report says the test failed" }], stopReason: "stop" } as any],
      diagnostics: { toolErrorCount: 1, providerErrorCount: 0 },
      phase: "finished",
    };
  });
  assert.equal(calls, 1);
  assert.equal(response.status, "completed");
  assert.equal(response.failureKind, "success");
  assert.deepEqual(response.attempt.diagnostics, { toolErrorCount: 1, providerErrorCount: 0 });
  const identity = makeSessionIdentity({ parentSessionId: "parent-1", cwd: "/tmp/project", agentName: "implementer", handle: response.handle! });
  const registry = JSON.parse(await fs.readFile(path.join(root, "registry", `${identity.key}.json`), "utf8"));
  assert.deepEqual(registry.attempts[0].diagnostics, { toolErrorCount: 1, providerErrorCount: 0 });
  await fs.rm(root, { recursive: true, force: true });
});

test("incomplete results never consume retry budget", async () => {
  const root = await tempRoot();
  let calls = 0;
  const response = await dispatchWithMock(root, async (options) => {
    calls += 1;
    await writeSession({ sessionDir: options.sessionDir, id: options.childSessionId, cwd: options.cwd });
    return result({ cwd: options.cwd, id: options.childSessionId, kind: "incomplete", model: options.model, attempt: options.attempt, source: options.source });
  });
  assert.equal(calls, 1);
  assert.equal(response.status, "recoverable_failed");
  assert.equal(response.failureKind, "incomplete");
  await fs.rm(root, { recursive: true, force: true });
});

test("agent persistence is overridable per call and defaults to true", async () => {
  const root = await tempRoot();
  const persistentByDefault = await dispatchWithMock(root, async (options) => {
    await writeSession({ sessionDir: options.sessionDir, id: options.childSessionId, cwd: options.cwd });
    return result({ cwd: options.cwd, id: options.childSessionId, kind: "success", model: options.model, attempt: options.attempt, source: options.source });
  }, { agent: agent({ persistent: false }) });
  assert.equal(persistentByDefault.persistent, false);
  assert.equal(persistentByDefault.handle, undefined);

  const explicitlyPersistent = await dispatchWithMock(root, async (options) => {
    await writeSession({ sessionDir: options.sessionDir, id: options.childSessionId, cwd: options.cwd });
    return result({ cwd: options.cwd, id: options.childSessionId, kind: "success", model: options.model, attempt: options.attempt, source: options.source });
  }, { agent: agent({ persistent: false }), persistent: true });
  assert.equal(explicitlyPersistent.persistent, true);
  assert.ok(explicitlyPersistent.handle);
  await fs.rm(root, { recursive: true, force: true });
});

test("a per-call model override is recorded separately from terminal actualModel", async () => {
  const root = await tempRoot();
  let seen: { model?: string; source: string } | undefined;
  const response = await dispatchWithMock(root, async (options) => {
    seen = { model: options.model, source: options.source };
    await writeSession({ sessionDir: options.sessionDir, id: options.childSessionId, cwd: options.cwd });
    return result({ cwd: options.cwd, id: options.childSessionId, kind: "success", model: options.model, actualModel: "provider/actual-model", attempt: options.attempt, source: options.source });
  }, { model: "override-model" });
  assert.deepEqual(seen, { model: "override-model", source: "user_override" });
  assert.equal(response.attempt.requestedModel, "override-model");
  assert.equal(response.attempt.actualModel, "provider/actual-model");
  const identity = makeSessionIdentity({ parentSessionId: "parent-1", cwd: "/tmp/project", agentName: "implementer", handle: response.handle! });
  const registry = JSON.parse(await fs.readFile(path.join(root, "registry", `${identity.key}.json`), "utf8"));
  assert.deepEqual(registry.attempts[0], { requestedModel: "override-model", actualModel: "provider/actual-model", attempt: 1, source: "user_override", kind: "success" });
  assert.equal(Object.prototype.hasOwnProperty.call(registry, "cwd"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(registry, "sessionFile"), false);
  assert.equal(JSON.stringify(response).includes("work"), false);
  await fs.rm(root, { recursive: true, force: true });
});

test("fallback models each receive their own initial+2 budget", async () => {
  const root = await tempRoot();
  const calls: Array<{ model?: string; source: string }> = [];
  const response = await dispatchWithMock(root, async (options) => {
    calls.push({ model: options.model, source: options.source });
    await writeSession({ sessionDir: options.sessionDir, id: options.childSessionId, cwd: options.cwd });
    return result({ cwd: options.cwd, id: options.childSessionId, kind: "transient_provider", model: options.model, attempt: options.attempt, source: options.source });
  });
  assert.equal(response.status, "recoverable_failed");
  assert.deepEqual(calls, [
    { model: "model-a", source: "initial" }, { model: "model-a", source: "retry" }, { model: "model-a", source: "retry" },
    { model: "model-b", source: "fallback" }, { model: "model-b", source: "retry" }, { model: "model-b", source: "retry" },
  ]);
  const identity = makeSessionIdentity({ parentSessionId: "parent-1", cwd: "/tmp/project", agentName: "implementer", handle: response.handle! });
  const registry = JSON.parse(await fs.readFile(path.join(root, "registry", `${identity.key}.json`), "utf8"));
  assert.deepEqual(registry.attempts.map((attempt: any) => [attempt.requestedModel, attempt.actualModel]), [
    ["model-a", "unknown"], ["model-a", "unknown"], ["model-a", "unknown"],
    ["model-b", "unknown"], ["model-b", "unknown"], ["model-b", "unknown"],
  ]);
  await fs.rm(root, { recursive: true, force: true });
});

test("persistent false keeps fallback attempts ephemeral", async () => {
  const root = await tempRoot();
  const calls: Array<{ model?: string; source: string }> = [];
  const response = await dispatchWithMock(root, async (options) => {
    calls.push({ model: options.model, source: options.source });
    await writeSession({ sessionDir: options.sessionDir, id: options.childSessionId, cwd: options.cwd });
    return result({ cwd: options.cwd, id: options.childSessionId, kind: calls.length === 4 ? "success" : "transient_provider", model: options.model, attempt: options.attempt, source: options.source });
  }, { persistent: false });
  assert.equal(response.status, "completed");
  assert.deepEqual(calls.map((call) => call.model), ["model-a", "model-a", "model-a", "model-b"]);
  assert.deepEqual(calls.map((call) => call.source), ["initial", "retry", "retry", "fallback"]);
  assert.equal(response.handle, undefined);
  assert.deepEqual(await fs.readdir(root), []);
  await fs.rm(root, { recursive: true, force: true });
});

test("persistent false cleans up after exhausted, non-transient, task, and cancelled outcomes", async () => {
  const cases: Array<{ name: string; kind: AttemptResult["failureKind"]; expectedCalls: number }> = [
    { name: "candidate exhaustion", kind: "transient_provider", expectedCalls: 6 },
    { name: "non-transient provider", kind: "non_transient_provider", expectedCalls: 1 },
    { name: "task failure", kind: "task_failure", expectedCalls: 1 },
  ];
  for (const current of cases) {
    const root = await tempRoot();
    let calls = 0;
    const response = await dispatchWithMock(root, async (options) => {
      calls += 1;
      await writeSession({ sessionDir: options.sessionDir, id: options.childSessionId, cwd: options.cwd });
      return result({ cwd: options.cwd, id: options.childSessionId, kind: current.kind, model: options.model, attempt: options.attempt, source: options.source });
    }, { persistent: false });
    assert.equal(response.status, "failed", current.name);
    assert.equal(calls, current.expectedCalls, current.name);
    assert.deepEqual(await fs.readdir(root), [], current.name);
    await fs.rm(root, { recursive: true, force: true });
  }

  const root = await tempRoot();
  const controller = new AbortController();
  let calls = 0;
  const cancelled = await dispatchAgent({ parentSessionId: "parent-1", cwd: "/tmp/project", task: "work", agent: agent(), persistent: false, signal: controller.signal }, {
    rootDir: root,
    sleep: async () => {},
    runAttempt: async (options) => {
      calls += 1;
      controller.abort();
      await writeSession({ sessionDir: options.sessionDir, id: options.childSessionId, cwd: options.cwd });
      return result({ cwd: options.cwd, id: options.childSessionId, kind: "transient_provider", model: options.model, attempt: options.attempt, source: options.source });
    },
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(calls, 1);
  assert.deepEqual(await fs.readdir(root), []);
  await fs.rm(root, { recursive: true, force: true });
});

test("persistent false is ephemeral, can retry in-call, and rejects a session handle", async () => {
  const root = await tempRoot(); const sessionFiles: string[] = []; let callCount = 0;
  const response = await dispatchWithMock(root, async (options) => {
    callCount += 1;
    if (options.sessionFile) sessionFiles.push(options.sessionFile);
    await writeSession({ sessionDir: options.sessionDir, id: options.childSessionId, cwd: options.cwd });
    return result({ cwd: options.cwd, id: options.childSessionId, kind: callCount === 1 ? "transient_provider" : "success", model: options.model, attempt: options.attempt, source: options.source });
  }, { persistent: false });
  assert.equal(response.handle, undefined);
  assert.equal(response.sessionFile, undefined);
  assert.equal(response.attempt.sessionId, undefined);
  assert.equal(response.persistent, false);
  assert.equal(response.status, "completed");
  assert.equal(sessionFiles.length, 1);
  assert.equal(await fs.stat(path.dirname(path.dirname(sessionFiles[0]))).then(() => true).catch(() => false), false);
  const rejected = await dispatchAgent({ parentSessionId: "p", cwd: "/tmp", task: "x", agent: agent(), persistent: false, session: "same" }, { rootDir: root });
  assert.equal(rejected.status, "invalid");
  await fs.rm(root, { recursive: true, force: true });
});

test("first persistent creation has one registry winner under dispatch interleaving", async () => {
  const root = await tempRoot();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const deps = {
    rootDir: root,
    runAttempt: async (options: Parameters<NonNullable<DispatchDependencies["runAttempt"]>>[0]) => {
      calls += 1;
      entered();
      await hold;
      await writeSession({ sessionDir: options.sessionDir, id: options.childSessionId, cwd: options.cwd });
      return result({ cwd: options.cwd, id: options.childSessionId, kind: "success", model: options.model, attempt: options.attempt, source: options.source });
    },
  } satisfies DispatchDependencies;
  const first = dispatchAgent({ parentSessionId: "p", cwd: "/tmp/project", task: "x", agent: agent(), session: "race" }, deps);
  await started;
  const second = dispatchAgent({ parentSessionId: "p", cwd: "/tmp/project", task: "x", agent: agent(), session: "race" }, deps);
  assert.equal((await second).status, "session-busy");
  release();
  const winner = await first;
  assert.equal(winner.status, "completed");
  assert.equal(calls, 1);
  const identity = makeSessionIdentity({ parentSessionId: "p", cwd: "/tmp/project", agentName: "implementer", handle: "race" });
  const registry = JSON.parse(await fs.readFile(path.join(root, "registry", `${identity.key}.json`), "utf8"));
  assert.equal(registry.childSessionId, winner.attempt.sessionId);
  await fs.rm(root, { recursive: true, force: true });
});

test("Fast is injected only on the first logical child spawn", async () => {
  const root = await tempRoot();
  const firstSpawn: boolean[] = [];
  const response = await dispatchWithMock(root, async (options) => {
    firstSpawn.push(options.firstLogicalChildSpawn);
    assert.equal(options.env?.PI_CODEX_FAST, "1");
    await writeSession({ sessionDir: options.sessionDir, id: options.childSessionId, cwd: options.cwd });
    return result({ cwd: options.cwd, id: options.childSessionId, kind: "success", model: options.model, attempt: options.attempt, source: options.source });
  }, { agent: agent({ codexFast: "inherit" }), fast: { requestedFast: true, environment: (_agent: AgentConfig, first: boolean) => ({ PI_CODEX_FAST: first ? "1" : undefined }) } as any });
  assert.equal(response.status, "completed");
  assert.deepEqual(firstSpawn, [true]);
  await fs.rm(root, { recursive: true, force: true });
});

test("a raw transient result cannot retry or fallback without a validated child session", async () => {
  const root = await tempRoot();
  let calls = 0;
  const response = await dispatchAgent({ parentSessionId: "parent-1", cwd: "/tmp/project", task: "work", agent: agent() }, {
    rootDir: root,
    runAttempt: async (options) => {
      calls += 1;
      return result({ cwd: options.cwd, id: options.childSessionId, kind: "transient_provider", model: options.model, attempt: options.attempt, source: options.source });
    },
  });
  assert.equal(calls, 1);
  assert.equal(response.status, "recoverable_failed");
  assert.equal(response.failureKind, "unknown_transport");
  await fs.rm(root, { recursive: true, force: true });
});

test("partial initial JSONL is quarantined, GC-reachable for 30d, and never resumable", async () => {
  const root = await tempRoot();
  const quarantineTime = new Date("2020-01-01T00:00:00.000Z");
  const partialFile: string[] = [];
  const first = await dispatchAgent({ parentSessionId: "parent-1", cwd: "/tmp/project", task: "work", agent: agent(), session: "partial-jsonl" }, {
    rootDir: root,
    now: () => quarantineTime,
    runAttempt: async (options) => {
      await fs.mkdir(options.sessionDir, { recursive: true });
      const file = path.join(options.sessionDir, "partial.jsonl");
      partialFile.push(file);
      await fs.writeFile(file, `{"type":"session","id":"${options.childSessionId}`);
      return result({ cwd: options.cwd, id: options.childSessionId, kind: "transient_provider", model: options.model, attempt: options.attempt, source: options.source });
    },
  });
  assert.equal(first.status, "recoverable_failed");
  assert.equal(first.failureKind, "unknown_transport");

  const identity = makeSessionIdentity({ parentSessionId: "parent-1", cwd: "/tmp/project", agentName: "implementer", handle: "partial-jsonl" });
  const registryFile = path.join(root, "registry", `${identity.key}.json`);
  const registry = JSON.parse(await fs.readFile(registryFile, "utf8"));
  assert.equal(registry.status, "quarantined");
  assert.equal(await fs.stat(partialFile[0]).then(() => true).catch(() => false), true);

  let spawned = false;
  const resumed = await dispatchAgent({ parentSessionId: "parent-1", cwd: "/tmp/project", task: "resume", agent: agent(), session: "partial-jsonl" }, {
    rootDir: root,
    runAttempt: async () => { spawned = true; throw new Error("must not spawn"); },
  });
  assert.equal(resumed.status, "invalid");
  assert.equal(spawned, false);

  const beforeExpiry = await garbageCollect({ rootDir: root, now: new Date(quarantineTime.getTime() + DEFAULT_RETENTION_MS - 1), retentionMs: DEFAULT_RETENTION_MS });
  assert.equal(beforeExpiry.removed, 0);
  assert.equal(await fs.stat(partialFile[0]).then(() => true).catch(() => false), true);

  const gc = await garbageCollect({ rootDir: root, now: new Date(quarantineTime.getTime() + DEFAULT_RETENTION_MS), retentionMs: DEFAULT_RETENTION_MS });
  assert.equal(gc.removed, 1);
  assert.equal(await fs.stat(partialFile[0]).then(() => true).catch(() => false), false);
  assert.equal(await fs.stat(registryFile).then(() => true).catch(() => false), false);
  await fs.rm(root, { recursive: true, force: true });
});

test("an interrupted tombstone blocks dispatch until GC removes the old session", async () => {
  const root = await tempRoot();
  const identity = makeSessionIdentity({ parentSessionId: "parent-1", cwd: "/tmp/project", agentName: "implementer", handle: "cleanup-pending" });
  const sessionDir = path.join(root, "sessions", identity.key);
  const registryDir = path.join(root, "registry");
  const tombstone = path.join(registryDir, `${identity.key}.json.tombstone-interrupted`);
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.mkdir(registryDir, { recursive: true });
  await fs.writeFile(path.join(sessionDir, "child.jsonl"), "old child session");
  await fs.writeFile(tombstone, JSON.stringify({ version: 1, key: identity.key }));

  let spawned = false;
  const blocked = await dispatchAgent({ parentSessionId: "parent-1", cwd: "/tmp/project", task: "must not start", agent: agent(), session: "cleanup-pending" }, {
    rootDir: root,
    runAttempt: async () => { spawned = true; throw new Error("must not spawn"); },
  });
  assert.equal(blocked.status, "cleanup-pending");
  assert.equal(blocked.error, "session cleanup pending");
  assert.equal(spawned, false);
  assert.equal(await fs.stat(path.join(root, "registry", `${identity.key}.json`)).then(() => true).catch(() => false), false);
  assert.equal(await fs.stat(path.join(sessionDir, "child.jsonl")).then(() => true).catch(() => false), true);

  const gc = await garbageCollect({ rootDir: root, now: new Date("2020-02-01T00:00:00.000Z"), retentionMs: 1 });
  assert.equal(gc.removed, 1);
  assert.equal(await fs.stat(sessionDir).then(() => true).catch(() => false), false);
  assert.equal(await fs.stat(tombstone).then(() => true).catch(() => false), false);
  await fs.rm(root, { recursive: true, force: true });
});

test("malformed registry metadata fails closed before spawning", async () => {
  const root = await tempRoot();
  const identity = makeSessionIdentity({ parentSessionId: "parent-1", cwd: "/tmp/project", agentName: "implementer", handle: "bad" });
  await fs.mkdir(path.join(root, "registry"), { recursive: true });
  await fs.writeFile(path.join(root, "registry", `${identity.key}.json`), JSON.stringify({ version: 1, key: identity.key, sessionFile: 42 }));
  let spawned = false;
  const response = await dispatchAgent({ parentSessionId: "parent-1", cwd: "/tmp/project", task: "continue", agent: agent(), session: "bad" }, {
    rootDir: root,
    runAttempt: async () => { spawned = true; throw new Error("must not spawn"); },
  });
  assert.equal(response.status, "invalid");
  assert.equal(spawned, false);
  await fs.rm(root, { recursive: true, force: true });
});

test("retry, fallback, and resume never inherit Fast", async () => {
  const root = await tempRoot();
  const flags: Array<string | undefined> = [];
  let count = 0;
  const fast = {
    requestedFast: true,
    environment: (_agent: AgentConfig, first: boolean) => {
      const env = { PI_CODEX_FAST: first ? "1" : undefined };
      flags.push(env.PI_CODEX_FAST);
      return env;
    },
  } as any;
  const first = await dispatchWithMock(root, async (options) => {
    await writeSession({ sessionDir: options.sessionDir, id: options.childSessionId, cwd: options.cwd });
    return result({ cwd: options.cwd, id: options.childSessionId, kind: ++count === 4 ? "success" : "transient_provider", model: options.model, attempt: options.attempt, source: options.source });
  }, { agent: agent({ codexFast: "inherit" }), session: "fast-resume", fast });
  assert.equal(first.status, "completed");
  const resumed = await dispatchAgent({ parentSessionId: "parent-1", cwd: "/tmp/project", task: "again", agent: agent({ codexFast: "inherit" }), session: "fast-resume", fast }, {
    rootDir: root,
    runAttempt: async (options) => result({ cwd: options.cwd, id: options.childSessionId, kind: "success", model: options.model, attempt: options.attempt, source: options.source }),
  });
  assert.equal(resumed.status, "completed");
  assert.deepEqual(flags, ["1", undefined, undefined, undefined, undefined]);
  await fs.rm(root, { recursive: true, force: true });
});

test("a valid header with a truncated second JSONL row is quarantined before resume", async () => {
  const root = await tempRoot();
  const first = await dispatchWithMock(root, async (options) => {
    await fs.mkdir(options.sessionDir, { recursive: true });
    await fs.writeFile(path.join(options.sessionDir, "child.jsonl"), `${JSON.stringify({ type: "session", version: 3, id: options.childSessionId, cwd: options.cwd })}\n{"type":"message_end","message":`);
    return result({ cwd: options.cwd, id: options.childSessionId, kind: "success", model: options.model, attempt: options.attempt, source: options.source });
  }, { session: "truncated-second-row" });
  assert.equal(first.status, "recoverable_failed");
  assert.equal(first.failureKind, "unknown_transport");
  const identity = makeSessionIdentity({ parentSessionId: "parent-1", cwd: "/tmp/project", agentName: "implementer", handle: "truncated-second-row" });
  const registryFile = path.join(root, "registry", `${identity.key}.json`);
  assert.equal(JSON.parse(await fs.readFile(registryFile, "utf8")).status, "quarantined");

  let spawned = false;
  const resumed = await dispatchAgent({ parentSessionId: "parent-1", cwd: "/tmp/project", task: "must not resume", agent: agent(), session: "truncated-second-row" }, {
    rootDir: root,
    runAttempt: async () => { spawned = true; throw new Error("must not spawn"); },
  });
  assert.equal(resumed.status, "invalid");
  assert.equal(spawned, false);
  await fs.rm(root, { recursive: true, force: true });
});

test("a resumed child that becomes truncated is quarantined before returning", async () => {
  const root = await tempRoot();
  let calls = 0;
  const first = await dispatchWithMock(root, async (options) => {
    await writeSession({ sessionDir: options.sessionDir, id: options.childSessionId, cwd: options.cwd });
    return result({ cwd: options.cwd, id: options.childSessionId, kind: "success", model: options.model, attempt: options.attempt, source: options.source });
  }, { session: "resume-truncated" });
  assert.equal(first.status, "completed");

  const resumed = await dispatchAgent({ parentSessionId: "parent-1", cwd: "/tmp/project", task: "continue", agent: agent(), session: "resume-truncated" }, {
    rootDir: root,
    runAttempt: async (options) => {
      calls += 1;
      await fs.appendFile(path.join(options.sessionDir, "session.jsonl"), "{\"type\":\"message_end\",\"message\":");
      return result({ cwd: options.cwd, id: options.childSessionId, kind: "success", model: options.model, attempt: options.attempt, source: options.source });
    },
  });
  assert.equal(calls, 1);
  assert.equal(resumed.status, "recoverable_failed");
  assert.equal(resumed.failureKind, "unknown_transport");
  const identity = makeSessionIdentity({ parentSessionId: "parent-1", cwd: "/tmp/project", agentName: "implementer", handle: "resume-truncated" });
  assert.equal(JSON.parse(await fs.readFile(path.join(root, "registry", `${identity.key}.json`), "utf8")).status, "quarantined");
  await fs.rm(root, { recursive: true, force: true });
});

test("an existing registry with a mismatched JSONL header fails closed before spawning", async () => {
  const root = await tempRoot();
  const first = await dispatchWithMock(root, async (options) => {
    await writeSession({ sessionDir: options.sessionDir, id: options.childSessionId, cwd: options.cwd });
    return result({ cwd: options.cwd, id: options.childSessionId, kind: "success", model: options.model, attempt: options.attempt, source: options.source });
  }, { session: "header-check" });
  const identity = makeSessionIdentity({ parentSessionId: "parent-1", cwd: "/tmp/project", agentName: "implementer", handle: "header-check" });
  const sessionFile = await fs.readdir(path.join(root, "sessions", identity.key)).then((items) => path.join(root, "sessions", identity.key, items[0]));
  await fs.writeFile(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "different-child", cwd: "/tmp/project" })}\n`);
  let spawned = false;
  const resumed = await dispatchAgent({ parentSessionId: "parent-1", cwd: "/tmp/project", task: "continue", agent: agent(), session: "header-check" }, {
    rootDir: root,
    runAttempt: async () => { spawned = true; throw new Error("must not spawn"); },
  });
  assert.equal(first.status, "completed");
  assert.equal(resumed.status, "invalid");
  assert.equal(spawned, false);
  await fs.rm(root, { recursive: true, force: true });
});

test("resume fails closed when registry session disappears instead of creating an empty session", async () => {
  const root = await tempRoot();
  const first = await dispatchWithMock(root, async (options) => {
    const file = await writeSession({ sessionDir: options.sessionDir, id: options.childSessionId, cwd: options.cwd });
    return result({ cwd: options.cwd, id: options.childSessionId, kind: "success", model: options.model, attempt: options.attempt, source: options.source });
  }, { session: "known" });
  assert.equal(first.status, "completed");
  const identity = makeSessionIdentity({ parentSessionId: "parent-1", cwd: "/tmp/project", agentName: "implementer", handle: "known" });
  await fs.rm(path.join(root, "sessions", identity.key), { recursive: true, force: true });
  let spawned = false;
  const resumed = await dispatchAgent({ parentSessionId: "parent-1", cwd: "/tmp/project", task: "continue", agent: agent(), session: "known" }, { rootDir: root, runAttempt: async () => { spawned = true; throw new Error("must not spawn"); } });
  assert.equal(resumed.status, "invalid");
  assert.equal(spawned, false);
  await fs.rm(root, { recursive: true, force: true });
});

test("identity lock makes first explicit-handle creation a single winner", async () => {
  const root = await tempRoot();
  const identity = makeSessionIdentity({ parentSessionId: "p", cwd: "/tmp/project", agentName: "implementer", handle: "race" });
  const { acquireIdentityLock } = await import("../src/session-lock.ts");
  const winners = await Promise.all([acquireIdentityLock({ rootDir: root, key: identity.key }), acquireIdentityLock({ rootDir: root, key: identity.key })]);
  assert.equal(winners.filter(Boolean).length, 1);
  const held = winners.find(Boolean)!;
  const busy = await dispatchAgent({ parentSessionId: "p", cwd: "/tmp/project", task: "x", agent: agent(), session: "race" }, { rootDir: root });
  assert.equal(busy.status, "session-busy");
  assert.equal(await fs.stat(path.join(root, "registry", `${identity.key}.json`)).then(() => true).catch(() => false), false);
  await held.release();
  await fs.rm(root, { recursive: true, force: true });
});
