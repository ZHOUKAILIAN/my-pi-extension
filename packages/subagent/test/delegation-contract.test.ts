import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDiscoverySnapshot } from "../src/agents.ts";
import {
  admitDispatchCallInternal,
  bindChildSessionInternal as bindChildSessionInternalBase,
  claimExecutionOwnerInternal as claimExecutionOwnerInternalBase,
  delegationFoundationCapability,
  executeDelegationInternal as executeDelegationInternalBase,
  markSpawnStartedInternal as markSpawnStartedInternalBase,
  markDelegationReturnedInternal as markDelegationReturnedInternalBase,
  normalizeExecutionStartupInternal,
  readDelegationInternal,
  readDispatchCallInternal,
  resolveDelegationInternal,
  reserveInitialInternal as reserveInitialInternalBase,
  reserveRecoveryCycleInternal as reserveRecoveryCycleInternalBase,
  acceptContinuationInternal as acceptContinuationInternalBase,
  reconcileRunningChildInternal as reconcileRunningChildInternalBase,
  classifyOwnerIdentityObservation,
  probeOwnerDeathStable,
} from "../src/delegation-internal.ts";
import type { ChildIdentity, DispatchCallAdmissionRequest, OwnerClaim, OwnerIdentity, ProjectTrustBinding } from "../src/delegation.ts";
import type { ActiveLineage } from "../src/lineage.ts";

const parentSessionId = "contract-parent";
const lineage: ActiveLineage = { parentSessionId, activeLineageId: "contract-lineage", activeBranchAnchor: "contract-leaf", currentLeafId: "contract-leaf", branchIds: ["root", "contract-leaf"], persistence: "in_process_only" };
const definition = "---\nname: implement\ndescription: implement\n---\nInstructions";

async function projectAgents(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o755 });
  await fs.writeFile(path.join(directory, "agent.md"), definition, { mode: 0o644 });
}
async function setup(toolCallId: string, persistent = true, requestLineage: ActiveLineage = lineage) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-contract-"));
  const project = path.join(rootDir, "agents"); await projectAgents(project);
  const snapshot = getAgentDiscoverySnapshot(project)!;
  const projectTrust: ProjectTrustBinding = { parentSessionId, discoveryRootRealpath: snapshot.rootRealpath, snapshotDigest: snapshot.digest };
  const request: DispatchCallAdmissionRequest = { parentSessionId, lineage: requestLineage, toolCallId, cwd: project, mode: "single", single: { agent: "implement", task: "private contract task", persistent }, agentScope: "project", projectTrust };
  const admitted = await admitDispatchCallInternal(request, rootDir);
  const delegationId = admitted.delegationIds![0];
  assert.equal((await resolveDelegationInternal(rootDir, admitted.dispatchCallId!, delegationId)).state, "resolved");
  return { rootDir, project, callId: admitted.dispatchCallId!, delegationId };
}
function owner(name: string, pid: number): OwnerIdentity { return { host: os.hostname(), pid, birth: name, parentSessionId, parentSessionPath: "/tmp/contract-parent", argvProof: name.padEnd(64, "0").slice(0, 64) }; }
function child(name: string, pid: number): ChildIdentity { return { host: os.hostname(), pid, birth: name, sessionPathHash: name.padEnd(32, "0").slice(0, 32), argvProof: name.padEnd(64, "0").slice(0, 64) }; }
function siblingLineage(): ActiveLineage { return { ...lineage, activeLineageId: "sibling-lineage", activeBranchAnchor: "sibling-leaf", currentLeafId: "sibling-leaf", branchIds: ["root", "sibling-leaf"] }; }
function claimFrom(started: { owner?: OwnerIdentity; ownerGeneration?: number; fencingGeneration?: number; spawnId?: string }): OwnerClaim { return { owner: started.owner!, ownerGeneration: started.ownerGeneration!, fencingGeneration: started.fencingGeneration!, spawnId: started.spawnId! }; }
const executionDeps = (deps: any = {}) => ({ ...deps, lineage: deps.lineage ?? lineage });
const reserveInitialInternal = (rootDir: string, callId: string, delegationId: string, deps: any = {}) => reserveInitialInternalBase(rootDir, callId, delegationId, executionDeps(deps));
const reserveRecoveryCycleInternal = (rootDir: string, callId: string, delegationId: string, deps: any = {}) => reserveRecoveryCycleInternalBase(rootDir, callId, delegationId, executionDeps(deps));
const claimExecutionOwnerInternal = (rootDir: string, callId: string, delegationId: string, owner: OwnerIdentity, deps: any = {}) => claimExecutionOwnerInternalBase(rootDir, callId, delegationId, owner, executionDeps(deps));
const markSpawnStartedInternal = (rootDir: string, callId: string, delegationId: string, kind: "initial" | "recovery", deps: any = {}) => markSpawnStartedInternalBase(rootDir, callId, delegationId, kind, executionDeps(deps));
const bindChildSessionInternal = (rootDir: string, callId: string, delegationId: string, claim: OwnerClaim, childSessionId: string, sessionPath?: string, pid?: number, deps: any = {}, attempt?: number) => bindChildSessionInternalBase(rootDir, callId, delegationId, claim, childSessionId, sessionPath, pid, executionDeps(deps), attempt);
const markDelegationReturnedInternal = (rootDir: string, callId: string, delegationId: string, outcome: "success" | "failure" | "cancelled", resultRef: string, claim: OwnerClaim, deps: any = {}) => markDelegationReturnedInternalBase(rootDir, callId, delegationId, outcome, resultRef, claim, executionDeps(deps));
const executeDelegationInternal = (rootDir: string, callId: string, delegationId: string, agent: any, deps: any = {}) => executeDelegationInternalBase(rootDir, callId, delegationId, agent, executionDeps(deps));
const reconcileRunningChildInternal = (rootDir: string, callId: string, delegationId: string, inspect: any, deps: any = {}) => reconcileRunningChildInternalBase(rootDir, callId, delegationId, inspect, executionDeps(deps));
const acceptContinuationInternal = (rootDir: string, callId: string, delegationId: string, reason: string, deps: any = {}) => acceptContinuationInternalBase(rootDir, callId, delegationId, reason, executionDeps(deps));
async function wal(rootDir: string, callId: string): Promise<any[]> { return (await fs.readFile(path.join(rootDir, "v2", "wal", `${callId}.jsonl`), "utf8")).trim().split("\n").map((line) => JSON.parse(line)); }
async function walBytes(rootDir: string, callId: string): Promise<Buffer> { return fs.readFile(path.join(rootDir, "v2", "wal", `${callId}.jsonl`)); }
async function appendWalForTest(rootDir: string, callId: string, type: string, data: Record<string, unknown>, delegationId: string): Promise<void> { const file = path.join(rootDir, "v2", "wal", `${callId}.jsonl`); const events = await wal(rootDir, callId); const previous = events.at(-1)!; const body = { version: 1, seq: previous.seq + 1, type, callId, delegationId, data, prevChecksum: previous.checksum }; const event = { ...body, checksum: createHash("sha256").update(JSON.stringify(body)).digest("hex") }; await fs.appendFile(file, `${JSON.stringify(event)}\n`); }

test("stateful execution actions require a current lineage and durable parent proof", async (t) => {
  const state = await setup("lineage-required"); t.after(() => fs.rm(state.rootDir, { recursive: true, force: true }));
  const ownerA = owner("a90", process.pid + 90);
  const before = await wal(state.rootDir, state.callId);
  assert.equal((await reserveInitialInternalBase(state.rootDir, state.callId, state.delegationId)).state, "rejected");
  assert.deepEqual(await wal(state.rootDir, state.callId), before);
  assert.equal((await claimExecutionOwnerInternalBase(state.rootDir, state.callId, state.delegationId, ownerA, { lineage: siblingLineage(), owner: ownerA })).state, "rejected");
  assert.deepEqual(await wal(state.rootDir, state.callId), before);

  const reserved = await reserveInitialInternalBase(state.rootDir, state.callId, state.delegationId, { lineage, owner: ownerA }); assert.equal(reserved.state, "reserved", JSON.stringify(reserved));
  const afterReserve = await wal(state.rootDir, state.callId);
  const missingLineageSpawn = await markSpawnStartedInternalBase(state.rootDir, state.callId, state.delegationId, "initial");
  assert.equal(missingLineageSpawn.state, "rejected"); assert.deepEqual(await wal(state.rootDir, state.callId), afterReserve);

  const durableParent = path.join(state.rootDir, "missing-parent-session.jsonl");
  const durable = await setup("durable-parent-proof", true, { ...lineage, persistence: "restart-durable", parentSessionFile: durableParent }); t.after(() => fs.rm(durable.rootDir, { recursive: true, force: true }));
  const durableBefore = await wal(durable.rootDir, durable.callId);
  assert.equal((await reserveInitialInternalBase(durable.rootDir, durable.callId, durable.delegationId, { lineage: { ...lineage, persistence: "restart-durable", parentSessionFile: durableParent }, owner: ownerA })).state, "rejected");
  assert.deepEqual(await wal(durable.rootDir, durable.callId), durableBefore);
});

test("pre-spawn abort rejects missing, sibling, and stale-owner proofs without WAL or attempts", async (t) => {
  const state = await setup("abort-proof-negative"); t.after(() => fs.rm(state.rootDir, { recursive: true, force: true }));
  const agent = { name: "implement", description: "implement", source: "project" as const, filePath: path.join(state.project, "agent.md"), systemPrompt: "Instructions" };
  const controller = new AbortController(); controller.abort(); let attempts = 0;
  const runAttempt = async () => { attempts += 1; throw new Error("must not run"); };
  const before = await wal(state.rootDir, state.callId);
  const missing = await executeDelegationInternalBase(state.rootDir, state.callId, state.delegationId, agent, { signal: controller.signal, runAttempt });
  assert.equal(missing.state, "rejected"); assert.equal(attempts, 0); assert.deepEqual(await wal(state.rootDir, state.callId), before);
  const sibling = await executeDelegationInternalBase(state.rootDir, state.callId, state.delegationId, agent, { signal: controller.signal, runAttempt, lineage: siblingLineage() });
  assert.equal(sibling.state, "rejected"); assert.equal(attempts, 0); assert.deepEqual(await wal(state.rootDir, state.callId), before);

  const ownerA = owner("a91", process.pid + 91); const ownerB = owner("b92", process.pid + 92);
  const reserved = await reserveInitialInternalBase(state.rootDir, state.callId, state.delegationId, { lineage, owner: ownerA });
  assert.equal(reserved.state, "reserved", JSON.stringify(reserved));
  const ownerBefore = await wal(state.rootDir, state.callId);
  const stale = await executeDelegationInternalBase(state.rootDir, state.callId, state.delegationId, agent, { signal: controller.signal, runAttempt, lineage, owner: ownerB });
  assert.equal(stale.state, "rejected"); assert.equal(attempts, 0); assert.deepEqual(await wal(state.rootDir, state.callId), ownerBefore);
});

test("pre-spawn transfer is limited to resolution pause and repaired resolution replays ready", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-resolution-transfer-")); t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const project = path.join(rootDir, "agents"); await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, "target.md"), definition, { mode: 0o644 }); await fs.writeFile(path.join(project, "conflict.md"), "---\nname: other\ndescription: other\naliases: [implement]\n---\nInstructions", { mode: 0o644 });
  const snapshot = getAgentDiscoverySnapshot(project)!; const projectTrust: ProjectTrustBinding = { parentSessionId, discoveryRootRealpath: snapshot.rootRealpath, snapshotDigest: snapshot.digest };
  const request: DispatchCallAdmissionRequest = { parentSessionId, lineage, toolCallId: "resolution-transfer", cwd: project, mode: "single", single: { agent: "implement", task: "private", persistent: true }, agentScope: "project", projectTrust };
  const admitted = await admitDispatchCallInternal(request, rootDir); const id = admitted.delegationIds![0]; assert.equal((await resolveDelegationInternal(rootDir, admitted.dispatchCallId!, id)).state, "paused_configuration");
  const ownerA = owner("a1", process.pid + 61); const ownerB = owner("b2", process.pid + 62);
  const firstClaim = await claimExecutionOwnerInternal(rootDir, admitted.dispatchCallId!, id, ownerA, { owner: ownerA }); assert.equal(firstClaim.state, "claimed", JSON.stringify(firstClaim));
  let ownerIdentityObservations = 0; let reusedPidSignals = 0;
  const transferred = await claimExecutionOwnerInternal(rootDir, admitted.dispatchCallId!, id, ownerB, { owner: ownerB, inspectOwnerIdentity: async () => { ownerIdentityObservations += 1; return { state: "present", pid: ownerA.pid, birth: "reused-owner-birth" }; }, ownerIdentityProbeSafety: { signal: () => { reusedPidSignals += 1; } }, ownerDeathObservationDelayMs: 0 });
  assert.equal(transferred.state, "transferred"); assert.equal(ownerIdentityObservations, 2); assert.equal(reusedPidSignals, 0);
  const transferEvents = await wal(rootDir, admitted.dispatchCallId!);
  const proofIndex = transferEvents.findIndex((event) => event.type === "pre_spawn_child_absence_proved");
  const transferIndex = transferEvents.findIndex((event) => event.type === "owner_transferred");
  assert.ok(proofIndex >= 0 && proofIndex < transferIndex);
  assert.deepEqual(transferEvents[proofIndex].data, { state: "paused_configuration", pauseReason: "resolution", ownerGeneration: 1, fencingGeneration: 0, childRefObservation1: "absent", childRefObservation2: "absent" });
  assert.equal(transferEvents[transferIndex].data.childDeathObservation1, undefined);
  assert.equal(transferEvents[transferIndex].data.childDeathObservation2, undefined);
  assert.equal((await readDelegationInternal(rootDir, admitted.dispatchCallId!, id))?.state, "paused_configuration");
  await fs.rm(path.join(project, "conflict.md"));
  assert.equal((await claimExecutionOwnerInternal(rootDir, admitted.dispatchCallId!, id, ownerB, { owner: ownerB })).state, "already_owned");
  assert.equal((await readDelegationInternal(rootDir, admitted.dispatchCallId!, id))?.state, "resolution_ready");
});

test("replay rejects a pre-spawn owner transfer without the absence proof", async (t) => {
  const state = await setup("missing-pre-spawn-proof"); t.after(() => fs.rm(state.rootDir, { recursive: true, force: true }));
  const ownerA = owner("a81", process.pid + 81); const ownerB = owner("b82", process.pid + 82);
  assert.equal((await claimExecutionOwnerInternal(state.rootDir, state.callId, state.delegationId, ownerA, { owner: ownerA })).state, "claimed");
  await appendWalForTest(state.rootDir, state.callId, "delegation_resolving", {}, state.delegationId);
  await appendWalForTest(state.rootDir, state.callId, "delegation_resolution_paused", { reason: "resolution", reasonCode: "ambiguous", rawCandidates: 2, shadowedCandidates: 0, auditRef: "private:audit-missing-proof" }, state.delegationId);
  await appendWalForTest(state.rootDir, state.callId, "owner_transferred", { ownerGeneration: 2, previousOwnerGeneration: 1, fencingGeneration: 1, owner: ownerB, deathObservation1: "dead", deathObservation2: "dead" }, state.delegationId);
  assert.equal((await readDispatchCallInternal(state.rootDir, state.callId))?.state, "paused_integrity");
});

test("bound configuration pause cannot be transferred before spawn", async (t) => {
  const state = await setup("bound-config-transfer"); t.after(() => fs.rm(state.rootDir, { recursive: true, force: true })); const ownerA = owner("a3", process.pid + 63); const ownerB = owner("b4", process.pid + 64);
  const firstClaim = await claimExecutionOwnerInternal(state.rootDir, state.callId, state.delegationId, ownerA, { owner: ownerA }); assert.equal(firstClaim.state, "claimed", JSON.stringify(firstClaim));
  await fs.appendFile(path.join(state.project, "agent.md"), "changed\n");
  assert.equal((await reserveInitialInternal(state.rootDir, state.callId, state.delegationId, { owner: ownerA })).state, "paused_configuration");
  const before = await wal(state.rootDir, state.callId); const transfer = await claimExecutionOwnerInternal(state.rootDir, state.callId, state.delegationId, ownerB, { owner: ownerB, inspectOwner: async () => "dead", ownerDeathObservationDelayMs: 0 });
  assert.equal(transfer.state, "rejected"); assert.equal((await wal(state.rootDir, state.callId)).filter((event) => event.type === "owner_transferred").length, 0); assert.equal((await wal(state.rootDir, state.callId)).length, before.length);
});

test("unknown startup child is observed without owner transfer or spawn and is idempotent", async (t) => {
  const state = await setup("unknown-bound-child"); t.after(() => fs.rm(state.rootDir, { recursive: true, force: true })); const ownerA = owner("a5", process.pid + 65); const staleOwner = owner("b6", process.pid + 66); const childA = child("c7", process.pid + 67);
  const reserved = await reserveInitialInternal(state.rootDir, state.callId, state.delegationId, { owner: ownerA }); assert.equal(reserved.state, "reserved", JSON.stringify(reserved)); const started = await markSpawnStartedInternal(state.rootDir, state.callId, state.delegationId, "initial", { owner: ownerA }); assert.equal(started.state, "initial_running"); assert.equal((await bindChildSessionInternal(state.rootDir, state.callId, state.delegationId, claimFrom(started), "c7", undefined, childA.pid, { childIdentity: childA })).state, "bound");
  let ownerInspections = 0; const inspectOwner = async () => { ownerInspections += 1; throw new Error("stale owner must not block observer"); }; const first = await reconcileRunningChildInternal(state.rootDir, state.callId, state.delegationId, async () => "unknown", { owner: staleOwner, inspectOwner }); assert.equal(first.state, "paused_integrity"); assert.equal(ownerInspections, 0);
  const afterFirst = await wal(state.rootDir, state.callId); assert.equal(afterFirst.filter((event) => event.type === "delegation_integrity_paused").length, 1); assert.equal(afterFirst.filter((event) => event.type === "owner_transferred").length, 0); assert.equal(afterFirst.filter((event) => event.type === "spawn_started").length, 1);
  const second = await reconcileRunningChildInternal(state.rootDir, state.callId, state.delegationId, async () => "unknown", { owner: staleOwner, inspectOwner }); assert.equal(second.state, "paused_integrity"); assert.deepEqual(await wal(state.rootDir, state.callId), afterFirst);
});

test("missing child identity pauses durably without invoking an owner inspector", async (t) => {
  const state = await setup("child-identity-missing"); t.after(() => fs.rm(state.rootDir, { recursive: true, force: true }));
  const ownerA = owner("a76", process.pid + 76); let ownerInspections = 0;
  assert.equal((await reserveInitialInternal(state.rootDir, state.callId, state.delegationId, { owner: ownerA })).state, "reserved");
  const started = await markSpawnStartedInternal(state.rootDir, state.callId, state.delegationId, "initial", { owner: ownerA }); assert.equal(started.state, "initial_running");
  assert.equal((await bindChildSessionInternal(state.rootDir, state.callId, state.delegationId, claimFrom(started), "identity-missing")).state, "bound");
  const result = await reconcileRunningChildInternal(state.rootDir, state.callId, state.delegationId, async () => "live", { owner: ownerA, inspectOwner: async () => { ownerInspections += 1; return "dead"; } });
  assert.equal(result.state, "paused_integrity"); assert.equal(ownerInspections, 0); const events = await wal(state.rootDir, state.callId);
  assert.equal(events.at(-1)?.type, "delegation_integrity_paused"); assert.equal(events.at(-1)?.data.reasonCode, "child_identity_unproven");
});

test("child identity/liveness inspection exceptions fail closed before owner claim", async (t) => {
  const state = await setup("child-inspection-throws"); t.after(() => fs.rm(state.rootDir, { recursive: true, force: true }));
  const ownerA = owner("a70", process.pid + 70); const staleOwner = owner("b71", process.pid + 71); const childA = child("c72", process.pid + 72);
  assert.equal((await reserveInitialInternal(state.rootDir, state.callId, state.delegationId, { owner: ownerA })).state, "reserved");
  const started = await markSpawnStartedInternal(state.rootDir, state.callId, state.delegationId, "initial", { owner: ownerA }); assert.equal(started.state, "initial_running");
  assert.equal((await bindChildSessionInternal(state.rootDir, state.callId, state.delegationId, claimFrom(started), "throw-child", undefined, childA.pid, { childIdentity: childA })).state, "bound");
  const first = await reconcileRunningChildInternal(state.rootDir, state.callId, state.delegationId, async () => { throw new Error("unreadable child"); }, { owner: staleOwner, inspectOwner: async () => { throw new Error("stale owner must not be inspected"); } });
  assert.equal(first.state, "paused_integrity"); const afterFirst = await wal(state.rootDir, state.callId);
  assert.equal(afterFirst.at(-1)?.type, "delegation_integrity_paused"); assert.equal(afterFirst.at(-1)?.data.reasonCode, "child_liveness_unproven"); assert.equal(afterFirst.filter((event) => event.type === "owner_transferred").length, 0);
  const second = await reconcileRunningChildInternal(state.rootDir, state.callId, state.delegationId, async () => { throw new Error("still unreadable"); }, { owner: staleOwner });
  assert.equal(second.state, "paused_integrity"); assert.deepEqual(await wal(state.rootDir, state.callId), afterFirst);
});

test("a dead child second observation exception pauses before any transfer claim", async (t) => {
  const state = await setup("child-dead-second-throws"); t.after(() => fs.rm(state.rootDir, { recursive: true, force: true }));
  const ownerA = owner("a73", process.pid + 73); const ownerB = owner("b74", process.pid + 74); const childA = child("c75", process.pid + 75);
  assert.equal((await reserveInitialInternal(state.rootDir, state.callId, state.delegationId, { owner: ownerA })).state, "reserved");
  const started = await markSpawnStartedInternal(state.rootDir, state.callId, state.delegationId, "initial", { owner: ownerA }); assert.equal(started.state, "initial_running");
  assert.equal((await bindChildSessionInternal(state.rootDir, state.callId, state.delegationId, claimFrom(started), "dead-child", undefined, childA.pid, { childIdentity: childA })).state, "bound");
  let observations = 0;
  const result = await reconcileRunningChildInternal(state.rootDir, state.callId, state.delegationId, async () => { observations += 1; if (observations === 1) return "dead"; throw new Error("death observation unreadable"); }, { owner: ownerB, inspectOwner: async () => "dead" });
  assert.equal(result.state, "paused_integrity"); assert.equal(observations, 2); const events = await wal(state.rootDir, state.callId);
  assert.equal(events.at(-1)?.type, "delegation_integrity_paused"); assert.equal(events.at(-1)?.data.reasonCode, "child_death_unstable"); assert.equal(events.some((event) => event.type === "owner_transferred"), false);
});

test("identity tuple probe treats stable same-PID birth mismatch as death without signaling the reused PID", async () => {
  const recorded = owner("recorded-birth", 424242); let observations = 0; let signals = 0;
  const reused = await probeOwnerDeathStable(recorded, async () => { observations += 1; return { state: "present", pid: recorded.pid, birth: "reused-birth" }; }, 0, { signal: () => { signals += 1; } });
  assert.equal(classifyOwnerIdentityObservation(recorded, { state: "present", pid: recorded.pid, birth: "reused-birth" }), "dead"); assert.equal(reused, "dead"); assert.equal(observations, 2);
  // The injected audit callback is observable and must remain untouched: a
  // birth mismatch never authorizes signaling the reused PID.
  assert.equal(signals, 0);
  let unstableObservations = 0;
  const unstable = await probeOwnerDeathStable(recorded, async () => { unstableObservations += 1; return unstableObservations === 1 ? { state: "present", pid: recorded.pid, birth: "reused-birth" } : { state: "present", pid: recorded.pid, birth: recorded.birth }; }, 0);
  assert.equal(unstable, "unknown"); assert.equal(unstableObservations, 2);
});

test("execution capability stays disabled and binding rejects a missing OwnerClaim without WAL", async (t) => {
  assert.deepEqual(delegationFoundationCapability(), { enabled: false, executionWired: false, recoveryWired: false });
  const state = await setup("missing-owner-claim"); t.after(() => fs.rm(state.rootDir, { recursive: true, force: true }));
  assert.equal((await reserveInitialInternal(state.rootDir, state.callId, state.delegationId)).state, "reserved"); const started = await markSpawnStartedInternal(state.rootDir, state.callId, state.delegationId, "initial"); assert.equal(started.state, "initial_running");
  const before = await wal(state.rootDir, state.callId);
  const result = await (bindChildSessionInternal as any)(state.rootDir, state.callId, state.delegationId, undefined, "child-without-claim");
  assert.equal(result.state, "rejected"); assert.deepEqual(await wal(state.rootDir, state.callId), before);
});

test("a stale owner claim is rejected after transfer and appends zero WAL", async (t) => {
  const state = await setup("stale-owner-claim"); t.after(() => fs.rm(state.rootDir, { recursive: true, force: true }));
  const ownerA = owner("a", process.pid + 11); const ownerB = owner("b", process.pid + 12); const childA = child("c", process.pid + 13);
  const reserved = await reserveInitialInternal(state.rootDir, state.callId, state.delegationId, { owner: ownerA }); assert.equal(reserved.state, "reserved");
  const started = await markSpawnStartedInternal(state.rootDir, state.callId, state.delegationId, "initial", { owner: ownerA }); assert.equal(started.state, "initial_running");
  const claimA = { owner: ownerA, ownerGeneration: started.ownerGeneration!, fencingGeneration: started.fencingGeneration!, spawnId: started.spawnId! };
  assert.equal((await bindChildSessionInternal(state.rootDir, state.callId, state.delegationId, claimA, "child-a", undefined, childA.pid, { childIdentity: childA })).state, "bound");
  assert.equal((await claimExecutionOwnerInternal(state.rootDir, state.callId, state.delegationId, ownerB, { owner: ownerB, inspectOwner: async () => "dead", inspectChild: async () => "dead" })).state, "transferred");
  const before = await wal(state.rootDir, state.callId);
  const stale = await bindChildSessionInternal(state.rootDir, state.callId, state.delegationId, claimA, "child-b", undefined, childA.pid + 1, { childIdentity: child("d", childA.pid + 1), owner: ownerA }, 2);
  assert.equal(stale.state, "rejected"); assert.deepEqual(await wal(state.rootDir, state.callId), before);
});

test("stale owner callbacks do not repair a torn tail or append WAL", async (t) => {
  const state = await setup("stale-owner-claim-torn-tail"); t.after(() => fs.rm(state.rootDir, { recursive: true, force: true }));
  const ownerA = owner("a", process.pid + 41); const ownerB = owner("b", process.pid + 42); const childA = child("c", process.pid + 43);
  assert.equal((await reserveInitialInternal(state.rootDir, state.callId, state.delegationId, { owner: ownerA })).state, "reserved");
  const started = await markSpawnStartedInternal(state.rootDir, state.callId, state.delegationId, "initial", { owner: ownerA }); assert.equal(started.state, "initial_running");
  const claimA = claimFrom(started);
  assert.equal((await bindChildSessionInternal(state.rootDir, state.callId, state.delegationId, claimA, "torn-child", undefined, childA.pid, { childIdentity: childA })).state, "bound");
  assert.equal((await claimExecutionOwnerInternal(state.rootDir, state.callId, state.delegationId, ownerB, { owner: ownerB, inspectOwner: async () => "dead", inspectChild: async () => "dead" })).state, "transferred");
  const file = path.join(state.rootDir, "v2", "wal", `${state.callId}.jsonl`); await fs.appendFile(file, "{\"torn\":", "utf8"); const before = await walBytes(state.rootDir, state.callId);
  assert.equal((await bindChildSessionInternal(state.rootDir, state.callId, state.delegationId, claimA, "stale-child", undefined, childA.pid + 1, { owner: ownerA }, 2)).state, "rejected");
  assert.equal((await markDelegationReturnedInternal(state.rootDir, state.callId, state.delegationId, "success", "stale", claimA, { owner: ownerA })).state, "rejected");
  assert.deepEqual(await walBytes(state.rootDir, state.callId), before);
});

test("transfer and reattach advance the fencing generation and fence stale callbacks", async (t) => {
  const transfer = await setup("transfer-fence"); t.after(() => fs.rm(transfer.rootDir, { recursive: true, force: true }));
  const ownerA = owner("a", process.pid + 21); const ownerB = owner("b", process.pid + 22); const childA = child("c", process.pid + 23);
  const reserved = await reserveInitialInternal(transfer.rootDir, transfer.callId, transfer.delegationId, { owner: ownerA }); assert.equal(reserved.state, "reserved");
  const started = await markSpawnStartedInternal(transfer.rootDir, transfer.callId, transfer.delegationId, "initial", { owner: ownerA }); assert.equal(started.state, "initial_running");
  const claimA = { owner: ownerA, ownerGeneration: started.ownerGeneration!, fencingGeneration: started.fencingGeneration!, spawnId: started.spawnId! };
  assert.equal((await bindChildSessionInternal(transfer.rootDir, transfer.callId, transfer.delegationId, claimA, "transfer-child", undefined, childA.pid, { childIdentity: childA })).state, "bound");
  assert.equal((await claimExecutionOwnerInternal(transfer.rootDir, transfer.callId, transfer.delegationId, ownerB, { owner: ownerB, inspectOwner: async () => "dead", inspectChild: async () => "dead" })).state, "transferred");
  let events = await wal(transfer.rootDir, transfer.callId); const transferred = events.find((event) => event.type === "owner_transferred"); assert.equal(transferred?.data.fencingGeneration, 1); assert.equal((await wal(transfer.rootDir, transfer.callId)).filter((event) => event.type === "owner_transferred").length, 1);
  const beforeStale = await wal(transfer.rootDir, transfer.callId); const staleReturn = await markDelegationReturnedInternal(transfer.rootDir, transfer.callId, transfer.delegationId, "success", "stale", claimA, { owner: ownerA }); assert.equal(staleReturn.state, "rejected"); assert.deepEqual(await wal(transfer.rootDir, transfer.callId), beforeStale);

  const reattach = await setup("reattach-fence"); t.after(() => fs.rm(reattach.rootDir, { recursive: true, force: true }));
  const reattachA = owner("d", process.pid + 24); const reattachB = owner("e", process.pid + 25); const liveChild = child("f", process.pid + 26);
  const reattachReserved = await reserveInitialInternal(reattach.rootDir, reattach.callId, reattach.delegationId, { owner: reattachA }); assert.equal(reattachReserved.state, "reserved"); const reattachStarted = await markSpawnStartedInternal(reattach.rootDir, reattach.callId, reattach.delegationId, "initial", { owner: reattachA }); assert.equal(reattachStarted.state, "initial_running");
  const reattachClaim = { owner: reattachA, ownerGeneration: reattachStarted.ownerGeneration!, fencingGeneration: reattachStarted.fencingGeneration!, spawnId: reattachStarted.spawnId! }; assert.equal((await bindChildSessionInternal(reattach.rootDir, reattach.callId, reattach.delegationId, reattachClaim, "reattach-child", undefined, liveChild.pid, { childIdentity: liveChild })).state, "bound");
  assert.equal((await claimExecutionOwnerInternal(reattach.rootDir, reattach.callId, reattach.delegationId, reattachB, { owner: reattachB, allowLiveReattach: true, inspectOwner: async () => "dead", inspectChild: async () => "live" })).state, "transferred"); events = await wal(reattach.rootDir, reattach.callId); const reattached = events.find((event) => event.type === "owner_reattached"); assert.equal(reattached?.data.fencingGeneration, 1);
  const beforeReattachStale = await wal(reattach.rootDir, reattach.callId); const staleBind = await bindChildSessionInternal(reattach.rootDir, reattach.callId, reattach.delegationId, reattachClaim, "reattach-child", undefined, liveChild.pid, { owner: reattachA, childIdentity: liveChild }, 2); assert.equal(staleBind.state, "rejected"); const staleReattachReturn = await markDelegationReturnedInternal(reattach.rootDir, reattach.callId, reattach.delegationId, "success", "stale", reattachClaim, { owner: reattachA }); assert.equal(staleReattachReturn.state, "rejected"); assert.deepEqual(await wal(reattach.rootDir, reattach.callId), beforeReattachStale);

  await reconcileRunningChildInternal(transfer.rootDir, transfer.callId, transfer.delegationId, async () => "dead", { owner: ownerB, inspectChild: async () => "dead" }); assert.equal((await acceptContinuationInternal(transfer.rootDir, transfer.callId, transfer.delegationId, "recover" , { owner: ownerB })).state, "accepted"); const recovery = await reserveRecoveryCycleInternal(transfer.rootDir, transfer.callId, transfer.delegationId, { owner: ownerB, lineage }); assert.equal(recovery.state, "reserved"); const recoveryWal = await wal(transfer.rootDir, transfer.callId); const beforeRecoveryStale = recoveryWal.length; const staleRecovery = await markSpawnStartedInternal(transfer.rootDir, transfer.callId, transfer.delegationId, "recovery", { owner: ownerA, inspectOwner: async () => "live" }); assert.equal(staleRecovery.state, "rejected"); assert.equal((await wal(transfer.rootDir, transfer.callId)).length, beforeRecoveryStale);
});

test("forged reattach verification with a mismatched fence fails closed", async (t) => {
  const state = await setup("forged-reattach-fence"); t.after(() => fs.rm(state.rootDir, { recursive: true, force: true }));
  const ownerA = owner("a", process.pid + 51); const childA = child("c", process.pid + 52);
  assert.equal((await reserveInitialInternal(state.rootDir, state.callId, state.delegationId, { owner: ownerA })).state, "reserved");
  const started = await markSpawnStartedInternal(state.rootDir, state.callId, state.delegationId, "initial", { owner: ownerA }); assert.equal(started.state, "initial_running"); const claim = claimFrom(started);
  assert.equal((await bindChildSessionInternal(state.rootDir, state.callId, state.delegationId, claim, "reattach-child", undefined, childA.pid, { childIdentity: childA })).state, "bound");
  await appendWalForTest(state.rootDir, state.callId, "delegation_reattach_verified", { childSessionId: "reattach-child", spawnId: started.spawnId!, fencingGeneration: started.fencingGeneration! + 1, ownerGeneration: started.ownerGeneration! }, state.delegationId);
  assert.equal((await readDispatchCallInternal(state.rootDir, state.callId))?.state, "paused_integrity");
});

test("startup records spawn outcome unknown without owner takeover or child-dead fiction", async (t) => {
  const state = await setup("spawn-window"); t.after(() => fs.rm(state.rootDir, { recursive: true, force: true }));
  assert.equal((await reserveInitialInternal(state.rootDir, state.callId, state.delegationId)).state, "reserved"); const started = await markSpawnStartedInternal(state.rootDir, state.callId, state.delegationId, "initial"); assert.equal(started.state, "initial_running");
  let ownerChecks = 0; let childChecks = 0;
  const normalized = await normalizeExecutionStartupInternal(state.rootDir, lineage, async () => { childChecks += 1; throw new Error("security reconciler must not inspect child"); }, { inspectOwner: async () => { ownerChecks += 1; return "unknown"; } });
  assert.equal(normalized.spawnCount, 0); assert.equal(ownerChecks, 0); assert.equal(childChecks, 0);
  const events = await wal(state.rootDir, state.callId); assert.equal(events.filter((event) => event.type === "paused_uncertainty").length, 1); assert.equal(events.some((event) => event.type === "execution_interrupted"), false);
  assert.equal((await readDelegationInternal(state.rootDir, state.callId, state.delegationId))?.pauseReason, "spawn outcome unknown");
  await normalizeExecutionStartupInternal(state.rootDir, lineage, async () => "unknown", { inspectOwner: async () => "unknown" });
  assert.equal((await wal(state.rootDir, state.callId)).filter((event) => event.type === "paused_uncertainty").length, 1);
});

test("same owner old spawn and fencing claim is rejected after recovery with zero WAL", async (t) => {
  const state = await setup("same-owner-recovery-fence"); t.after(() => fs.rm(state.rootDir, { recursive: true, force: true }));
  const ownerA = owner("a", process.pid + 31); const childA = child("c", process.pid + 32);
  assert.equal((await reserveInitialInternal(state.rootDir, state.callId, state.delegationId, { owner: ownerA })).state, "reserved");
  const initial = await markSpawnStartedInternal(state.rootDir, state.callId, state.delegationId, "initial", { owner: ownerA }); assert.equal(initial.state, "initial_running");
  const initialClaim = claimFrom(initial);
  assert.equal((await bindChildSessionInternal(state.rootDir, state.callId, state.delegationId, initialClaim, "same-child-session", undefined, childA.pid, { owner: ownerA, childIdentity: childA })).state, "bound");
  assert.equal((await reconcileRunningChildInternal(state.rootDir, state.callId, state.delegationId, async () => "dead", { owner: ownerA })).state, "recovery_ready");
  assert.equal((await acceptContinuationInternal(state.rootDir, state.callId, state.delegationId, "recover", { owner: ownerA })).state, "accepted");
  assert.equal((await reserveRecoveryCycleInternal(state.rootDir, state.callId, state.delegationId, { owner: ownerA, lineage })).state, "reserved");
  const recovery = await markSpawnStartedInternal(state.rootDir, state.callId, state.delegationId, "recovery", { owner: ownerA, lineage }); assert.equal(recovery.state, "recovery_running");
  assert.notEqual(recovery.spawnId, initial.spawnId); assert.notEqual(recovery.fencingGeneration, initial.fencingGeneration);
  const before = await wal(state.rootDir, state.callId);
  const stale = await markDelegationReturnedInternal(state.rootDir, state.callId, state.delegationId, "success", "stale-recovery", initialClaim, { owner: ownerA });
  assert.equal(stale.state, "rejected"); assert.deepEqual(await wal(state.rootDir, state.callId), before);
});

test("cleanup completion fails closed without the durable outcome fence", async (t) => {
  const state = await setup("cleanup-fence-required"); t.after(() => fs.rm(state.rootDir, { recursive: true, force: true }));
  const reserved = await reserveInitialInternal(state.rootDir, state.callId, state.delegationId); assert.equal(reserved.state, "reserved");
  const started = await markSpawnStartedInternal(state.rootDir, state.callId, state.delegationId, "initial"); assert.equal(started.state, "initial_running");
  assert.equal((await markDelegationReturnedInternal(state.rootDir, state.callId, state.delegationId, "success", "ref:returned", claimFrom(started))).state, "returned");
  await appendWalForTest(state.rootDir, state.callId, "cleanup_completed", { spawnId: started.spawnId!, fencingGeneration: started.fencingGeneration!, ownerGeneration: started.ownerGeneration!, sessionRef: `v2:sessions/${state.delegationId}` }, state.delegationId);
  assert.equal((await readDispatchCallInternal(state.rootDir, state.callId))?.state, "paused_integrity");
});

test("persistent:false captures cleanup in the outcome and startup clears the pending projection", async (t) => {
  const state = await setup("outcome-cleanup", false); t.after(() => fs.rm(state.rootDir, { recursive: true, force: true }));
  const agent = { name: "implement", description: "implement", source: "project" as const, filePath: path.join(state.project, "agent.md"), systemPrompt: "Instructions" };
  let killed = true;
  await assert.rejects(() => executeDelegationInternal(state.rootDir, state.callId, state.delegationId, agent, {
    fault: (point) => { if (killed && point === "after:execution_outcome_captured") { killed = false; throw new Error("kill-after-outcome"); } },
    runAttempt: async (options: any) => { await options.onChildProcess?.({ pid: 1234, identity: options.childSessionId }); await fs.writeFile(path.join(options.sessionDir, "session.jsonl"), `${JSON.stringify({ type: "session", version: 3, id: options.childSessionId, cwd: options.cwd, timestamp: new Date().toISOString() })}\n`); return { agent: "implement", agentSource: "project", exitCode: 0, messages: [], toolResults: [], usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 1, turns: 1 }, requestedModel: "model", actualModel: "model", source: options.source, attempt: options.attempt, failureKind: "success", sessionId: options.childSessionId, cwdScope: "cwd:opaque" };
    },
  }));
  const events = await wal(state.rootDir, state.callId); const outcome = events.find((event) => event.type === "execution_outcome_captured"); assert.equal(outcome.data.cleanupRequired, true); assert.equal(outcome.data.sessionRef, `v2:sessions/${state.delegationId}`); assert.equal(events.some((event) => event.type === "cleanup_requested" || event.type === "child_ref_released"), false); assert.equal((await readDelegationInternal(state.rootDir, state.callId, state.delegationId))?.cleanupPending, true);
  await normalizeExecutionStartupInternal(state.rootDir, lineage, async () => { throw new Error("cleanup reconciler must not inspect child"); }, { inspectOwner: async () => { throw new Error("cleanup reconciler must not inspect owner"); } });
  assert.equal((await wal(state.rootDir, state.callId)).at(-1).type, "cleanup_completed"); assert.equal((await readDelegationInternal(state.rootDir, state.callId, state.delegationId))?.cleanupPending, false); assert.equal((await readDispatchCallInternal(state.rootDir, state.callId))?.state, "admitted");
  const afterCompletion = await wal(state.rootDir, state.callId); await normalizeExecutionStartupInternal(state.rootDir, lineage, async () => { throw new Error("idempotent cleanup must not inspect child"); }); assert.deepEqual(await wal(state.rootDir, state.callId), afterCompletion);
});
