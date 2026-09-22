import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runPiAttempt } from "../src/runner.ts";
import { buildSideEffectFenceExtensions, cleanupSideEffectFenceOrphans, startSideEffectFenceServer, sideEffectFenceEnvironment, sideEffectFencePackageManifestDigest, sideEffectFenceToolSetDigest, sideEffectFenceSnapshotDigest, createSideEffectFenceTestClientProof, createSideEffectFenceTestDeploymentProof, createSideEffectFenceTestSnapshot, type SideEffectFenceConfig } from "../src/delegation-internal.ts";
import { admitDispatchCallInternal, resolveDelegationInternal, reserveInitialInternal, markSpawnStartedInternal, bindChildSessionInternal, readActionLedgerInternal, executeDelegationInternal, executeReattachedDelegationInternal } from "../src/delegation-internal.ts";
import { getAgentDiscoverySnapshot } from "../src/agents.ts";
import { createHash } from "node:crypto";
import type { ActiveLineage } from "../src/lineage.ts";
import type { OwnerIdentity } from "../src/delegation-internal.ts";
import { readStableOwnerFileSync } from "../src/secure-fs.ts";
import { hashPath } from "../src/delegation-context.ts";
import type { AgentConfig } from "../src/agents.ts";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as net from "node:net";
import { spawn as childSpawn } from "node:child_process";

const agent: AgentConfig = { name: "implementer", description: "test", source: "user", filePath: "/tmp/agent.md", systemPrompt: "" };
const header = { type: "session", version: 3, id: "fence-child", cwd: "/tmp/fence-project", timestamp: new Date().toISOString() };
const terminal = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], api: "openai-completions", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } };
function fakeProcess(capture: { args?: string[]; env?: NodeJS.ProcessEnv; stdio?: unknown[]; killed?: boolean }): any {
  const child = new EventEmitter() as any; child.pid = 4567; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.killed = false; child.kill = () => { child.killed = true; capture.killed = true; return true; };
  queueMicrotask(() => { child.stdout.write(`${JSON.stringify(header)}\n${JSON.stringify(terminal)}\n`); child.stdout.end(); child.stderr.end(); child.emit("close", 0); });
  return child;
}
function digest(file: string): string { return readStableOwnerFileSync(file)!.digest; }
async function extensionSpec(file: string, toolNames: string[] = ["custom_tool"]) {
  const content = await fs.readFile(file, "utf8");
  const snapshot = await createSideEffectFenceTestSnapshot(path.dirname(file), { [`${path.basename(file)}`]: content, "interceptor.ts": content });
  const entry = readStableOwnerFileSync(snapshot.files[path.basename(file)])!;
  const packageManifest = JSON.parse(await fs.readFile(snapshot.files["package.json"], "utf8"));
  const packageStable = readStableOwnerFileSync(snapshot.files["package.json"])!;
  return { path: entry.realpath, version: "1.0.0", digest: entry.digest, toolNames, preprocessor: true as const, snapshotRoot: snapshot.root, snapshotManifestPath: snapshot.manifestPath, snapshotManifestDigest: snapshot.manifestDigest, snapshotDigest: sideEffectFenceSnapshotDigest(entry.digest, snapshot.manifestDigest), packagePath: packageStable.realpath, packageName: packageManifest.name, packageVersion: packageManifest.version, entryRealpath: entry.realpath, entryDigest: entry.digest, entryRelativePath: path.basename(file), toolSetDigest: sideEffectFenceToolSetDigest(toolNames), packageManifestDigest: sideEffectFencePackageManifestDigest(packageManifest), interceptorPath: path.join(snapshot.root, "interceptor.ts") };
}
function config(allowlist: SideEffectFenceConfig["allowlist"]): SideEffectFenceConfig {
  const base: SideEffectFenceConfig = { enabled: true, allowlist, interceptorPath: allowlist[0] ? path.join(allowlist[0].snapshotRoot, "interceptor.ts") : undefined, policy: { version: "1.0.0", source: "immutable-test-seam", tools: [{ toolName: "custom_tool", classification: "fenced_mutating" }] } };
  if (!allowlist.length) return base;
  const manifest = buildSideEffectFenceExtensions(base).allowlistDigest;
  return { ...base, deploymentVerification: createSideEffectFenceTestDeploymentProof({ manifestDigest: manifest }) };
}
async function liveFence(prefix: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const project = path.join(root, "project"); await fs.mkdir(project); await fs.writeFile(path.join(project, "agent.md"), "---\nname: implement\ndescription: test\n---\nworker", { mode: 0o600 });
  const snapshot = getAgentDiscoverySnapshot(project)!; const parentSessionId = `${prefix}-parent`; const lineage: ActiveLineage = { parentSessionId, activeLineageId: `${prefix}-lineage`, activeBranchAnchor: `${prefix}-anchor`, currentLeafId: `${prefix}-anchor`, branchIds: ["root", `${prefix}-anchor`], persistence: "in_process_only" };
  const admitted = await admitDispatchCallInternal({ parentSessionId, lineage, toolCallId: `${prefix}-tool`, cwd: project, mode: "single", agentScope: "project", projectTrust: { parentSessionId, discoveryRootRealpath: snapshot.rootRealpath, snapshotDigest: snapshot.digest }, single: { agent: "implement", task: "opaque" } }, root);
  const callId = admitted.dispatchCallId!; const delegationId = admitted.delegationIds![0]!; await resolveDelegationInternal(root, callId, delegationId, { lineage });
  const owner: OwnerIdentity = { host: os.hostname(), pid: process.pid, birth: `${prefix}-owner`, parentSessionId, parentSessionPath: path.join(root, "parent.jsonl"), argvProof: createHash("sha256").update(prefix).digest("hex") };
  const reserved = await reserveInitialInternal(root, callId, delegationId, { lineage, owner }); const started = await markSpawnStartedInternal(root, callId, delegationId, "initial", { lineage, owner }); assert.equal(started.state, "initial_running");
  const extension = path.join(root, "allowed.ts"); await fs.writeFile(extension, "export default function () {}\n", { mode: 0o600 });
  const server = await startSideEffectFenceServer({ rootDir: root, dispatchCallId: callId, delegationId, executionScope: `${prefix}-scope`, reservationId: reserved.reservationId!, continuationEpoch: 0, claim: { owner: started.owner!, ownerGeneration: started.ownerGeneration!, fencingGeneration: started.fencingGeneration!, spawnId: started.spawnId! }, config: config([await extensionSpec(extension)]) });
  return { root, server, callId, delegationId };
}
function wireHash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
async function removeFixture(root: string): Promise<void> { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); }
async function openFence(server: Awaited<ReturnType<typeof startSideEffectFenceServer>>, childSessionId: string) {
  await server.bindChild(process.pid, childSessionId);
  const socket = net.createConnection(server.socket); const queue: any[] = []; const waiters: Array<(frame: any) => void> = []; let buffer = "";
  socket.on("data", (chunk) => { buffer += chunk.toString(); const lines = buffer.split("\n"); buffer = lines.pop() ?? ""; for (const line of lines) { if (!line) continue; const frame = JSON.parse(line); const waiter = waiters.shift(); if (waiter) waiter(frame); else queue.push(frame); } });
  await new Promise<void>((resolve, reject) => { socket.once("connect", () => resolve()); socket.once("error", reject); });
  const next = () => queue.length ? Promise.resolve(queue.shift()) : new Promise<any>((resolve) => waiters.push(resolve));
  const binding = server.client.handshake!; const hello = { version: 1, type: "hello", seq: 0, nonce: server.client.nonce, ...binding, childSessionId, pid: process.pid, childIdentityRef: wireHash({ pid: process.pid, sessionId: childSessionId }) }; socket.write(`${JSON.stringify(hello)}\n`);
  assert.equal((await next()).type, "hello_ack"); assert.equal(await server.awaitHandshake(), true);
  return { socket, next, send(frame: Record<string, unknown>) { socket.write(`${JSON.stringify(frame)}\n`); return next(); } };
}
function goodbyeFrame(server: Awaited<ReturnType<typeof startSideEffectFenceServer>>, childSessionId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const binding = server.client.handshake!; return { version: 1, type: "goodbye", seq: 1, requestId: "goodbye", nonce: server.client.nonce, dispatchCallId: binding.dispatchCallId, delegationId: binding.delegationId, executionScope: binding.executionScope, reservationId: binding.reservationId, owner: binding.owner, ownerGeneration: binding.ownerGeneration, fencingGeneration: binding.fencingGeneration, childSessionId, childIdentityRef: wireHash({ pid: process.pid, sessionId: childSessionId }), pid: process.pid, completedActionIds: [], blockedActionIds: [], inflight: { prepare: 0, intent: 0, result: 0 }, ...overrides };
}
function runnerFenceClient(root: string, proof: ReturnType<typeof buildSideEffectFenceExtensions>, fenceConfig: SideEffectFenceConfig, overrides: Record<string, unknown> = {}): any {
  return { socket: path.join(root, "socket"), nonce: "opaque-nonce", protocol: 1, extensions: proof.extensions, interceptor: proof.interceptor, deploymentProof: createSideEffectFenceTestClientProof(fenceConfig.deploymentVerification!, proof.allowlistDigest, "opaque-nonce"), handshake: { dispatchCallId: "call", delegationId: "delegation", executionScope: "scope", reservationId: "reservation", owner: "owner", ownerGeneration: 1, fencingGeneration: 1, childIdentityRef: "self", allowlistManifestDigest: proof.allowlistDigest, extensionOrderDigest: proof.extensionOrderDigest, toolSetDigest: proof.toolSetDigest, policyDigest: proof.policyDigest, interceptorRealpath: proof.interceptorSpec.path, interceptorDigest: proof.interceptorSpec.digest, interceptorVersion: proof.interceptorSpec.version, fenceLastProof: "proof" }, bindChild: async () => true, awaitHandshake: async () => true, awaitGraceful: async () => true, close: async () => {}, ...overrides };
}

test("fenced runner uses no ambient discovery, deterministic explicit order, and no private prompt argv/env", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fence-runner-"));
  const extension = path.join(root, "custom.ts"); await fs.writeFile(extension, "export default function () {}\n", { mode: 0o600 });
  const spec = await extensionSpec(extension); const fenceConfig = config([spec]); const proof = buildSideEffectFenceExtensions(fenceConfig);
  const capture: { args?: string[]; env?: NodeJS.ProcessEnv; stdio?: unknown[] } = {};
  const attempt = await runPiAttempt({ cwd: "/tmp/fence-project", agent, task: "PRIVATE TASK", model: "test", attempt: 1, source: "initial", sessionDir: root, childSessionId: "fence-child", firstLogicalChildSpawn: true, parentFastRequested: false, sideEffectFence: { socket: path.join(root, "socket"), nonce: "opaque-nonce", protocol: 1, extensions: proof.extensions, interceptor: proof.interceptor, deploymentProof: createSideEffectFenceTestClientProof(fenceConfig.deploymentVerification!, proof.allowlistDigest, "opaque-nonce"), bindChild: async () => true, awaitHandshake: async () => true, awaitGraceful: async () => true, close: async () => {}, handshake: { dispatchCallId: "call", delegationId: "delegation", executionScope: "scope", reservationId: "reservation", owner: "owner", ownerGeneration: 1, fencingGeneration: 1, childIdentityRef: "self", allowlistManifestDigest: proof.allowlistDigest, extensionOrderDigest: proof.extensionOrderDigest, toolSetDigest: proof.toolSetDigest, policyDigest: proof.policyDigest, interceptorRealpath: proof.interceptorSpec.path, interceptorDigest: proof.interceptorSpec.digest, interceptorVersion: proof.interceptorSpec.version, fenceLastProof: "proof" } }, onChildProcess: async () => true, spawn: ((_command, args, options) => { capture.args = args; capture.env = options.env; capture.stdio = options.stdio; return fakeProcess(capture); }) as any });
  assert.equal(attempt.failureKind, "success");
  assert.deepEqual(capture.args?.slice(capture.args?.indexOf("--no-tools")), ["--no-tools", "--no-extensions", "-e", proof.extensions[0], "-e", proof.interceptor]);
  assert.equal(capture.args?.includes("PRIVATE TASK"), false);
  assert.equal(capture.env?.PI_SUBAGENT_FENCE_NONCE, "opaque-nonce");
  assert.equal(capture.env?.PI_SUBAGENT_FENCE_PROTOCOL, "1");
  assert.equal(capture.env?.PI_SUBAGENT_FENCE_SOCKET, path.join(root, "socket"));
  assert.equal(capture.env?.PATH, process.env.PATH);
  assert.equal(Object.values(capture.env ?? {}).includes("PRIVATE TASK"), false);
  assert.deepEqual(capture.stdio, ["pipe", "pipe", "pipe"]);
  await fs.rm(root, { recursive: true, force: true });
});

test("direct runner refuses to spawn without an opaque deployment proof", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fence-missing-proof-")); let spawned = false;
  const result = await runPiAttempt({ cwd: "/tmp/fence-project", agent, task: "PRIVATE TASK", model: "test", attempt: 1, source: "initial", sessionDir: root, childSessionId: "fence-child", firstLogicalChildSpawn: true, parentFastRequested: false, sideEffectFence: { socket: path.join(root, "socket"), nonce: "opaque-nonce", protocol: 1, extensions: [], interceptor: "/tmp/interceptor" }, spawn: (() => { spawned = true; return fakeProcess({}); }) as any });
  assert.equal(spawned, false); assert.equal(result.failureKind, "unknown_transport"); await fs.rm(root, { recursive: true, force: true });
});

test("reattach refuses to invoke a live child executor without deployment and channel proofs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fence-reattach-proof-")); const project = path.join(root, "project"); await fs.mkdir(project, { mode: 0o700 }); await fs.writeFile(path.join(project, "agent.md"), "---\nname: implement\ndescription: implement\n---\nInstructions", { mode: 0o600 }); const snapshot = getAgentDiscoverySnapshot(project)!; const parentSessionId = "reattach-proof-parent"; const lineage: ActiveLineage = { parentSessionId, activeLineageId: "reattach-proof-lineage", activeBranchAnchor: "reattach-proof-anchor", currentLeafId: "reattach-proof-anchor", branchIds: ["root", "reattach-proof-anchor"], persistence: "in_process_only" };
  const admitted = await admitDispatchCallInternal({ parentSessionId, lineage, toolCallId: "reattach-proof-tool", cwd: project, mode: "single", agentScope: "project", projectTrust: { parentSessionId, discoveryRootRealpath: snapshot.rootRealpath, snapshotDigest: snapshot.digest }, single: { agent: "implement", task: "opaque" } }, root); const delegationId = admitted.delegationIds![0]!; await resolveDelegationInternal(root, admitted.dispatchCallId!, delegationId, { lineage }); const owner: OwnerIdentity = { host: os.hostname(), pid: process.pid, birth: "reattach-proof-owner", parentSessionId, parentSessionPath: path.join(root, "parent.jsonl"), argvProof: createHash("sha256").update("reattach-proof-owner").digest("hex") }; await reserveInitialInternal(root, admitted.dispatchCallId!, delegationId, { lineage, owner }); const started = await markSpawnStartedInternal(root, admitted.dispatchCallId!, delegationId, "initial", { lineage, owner }); assert.equal(started.state, "initial_running"); await bindChildSessionInternal(root, admitted.dispatchCallId!, delegationId, { owner: started.owner!, ownerGeneration: started.ownerGeneration!, fencingGeneration: started.fencingGeneration!, spawnId: started.spawnId! }, "live-child", undefined, 12345, { lineage, owner, childIdentity: { host: os.hostname(), pid: 12345, birth: "live-child-birth", sessionPathHash: hashPath(path.join(root, "child-session.jsonl")), argvProof: "a".repeat(64) } }); let invoked = false; const result = await executeReattachedDelegationInternal(root, admitted.dispatchCallId!, delegationId, async () => { invoked = true; throw new Error("must not execute"); }, { lineage, owner, inspectChild: async () => "live", sideEffectFence: config([]) }); assert.equal(invoked, false); assert.equal(result.state, "paused_integrity"); await fs.rm(root, { recursive: true, force: true });
});

test("allowlist tamper, symlink, duplicate and non-owner-writable proof fail closed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fence-proof-"));
  const extension = path.join(root, "custom.ts"); await fs.writeFile(extension, "export default function () {}\n", { mode: 0o600 });
  const spec = await extensionSpec(extension);
  await fs.appendFile(spec.path, "tampered\n");
  assert.throws(() => buildSideEffectFenceExtensions(config([spec])));
  await fs.writeFile(spec.path, "export default function () {}\n", { mode: 0o600 });
  const repaired = await extensionSpec(extension);
  await fs.chmod(repaired.path, 0o644); assert.throws(() => config([repaired])); await fs.chmod(repaired.path, 0o600);
  await fs.chmod(repaired.snapshotRoot, 0o755); assert.throws(() => config([repaired])); await fs.chmod(repaired.snapshotRoot, 0o700);
  const link = path.join(root, "link.ts"); await fs.symlink(extension, link);
  assert.throws(() => buildSideEffectFenceExtensions(config([{ ...repaired, path: link }])));
  assert.throws(() => buildSideEffectFenceExtensions(config([repaired, repaired])));
  await fs.rm(root, { recursive: true, force: true });
});

test("deployment verification gate pauses before any opt-in spawn", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fence-deployment-gate-"));
  const project = path.join(root, "project"); await fs.mkdir(project, { mode: 0o700 }); await fs.writeFile(path.join(project, "agent.md"), "---\nname: implement\ndescription: implement\n---\nInstructions", { mode: 0o600 });
  const snapshot = getAgentDiscoverySnapshot(project)!; const parentSessionId = "gate-parent"; const lineage: ActiveLineage = { parentSessionId, activeLineageId: "gate-lineage", activeBranchAnchor: "gate-anchor", currentLeafId: "gate-anchor", branchIds: ["root", "gate-anchor"], persistence: "in_process_only" };
  const admitted = await admitDispatchCallInternal({ parentSessionId, lineage, toolCallId: "gate-tool", cwd: project, mode: "single", agentScope: "project", projectTrust: { parentSessionId, discoveryRootRealpath: snapshot.rootRealpath, snapshotDigest: snapshot.digest }, single: { agent: "implement", task: "opaque" } }, root);
  const delegationId = admitted.delegationIds![0]!; await resolveDelegationInternal(root, admitted.dispatchCallId!, delegationId, { lineage });
  let attempts = 0; const executionAgent = { name: "implement", description: "implement", source: "project" as const, filePath: path.join(project, "agent.md"), systemPrompt: "Instructions" }; const result = await executeDelegationInternal(root, admitted.dispatchCallId!, delegationId, executionAgent, { lineage, sideEffectFence: config([]), runAttempt: async () => { attempts += 1; throw new Error("must not spawn"); } });
  assert.equal(result.state, "paused_integrity"); assert.equal(attempts, 0); assert.match(String(result.error), /deployment verification/);
  await fs.rm(root, { recursive: true, force: true });
});

test("admission-bound allowlist requires exact owner package metadata and tool-set proof", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fence-package-proof-"));
  const packageRoot = path.join(root, "pkg"); await fs.mkdir(packageRoot, { mode: 0o700 });
  const manifest = { name: "@test/fenced-entry", version: "1.0.0", exports: "./entry.ts", pi: { extensions: ["entry.ts"], recoveryFenceExtensions: [{ path: "interceptor.ts", role: "fence" }] } };
  const snapshot = await createSideEffectFenceTestSnapshot(packageRoot, { "entry.ts": "export default function () {}\\n", "package.json": JSON.stringify(manifest), "interceptor.ts": "export default function () {}\\n" });
  const entryStable = readStableOwnerFileSync(snapshot.files["entry.ts"])!; const packageStable = readStableOwnerFileSync(snapshot.files["package.json"])!;
  const spec = { path: entryStable.realpath, version: "1.0.0", digest: entryStable.digest, toolNames: ["custom_tool"], preprocessor: true as const, snapshotRoot: snapshot.root, snapshotManifestPath: snapshot.manifestPath, snapshotManifestDigest: snapshot.manifestDigest, snapshotDigest: sideEffectFenceSnapshotDigest(entryStable.digest, snapshot.manifestDigest), packagePath: packageStable.realpath, packageName: manifest.name, packageVersion: manifest.version, entryRealpath: entryStable.realpath, entryDigest: entryStable.digest, toolSetDigest: createHash("sha256").update(JSON.stringify(["custom_tool"])).digest("hex"), packageManifestDigest: sideEffectFencePackageManifestDigest(manifest) };
  const admissionBase: SideEffectFenceConfig = { enabled: true, allowlist: [spec], interceptorPath: snapshot.files["interceptor.ts"], policy: { version: "1.0.0", source: "admission-bound", tools: [{ toolName: "custom_tool", classification: "fenced_mutating" }] } };
  const admissionConfig: SideEffectFenceConfig = { ...admissionBase, deploymentVerification: createSideEffectFenceTestDeploymentProof({ manifestDigest: buildSideEffectFenceExtensions(admissionBase).allowlistDigest }) };
  assert.equal(buildSideEffectFenceExtensions(admissionConfig).extensions[0], entryStable.realpath);
  assert.throws(() => buildSideEffectFenceExtensions({ ...admissionConfig, allowlist: [{ ...spec, packageVersion: "1.0.1" }] }));
  await fs.rm(root, { recursive: true, force: true });
});

test("package provenance rejects name/version-only, wrong-role, wrong-path, and duplicate declarations", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fence-package-schema-"));
  const makeSpec = async (manifest: Record<string, unknown>) => {
    const snapshot = await createSideEffectFenceTestSnapshot(root, { "entry.ts": "export default function () {}\n", "package.json": JSON.stringify(manifest), "interceptor.ts": "export default function () {}\n" });
    const entry = readStableOwnerFileSync(snapshot.files["entry.ts"])!; const packageFile = readStableOwnerFileSync(snapshot.files["package.json"])!;
    return { path: entry.realpath, version: "1.0.0", digest: entry.digest, toolNames: ["custom_tool"], preprocessor: true as const, snapshotRoot: snapshot.root, snapshotManifestPath: snapshot.manifestPath, snapshotManifestDigest: snapshot.manifestDigest, snapshotDigest: sideEffectFenceSnapshotDigest(entry.digest, snapshot.manifestDigest), packagePath: packageFile.realpath, packageName: manifest.name, packageVersion: manifest.version, entryRealpath: entry.realpath, entryDigest: entry.digest, entryRelativePath: "entry.ts", toolSetDigest: sideEffectFenceToolSetDigest(["custom_tool"]), packageManifestDigest: sideEffectFencePackageManifestDigest(manifest) };
  };
  const base = { name: "@test/schema", version: "1.0.0" };
  const forged = await makeSpec(base);
  assert.throws(() => buildSideEffectFenceExtensions({ enabled: true, allowlist: [forged], interceptorPath: path.join(forged.snapshotRoot, "interceptor.ts"), policy: { version: "1.0.0", source: "immutable-test-seam", tools: [{ toolName: "custom_tool", classification: "fenced_mutating" }] } }));
  const wrongPath = await makeSpec({ ...base, pi: { extensions: ["other.ts"], recoveryFenceExtensions: [{ path: "interceptor.ts", role: "fence" }] } });
  assert.throws(() => buildSideEffectFenceExtensions({ enabled: true, allowlist: [wrongPath], interceptorPath: path.join(wrongPath.snapshotRoot, "interceptor.ts"), policy: { version: "1.0.0", source: "immutable-test-seam", tools: [{ toolName: "custom_tool", classification: "fenced_mutating" }] } }));
  const wrongRole = await makeSpec({ ...base, pi: { extensions: ["entry.ts"], recoveryFenceExtensions: [{ path: "interceptor.ts", role: "preprocessor" }] } });
  assert.throws(() => buildSideEffectFenceExtensions({ enabled: true, allowlist: [wrongRole], interceptorPath: path.join(wrongRole.snapshotRoot, "interceptor.ts"), policy: { version: "1.0.0", source: "immutable-test-seam", tools: [{ toolName: "custom_tool", classification: "fenced_mutating" }] } }));
  const duplicate = await makeSpec({ ...base, pi: { extensions: ["entry.ts", "entry.ts"], recoveryFenceExtensions: [{ path: "interceptor.ts", role: "fence" }] } });
  assert.throws(() => buildSideEffectFenceExtensions({ enabled: true, allowlist: [duplicate], interceptorPath: path.join(duplicate.snapshotRoot, "interceptor.ts"), policy: { version: "1.0.0", source: "immutable-test-seam", tools: [{ toolName: "custom_tool", classification: "fenced_mutating" }] } }));
  await fs.rm(root, { recursive: true, force: true });
});

test("fence runner fails closed unless callback, client bind, and client handshake all succeed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fence-runner-lifecycle-")); const extension = path.join(root, "custom.ts"); await fs.writeFile(extension, "export default function () {}\n", { mode: 0o600 }); const spec = await extensionSpec(extension); const fenceConfig = config([spec]); const proof = buildSideEffectFenceExtensions(fenceConfig);
  const makeProcess = (capture: { spawned?: boolean; bytes: number }) => { const child = new EventEmitter() as any; child.pid = 4567; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.killed = false; child.stdin.on("data", (chunk: Buffer) => { capture.bytes += chunk.length; }); child.kill = () => { child.killed = true; queueMicrotask(() => child.emit("close", null)); return true; }; queueMicrotask(() => { child.stdout.end(); child.stderr.end(); }); return child; };
  const run = (client: any, callback?: any) => { const capture = { spawned: false, bytes: 0 }; return runPiAttempt({ cwd: "/tmp/fence-project", agent, task: "PRIVATE TASK", model: "test", attempt: 1, source: "initial", sessionDir: root, childSessionId: "fence-child", firstLogicalChildSpawn: true, parentFastRequested: false, sideEffectFence: client, ...(callback ? { onChildProcess: callback } : {}), spawn: (() => { capture.spawned = true; return makeProcess(capture); }) as any }).then((result) => ({ result, capture })); };
  const missing = await run(runnerFenceClient(root, proof, fenceConfig)); assert.equal(missing.capture.spawned, false); assert.equal(missing.capture.bytes, 0); assert.equal(missing.result.failureKind, "unknown_transport");
  const throwing = await run(runnerFenceClient(root, proof, fenceConfig), async () => { throw new Error("bind failed"); }); assert.equal(throwing.capture.bytes, 0); assert.equal(throwing.result.failureKind, "unknown_transport");
  const bindFalse = await run(runnerFenceClient(root, proof, fenceConfig, { bindChild: async () => false }), async () => true); assert.equal(bindFalse.capture.bytes, 0); assert.equal(bindFalse.result.failureKind, "unknown_transport");
  const handshakeFalse = await run(runnerFenceClient(root, proof, fenceConfig, { awaitHandshake: async () => false }), async () => true); assert.equal(handshakeFalse.capture.bytes, 0); assert.equal(handshakeFalse.result.failureKind, "unknown_transport");
  await fs.rm(root, { recursive: true, force: true });
});

test("fence failure drives the parent watchdog to terminate the child", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fence-watchdog-"));
  const capture: { killed?: boolean; spawned?: boolean } = {};
  const attempt = await runPiAttempt({ cwd: "/tmp/fence-project", agent, task: "PRIVATE TASK", model: "test", attempt: 1, source: "initial", sessionDir: root, childSessionId: "fence-child", firstLogicalChildSpawn: true, parentFastRequested: false, sideEffectFence: { socket: path.join(root, "socket"), nonce: "opaque-nonce", protocol: 1, extensions: [], interceptor: "/tmp/interceptor", awaitGraceful: async () => false, failure: Promise.resolve("result_ack_failed") }, spawn: ((_command, _args, _options) => { capture.spawned = true; return fakeProcess(capture); }) as any });
  assert.equal(capture.spawned, undefined); assert.equal(attempt.failureKind, "unknown_transport");
  await fs.rm(root, { recursive: true, force: true });
});

test("v1 runner invocation remains unchanged when no fence is supplied", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fence-v1-"));
  const capture: { args?: string[] } = {};
  await runPiAttempt({ cwd: "/tmp/fence-project", agent, task: "PRIVATE TASK", model: "test", attempt: 1, source: "initial", sessionDir: root, childSessionId: "fence-child", firstLogicalChildSpawn: true, parentFastRequested: false, spawn: ((_command, args, _options) => { capture.args = args; return fakeProcess(capture); }) as any });
  assert.deepEqual(capture.args, [process.argv[1], "--mode", "json", "-p", "--session-dir", root, "--session-id", "fence-child", "--model", "test", "PRIVATE TASK"]);
  await fs.rm(root, { recursive: true, force: true });
});

test("real cross-process Unix socket handshake and prepare-intent-result ACK settle the ledger", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fence-ipc-") );
  const project = path.join(root, "project"); await fs.mkdir(project); await fs.writeFile(path.join(project, "agent.md"), "---\nname: implement\ndescription: test\n---\nworker", { mode: 0o600 });
  const snapshot = getAgentDiscoverySnapshot(project)!;
  const parentSessionId = "parent-ipc"; const lineage: ActiveLineage = { parentSessionId, activeLineageId: "lineage-ipc", activeBranchAnchor: "anchor-ipc", currentLeafId: "anchor-ipc", branchIds: ["root", "anchor-ipc"], persistence: "in_process_only" };
  const admitted = await admitDispatchCallInternal({ parentSessionId, lineage, toolCallId: "tool-ipc", cwd: project, mode: "single", agentScope: "project", projectTrust: { parentSessionId, discoveryRootRealpath: snapshot.rootRealpath, snapshotDigest: snapshot.digest }, single: { agent: "implement", task: "opaque" } }, root);
  const callId = admitted.dispatchCallId!; const delegationId = admitted.delegationIds![0]!; await resolveDelegationInternal(root, callId, delegationId, { lineage });
  const owner: OwnerIdentity = { host: os.hostname(), pid: process.pid, birth: "ipc-owner", parentSessionId, parentSessionPath: path.join(root, "parent.jsonl"), argvProof: createHash("sha256").update("ipc-owner").digest("hex") };
  const reserved = await reserveInitialInternal(root, callId, delegationId, { lineage, owner }); const started = await markSpawnStartedInternal(root, callId, delegationId, "initial", { lineage, owner }); assert.equal(started.state, "initial_running");
  const extension = path.join(root, "allowed.ts"); await fs.writeFile(extension, "export default function () {}\n", { mode: 0o600 });
  const server = await startSideEffectFenceServer({ rootDir: root, dispatchCallId: callId, delegationId, executionScope: "ipc-scope", reservationId: reserved.reservationId!, continuationEpoch: 0, claim: { owner: started.owner!, ownerGeneration: started.ownerGeneration!, fencingGeneration: started.fencingGeneration!, spawnId: started.spawnId! }, config: config([await extensionSpec(extension)]) });
  const script = `import net from 'node:net'; import crypto from 'node:crypto'; const env=process.env; const binding=JSON.parse(Buffer.from(env.PI_SUBAGENT_FENCE_HANDSHAKE,'base64url').toString()); const hash=(v)=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex'); const childSessionId='ipc-child'; const frame=(x)=>JSON.stringify(x)+'\\n'; const c=net.createConnection(env.PI_SUBAGENT_FENCE_SOCKET); let seq=1, buf=''; const send=(x)=>c.write(frame(x)); c.on('data',d=>{buf+=d; const lines=buf.split('\\n'); buf=lines.pop(); for(const line of lines){if(!line)continue; const r=JSON.parse(line); if(r.type==='hello_ack'){send({version:1,type:'prepare',seq:seq++,requestId:'p',toolCallId:'replacement-a',toolName:'custom_tool',input:{value:1},toolCallOrdinal:0,logicalCheckpoint:'checkpoint:0'});} else if(r.type==='response'&&r.requestId==='p'){send({version:1,type:'intent',seq:seq++,requestId:'i',toolCallId:'replacement-a',toolName:'custom_tool',input:{value:1},toolCallOrdinal:0,logicalCheckpoint:'checkpoint:0',preInjectionArgsDigest:r.preInjectionArgsDigest,stableIdempotencyKey:r.stableIdempotencyKey});} else if(r.type==='response'&&r.requestId==='i'){send({version:1,type:'result',seq:seq++,requestId:'r',toolCallId:'replacement-a',resultDigest:hash({ok:true}),resultType:'tool:custom_tool',status:'success'});} else if(r.type==='response'&&r.requestId==='r'){process.exit(r.ok?0:2);}}}); c.on('connect',()=>send({version:1,type:'hello',seq:0,nonce:env.PI_SUBAGENT_FENCE_NONCE,dispatchCallId:binding.dispatchCallId,delegationId:binding.delegationId,executionScope:binding.executionScope,reservationId:binding.reservationId,owner:binding.owner,ownerGeneration:binding.ownerGeneration,fencingGeneration:binding.fencingGeneration,childSessionId,pid:process.pid,childIdentityRef:hash({pid:process.pid,sessionId:childSessionId}),allowlistManifestDigest:binding.allowlistManifestDigest,extensionOrderDigest:binding.extensionOrderDigest,toolSetDigest:binding.toolSetDigest,policyDigest:binding.policyDigest,interceptorRealpath:binding.interceptorRealpath,interceptorDigest:binding.interceptorDigest,interceptorVersion:binding.interceptorVersion,fenceLastProof:binding.fenceLastProof}));`;
  const child = (await import("node:child_process")).spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, ...sideEffectFenceEnvironment(server.client) }, stdio: ["ignore", "pipe", "pipe"] });
  await server.bindChild(child.pid!, "ipc-child"); const code = await new Promise<number | null>((resolve) => child.on("close", resolve)); assert.equal(code, 0); assert.equal(await server.awaitHandshake(), true); await server.close(); assert.equal((await readActionLedgerInternal(root, callId))?.[0]?.status, "result_acked"); await fs.rm(root, { recursive: true, force: true });
});

function realRunnerChildScript(): string {
  return `import net from "node:net"; import crypto from "node:crypto"; import fs from "node:fs";
const env = process.env; const binding = JSON.parse(Buffer.from(env.PI_SUBAGENT_FENCE_HANDSHAKE, "base64url").toString());
const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const mode = env.TEST_FENCE_MODE; const childSessionId = env.TEST_FENCE_CHILD; const marker = env.TEST_FENCE_MARKER;
const frame = (value) => JSON.stringify(value) + "\\n"; const socket = net.createConnection(env.PI_SUBAGENT_FENCE_SOCKET);
let seq = 1; let helloAck = false; let goodbyeAck = false; let stdinEnded = false; let resultActionId;
const send = (value) => socket.write(frame(value));
const goodbye = () => send({ version: 1, type: "goodbye", seq: seq++, requestId: "goodbye", nonce: env.PI_SUBAGENT_FENCE_NONCE, dispatchCallId: binding.dispatchCallId, delegationId: binding.delegationId, executionScope: binding.executionScope, reservationId: binding.reservationId, owner: binding.owner, ownerGeneration: binding.ownerGeneration, fencingGeneration: binding.fencingGeneration, childSessionId, childIdentityRef: hash({ pid: process.pid, sessionId: childSessionId }), pid: process.pid, completedActionIds: resultActionId ? [resultActionId] : [], blockedActionIds: [], inflight: { prepare: 0, intent: 0, result: 0 } });
const finish = () => { if (!helloAck || !goodbyeAck || !stdinEnded) return; fs.appendFileSync(marker, "finished\\n"); const header = { type: "session", version: 3, id: childSessionId, cwd: "/tmp", timestamp: new Date().toISOString() }; const message = { role: "assistant", content: [{ type: "text", text: "done" }], api: "openai-completions", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() }; process.stdout.write(JSON.stringify(header) + "\\n" + JSON.stringify({ type: "message_end", message }) + "\\n"); process.exit(0); };
let buffer = ""; socket.on("data", (chunk) => { buffer += chunk.toString(); const lines = buffer.split("\\n"); buffer = lines.pop() ?? ""; for (const line of lines) { if (!line) continue; const response = JSON.parse(line); if (response.type === "hello_ack") { helloAck = true; fs.appendFileSync(marker, "handshake\\n"); if (mode === "tool") send({ version: 1, type: "prepare", seq: seq++, requestId: "prepare", toolCallId: "runner-tool", toolName: "custom_tool", input: { value: 1 }, toolCallOrdinal: 0, logicalCheckpoint: "checkpoint:0" }); else if (mode === "close") process.exit(0); else if (mode !== "wait") goodbye(); } else if (response.type === "response" && response.requestId === "prepare") send({ version: 1, type: "intent", seq: seq++, requestId: "intent", toolCallId: "runner-tool", toolName: "custom_tool", input: { value: 1 }, toolCallOrdinal: 0, logicalCheckpoint: "checkpoint:0", preInjectionArgsDigest: response.preInjectionArgsDigest, stableIdempotencyKey: response.stableIdempotencyKey }); else if (response.type === "response" && response.requestId === "intent") send({ version: 1, type: "result", seq: seq++, requestId: "result", toolCallId: "runner-tool", resultDigest: hash({ ok: true }), resultType: "tool:custom_tool", status: "success" }); else if (response.type === "response" && response.requestId === "result") { resultActionId = response.actionId; goodbye(); } else if (response.type === "goodbye_ack") { goodbyeAck = true; finish(); } } });
socket.on("connect", () => send({ version: 1, type: "hello", seq: 0, nonce: env.PI_SUBAGENT_FENCE_NONCE, dispatchCallId: binding.dispatchCallId, delegationId: binding.delegationId, executionScope: binding.executionScope, reservationId: binding.reservationId, owner: binding.owner, ownerGeneration: binding.ownerGeneration, fencingGeneration: binding.fencingGeneration, childSessionId, pid: process.pid, childIdentityRef: hash({ pid: process.pid, sessionId: childSessionId }), allowlistManifestDigest: binding.allowlistManifestDigest, extensionOrderDigest: binding.extensionOrderDigest, toolSetDigest: binding.toolSetDigest, policyDigest: binding.policyDigest, interceptorRealpath: binding.interceptorRealpath, interceptorDigest: binding.interceptorDigest, interceptorVersion: binding.interceptorVersion, fenceLastProof: binding.fenceLastProof }));
process.stdin.setEncoding("utf8"); process.stdin.on("data", () => { fs.appendFileSync(marker, helloAck ? "stdin-after-handshake\\n" : "stdin-before-handshake\\n"); }); process.stdin.on("end", () => { stdinEnded = true; finish(); });`;
}

async function runRealRunnerLifecycle(mode: "none" | "tool" | "wait" | "close", fixture: Awaited<ReturnType<typeof liveFence>>, marker: string, timeoutMs = 1000): Promise<Awaited<ReturnType<typeof runPiAttempt>>> {
  const childSessionId = `runner-${mode}-child`;
  (fixture.server.client as any).timeoutMs = timeoutMs;
  const result = await runPiAttempt({
    cwd: "/tmp", agent, task: "PRIVATE TASK", model: "test", attempt: 1, source: "initial", sessionDir: fixture.root,
    childSessionId, firstLogicalChildSpawn: true, parentFastRequested: false,
    sideEffectFence: { ...fixture.server.client, timeoutMs },
    onChildProcess: (child) => fixture.server.bindChild(child.pid, child.identity),
    spawn: (_command, _args, spawnOptions) => {

      const spawned = childSpawn(process.execPath, ["--input-type=module", "-e", realRunnerChildScript()], { ...spawnOptions, env: { ...spawnOptions.env, TEST_FENCE_MODE: mode, TEST_FENCE_CHILD: childSessionId, TEST_FENCE_MARKER: marker } }); return spawned as any;
    },
  });
  return result;
}

test("real runner and fence server settle no-tool/tool goodbye before process close without watchdog", async () => {
  for (const mode of ["none", "tool"] as const) {
    for (let round = 0; round < 2; round += 1) {
      const fixture = await liveFence(`frn-${mode[0]}-${round}-`); const marker = path.join(fixture.root, "runner-marker");
      try {
        const result = await runRealRunnerLifecycle(mode, fixture, marker);
        assert.equal(result.failureKind, "success", `${mode} round ${round}: ${result.errorMessage}`);
        assert.equal(await fixture.server.awaitGraceful(), true);
        const failure = await Promise.race([fixture.server.client.failure!.then(() => "signalled"), new Promise<string>((resolve) => setTimeout(() => resolve("quiet"), 50))]);
        assert.equal(failure, "quiet");
        assert.deepEqual((await fs.readFile(marker, "utf8")).split("\n").filter(Boolean), ["handshake", "stdin-after-handshake", "finished"]);
      } finally { await fixture.server.close(`real-${mode}-done`); await removeFixture(fixture.root); }
    }
  }
});

test("real runner watchdog handles a live socket timeout and direct close as unknown transport", async () => {
  const timeoutFixture = await liveFence("frt-"); const timeoutMarker = path.join(timeoutFixture.root, "runner-marker");
  try {
    const pending = runRealRunnerLifecycle("wait", timeoutFixture, timeoutMarker, 1000);
    assert.equal(await timeoutFixture.server.awaitHandshake(1500), true);
    assert.equal(await timeoutFixture.server.awaitGraceful(30), false);
    const timeoutResult = await pending;
    assert.equal(timeoutResult.failureKind, "unknown_transport");
    assert.match(String(await Promise.race([timeoutFixture.server.client.failure!, new Promise<string>((resolve) => setTimeout(() => resolve("missing"), 100))])), /graceful|timeout/);
  } finally { await timeoutFixture.server.close("real-timeout-done"); await removeFixture(timeoutFixture.root); }

  const closeFixture = await liveFence("frc-"); const closeMarker = path.join(closeFixture.root, "runner-marker");
  try {
    const closeResult = await runRealRunnerLifecycle("close", closeFixture, closeMarker);
    assert.equal(closeResult.failureKind, "unknown_transport");
    assert.equal(await closeFixture.server.awaitGraceful(30), false);
    assert.match(String(await Promise.race([closeFixture.server.client.failure!, new Promise<string>((resolve) => setTimeout(() => resolve("missing"), 100))])), /disconnect|closed/);
  } finally { await closeFixture.server.close("real-close-done"); await removeFixture(closeFixture.root); }
});

test("no-tool shutdown completes the versioned graceful goodbye", async () => {
  const fixture = await liveFence("fence-no-tool-"); const child = await openFence(fixture.server, "no-tool-child");
  const ack = await child.send(goodbyeFrame(fixture.server, "no-tool-child")); assert.equal(ack.type, "goodbye_ack"); assert.equal(await fixture.server.awaitGraceful(), true); child.socket.destroy(); await fixture.server.close("test-graceful"); await fs.rm(fixture.root, { recursive: true, force: true });
});

test("a single tool with a durable result ACK closes gracefully", async () => {
  const fixture = await liveFence("fs-"); const child = await openFence(fixture.server, "single-tool-child");
  const prepared = await child.send({ version: 1, type: "prepare", seq: 1, requestId: "prepare", toolCallId: "single-call", toolName: "custom_tool", input: { value: 1 }, toolCallOrdinal: 0, logicalCheckpoint: "checkpoint:0" });
  const intent = await child.send({ version: 1, type: "intent", seq: 2, requestId: "intent", toolCallId: "single-call", toolName: "custom_tool", input: { value: 1 }, toolCallOrdinal: 0, logicalCheckpoint: "checkpoint:0", preInjectionArgsDigest: prepared.preInjectionArgsDigest, stableIdempotencyKey: prepared.stableIdempotencyKey });
  const result = await child.send({ version: 1, type: "result", seq: 3, requestId: "result", toolCallId: "single-call", resultDigest: wireHash({ ok: true }), resultType: "tool:custom_tool", status: "success" }); assert.equal(result.handler, 1);
  const goodbye = await child.send(goodbyeFrame(fixture.server, "single-tool-child", { seq: 4, completedActionIds: [String(result.actionId ?? intent.actionId)] })); assert.equal(goodbye.type, "goodbye_ack"); assert.equal(await fixture.server.awaitGraceful(), true); child.socket.destroy(); await fixture.server.close("test-graceful-result"); assert.equal((await readActionLedgerInternal(fixture.root, fixture.callId))?.[0]?.status, "result_acked"); await fs.rm(fixture.root, { recursive: true, force: true });
});

test("an unacknowledged intent cannot disconnect as graceful", async () => {
  const fixture = await liveFence("fo-"); const child = await openFence(fixture.server, "outstanding-child");
  const prepared = await child.send({ version: 1, type: "prepare", seq: 1, requestId: "prepare", toolCallId: "outstanding-call", toolName: "custom_tool", input: { value: 1 }, toolCallOrdinal: 0, logicalCheckpoint: "checkpoint:0" }); assert.equal(prepared.handler, 1);
  child.socket.destroy(); const failure = await Promise.race([fixture.server.client.failure!, new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 500))]); assert.match(failure, /disconnect/); assert.equal(await fixture.server.awaitGraceful(50), false); await fixture.server.close("test-disconnect"); await fs.rm(fixture.root, { recursive: true, force: true });
});

test("a forged goodbye identity is rejected and signals failure", async () => {
  const fixture = await liveFence("fg-"); const child = await openFence(fixture.server, "forged-child");
  child.socket.write(`${JSON.stringify(goodbyeFrame(fixture.server, "forged-child", { nonce: "forged-nonce" }))}\n`); const failure = await Promise.race([fixture.server.client.failure!, new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 500))]); assert.match(failure, /goodbye/); assert.equal(await fixture.server.awaitGraceful(50), false); await fixture.server.close("test-forged-goodbye"); await new Promise((resolve) => setTimeout(resolve, 100)); await fs.rm(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

test("orphan cleanup refuses a symlink directory and removes only owner directories", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fence-orphan-"));
  const fences = path.join(root, "v2", "fences"); await fs.mkdir(fences, { recursive: true, mode: 0o700 });
  const orphan = path.join(fences, "channel-old"); await fs.mkdir(orphan, { mode: 0o700 }); await fs.writeFile(path.join(orphan, "lifecycle.json"), JSON.stringify({ version: 1, dispatchCallId: "a".repeat(64), delegationId: "b".repeat(64), ownerGeneration: 1, fencingGeneration: 1, state: "terminal", expiresAt: new Date(Date.now() - 1).toISOString() }), { mode: 0o600 }); await fs.chmod(path.join(orphan, "lifecycle.json"), 0o600);
  const target = path.join(root, "target"); await fs.mkdir(target, { mode: 0o700 }); await fs.symlink(target, path.join(fences, "channel-link"));
  const noProof = await cleanupSideEffectFenceOrphans(root); assert.equal(noProof.cleaned, 0);
  const result = await cleanupSideEffectFenceOrphans(root, { activeSet: new Set(), proof: async () => true });
  assert.equal(result.cleaned, 1); assert.equal(result.pausedIntegrity, 1);
  await fs.rm(root, { recursive: true, force: true });
});
