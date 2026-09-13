import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { garbageCollect } from "../src/gc.ts";
import { dispatchAgent } from "../src/dispatcher.ts";
import { makeSessionIdentity } from "../src/session-identity.ts";
import type { AgentConfig } from "../src/agents.ts";
import type { AttemptResult } from "../src/runner.ts";
import { acquireIdentityLock } from "../src/session-lock.ts";

test("30d GC rechecks under identity lock, tombstones, and removes only managed child", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-test-"));
  const identity = makeSessionIdentity({ parentSessionId: "p", cwd: "/tmp/project", agentName: "implementer", handle: "old" });
  const session = path.join(root, "sessions", identity.key, "child.jsonl");
  await fs.mkdir(path.dirname(session), { recursive: true });
  await fs.mkdir(path.join(root, "registry"), { recursive: true });
  await fs.writeFile(session, "managed");
  await fs.writeFile(path.join(root, "registry", `${identity.key}.json`), JSON.stringify({ version: 1, key: identity.key, parentSessionId: "p", agentName: "implementer", handle: "old", childSessionId: "child", status: "settled", createdAt: "2020-01-01T00:00:00.000Z", lastActivityAt: "2020-01-01T00:00:00.000Z", attempts: [] }));
  const gc = await garbageCollect({ rootDir: root, now: new Date("2020-02-01T00:00:00.000Z"), retentionMs: 1 });
  assert.equal(gc.removed, 1);
  assert.equal(await fs.stat(session).then(() => true).catch(() => false), false);
  assert.deepEqual(await fs.readdir(path.join(root, "registry")), []);
  await fs.rm(root, { recursive: true, force: true });
});

test("GC resumes an interrupted tombstone cleanup on the next pass", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-test-"));
  const identity = makeSessionIdentity({ parentSessionId: "p", cwd: "/tmp/project", agentName: "implementer", handle: "tombstone" });
  const sessionDir = path.join(root, "sessions", identity.key);
  const registryDir = path.join(root, "registry");
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.mkdir(registryDir, { recursive: true });
  await fs.writeFile(path.join(sessionDir, "child.jsonl"), "managed");
  const tombstone = path.join(registryDir, `${identity.key}.json.tombstone-interrupted`);
  await fs.writeFile(tombstone, JSON.stringify({ version: 1, key: identity.key }));
  const gc = await garbageCollect({ rootDir: root, now: new Date("2020-02-01T00:00:00.000Z"), retentionMs: 1 });
  assert.equal(gc.scanned, 1);
  assert.equal(gc.removed, 1);
  assert.equal(await fs.stat(sessionDir).then(() => true).catch(() => false), false);
  assert.equal(await fs.stat(tombstone).then(() => true).catch(() => false), false);
  await fs.rm(root, { recursive: true, force: true });
});

test("GC deletes session and reappeared metadata before removing a tombstone", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-test-"));
  const identity = makeSessionIdentity({ parentSessionId: "p", cwd: "/tmp/project", agentName: "implementer", handle: "reappeared" });
  const sessionDir = path.join(root, "sessions", identity.key);
  const registryDir = path.join(root, "registry");
  const registryFile = path.join(registryDir, `${identity.key}.json`);
  const tombstone = `${registryFile}.tombstone-interrupted`;
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.mkdir(registryDir, { recursive: true });
  await fs.writeFile(path.join(sessionDir, "child.jsonl"), "managed");
  await fs.writeFile(registryFile, JSON.stringify({ version: 1, key: identity.key, parentSessionId: "p", agentName: "implementer", handle: "reappeared", childSessionId: "child", status: "settled", createdAt: "2020-01-01T00:00:00.000Z", lastActivityAt: "2020-01-01T00:00:00.000Z", attempts: [] }));
  await fs.writeFile(tombstone, JSON.stringify({ version: 1, key: identity.key }));

  const gc = await garbageCollect({ rootDir: root, now: new Date("2020-02-01T00:00:00.000Z"), retentionMs: 1 });
  assert.equal(gc.removed, 1);
  assert.equal(await fs.stat(sessionDir).then(() => true).catch(() => false), false);
  assert.equal(await fs.stat(registryFile).then(() => true).catch(() => false), false);
  assert.equal(await fs.stat(tombstone).then(() => true).catch(() => false), false);
  await fs.rm(root, { recursive: true, force: true });
});

test("GC and an active resume share the identity lock and do not race", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-test-"));
  const agent: AgentConfig = { name: "implementer", description: "test", source: "user", filePath: "/tmp/a.md", systemPrompt: "", model: "model-a" };
  let entered!: () => void;
  const running = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const finish = new Promise<void>((resolve) => { release = resolve; });
  const dispatching = dispatchAgent({ parentSessionId: "p", cwd: "/tmp/project", task: "resume", agent }, {
    rootDir: root,
    now: () => new Date("2020-01-01T00:00:00.000Z"),
    runAttempt: async (options): Promise<AttemptResult> => {
      entered();
      await finish;
      await fs.mkdir(options.sessionDir, { recursive: true });
      await fs.writeFile(path.join(options.sessionDir, "child.jsonl"), `${JSON.stringify({ type: "session", id: options.childSessionId, cwd: options.cwd })}\n`);
      return { agent: agent.name, agentSource: "user", task: options.task, cwd: options.cwd, exitCode: 0, messages: [], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }, sessionId: options.childSessionId, model: options.model, source: options.source, attempt: options.attempt, failureKind: "success" };
    },
  });
  await running;
  const gc = await garbageCollect({ rootDir: root, now: new Date("2020-02-01T00:00:00.000Z"), retentionMs: 1 });
  assert.equal(gc.skippedBusy, 1);
  release();
  assert.equal((await dispatching).status, "completed");
  await fs.rm(root, { recursive: true, force: true });
});

test("GC cannot delete an existing persistent session while resume holds its identity lock", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-test-"));
  const agent: AgentConfig = { name: "implementer", description: "test", source: "user", filePath: "/tmp/a.md", systemPrompt: "", model: "model-a" };
  const first = await dispatchAgent({ parentSessionId: "p", cwd: "/tmp/project", task: "create", agent, session: "existing" }, {
    rootDir: root,
    now: () => new Date("2020-01-01T00:00:00.000Z"),
    runAttempt: async (options): Promise<AttemptResult> => {
      await fs.mkdir(options.sessionDir, { recursive: true });
      await fs.writeFile(path.join(options.sessionDir, "child.jsonl"), `${JSON.stringify({ type: "session", id: options.childSessionId, cwd: options.cwd })}\n`);
      return { agent: agent.name, agentSource: "user", task: options.task, cwd: options.cwd, exitCode: 0, messages: [], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }, sessionId: options.childSessionId, model: options.model, source: options.source, attempt: options.attempt, failureKind: "success" };
    },
  });
  assert.equal(first.status, "completed");
  let entered!: () => void;
  const running = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const resumed = dispatchAgent({ parentSessionId: "p", cwd: "/tmp/project", task: "resume", agent, session: "existing" }, {
    rootDir: root,
    now: () => new Date("2020-01-01T00:00:00.000Z"),
    runAttempt: async (options): Promise<AttemptResult> => {
      entered();
      await hold;
      return { agent: agent.name, agentSource: "user", task: options.task, cwd: options.cwd, exitCode: 0, messages: [], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }, sessionId: options.childSessionId, model: options.model, source: options.source, attempt: options.attempt, failureKind: "success" };
    },
  });
  await running;
  const gc = await garbageCollect({ rootDir: root, now: new Date("2020-02-01T00:00:00.000Z"), retentionMs: 1 });
  assert.equal(gc.skippedBusy, 1);
  release();
  assert.equal((await resumed).status, "completed");
  await fs.rm(root, { recursive: true, force: true });
});

test("live identity lock prevents GC from deleting a fresh recheck target", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-test-"));
  const key = "a".repeat(64);
  await fs.mkdir(path.join(root, "registry"), { recursive: true });
  await fs.writeFile(path.join(root, "registry", `${key}.json`), JSON.stringify({ version: 1, key, lastActivityAt: "2020-01-01T00:00:00.000Z" }));
  const lock = await acquireIdentityLock({ rootDir: root, key }); assert.ok(lock);
  const gc = await garbageCollect({ rootDir: root, now: new Date("2020-02-01T00:00:00.000Z"), retentionMs: 1 });
  assert.equal(gc.skippedBusy, 1);
  assert.equal(await fs.stat(path.join(root, "registry", `${key}.json`)).then(() => true).catch(() => false), true);
  await lock.release(); await fs.rm(root, { recursive: true, force: true });
});
