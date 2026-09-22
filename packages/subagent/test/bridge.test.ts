import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createPreservationPin as publicCreatePreservationPin, DEFAULT_ROLLBACK_WINDOW_MS, inspectPreservationPin as publicInspectPreservationPin, isBridgeV1Capability, probeBridgeV1Capability, canAdoptExistingV1, refreshPreservationPin as publicRefreshPreservationPin, releasePreservationPin as publicReleasePreservationPin } from "../src/bridge.ts";
import { createPreservationPin as bridgeCreatePreservationPin, inspectPreservationPin as bridgeInspectPreservationPin, refreshPreservationPin as bridgeRefreshPreservationPin, releasePreservationPin as bridgeReleasePreservationPin } from "../src/bridge-internal.ts";
import { garbageCollect } from "../src/gc.ts";
import { acquireIdentityLock } from "../src/session-lock.ts";

const SOURCE_HASH = "a".repeat(64);
const NOW = new Date("2026-01-01T00:00:00.000Z");
type TestTimed<T> = T & { now?: Date; beforePublish?: (paths: { directory: string; temporary: string; target: string }) => Promise<void> };
const testDependencies = (now: Date | undefined, beforePublish?: TestTimed<unknown>["beforePublish"]) => now || beforePublish ? { now: now ? () => now : undefined, beforePublish } : undefined;
const createPreservationPin = (options: TestTimed<Parameters<typeof bridgeCreatePreservationPin>[0]>, dependencies?: { beforePublish?: TestTimed<unknown>["beforePublish"] }) => {
  const { now, beforePublish, ...publicOptions } = options;
  return bridgeCreatePreservationPin(publicOptions, testDependencies(now, dependencies?.beforePublish ?? beforePublish));
};
const inspectPreservationPin = (options: TestTimed<Parameters<typeof bridgeInspectPreservationPin>[0]>) => {
  const { now, ...publicOptions } = options;
  return bridgeInspectPreservationPin(publicOptions, testDependencies(now));
};
const refreshPreservationPin = (options: TestTimed<Parameters<typeof bridgeRefreshPreservationPin>[0]>, dependencies?: { beforePublish?: TestTimed<unknown>["beforePublish"] }) => {
  const { now, beforePublish, ...publicOptions } = options;
  return bridgeRefreshPreservationPin(publicOptions, testDependencies(now, dependencies?.beforePublish ?? beforePublish));
};
const releasePreservationPin = (options: TestTimed<Parameters<typeof bridgeReleasePreservationPin>[0]>) => {
  const { now, ...publicOptions } = options;
  return bridgeReleasePreservationPin(publicOptions, testDependencies(now));
};

async function atomicSignal(file: string, value: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  await fs.rename(temporary, file);
}

async function tempRoot(t: TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-bridge-test-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return root;
}

async function writeOldRegistry(rootDir: string, sourceHash = SOURCE_HASH): Promise<string> {
  const registryDir = path.join(rootDir, "registry");
  const sessionDir = path.join(rootDir, "sessions", sourceHash);
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.mkdir(registryDir, { recursive: true });
  await fs.writeFile(path.join(sessionDir, "child.jsonl"), "managed");
  await fs.writeFile(path.join(registryDir, `${sourceHash}.json`), JSON.stringify({
    version: 1,
    key: sourceHash,
    parentSessionId: "opaque-parent",
    agentName: "implementer",
    handle: "bridge",
    childSessionId: "child",
    status: "settled",
    createdAt: "2020-01-01T00:00:00.000Z",
    lastActivityAt: "2020-01-01T00:00:00.000Z",
    attempts: [],
  }));
  return sessionDir;
}

async function runLegacyV1Worker(rootDir: string): Promise<void> {
  const script = `import fs from "node:fs/promises"; import path from "node:path"; const root = process.argv[1]; const cutoff = Number(process.argv[2]); const dir = path.join(root, "registry"); for (const entry of await fs.readdir(dir, { withFileTypes: true })) { if (!entry.isFile() || !entry.name.endsWith(".json")) continue; const file = path.join(dir, entry.name); const value = JSON.parse(await fs.readFile(file, "utf8")); if (typeof value.lastActivityAt !== "string" || Date.parse(value.lastActivityAt) > cutoff) continue; const key = entry.name.slice(0, -5); await fs.rm(path.join(root, "sessions", key), { recursive: true, force: true }); await fs.rm(file, { force: true }); }`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, rootDir, String(NOW.getTime())], { stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    child.stderr.on("data", (chunk) => { error += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(error || `legacy worker exit ${code}`)));
  });
}

test("production preservation API exposes only one options parameter", () => {
  assert.equal(publicCreatePreservationPin.length, 1);
  assert.equal(publicInspectPreservationPin.length, 1);
  assert.equal(publicRefreshPreservationPin.length, 1);
  assert.equal(publicReleasePreservationPin.length, 1);
});

test("bridge capability is versioned but adoption remains closed until deployment verification", () => {
  const capability = probeBridgeV1Capability();
  assert.equal(capability.capability, "bridge-v1");
  assert.equal(capability.version, 1);
  assert.equal(capability.verified, false);
  assert.equal(isBridgeV1Capability(capability), true);
  assert.equal(canAdoptExistingV1(capability), false);
  assert.equal(isBridgeV1Capability({ capability: "bridge-v1", version: 2 }), false);
  assert.equal(canAdoptExistingV1(undefined), false);
});

test("pin creation is owner-only, atomic, opaque, and idempotent", async (t) => {
  const rootDir = await tempRoot(t);
  const pinUntil = new Date(NOW.getTime() + DEFAULT_ROLLBACK_WINDOW_MS);
  const first = await createPreservationPin({ rootDir, sourceHash: SOURCE_HASH, now: NOW, pinUntil });
  assert.equal(first.status, "created");
  const second = await createPreservationPin({ rootDir, sourceHash: SOURCE_HASH, now: NOW, pinUntil });
  assert.equal(second.status, "already_exists");
  const markerDir = path.join(rootDir, "preservation-pins");
  const markerFile = path.join(markerDir, `${SOURCE_HASH}.json`);
  const hardlink = path.join(markerDir, "hardlink.json");
  await fs.link(markerFile, hardlink);
  assert.equal((await inspectPreservationPin({ rootDir, sourceHash: SOURCE_HASH, now: NOW })).state, "invalid");
  await fs.unlink(hardlink);
  const marker = JSON.parse(await fs.readFile(markerFile, "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(marker).sort(), ["createdAt", "integrity", "lastRefreshedAt", "pinUntil", "sourceHash", "version"]);
  assert.equal(marker.sourceHash, SOURCE_HASH);
  assert.equal("task" in marker, false);
  assert.equal("cwd" in marker, false);
  assert.equal("agent" in marker, false);
  assert.equal("token" in marker, false);
  assert.equal((await fs.stat(markerDir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(markerFile)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(markerFile)).mtimeMs, NOW.getTime());
  assert.equal(marker.lastRefreshedAt, NOW.toISOString());
  assert.equal((await inspectPreservationPin({ rootDir, sourceHash: SOURCE_HASH, now: NOW })).state, "valid");

  const before = (await fs.stat(markerFile)).mtimeMs;
  const refreshedAt = new Date(NOW.getTime() + 1_000);
  const refreshed = await refreshPreservationPin({ rootDir, sourceHash: SOURCE_HASH, now: refreshedAt, pinUntil: new Date(pinUntil.getTime() + 1_000) });
  assert.equal(refreshed.status, "refreshed");
  assert.equal((await fs.stat(markerFile)).mtimeMs, refreshedAt.getTime());
  assert.ok((await fs.stat(markerFile)).mtimeMs >= before);
  await fs.rm(rootDir, { recursive: true, force: true });
});

test("owner proof is fail closed when uid inspection is unavailable", async (t) => {
  const rootDir = await tempRoot(t);
  const moduleUrl = new URL("../src/bridge.ts", import.meta.url).href;
  const script = `import { createPreservationPin } from ${JSON.stringify(moduleUrl)}; process.getuid = undefined; const result = await createPreservationPin({ rootDir: process.argv[1], sourceHash: "${SOURCE_HASH}", pinUntil: new Date(Date.now() + 86400000) }); process.stdout.write(result.status);`;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, rootDir], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  await new Promise<void>((resolve, reject) => { let error = ""; child.stderr.on("data", (chunk) => { error += chunk; }); child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(error || `child exit ${code}`))); });
  assert.equal(output, "rejected");
});

test("marker survives child process kill and reopen after durable return", async (t) => {
  const rootDir = await tempRoot(t);
  const ready = path.join(rootDir, "created");
  const moduleUrl = new URL("../src/bridge.ts", import.meta.url).href;
  const script = `import { createPreservationPin } from ${JSON.stringify(moduleUrl)}; import fs from "node:fs/promises"; import { randomUUID } from "node:crypto"; const signal = async (file, value) => { const temporary = file + "." + process.pid + "." + randomUUID() + ".tmp"; const handle = await fs.open(temporary, "wx", 0o600); await handle.writeFile(value, "utf8"); await handle.sync(); await handle.close(); await fs.rename(temporary, file); }; const rootDir = process.argv[1]; const ready = process.argv[2]; const result = await createPreservationPin({ rootDir, sourceHash: "${SOURCE_HASH}", pinUntil: new Date("2099-01-01T00:00:00.000Z") }); await signal(ready, result.status); setInterval(() => {}, 10_000);`;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, rootDir, ready], { stdio: "ignore" });
  t.after(async () => { if (!child.killed && child.exitCode === null) child.kill("SIGKILL"); });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !await fs.stat(ready).then(() => true).catch(() => false)) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(await fs.stat(ready).then(() => true).catch(() => false), true);
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  assert.equal((await inspectPreservationPin({ rootDir, sourceHash: SOURCE_HASH, now: new Date("2026-01-02T00:00:00.000Z") })).state, "valid");
});

test("default pin uses the system clock and the 30-day rollback window", async (t) => {
  const rootDir = await tempRoot(t);
  const created = await createPreservationPin({ rootDir, sourceHash: SOURCE_HASH });
  assert.equal(created.status, "created");
  assert.ok(created.pin);
  assert.equal(Date.parse(created.pin.pinUntil) - Date.parse(created.pin.createdAt), DEFAULT_ROLLBACK_WINDOW_MS);
  assert.equal((await inspectPreservationPin({ rootDir, sourceHash: SOURCE_HASH })).state, "valid");
  assert.equal((await inspectPreservationPin({ rootDir, sourceHash: SOURCE_HASH, now: new Date(Date.parse(created.pin.pinUntil) - 1) })).state, "valid");
  assert.equal((await inspectPreservationPin({ rootDir, sourceHash: SOURCE_HASH, now: new Date(created.pin.pinUntil) })).state, "expired");
});

test("active pin can be safely released before expiry", async (t) => { const rootDir = await tempRoot(t); const pinUntil = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000); assert.equal((await createPreservationPin({ rootDir, sourceHash: SOURCE_HASH, now: NOW, pinUntil })).status, "created"); assert.equal((await releasePreservationPin({ rootDir, sourceHash: SOURCE_HASH, now: new Date(pinUntil.getTime() - 1) })).status, "released"); assert.equal((await inspectPreservationPin({ rootDir, sourceHash: SOURCE_HASH, now: NOW })).state, "absent"); });

test("active pin conflicts, expires exactly at the boundary, and releases idempotently", async (t) => {
  const rootDir = await tempRoot(t);
  const pinUntil = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000);
  assert.equal((await createPreservationPin({ rootDir, sourceHash: SOURCE_HASH, now: NOW, pinUntil })).status, "created");
  assert.equal((await createPreservationPin({ rootDir, sourceHash: SOURCE_HASH, now: NOW, pinUntil: new Date(pinUntil.getTime() + 1) })).status, "conflict");
  assert.equal((await inspectPreservationPin({ rootDir, sourceHash: SOURCE_HASH, now: new Date(pinUntil.getTime() - 1) })).state, "valid");
  assert.equal((await inspectPreservationPin({ rootDir, sourceHash: SOURCE_HASH, now: pinUntil })).state, "expired");
  assert.equal((await releasePreservationPin({ rootDir, sourceHash: SOURCE_HASH, now: pinUntil })).status, "released");
  assert.equal((await releasePreservationPin({ rootDir, sourceHash: SOURCE_HASH, now: pinUntil })).status, "absent");
  await fs.rm(rootDir, { recursive: true, force: true });
});

test("two real Node processes serialize pin creation under a deterministic held-lock barrier", async (t) => {
  const rootDir = await tempRoot(t);
  const lock = await acquireIdentityLock({ rootDir, key: SOURCE_HASH });
  assert.ok(lock);
  const children: ReturnType<typeof spawn>[] = [];
  t.after(async () => {
    for (const child of children) if (!child.killed && child.exitCode === null) child.kill("SIGTERM");
  });
  const moduleUrl = new URL("../src/bridge.ts", import.meta.url).href;
  const go = path.join(rootDir, "go");
  const script = `import { createPreservationPin } from ${JSON.stringify(moduleUrl)}; import fs from "node:fs/promises"; import { randomUUID } from "node:crypto"; import path from "node:path"; const signal = async (file, value) => { const temporary = file + "." + process.pid + "." + randomUUID() + ".tmp"; const handle = await fs.open(temporary, "wx", 0o600); await handle.writeFile(value, "utf8"); await handle.sync(); await handle.close(); await fs.rename(temporary, file); }; const rootDir = process.argv[1]; const index = process.argv[2]; const ready = path.join(rootDir, "ready-" + index); const go = path.join(rootDir, "go"); await signal(ready, "ready"); while (!(await fs.stat(go).then(() => true).catch(() => false))) await new Promise((resolve) => setTimeout(resolve, 2)); await signal(path.join(rootDir, "attempted-" + index), "attempted"); const result = await createPreservationPin({ rootDir, sourceHash: "${SOURCE_HASH}", pinUntil: new Date("2099-01-01T00:00:00.000Z") }); process.stdout.write(JSON.stringify(result));`;
  const run = (index: number): Promise<{ status: string }> => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, rootDir, String(index)], { stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let output = "";
    let error = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { error += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(JSON.parse(output) as { status: string }) : reject(new Error(error || `child exit ${code}`)));
  });
  const resultsPromise = Promise.all([run(0), run(1)]);
  const waitFor = async (file: string): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (await fs.stat(file).then(() => true).catch(() => false)) return;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error(`barrier timeout: ${file}`);
  };
  await Promise.all([waitFor(path.join(rootDir, "ready-0")), waitFor(path.join(rootDir, "ready-1"))]);
  await atomicSignal(go, "go");
  await Promise.all([waitFor(path.join(rootDir, "attempted-0")), waitFor(path.join(rootDir, "attempted-1"))]);
  const results = await resultsPromise;
  assert.deepEqual(results.map((result) => result.status).sort(), ["busy", "busy"]);
  await lock.release();
  assert.equal((await createPreservationPin({ rootDir, sourceHash: SOURCE_HASH, now: NOW, pinUntil: new Date("2026-01-31T00:00:00.000Z") })).status, "created");
  assert.equal((await createPreservationPin({ rootDir, sourceHash: SOURCE_HASH, now: NOW, pinUntil: new Date("2026-01-31T00:00:00.000Z") })).status, "already_exists");
});

test("two real children observe busy then deterministic created/already_exists retry", async (t) => {
  const rootDir = await tempRoot(t);
  const lock = await acquireIdentityLock({ rootDir, key: SOURCE_HASH });
  assert.ok(lock);
  const children: ReturnType<typeof spawn>[] = [];
  const exits: Promise<void>[] = [];
  t.after(async () => {
    if (lock) await lock.release().catch(() => undefined);
    for (const child of children) if (!child.killed && child.exitCode === null) child.kill("SIGTERM");
    await Promise.all(exits);
  });
  const moduleUrl = new URL("../src/bridge.ts", import.meta.url).href;
  const script = `import { createPreservationPin } from ${JSON.stringify(moduleUrl)}; import fs from "node:fs/promises"; import { randomUUID } from "node:crypto"; import path from "node:path"; const signal = async (file, value) => { const temporary = file + "." + process.pid + "." + randomUUID() + ".tmp"; const handle = await fs.open(temporary, "wx", 0o600); await handle.writeFile(value, "utf8"); await handle.sync(); await handle.close(); await fs.rename(temporary, file); }; const root = process.argv[1]; const index = process.argv[2]; const initial = await createPreservationPin({ rootDir: root, sourceHash: "${SOURCE_HASH}", pinUntil: new Date("2099-01-01T00:00:00.000Z") }); await signal(path.join(root, "initial-" + index), initial.status); while (!(await fs.stat(path.join(root, "retry-" + index)).then(() => true).catch(() => false))) await new Promise((resolve) => setTimeout(resolve, 2)); const retry = await createPreservationPin({ rootDir: root, sourceHash: "${SOURCE_HASH}", pinUntil: new Date("2099-01-01T00:00:00.000Z") }); await signal(path.join(root, "result-" + index), retry.status);`;
  const run = (index: number): void => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, rootDir, String(index)], { stdio: ["ignore", "ignore", "pipe"] });
    children.push(child);
    const exited = new Promise<void>((resolve, reject) => { let error = ""; child.stderr.on("data", (chunk) => { error += chunk; }); child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(error || `child exit ${code}`))); });
    exits.push(exited);
  };
  run(0); run(1);
  const waitFor = async (file: string): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) { if (await fs.stat(file).then(() => true).catch(() => false)) return; await new Promise((resolve) => setTimeout(resolve, 2)); }
    throw new Error(`barrier timeout: ${file}`);
  };
  await Promise.all([waitFor(path.join(rootDir, "initial-0")), waitFor(path.join(rootDir, "initial-1"))]);
  assert.deepEqual(await Promise.all([fs.readFile(path.join(rootDir, "initial-0"), "utf8"), fs.readFile(path.join(rootDir, "initial-1"), "utf8")]), ["busy", "busy"]);
  await lock.release();
  await atomicSignal(path.join(rootDir, "retry-0"), "go");
  await waitFor(path.join(rootDir, "result-0"));
  assert.equal(await fs.readFile(path.join(rootDir, "result-0"), "utf8"), "created");
  await atomicSignal(path.join(rootDir, "retry-1"), "go");
  await waitFor(path.join(rootDir, "result-1"));
  assert.equal(await fs.readFile(path.join(rootDir, "result-1"), "utf8"), "already_exists");
  await Promise.all(exits);
});

test("tampering and symlink boundaries fail closed", async (t) => {
  const rootDir = await tempRoot(t);
  const pinUntil = new Date(NOW.getTime() + DEFAULT_ROLLBACK_WINDOW_MS);
  await createPreservationPin({ rootDir, sourceHash: SOURCE_HASH, now: NOW, pinUntil });
  const markerFile = path.join(rootDir, "preservation-pins", `${SOURCE_HASH}.json`);
  await fs.chmod(markerFile, 0o644);
  assert.equal((await inspectPreservationPin({ rootDir, sourceHash: SOURCE_HASH, now: NOW })).state, "invalid");
  await fs.chmod(markerFile, 0o600);
  const marker = JSON.parse(await fs.readFile(markerFile, "utf8")) as Record<string, unknown>;
  marker.pinUntil = new Date(pinUntil.getTime() + 1).toISOString();
  await fs.writeFile(markerFile, JSON.stringify(marker));
  assert.equal((await inspectPreservationPin({ rootDir, sourceHash: SOURCE_HASH, now: NOW })).state, "invalid");
  assert.equal((await refreshPreservationPin({ rootDir, sourceHash: SOURCE_HASH, now: NOW, pinUntil })).status, "rejected");

  const outside = await tempRoot(t);
  await fs.rm(path.join(rootDir, "preservation-pins"), { recursive: true, force: true });
  await fs.symlink(outside, path.join(rootDir, "preservation-pins"));
  assert.equal((await createPreservationPin({ rootDir, sourceHash: "b".repeat(64), now: NOW, pinUntil })).status, "rejected");
  assert.equal((await inspectPreservationPin({ rootDir, sourceHash: SOURCE_HASH, now: NOW })).state, "invalid");
  await fs.rm(rootDir, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

test("publish rejects temp, target, and marker-directory replacement", async (t) => {
  const pinUntil = new Date(NOW.getTime() + DEFAULT_ROLLBACK_WINDOW_MS);
  const exercise = async (beforePublish: (paths: { directory: string; temporary: string; target: string }) => Promise<void>) => {
    const rootDir = await tempRoot(t);
    await createPreservationPin({ rootDir, sourceHash: SOURCE_HASH, now: NOW, pinUntil });
    const result = await refreshPreservationPin({ rootDir, sourceHash: SOURCE_HASH, now: NOW, pinUntil: new Date(pinUntil.getTime() + 1) }, { beforePublish });
    assert.equal(result.status, "rejected");
  };
  const outside = await tempRoot(t);
  await exercise(async ({ temporary }) => { await fs.unlink(temporary); await fs.symlink(outside, temporary); });
  await exercise(async ({ target }) => { await fs.rename(target, `${target}.old`); await fs.writeFile(target, "replacement", { mode: 0o600 }); });
  await exercise(async ({ directory }) => { await fs.rename(directory, `${directory}.old`); await fs.mkdir(directory, { mode: 0o700 }); });
});

test("bridge GC protects a valid pin inside the original identity lock", async (t) => {
  const rootDir = await tempRoot(t);
  const sessionDir = await writeOldRegistry(rootDir);
  const pinUntil = new Date(NOW.getTime() + DEFAULT_ROLLBACK_WINDOW_MS);
  await createPreservationPin({ rootDir, sourceHash: SOURCE_HASH, now: NOW, pinUntil });
  const marker = path.join(rootDir, "preservation-pins", `${SOURCE_HASH}.json`);
  const before = (await fs.stat(marker)).mtimeMs;
  const result = await garbageCollect({ rootDir, now: new Date("2026-01-02T00:00:00.000Z"), retentionMs: 1 });
  assert.equal(result.removed, 0);
  assert.equal(result.skippedPinned, 1);
  assert.equal(await fs.stat(sessionDir).then(() => true).catch(() => false), true);
  assert.equal(await fs.stat(path.join(rootDir, "registry", `${SOURCE_HASH}.json`)).then(() => true).catch(() => false), true);
  assert.equal((await fs.stat(marker)).mtimeMs, before);
  await fs.rm(rootDir, { recursive: true, force: true });
});

test("bridge GC deletes an expired pin and its v1 source, but never scans v2 namespace", async (t) => {
  const rootDir = await tempRoot(t);
  const sessionDir = await writeOldRegistry(rootDir);
  await fs.mkdir(path.join(rootDir, "v2", "sessions", SOURCE_HASH), { recursive: true });
  await fs.writeFile(path.join(rootDir, "v2", "sessions", SOURCE_HASH, "live"), "v2");
  const pinUntil = new Date(NOW.getTime() + DEFAULT_ROLLBACK_WINDOW_MS);
  await createPreservationPin({ rootDir, sourceHash: SOURCE_HASH, now: NOW, pinUntil });
  const result = await garbageCollect({ rootDir, now: new Date(pinUntil.getTime()), retentionMs: 1 });
  assert.equal(result.removed, 1);
  assert.equal(await fs.stat(sessionDir).then(() => true).catch(() => false), false);
  assert.equal(await fs.stat(path.join(rootDir, "v2", "sessions", SOURCE_HASH, "live")).then(() => true).catch(() => false), true);
  await fs.rm(rootDir, { recursive: true, force: true });
});

test("invalid pin blocks GC rather than guessing a safe rollback", async (t) => {
  const rootDir = await tempRoot(t);
  const sessionDir = await writeOldRegistry(rootDir);
  await createPreservationPin({ rootDir, sourceHash: SOURCE_HASH, now: NOW, pinUntil: new Date(NOW.getTime() + DEFAULT_ROLLBACK_WINDOW_MS) });
  const marker = path.join(rootDir, "preservation-pins", `${SOURCE_HASH}.json`);
  const value = JSON.parse(await fs.readFile(marker, "utf8")) as Record<string, unknown>;
  value.integrity = "0".repeat(64);
  await fs.writeFile(marker, JSON.stringify(value));
  const result = await garbageCollect({ rootDir, now: new Date("2027-01-01T00:00:00.000Z"), retentionMs: 1 });
  assert.equal(result.removed, 0);
  assert.equal(result.skippedPinned, 1);
  assert.equal(await fs.stat(sessionDir).then(() => true).catch(() => false), true);
  await fs.rm(rootDir, { recursive: true, force: true });
});

test("legacy v1 negative fixture ignores the marker and still cannot enable adoption", async (t) => {
  const rootDir = await tempRoot(t);
  const sessionDir = await writeOldRegistry(rootDir);
  await createPreservationPin({ rootDir, sourceHash: SOURCE_HASH, now: NOW, pinUntil: new Date(NOW.getTime() + DEFAULT_ROLLBACK_WINDOW_MS) });
  // This is a fixed old-v1 worker fixture: it scans the registry itself and
  // has no bridge capability, so it does not inspect the independent marker.
  await runLegacyV1Worker(rootDir);
  assert.equal(await fs.stat(sessionDir).then(() => true).catch(() => false), false);
  assert.equal(await fs.stat(path.join(rootDir, "registry", `${SOURCE_HASH}.json`)).then(() => true).catch(() => false), false);
  assert.equal(await fs.stat(sessionDir).then(() => true).catch(() => false), false);
  assert.equal(canAdoptExistingV1(probeBridgeV1Capability()), false);
});

test("a symlinked root is not a bridge store", async (t) => {
  const realRoot = await tempRoot(t);
  const parent = await tempRoot(t);
  const link = path.join(parent, "link");
  await fs.symlink(realRoot, link);
  const result = await createPreservationPin({ rootDir: link, sourceHash: SOURCE_HASH, now: NOW, pinUntil: new Date(NOW.getTime() + DEFAULT_ROLLBACK_WINDOW_MS) });
  assert.equal(result.status, "rejected");
  assert.equal(await fs.stat(path.join(realRoot, "preservation-pins")).then(() => true).catch(() => false), false);
  await fs.rm(realRoot, { recursive: true, force: true });
  await fs.rm(parent, { recursive: true, force: true });
});
