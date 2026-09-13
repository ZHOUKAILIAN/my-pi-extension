import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { acquireIdentityLock } from "../src/session-lock.ts";

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "subagent-lock-test-"));
}

test("lock records child PID and identity before release", async () => {
  const root = await tempRoot();
  const lock = await acquireIdentityLock({ rootDir: root, key: "identity" });
  assert.ok(lock);
  await lock.markChildStarting();
  await lock.setChildProcess({ pid: 4321, identity: "child-session" });
  const payload = JSON.parse(await fs.readFile(lock.path, "utf8")) as { child: { state: string; pid: number; identity: string; startedAt: string } };
  assert.equal(payload.child.state, "running");
  assert.equal(payload.child.pid, 4321);
  assert.equal(payload.child.identity, "child-session");
  assert.ok(payload.child.startedAt);
  await lock.release();
  await fs.rm(root, { recursive: true, force: true });
});

test("stale pre-spawn dispatcher lock is safely reclaimed when no child PID exists", async () => {
  const root = await tempRoot();
  const locks = path.join(root, "locks");
  await fs.mkdir(locks, { recursive: true });
  const exitedDispatcher = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  assert.ok(exitedDispatcher.pid);
  await new Promise<void>((resolve) => exitedDispatcher.once("exit", () => resolve()));
  await fs.writeFile(path.join(locks, "identity.lock"), JSON.stringify({
    host: os.hostname(), pid: exitedDispatcher.pid, token: "stale-pre-spawn", createdAt: new Date(0).toISOString(),
    child: { state: "starting", identity: "child-session", startedAt: new Date(0).toISOString() },
  }));
  const recovered = await acquireIdentityLock({ rootDir: root, key: "identity", processExists: async () => false, listProcesses: async () => [] });
  assert.ok(recovered);
  await recovered.release();
  await fs.rm(root, { recursive: true, force: true });
});

test("starting grace refuses takeover before child PID registration", async () => {
  const root = await tempRoot();
  const locks = path.join(root, "locks");
  await fs.mkdir(locks, { recursive: true });
  const exitedDispatcher = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  assert.ok(exitedDispatcher.pid);
  await new Promise<void>((resolve) => exitedDispatcher.once("exit", () => resolve()));
  const now = new Date("2026-01-01T00:00:00.000Z");
  await fs.writeFile(path.join(locks, "identity.lock"), JSON.stringify({
    host: os.hostname(), pid: exitedDispatcher.pid, token: "starting-grace", createdAt: now.toISOString(),
    child: { state: "starting", identity: "child-session", startedAt: now.toISOString() },
  }));
  const blocked = await acquireIdentityLock({ rootDir: root, key: "identity", now: () => now, listProcesses: async () => [] });
  assert.equal(blocked, undefined);
  await fs.rm(root, { recursive: true, force: true });
});

test("stale lock stays busy when process inspection cannot prove the Pi child is gone", async () => {
  const root = await tempRoot();
  const locks = path.join(root, "locks");
  await fs.mkdir(locks, { recursive: true });
  const exitedDispatcher = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  assert.ok(exitedDispatcher.pid);
  await new Promise<void>((resolve) => exitedDispatcher.once("exit", () => resolve()));
  await fs.writeFile(path.join(locks, "identity.lock"), JSON.stringify({
    host: os.hostname(), pid: exitedDispatcher.pid, token: "unknown-child", createdAt: new Date(0).toISOString(),
    child: { state: "running", pid: 4321, identity: "child-session" },
  }));
  const blocked = await acquireIdentityLock({ rootDir: root, key: "identity", processExists: async () => false, listProcesses: async () => undefined });
  assert.equal(blocked, undefined);
  await fs.rm(root, { recursive: true, force: true });
});

test("stale lock stays busy when a matching Pi child is found by session identity or path", async () => {
  const root = await tempRoot();
  const locks = path.join(root, "locks");
  await fs.mkdir(locks, { recursive: true });
  const exitedDispatcher = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  assert.ok(exitedDispatcher.pid);
  await new Promise<void>((resolve) => exitedDispatcher.once("exit", () => resolve()));
  await fs.writeFile(path.join(locks, "identity.lock"), JSON.stringify({
    host: os.hostname(), pid: exitedDispatcher.pid, token: "scanned-child", createdAt: new Date(0).toISOString(),
    child: { state: "running", pid: 4321, identity: "child-session", sessionPath: "/tmp/child.jsonl" },
  }));
  const blocked = await acquireIdentityLock({
    rootDir: root,
    key: "identity",
    processExists: async () => false,
    listProcesses: async () => [{ pid: 9999, command: "pi --mode json --session-id child-session" }],
  });
  assert.equal(blocked, undefined);
  await fs.rm(path.join(locks, "identity.lock"));
  await fs.writeFile(path.join(locks, "identity.lock"), JSON.stringify({
    host: os.hostname(), pid: exitedDispatcher.pid, token: "scanned-path", createdAt: new Date(0).toISOString(),
    child: { state: "running", pid: 4321, identity: "different-child", sessionPath: "/tmp/child.jsonl" },
  }));
  const pathBlocked = await acquireIdentityLock({
    rootDir: root,
    key: "identity",
    processExists: async () => false,
    listProcesses: async () => [{ pid: 9999, command: "pi --mode json --session /tmp/child.jsonl" }],
  });
  assert.equal(pathBlocked, undefined);
  await fs.rm(root, { recursive: true, force: true });
});

test("stale dispatcher lock stays fail-closed while the recorded Pi child is alive", async () => {
  const root = await tempRoot();
  const locks = path.join(root, "locks");
  await fs.mkdir(locks, { recursive: true });
  const exitedDispatcher = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  assert.ok(exitedDispatcher.pid);
  await new Promise<void>((resolve) => exitedDispatcher.once("exit", () => resolve()));
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 10000)"], { stdio: "ignore" });
  assert.ok(child.pid);
  await fs.writeFile(path.join(locks, "identity.lock"), JSON.stringify({
    host: os.hostname(), pid: exitedDispatcher.pid, token: "stale-dispatcher", createdAt: new Date(0).toISOString(),
    child: { state: "running", pid: child.pid, identity: "child-session" },
  }));

  const blocked = await acquireIdentityLock({ rootDir: root, key: "identity" });
  assert.equal(blocked, undefined);

  child.kill("SIGTERM");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const recovered = await acquireIdentityLock({ rootDir: root, key: "identity" });
  assert.ok(recovered);
  await recovered.release();
  await fs.rm(root, { recursive: true, force: true });
});
