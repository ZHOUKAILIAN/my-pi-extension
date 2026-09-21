import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDiscoverySnapshot } from "../src/agents.ts";
import {
  acceptConfigRevisionInternal,
  admitDispatchCallInternal,
  acceptContinuationInternal,
  claimExecutionOwnerInternal,
  bindChildSessionInternal,
  reconcileRunningChildInternal,
  delegationFoundationCapability,
  finalizeCallInternal,
  markDelegationReturnedInternal,
  markSpawnStartedInternal,
  normalizeStartupInternal,
  readDelegationInternal,
  readDispatchCallInternal,
  requestDelegationCancelInternal,
  requestDelegationCancelScopedInternal,
  reconcileDelegationCancelInternal,
  reserveInitialInternal,
  reserveRecoveryCycleInternal,
  resolveDelegationInternal,
} from "../src/delegation-internal.ts";
import { appendWal } from "../src/delegation-context.ts";
import type { ActiveLineage } from "../src/lineage.ts";
import type { DispatchCallAdmissionRequest, OwnerIdentity, ProjectTrustBinding } from "../src/delegation.ts";

const parentSessionId = "cancel-parent";
const lineage: ActiveLineage = { parentSessionId, activeLineageId: "cancel-lineage", activeBranchAnchor: "cancel-anchor", currentLeafId: "cancel-anchor", branchIds: ["root", "cancel-anchor"], persistence: "in_process_only" };
const actor = { parentSessionId, activeLineageId: lineage.activeLineageId, activeBranchAnchor: lineage.activeBranchAnchor };
const definition = "---\nname: implement\ndescription: implement\n---\nInstructions";

async function setup(toolCallId: string, withProject = false, ambiguous = false) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-cancel-"));
  const project = path.join(rootDir, "agents");
  let projectTrust: ProjectTrustBinding | undefined;
  if (withProject) {
    await fs.mkdir(project, { recursive: true, mode: 0o755 });
    await fs.writeFile(path.join(project, "agent.md"), definition, { mode: 0o644 });
    if (ambiguous) await fs.writeFile(path.join(project, "other.md"), definition, { mode: 0o644 });
    const snapshot = getAgentDiscoverySnapshot(project)!;
    projectTrust = { parentSessionId, discoveryRootRealpath: snapshot.rootRealpath, snapshotDigest: snapshot.digest };
  }
  const request: DispatchCallAdmissionRequest = {
    parentSessionId, lineage, toolCallId, cwd: withProject ? project : "/tmp/project", mode: "single",
    single: { agent: withProject ? "implement" : "missing", task: "cancel task" }, agentScope: withProject ? "project" : "user", ...(projectTrust ? { projectTrust } : {}),
  };
  const admitted = await admitDispatchCallInternal(request, rootDir);
  return { rootDir, project, callId: admitted.dispatchCallId!, delegationId: admitted.delegationIds![0]!, cleanup: () => fs.rm(rootDir, { recursive: true, force: true }) };
}
async function wal(rootDir: string, callId: string): Promise<any[]> { return (await fs.readFile(path.join(rootDir, "v2", "wal", `${callId}.jsonl`), "utf8")).trim().split("\n").map((line) => JSON.parse(line)); }
async function privateSnapshot(rootDir: string): Promise<Record<string, string>> { const result: Record<string, string> = {}; for (const file of (await fs.readdir(path.join(rootDir, "v2", "private"))).sort()) result[file] = await fs.readFile(path.join(rootDir, "v2", "private", file), "utf8"); return result; }
async function privateSnapshotForDelegation(rootDir: string, delegationId: string): Promise<Record<string, string>> { const snapshot = await privateSnapshot(rootDir); return Object.fromEntries(Object.entries(snapshot).filter(([file, content]) => file.includes(delegationId) || content.includes(`"delegationId":"${delegationId}"`))); }
async function setupParallel(toolCallId: string) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-cancel-parallel-"));
  const project = path.join(rootDir, "agents"); await fs.mkdir(project, { recursive: true, mode: 0o755 }); await fs.writeFile(path.join(project, "agent.md"), definition, { mode: 0o644 });
  const snapshot = getAgentDiscoverySnapshot(project)!; const projectTrust = { parentSessionId, discoveryRootRealpath: snapshot.rootRealpath, snapshotDigest: snapshot.digest };
  const request: DispatchCallAdmissionRequest = { parentSessionId, lineage, toolCallId, cwd: project, mode: "parallel", tasks: [{ agent: "implement", task: "cancel sibling one" }, { agent: "implement", task: "cancel sibling two" }], agentScope: "project", projectTrust };
  const admitted = await admitDispatchCallInternal(request, rootDir);
  return { rootDir, project, callId: admitted.dispatchCallId!, delegationIds: admitted.delegationIds!, cleanup: () => fs.rm(rootDir, { recursive: true, force: true }) };
}
async function setupChain(toolCallId: string) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-cancel-chain-"));
  const project = path.join(rootDir, "agents"); await fs.mkdir(project, { recursive: true, mode: 0o755 }); await fs.writeFile(path.join(project, "agent.md"), definition, { mode: 0o644 });
  const snapshot = getAgentDiscoverySnapshot(project)!; const projectTrust = { parentSessionId, discoveryRootRealpath: snapshot.rootRealpath, snapshotDigest: snapshot.digest };
  const request: DispatchCallAdmissionRequest = { parentSessionId, lineage, toolCallId, cwd: project, mode: "chain", chain: [{ agent: "implement", task: "cancel chain one" }, { agent: "implement", task: "cancel chain two" }], agentScope: "project", projectTrust };
  const admitted = await admitDispatchCallInternal(request, rootDir);
  return { rootDir, callId: admitted.dispatchCallId!, delegationId: admitted.delegationIds![0]!, cleanup: () => fs.rm(rootDir, { recursive: true, force: true }) };
}
async function appendForged(rootDir: string, callId: string, delegationId: string, data: Record<string, unknown>): Promise<void> { const events = await wal(rootDir, callId); const previous = events.at(-1)!; const body = { version: 1, seq: previous.seq + 1, type: "cancel_requested", callId, delegationId, data, prevChecksum: previous.checksum }; const checksum = createHash("sha256").update(JSON.stringify(body)).digest("hex"); await fs.appendFile(path.join(rootDir, "v2", "wal", `${callId}.jsonl`), `${JSON.stringify({ ...body, checksum })}\n`); }
function owner(name: string): OwnerIdentity { return { host: os.hostname(), pid: process.pid, birth: name, parentSessionId, parentSessionPath: "/tmp/cancel-parent", argvProof: createHash("sha256").update(name).digest("hex") }; }

 test("actor and lineage mismatch fail closed with WAL=0", async () => {
  const state = await setup("actor-mismatch");
  try {
    const before = await wal(state.rootDir, state.callId);
    assert.equal((await requestDelegationCancelInternal(state.rootDir, state.callId, state.delegationId, { ...actor, activeLineageId: "sibling" }, { lineage })).state, "rejected");
    assert.deepEqual(await wal(state.rootDir, state.callId), before);
    assert.equal((await requestDelegationCancelInternal(state.rootDir, state.callId, "not-a-delegation", actor, { lineage })).state, "rejected");
    assert.deepEqual(await wal(state.rootDir, state.callId), before);
    assert.equal((await requestDelegationCancelScopedInternal(state.rootDir, state.callId, state.delegationId, "call", actor, { lineage })).state, "rejected");
    assert.deepEqual(await wal(state.rootDir, state.callId), before);
    await appendForged(state.rootDir, state.callId, state.delegationId, { target: state.delegationId, scope: "item", actorRef: "0".repeat(64), parentSessionId, activeLineageId: lineage.activeLineageId, activeBranchAnchor: lineage.activeBranchAnchor, priorState: "admitted" });
    assert.equal((await readDelegationInternal(state.rootDir, state.callId, state.delegationId)), undefined);
  } finally { await state.cleanup(); }
});

test("duplicate and concurrent item cancel have one durable winner and stable receipt", async () => {
  const state = await setup("cancel-race");
  try {
    const results = await Promise.all(Array.from({ length: 8 }, () => requestDelegationCancelInternal(state.rootDir, state.callId, state.delegationId, actor, { lineage })));
    const receipts = results.filter((result): result is { walSeq: number; actorRef: string; target: string; scope: "item"; status: string } => "walSeq" in result);
    assert.equal(receipts.length, 8);
    assert.equal(new Set(receipts.map((receipt) => receipt.walSeq)).size, 1);
    assert.equal((await wal(state.rootDir, state.callId)).filter((event) => event.type === "cancel_requested").length, 1);
    assert.equal((await requestDelegationCancelInternal(state.rootDir, state.callId, state.delegationId, actor, { lineage })).status, "already_requested");
  } finally { await state.cleanup(); }
});

test("pre-spawn no-reservation cancel converges at startup and never writes death", async () => {
  const state = await setup("cancel-no-reservation");
  try {
    assert.equal((await requestDelegationCancelInternal(state.rootDir, state.callId, state.delegationId, actor, { lineage })).status, "requested");
    const normalized = await normalizeStartupInternal(state.rootDir, lineage);
    assert.equal(normalized.spawnCount, 0);
    assert.equal((await readDelegationInternal(state.rootDir, state.callId, state.delegationId))?.state, "cancelled");
    const events = await wal(state.rootDir, state.callId);
    assert.equal(events.filter((event) => event.type === "pre_spawn_no_reservation").length, 1);
    assert.equal(events.some((event) => event.type === "child_death_observed" || event.type === "terminate_requested"), false);
    assert.equal((await requestDelegationCancelInternal(state.rootDir, state.callId, state.delegationId, actor, { lineage })).status, "completed");
  } finally { await state.cleanup(); }
});

test("paused_configuration never-spawn follows pre-spawn history, while ever-spawn stays requested", async () => {
  const never = await setup("cancel-paused-never", true, true);
  try {
    assert.equal((await resolveDelegationInternal(never.rootDir, never.callId, never.delegationId, { lineage })).state, "paused_configuration");
    assert.equal((await requestDelegationCancelInternal(never.rootDir, never.callId, never.delegationId, actor, { lineage })).status, "requested");
    assert.equal((await reconcileDelegationCancelInternal(never.rootDir, never.callId, never.delegationId, { lineage })).state, "cancelled");
  } finally { await never.cleanup(); }

  const ever = await setup("cancel-paused-ever", true);
  try {
    assert.equal((await resolveDelegationInternal(ever.rootDir, ever.callId, ever.delegationId, { lineage })).state, "resolved");
    const spawnOwner = owner("paused-ever");
    assert.equal((await reserveInitialInternal(ever.rootDir, ever.callId, ever.delegationId, { lineage, owner: spawnOwner })).state, "reserved");
    const started = await markSpawnStartedInternal(ever.rootDir, ever.callId, ever.delegationId, "initial", { lineage, owner: spawnOwner });
    assert.equal(started.state, "initial_running");
    await appendWal(ever.rootDir, ever.callId, "execution_interrupted", { reason: "provider configuration", failureKind: "non_transient_provider", resultRef: "ref:config", spawnId: started.spawnId, fencingGeneration: started.fencingGeneration, ownerGeneration: started.ownerGeneration }, ever.delegationId);
    assert.equal((await readDelegationInternal(ever.rootDir, ever.callId, ever.delegationId))?.state, "paused_configuration");
    assert.equal((await requestDelegationCancelInternal(ever.rootDir, ever.callId, ever.delegationId, actor, { lineage })).status, "requested");
    assert.equal((await reconcileDelegationCancelInternal(ever.rootDir, ever.callId, ever.delegationId, { lineage })).state, "cancel_requested");
  } finally { await ever.cleanup(); }
});

test("logical spawn intent does not block pre-spawn cancel, and cancel fence rejects spawn completion", async () => {
  const state = await setup("cancel-after-logical-intent", true);
  try {
    assert.equal((await resolveDelegationInternal(state.rootDir, state.callId, state.delegationId, { lineage })).state, "resolved");
    const spawnOwner = owner("logical-intent");
    assert.equal((await reserveInitialInternal(state.rootDir, state.callId, state.delegationId, { lineage, owner: spawnOwner })).state, "reserved");
    await assert.rejects(() => markSpawnStartedInternal(state.rootDir, state.callId, state.delegationId, "initial", { lineage, owner: spawnOwner, fault: (point) => { if (point === "after:spawn_intent") throw new Error("crash-after-logical-intent"); } }));
    assert.equal((await wal(state.rootDir, state.callId)).filter((event) => event.type === "spawn_intent").length, 1);
    await assert.rejects(() => requestDelegationCancelInternal(state.rootDir, state.callId, state.delegationId, actor, { lineage, fault: (point) => { if (point === "after:cancel_requested") throw new Error("crash-after-cancel"); } }));
    const normalized = await normalizeStartupInternal(state.rootDir, lineage);
    assert.equal(normalized.spawnCount, 0);
    assert.equal((await readDelegationInternal(state.rootDir, state.callId, state.delegationId))?.state, "cancelled");
    const events = await wal(state.rootDir, state.callId);
    assert.equal(events.filter((event) => event.type === "reservation_cancelled").length, 1);
    assert.equal(events.filter((event) => event.type === "delegation_cancelled").length, 1);
    assert.equal(events.filter((event) => event.type === "spawn_started").length, 0);
    assert.equal(events.some((event) => ["child_session_bound", "child_session_rebound", "child_death_observed", "terminate_requested"].includes(event.type)), false);
    const beforeFenceRetry = events.length;
    assert.equal((await markSpawnStartedInternal(state.rootDir, state.callId, state.delegationId, "initial", { lineage, owner: spawnOwner })).state, "rejected");
    assert.equal((await wal(state.rootDir, state.callId)).length, beforeFenceRetry);
  } finally { await state.cleanup(); }
});

test("reservation seal kill point replays to cancellation without a death fact", async () => {
  const state = await setup("cancel-reservation-kill", true);
  try {
    assert.equal((await resolveDelegationInternal(state.rootDir, state.callId, state.delegationId, { lineage })).state, "resolved");
    assert.equal((await reserveInitialInternal(state.rootDir, state.callId, state.delegationId, { lineage })).state, "reserved");
    assert.equal((await requestDelegationCancelInternal(state.rootDir, state.callId, state.delegationId, actor, { lineage })).status, "requested");
    let killed = true;
    await assert.rejects(() => reconcileDelegationCancelInternal(state.rootDir, state.callId, state.delegationId, { lineage, fault: (point) => { if (killed && point === "after:reservation_cancelled") { killed = false; throw new Error("kill-after-reservation-seal"); } } }));
    const sealed = await wal(state.rootDir, state.callId);
    assert.equal(sealed.filter((event) => event.type === "reservation_cancelled").length, 1);
    assert.equal(sealed.filter((event) => event.type === "delegation_cancelled").length, 0);
    assert.equal((await normalizeStartupInternal(state.rootDir, lineage)).spawnCount, 0);
    assert.equal((await readDelegationInternal(state.rootDir, state.callId, state.delegationId))?.state, "cancelled");
    const replayed = await wal(state.rootDir, state.callId);
    assert.equal(replayed.filter((event) => event.type === "delegation_cancelled").length, 1);
    assert.equal(replayed.some((event) => ["child_death_observed", "terminate_requested", "child_death_proved"].includes(event.type)), false);
  } finally { await state.cleanup(); }
});

test("startup reservation-seal kill point replays to cancellation without a death fact", async () => {
  const state = await setup("cancel-startup-reservation-kill", true);
  try {
    assert.equal((await resolveDelegationInternal(state.rootDir, state.callId, state.delegationId, { lineage })).state, "resolved");
    assert.equal((await reserveInitialInternal(state.rootDir, state.callId, state.delegationId, { lineage })).state, "reserved");
    assert.equal((await requestDelegationCancelInternal(state.rootDir, state.callId, state.delegationId, actor, { lineage })).status, "requested");
    await assert.rejects(() => normalizeStartupInternal(state.rootDir, lineage, { lineage, fault: (point) => { if (point === "after:reservation_cancelled") throw new Error("kill-during-startup-cancel"); } }));
    const sealed = await wal(state.rootDir, state.callId);
    assert.equal(sealed.filter((event) => event.type === "reservation_cancelled").length, 1);
    assert.equal(sealed.filter((event) => event.type === "delegation_cancelled").length, 0);
    assert.equal((await normalizeStartupInternal(state.rootDir, lineage)).spawnCount, 0);
    assert.equal((await readDelegationInternal(state.rootDir, state.callId, state.delegationId))?.state, "cancelled");
    const replayed = await wal(state.rootDir, state.callId);
    assert.equal(replayed.filter((event) => event.type === "delegation_cancelled").length, 1);
    assert.equal(replayed.some((event) => ["child_death_observed", "terminate_requested", "child_death_proved"].includes(event.type)), false);
  } finally { await state.cleanup(); }
});

test("initial reservation is sealed before pre-spawn cancellation", async () => {
  const state = await setup("cancel-reservation", true);
  try {
    assert.equal((await resolveDelegationInternal(state.rootDir, state.callId, state.delegationId, { lineage })).state, "resolved");
    assert.equal((await reserveInitialInternal(state.rootDir, state.callId, state.delegationId, { lineage })).state, "reserved");
    assert.equal((await requestDelegationCancelInternal(state.rootDir, state.callId, state.delegationId, actor, { lineage })).status, "requested");
    assert.equal((await reconcileDelegationCancelInternal(state.rootDir, state.callId, state.delegationId, { lineage })).state, "cancelled");
    const events = await wal(state.rootDir, state.callId);
    assert.equal(events.filter((event) => event.type === "reservation_cancelled").length, 1);
    assert.equal(events.filter((event) => event.type === "delegation_cancelled").length, 1);
    assert.equal(events.filter((event) => event.type === "spawn_started").length, 0);
    const before = events.length;
    assert.equal((await reserveInitialInternal(state.rootDir, state.callId, state.delegationId, { lineage })).state, "rejected");
    assert.equal((await wal(state.rootDir, state.callId)).length, before);
  } finally { await state.cleanup(); }
});

test("startup cancel wins over an accepted-but-unpublished revision", async () => {
  const state = await setup("cancel-before-revision-publish", true);
  try {
    assert.equal((await resolveDelegationInternal(state.rootDir, state.callId, state.delegationId, { lineage })).state, "resolved");
    await fs.appendFile(path.join(state.project, "agent.md"), "revision-before-cancel\\n");
    const revisedSnapshot = getAgentDiscoverySnapshot(state.project)!;
    const revisedTrust = { parentSessionId, discoveryRootRealpath: revisedSnapshot.rootRealpath, snapshotDigest: revisedSnapshot.digest };
    await assert.rejects(() => acceptConfigRevisionInternal(state.rootDir, state.callId, state.delegationId, revisedTrust, { actorId: "revision-before-cancel", ...actor }, { fault: (point) => { if (point === "after:config_revision_accepted") throw new Error("crash-after-accepted"); } }));
    const acceptedBeforeCancel = await wal(state.rootDir, state.callId);
    assert.equal(acceptedBeforeCancel.filter((event) => event.type === "config_revision_accepted").length, 1);
    assert.equal(acceptedBeforeCancel.filter((event) => event.type === "config_revision_published").length, 0);
    const privateBeforeCancel = await privateSnapshot(state.rootDir);
    const bindingBeforeCancel = privateBeforeCancel[`binding-${state.delegationId}.json`];
    await assert.rejects(() => requestDelegationCancelInternal(state.rootDir, state.callId, state.delegationId, actor, { lineage, fault: (point) => { if (point === "after:cancel_requested") throw new Error("crash-after-cancel"); } }));
    const beforeStartup = await wal(state.rootDir, state.callId);
    assert.equal(beforeStartup.filter((event) => event.type === "config_revision_published").length, 0);
    assert.equal((await normalizeStartupInternal(state.rootDir, lineage)).pausedIntegrity, 0);
    assert.equal((await readDelegationInternal(state.rootDir, state.callId, state.delegationId))?.state, "cancelled");
    const afterStartup = await wal(state.rootDir, state.callId);
    assert.equal(afterStartup.filter((event) => event.type === "config_revision_published").length, 0);
    assert.equal(afterStartup.filter((event) => event.type === "config_revision_accepted").length, 1);
    assert.equal((await privateSnapshot(state.rootDir))[`binding-${state.delegationId}.json`], bindingBeforeCancel);
    const stableAfterStartup = await wal(state.rootDir, state.callId);
    assert.equal((await readDelegationInternal(state.rootDir, state.callId, state.delegationId, lineage))?.state, "cancelled");
    assert.deepEqual(await wal(state.rootDir, state.callId), stableAfterStartup);
    assert.deepEqual(await privateSnapshot(state.rootDir), privateBeforeCancel);
    assert.deepEqual((await privateSnapshot(state.rootDir))[`binding-${state.delegationId}.json`], bindingBeforeCancel);
  } finally { await state.cleanup(); }
});

test("item cancel does not block accepted revision reconciliation for a parallel sibling", async () => {
  const state = await setupParallel("cancel-parallel-revision");
  try {
    for (const delegationId of state.delegationIds) assert.equal((await resolveDelegationInternal(state.rootDir, state.callId, delegationId, { lineage })).state, "resolved");
    await fs.appendFile(path.join(state.project, "agent.md"), "parallel-revision\n");
    const revisedSnapshot = getAgentDiscoverySnapshot(state.project)!;
    const revisedTrust = { parentSessionId, discoveryRootRealpath: revisedSnapshot.rootRealpath, snapshotDigest: revisedSnapshot.digest };
    const revisionActor = { actorId: "parallel-revision", ...actor };
    for (const delegationId of state.delegationIds) {
      await assert.rejects(() => acceptConfigRevisionInternal(state.rootDir, state.callId, delegationId, revisedTrust, revisionActor, { fault: (point) => { if (point === "after:config_revision_accepted") throw new Error("kill-after-accepted"); } }));
    }
    const target = state.delegationIds[0]!; const sibling = state.delegationIds[1]!;
    const targetPrivateBefore = await privateSnapshotForDelegation(state.rootDir, target);
    const beforeCancel = await wal(state.rootDir, state.callId);
    assert.equal(beforeCancel.filter((event) => event.type === "config_revision_published").length, 0);
    assert.equal((await requestDelegationCancelInternal(state.rootDir, state.callId, target, actor, { lineage })).status, "requested");
    const direct = await readDispatchCallInternal(state.rootDir, state.callId, lineage);
    assert.equal(direct?.state, "admitted");
    const afterDirect = await wal(state.rootDir, state.callId);
    assert.equal(afterDirect.filter((event) => event.type === "config_revision_published" && event.delegationId === target).length, 0);
    assert.equal(afterDirect.filter((event) => event.type === "config_revision_published" && event.delegationId === sibling).length, 1);
    assert.deepEqual(await privateSnapshotForDelegation(state.rootDir, target), targetPrivateBefore);
    assert.equal((await readDelegationInternal(state.rootDir, state.callId, sibling))?.state, "bound");
    assert.equal((await normalizeStartupInternal(state.rootDir, lineage)).pausedIntegrity, 0);
    assert.equal((await readDelegationInternal(state.rootDir, state.callId, target))?.state, "cancelled");
    const finalEvents = await wal(state.rootDir, state.callId);
    const targetEventsAfterCancel = finalEvents.filter((event) => event.delegationId === target && event.seq > beforeCancel.at(-1)!.seq);
    assert.deepEqual(targetEventsAfterCancel.map((event) => event.type), ["cancel_requested", "pre_spawn_no_reservation", "delegation_cancelled"]);
    assert.equal(finalEvents.filter((event) => event.type === "config_revision_published" && event.delegationId === target).length, 0);
    assert.equal(finalEvents.filter((event) => event.type === "config_revision_published" && event.delegationId === sibling).length, 1);
  } finally { await state.cleanup(); }
});

test("recovery reservation uses the current scope, not an earlier spawn history", async () => {
  const state = await setup("cancel-recovery-scope", true);
  try {
    assert.equal((await resolveDelegationInternal(state.rootDir, state.callId, state.delegationId, { lineage })).state, "resolved");
    const spawnOwner = owner("recovery-scope");
    assert.equal((await reserveInitialInternal(state.rootDir, state.callId, state.delegationId, { lineage, owner: spawnOwner })).state, "reserved");
    const started = await markSpawnStartedInternal(state.rootDir, state.callId, state.delegationId, "initial", { lineage, owner: spawnOwner });
    assert.equal(started.state, "initial_running");
    assert.equal((await bindChildSessionInternal(state.rootDir, state.callId, state.delegationId, { owner: started.owner!, ownerGeneration: started.ownerGeneration!, fencingGeneration: started.fencingGeneration!, spawnId: started.spawnId! }, "historical-child", undefined, 4321, { lineage, owner: spawnOwner, childIdentity: { host: os.hostname(), pid: 4321, birth: "historical-child", sessionPathHash: "1".repeat(32), argvProof: "2".repeat(64) } })).state, "bound");
    assert.equal((await reconcileRunningChildInternal(state.rootDir, state.callId, state.delegationId, async () => "dead", { lineage, owner: spawnOwner })).state, "recovery_ready");
    assert.equal((await acceptContinuationInternal(state.rootDir, state.callId, state.delegationId, "retry", { lineage, owner: spawnOwner })).state, "accepted");
    assert.equal((await reserveRecoveryCycleInternal(state.rootDir, state.callId, state.delegationId, { lineage, owner: spawnOwner })).state, "reserved");
    assert.equal((await requestDelegationCancelInternal(state.rootDir, state.callId, state.delegationId, actor, { lineage })).status, "requested");
    assert.equal((await reconcileDelegationCancelInternal(state.rootDir, state.callId, state.delegationId, { lineage })).state, "cancelled");
    const events = await wal(state.rootDir, state.callId);
    assert.equal(events.filter((event) => event.type === "spawn_started").length, 1);
    assert.equal(events.filter((event) => event.type === "execution_interrupted").length, 1);
    assert.equal(events.filter((event) => event.type === "reservation_cancelled").length, 1);
    assert.equal(events.filter((event) => event.type === "delegation_cancelled").length, 1);
    assert.equal(events.some((event) => ["child_death_observed", "terminate_requested", "child_death_proved"].includes(event.type)), false);
  } finally { await state.cleanup(); }
});

test("post-spawn cancellation remains requested and never claims recovery", async () => {
  const state = await setup("cancel-post-spawn", true);
  try {
    assert.equal((await resolveDelegationInternal(state.rootDir, state.callId, state.delegationId, { lineage })).state, "resolved");
    const spawnOwner = owner("post-spawn");
    assert.equal((await reserveInitialInternal(state.rootDir, state.callId, state.delegationId, { lineage, owner: spawnOwner })).state, "reserved");
    assert.equal((await markSpawnStartedInternal(state.rootDir, state.callId, state.delegationId, "initial", { lineage, owner: spawnOwner })).state, "initial_running");
    assert.equal((await requestDelegationCancelInternal(state.rootDir, state.callId, state.delegationId, actor, { lineage })).status, "requested");
    assert.equal((await reconcileDelegationCancelInternal(state.rootDir, state.callId, state.delegationId, { lineage })).state, "cancel_requested");
    const events = await wal(state.rootDir, state.callId);
    assert.equal(events.filter((event) => event.type === "reservation_cancelled").length, 0);
    assert.equal(events.filter((event) => event.type === "delegation_cancelled").length, 0);
    assert.equal(events.filter((event) => event.type === "spawn_started").length, 1);
    assert.equal((await readDelegationInternal(state.rootDir, state.callId, state.delegationId))?.state, "cancel_requested");
    assert.equal((await claimExecutionOwnerInternal(state.rootDir, state.callId, state.delegationId, owner("new-owner"), { lineage, inspectOwner: async () => "dead" })).state, "rejected");
  } finally { await state.cleanup(); }
});

test("AbortSignal interruption is not an explicit cancel fact", async () => {
  const state = await setup("abort-is-not-cancel");
  try {
    const controller = new AbortController(); controller.abort();
    const before = await wal(state.rootDir, state.callId);
    assert.equal((await reserveInitialInternal(state.rootDir, state.callId, state.delegationId, { lineage, signal: controller.signal })).state, "rejected");
    const events = await wal(state.rootDir, state.callId);
    assert.equal(events.some((event) => event.type === "cancel_requested"), false);
    assert.ok(events.length >= before.length);
  } finally { await state.cleanup(); }
});

test("pre-spawn single cancel finalizes the Call as cancelled and materializes its proof", async () => {
  const state = await setup("cancel-final-single");
  try {
    assert.equal((await requestDelegationCancelInternal(state.rootDir, state.callId, state.delegationId, actor, { lineage })).status, "requested");
    assert.equal((await reconcileDelegationCancelInternal(state.rootDir, state.callId, state.delegationId, { lineage })).state, "cancelled");
    assert.equal((await finalizeCallInternal(state.rootDir, state.callId)).state, "final");
    assert.equal((await readDispatchCallInternal(state.rootDir, state.callId))?.finalOutcome, "cancelled");
    const proofPath = path.join(state.rootDir, "v2", "proofs", `${state.callId}.json`);
    const proof = JSON.parse(await fs.readFile(proofPath, "utf8"));
    assert.equal(proof.outcome, "cancelled");
    assert.deepEqual(proof.slots.map((slot: any) => [slot.index, slot.order, slot.state, slot.terminalOutcome]), [[0, 0, "cancelled", "cancelled"]]);
    const finalEvents = (await wal(state.rootDir, state.callId)).filter((event) => event.type === "call_finalized");
    assert.equal(finalEvents.length, 1);
    await fs.unlink(proofPath);
    assert.deepEqual(await finalizeCallInternal(state.rootDir, state.callId), { state: "final", outcome: "cancelled" });
    assert.equal((await wal(state.rootDir, state.callId)).filter((event) => event.type === "call_finalized").length, 1);
    assert.equal(JSON.parse(await fs.readFile(proofPath, "utf8")).outcome, "cancelled");
  } finally { await state.cleanup(); }
});

test("parallel returned and item-cancelled slots finalize by original index", async () => {
  const state = await setupParallel("cancel-final-parallel");
  try {
    for (const delegationId of state.delegationIds) assert.equal((await resolveDelegationInternal(state.rootDir, state.callId, delegationId, { lineage })).state, "resolved");
    const returned = state.delegationIds[0]!;
    const returnOwner = owner("parallel-return");
    assert.equal((await reserveInitialInternal(state.rootDir, state.callId, returned, { lineage, owner: returnOwner })).state, "reserved");
    const started = await markSpawnStartedInternal(state.rootDir, state.callId, returned, "initial", { lineage, owner: returnOwner });
    assert.equal(started.state, "initial_running");
    await markDelegationReturnedInternal(state.rootDir, state.callId, returned, "success", "result:parallel", { owner: started.owner!, ownerGeneration: started.ownerGeneration!, fencingGeneration: started.fencingGeneration!, spawnId: started.spawnId! }, { lineage });
    const cancelled = state.delegationIds[1]!;
    assert.equal((await requestDelegationCancelInternal(state.rootDir, state.callId, cancelled, actor, { lineage })).status, "requested");
    assert.equal((await reconcileDelegationCancelInternal(state.rootDir, state.callId, cancelled, { lineage })).state, "cancelled");
    assert.deepEqual(await finalizeCallInternal(state.rootDir, state.callId), { state: "final", outcome: "cancelled" });
    const view = await readDispatchCallInternal(state.rootDir, state.callId);
    assert.equal(view?.finalOutcome, "cancelled");
    assert.deepEqual(view?.slots.map((slot) => [slot.index, slot.order, slot.state, slot.terminalOutcome]), [[0, 0, "returned", "success"], [1, 1, "cancelled", "cancelled"]]);
    const proof = JSON.parse(await fs.readFile(path.join(state.rootDir, "v2", "proofs", `${state.callId}.json`), "utf8"));
    assert.deepEqual(proof.slots.map((slot: any) => [slot.index, slot.order, slot.state, slot.terminalOutcome]), [[0, 0, "returned", "success"], [1, 1, "cancelled", "cancelled"]]);
  } finally { await state.cleanup(); }
});

test("parallel finalization rejects while any required slot is not terminal", async () => {
  const state = await setupParallel("cancel-final-parallel-incomplete");
  try {
    for (const delegationId of state.delegationIds) assert.equal((await resolveDelegationInternal(state.rootDir, state.callId, delegationId, { lineage })).state, "resolved");
    const incompleteOwner = owner("parallel-incomplete");
    assert.equal((await reserveInitialInternal(state.rootDir, state.callId, state.delegationIds[0]!, { lineage, owner: incompleteOwner })).state, "reserved");
    const started = await markSpawnStartedInternal(state.rootDir, state.callId, state.delegationIds[0]!, "initial", { lineage, owner: incompleteOwner });
    await markDelegationReturnedInternal(state.rootDir, state.callId, state.delegationIds[0]!, "success", "result:one", { owner: started.owner!, ownerGeneration: started.ownerGeneration!, fencingGeneration: started.fencingGeneration!, spawnId: started.spawnId! }, { lineage });
    assert.equal((await finalizeCallInternal(state.rootDir, state.callId)).state, "rejected");
    assert.equal((await requestDelegationCancelInternal(state.rootDir, state.callId, state.delegationIds[1]!, actor, { lineage })).status, "requested");
    assert.equal((await finalizeCallInternal(state.rootDir, state.callId)).state, "rejected");
  } finally { await state.cleanup(); }
});

test("chain finalization rejects while future required slots are not admitted", async () => {
  const state = await setupChain("cancel-final-chain-missing");
  try {
    assert.equal((await requestDelegationCancelInternal(state.rootDir, state.callId, state.delegationId, actor, { lineage })).status, "requested");
    assert.equal((await reconcileDelegationCancelInternal(state.rootDir, state.callId, state.delegationId, { lineage })).state, "cancelled");
    assert.equal((await finalizeCallInternal(state.rootDir, state.callId)).state, "rejected");
    assert.equal((await readDispatchCallInternal(state.rootDir, state.callId))?.finalOutcome, undefined);
  } finally { await state.cleanup(); }
});

test("cancel capability stays gated", () => {
  assert.deepEqual(delegationFoundationCapability(), { enabled: false, executionWired: false, recoveryWired: false });
});
