import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDiscoverySnapshot } from "../src/agents.ts";
import {
  admitDispatchCallInternal, admitNextChainStepInternal, resolveDelegationInternal, reserveInitialInternal,
  markSpawnStartedInternal, markDelegationReturnedInternal, finalizeCallInternal,
  requestDelegationDeleteInternal, requestCallCleanupInternal, cleanupActorSecretPath,
  gcCleanupTombstonesInternal, querySubagentStatusInternal, requestRetentionCleanupInternal,
  reconcileCleanupStartupInternal, normalizeStartupInternal, cleanupOrphanDelegationInternal,
} from "../src/delegation-internal.ts";
import type { ActiveLineage } from "../src/lineage.ts";
import type { DispatchCallAdmissionRequest } from "../src/delegation-types.ts";
import { withCallLock } from "../src/delegation-context.ts";

const parentSessionId = "cleanup-parent";
function lineage(): ActiveLineage { return { parentSessionId, activeLineageId: "cleanup-lineage", activeBranchAnchor: "cleanup-anchor", currentLeafId: "cleanup-anchor", branchIds: ["cleanup-anchor"], persistence: "in_process_only" }; }
async function setup(name: string, persistent = true) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), `subagent-${name}-`));
  const agents = path.join(rootDir, "agents"); await fs.mkdir(agents, { mode: 0o700 });
  await fs.writeFile(path.join(agents, "agent.md"), "---\nname: implement\ndescription: implement\n---\nInstructions", { mode: 0o600 });
  const snapshot = getAgentDiscoverySnapshot(agents)!; const current = lineage();
  const request: DispatchCallAdmissionRequest = { parentSessionId, lineage: current, toolCallId: name, cwd: agents, mode: "single", persistent, agentScope: "project", projectTrust: { parentSessionId, discoveryRootRealpath: snapshot.rootRealpath, snapshotDigest: snapshot.digest }, single: { agent: "implement", task: "private cleanup task", persistent } };
  const admitted = await admitDispatchCallInternal(request, rootDir); assert.equal(admitted.state, "admitted");
  const callId = admitted.dispatchCallId!; const delegationId = admitted.delegationIds![0]!;
  await resolveDelegationInternal(rootDir, callId, delegationId, { lineage: current }); await reserveInitialInternal(rootDir, callId, delegationId, { lineage: current });
  const started = await markSpawnStartedInternal(rootDir, callId, delegationId, "initial", { lineage: current });
  const claim = { owner: started.owner!, ownerGeneration: started.ownerGeneration!, fencingGeneration: started.fencingGeneration!, spawnId: started.spawnId! };
  await markDelegationReturnedInternal(rootDir, callId, delegationId, "success", "result:cleanup", claim, { lineage: current });
  assert.equal((await finalizeCallInternal(rootDir, callId)).state, "final");
  const actor = { parentSessionId, activeLineageId: current.activeLineageId, activeBranchAnchor: current.activeBranchAnchor };
  const host = { scanActiveBranch: async () => [{ entryRef: "entry:tool-result", role: "toolResult" as const, parentSessionId, activeLineageId: current.activeLineageId, activeBranchAnchor: current.activeBranchAnchor, dispatchCallId: callId, proofRef: `proof:${callId}`, toolCallId: name, toolCallIdHash: undefined }], appendCustomMessage: async () => undefined };
  return { rootDir, callId, delegationId, actor, lineage: current, host, cleanup: () => fs.rm(rootDir, { recursive: true, force: true }) };
}
async function wal(rootDir: string, callId: string): Promise<any[]> { return (await fs.readFile(path.join(rootDir, "v2", "wal", `${callId}.jsonl`), "utf8")).trim().split("\n").map(JSON.parse); }
async function snapshotFiles(rootDir: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>(); const root = path.join(rootDir, "v2");
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else snapshot.set(path.relative(root, file), (await fs.readFile(file)).toString("base64"));
    }
  };
  await visit(root); return snapshot;
}
async function setupMode(name: string, mode: "parallel" | "chain") {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), `subagent-${name}-`)); const agents = path.join(rootDir, "agents"); await fs.mkdir(agents, { mode: 0o700 }); await fs.writeFile(path.join(agents, "agent.md"), "---\nname: implement\ndescription: implement\n---\nInstructions", { mode: 0o600 });
  const snapshot = getAgentDiscoverySnapshot(agents)!; const current = lineage(); const items = [{ agent: "implement", task: "first" }, { agent: "implement", task: "second" }];
  const request: DispatchCallAdmissionRequest = { parentSessionId, lineage: current, toolCallId: name, cwd: agents, mode, agentScope: "project", projectTrust: { parentSessionId, discoveryRootRealpath: snapshot.rootRealpath, snapshotDigest: snapshot.digest }, ...(mode === "parallel" ? { tasks: items } : { chain: items }) };
  const admitted = await admitDispatchCallInternal(request, rootDir); assert.equal(admitted.state, "admitted"); const ids = [...(admitted.delegationIds ?? [])];
  const finish = async (delegationId: string, index: number) => { await resolveDelegationInternal(rootDir, admitted.dispatchCallId!, delegationId, { lineage: current }); await reserveInitialInternal(rootDir, admitted.dispatchCallId!, delegationId, { lineage: current }); const started = await markSpawnStartedInternal(rootDir, admitted.dispatchCallId!, delegationId, "initial", { lineage: current }); await markDelegationReturnedInternal(rootDir, admitted.dispatchCallId!, delegationId, "success", `result:${index}`, { owner: started.owner!, ownerGeneration: started.ownerGeneration!, fencingGeneration: started.fencingGeneration!, spawnId: started.spawnId! }, { lineage: current }); };
  await finish(ids[0]!, 0);
  if (mode === "chain") { const next = await admitNextChainStepInternal(rootDir, admitted.dispatchCallId!, current); assert.equal(next.state, "admitted"); ids.push(next.delegationId!); await finish(ids[1]!, 1); } else { await finish(ids[1]!, 1); }
  assert.equal((await finalizeCallInternal(rootDir, admitted.dispatchCallId!)).state, "final");
  const actor = { parentSessionId, activeLineageId: current.activeLineageId, activeBranchAnchor: current.activeBranchAnchor }; const host = { scanActiveBranch: async () => [{ entryRef: "entry:tool-result", role: "toolResult" as const, parentSessionId, activeLineageId: current.activeLineageId, activeBranchAnchor: current.activeBranchAnchor, dispatchCallId: admitted.dispatchCallId!, proofRef: `proof:${admitted.dispatchCallId}`, toolCallId: name }], appendCustomMessage: async () => undefined };
  return { rootDir, callId: admitted.dispatchCallId!, actor, lineage: current, host, cleanup: () => fs.rm(rootDir, { recursive: true, force: true }) };
}

test("single delete uses durable plan→proof→release→request→prune→tombstone→complete and retains proof", async (t) => {
  const state = await setup("single-success"); t.after(state.cleanup);
  await querySubagentStatusInternal(state.rootDir, state.callId, state.lineage, undefined, { lineage: state.lineage, deliveryHostAdapter: state.host });
  const result = await requestDelegationDeleteInternal(state.rootDir, state.delegationId, state.actor, { lineage: state.lineage, deliveryHostAdapter: state.host });
  assert.equal(result.status, "completed", JSON.stringify(result));
  const events = await wal(state.rootDir, state.callId); const types = events.map((event) => event.type);
  const ordered = ["delegation_delete_planned", "call_aggregate_proof_created", "call_delegation_reference_released", "delegation_delete_requested", "delegation_private_deleted", "delegation_tombstone_written", "delegation_delete_completed"];
  for (let index = 1; index < ordered.length; index += 1) assert.ok(types.indexOf(ordered[index - 1]!) < types.indexOf(ordered[index]!), `${ordered[index - 1]} < ${ordered[index]}`);
  const plan = events.find((event) => event.type === "delegation_delete_planned")!;
  assert.deepEqual(Object.keys(plan.data).sort(), ["actorScopeTag", "delegationId", "deletedAt", "idHash", "objectKind", "proofRef", "referenceOrderDigest", "schemaVersion", "slotIndex", "status"]);
  assert.equal(plan.data.delegationId, state.delegationId); assert.equal(plan.data.slotIndex, 0); assert.equal(plan.data.proofRef, `proof:${state.callId}`); assert.equal(plan.data.objectKind, "delegation"); assert.equal(plan.data.schemaVersion, 1); assert.equal(plan.data.status, "deleted");
  assert.ok(types.indexOf("delegation_delete_requested") < types.indexOf("delegation_private_deleted"));
  assert.ok(types.indexOf("delegation_private_deleted") < types.indexOf("delegation_delete_completed"));
  assert.equal(await fs.stat(path.join(state.rootDir, "v2", "proofs", `${state.callId}.json`)).then(() => true).catch(() => false), true);
  assert.equal(await fs.stat(path.join(state.rootDir, "v2", "private", `${state.delegationId}.json`)).then(() => true).catch(() => false), false);
  const repeated = await requestDelegationDeleteInternal(state.rootDir, state.delegationId, state.actor, { lineage: state.lineage, deliveryHostAdapter: state.host }); assert.equal(repeated.status, "completed");
});

test("single blocker is WAL=0 and normal delivery can be observed before retry", async (t) => {
  const state = await setup("single-blocker"); t.after(state.cleanup);
  const before = await wal(state.rootDir, state.callId);
  const blocked = await requestDelegationDeleteInternal(state.rootDir, state.delegationId, state.actor, { lineage: state.lineage }); assert.equal(blocked.status, "rejected");
  assert.deepEqual(await wal(state.rootDir, state.callId), before);
  await querySubagentStatusInternal(state.rootDir, state.callId, state.lineage, undefined, { lineage: state.lineage, deliveryHostAdapter: state.host });
  const allowed = await requestDelegationDeleteInternal(state.rootDir, state.delegationId, state.actor, { lineage: state.lineage, deliveryHostAdapter: state.host }); assert.equal(allowed.status, "completed");
});

test("whole Call cleanup cascades in stable slot order and leaves only opaque tombstones", async (t) => {
  const state = await setup("whole-success"); t.after(state.cleanup);
  await querySubagentStatusInternal(state.rootDir, state.callId, state.lineage, undefined, { lineage: state.lineage, deliveryHostAdapter: state.host });
  const result = await requestCallCleanupInternal(state.rootDir, state.callId, state.actor, "explicit_delete", { lineage: state.lineage, deliveryHostAdapter: state.host }); assert.equal(result.status, "completed");
  const events = await wal(state.rootDir, state.callId); assert.ok(events.some((event) => event.type === "call_cleanup_requested")); assert.ok(events.some((event) => event.type === "cleanup_complete"));
  assert.equal(await fs.stat(path.join(state.rootDir, "v2", "proofs", `${state.callId}.json`)).then(() => true).catch(() => false), false);
  const tombstones = await fs.readdir(path.join(state.rootDir, "v2", "tombstones")); assert.equal(tombstones.length, 2);
  for (const file of tombstones) { const value = JSON.parse(await fs.readFile(path.join(state.rootDir, "v2", "tombstones", file), "utf8")); assert.deepEqual(Object.keys(value).sort(), ["actorScopeTag", "deletedAt", "idHash", "objectKind", "schemaVersion", "status"]); assert.equal(JSON.stringify(value).includes(state.callId), false); assert.equal(JSON.stringify(value).includes(state.delegationId), false); }
});

test("delete fails closed when actor secret is removed or tampered", async (t) => {
  const state = await setup("secret-fail-closed"); t.after(state.cleanup); const secret = cleanupActorSecretPath(state.rootDir);
  await fs.unlink(secret); const missing = await requestDelegationDeleteInternal(state.rootDir, state.delegationId, state.actor, { lineage: state.lineage, deliveryHostAdapter: state.host }); assert.equal(missing.status, "rejected");
  const state2 = await setup("secret-tamper"); t.after(state2.cleanup); await fs.chmod(cleanupActorSecretPath(state2.rootDir), 0o644); const tampered = await requestDelegationDeleteInternal(state2.rootDir, state2.delegationId, state2.actor, { lineage: state2.lineage, deliveryHostAdapter: state2.host }); assert.equal(tampered.status, "rejected");
});

test("retention records eligibility before reusing the cleanup lifecycle", async (t) => {
  const state = await setup("retention"); t.after(state.cleanup);
  await querySubagentStatusInternal(state.rootDir, state.callId, state.lineage, undefined, { lineage: state.lineage, deliveryHostAdapter: state.host });
  const result = await requestRetentionCleanupInternal(state.rootDir, state.callId, { lineage: state.lineage, now: () => new Date(Date.now() + 31 * 24 * 60 * 60 * 1000), deliveryHostAdapter: state.host });
  assert.equal(result.status, "completed"); assert.ok((await wal(state.rootDir, state.callId)).some((event) => event.type === "retention_eligible"));
});

test("tombstone GC uses the exact 30-day boundary and rejects symlink state", async (t) => {
  const state = await setup("tombstone-gc"); t.after(state.cleanup); await querySubagentStatusInternal(state.rootDir, state.callId, state.lineage, undefined, { lineage: state.lineage, deliveryHostAdapter: state.host }); assert.equal((await requestCallCleanupInternal(state.rootDir, state.callId, state.actor, "explicit_delete", { lineage: state.lineage, deliveryHostAdapter: state.host })).status, "completed");
  const directory = path.join(state.rootDir, "v2", "tombstones"); const files = await fs.readdir(directory); const at = new Date("2030-01-31T00:00:00.000Z");
  for (const file of files) { const value = JSON.parse(await fs.readFile(path.join(directory, file), "utf8")); value.deletedAt = new Date(at.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(); await fs.writeFile(path.join(directory, file), JSON.stringify(value), { mode: 0o600 }); }
  assert.equal((await gcCleanupTombstonesInternal(state.rootDir, at)).collected, 2);
});

test("delete preflight is strict read-only for a torn WAL", async (t) => {
  const state = await setup("torn-preflight"); t.after(state.cleanup); const file = path.join(state.rootDir, "v2", "wal", `${state.callId}.jsonl`); const before = await fs.readFile(file, "utf8");
  await fs.appendFile(file, "{torn"); const result = await requestCallCleanupInternal(state.rootDir, state.callId, state.actor, "explicit_delete", { lineage: state.lineage });
  assert.equal(result.status, "paused_integrity"); assert.equal(await fs.readFile(file, "utf8"), `${before}{torn`);
});

test("proof tamper fails before cleanup request and repeated tombstone verification is exact", async (t) => {
  const state = await setup("proof-tamper"); t.after(state.cleanup); await querySubagentStatusInternal(state.rootDir, state.callId, state.lineage, undefined, { lineage: state.lineage, deliveryHostAdapter: state.host });
  assert.equal((await requestDelegationDeleteInternal(state.rootDir, state.delegationId, state.actor, { lineage: state.lineage, deliveryHostAdapter: state.host })).status, "completed");
  const proof = path.join(state.rootDir, "v2", "proofs", `${state.callId}.json`); const value = JSON.parse(await fs.readFile(proof, "utf8")); value.outcome = "failure"; await fs.writeFile(proof, JSON.stringify(value), { mode: 0o600 });
  const before = await wal(state.rootDir, state.callId); const failed = await requestCallCleanupInternal(state.rootDir, state.callId, state.actor, "explicit_delete", { lineage: state.lineage, deliveryHostAdapter: state.host });
  assert.equal(failed.status, "paused_integrity"); assert.deepEqual(await wal(state.rootDir, state.callId), before);
});

test("cleanup cursor is durable and actor authentication is mandatory", async (t) => {
  const state = await setup("cursor-auth"); t.after(state.cleanup); const before = await wal(state.rootDir, state.callId);
  assert.equal((await requestCallCleanupInternal(state.rootDir, state.callId, state.actor, "explicit_delete", {})).status, "rejected"); assert.deepEqual(await wal(state.rootDir, state.callId), before);
  const result = await requestCallCleanupInternal(state.rootDir, state.callId, state.actor, "explicit_delete", { lineage: state.lineage, deliveryHostAdapter: state.host }); assert.equal(result.status, "completed");
  const events = await wal(state.rootDir, state.callId); assert.equal(events.filter((event) => event.type === "cleanup_cursor_advanced").length, 1); assert.equal(events.filter((event) => event.type === "call_cleanup_requested").length, 1);
});

test("startup cleanup requires matching parent and lineage before it can resume an authenticated plan", async (t) => {
  const cases: Array<[string, ActiveLineage | undefined]> = [
    ["missing-lineage", undefined],
    ["different-parent", { ...lineage(), parentSessionId: "other-parent" }],
    ["sibling-fork-same-anchor", { ...lineage(), activeLineageId: "sibling-lineage" }],
  ];
  for (const [name, wrongLineage] of cases) {
    const state = await setup(`startup-lineage-${name}`); t.after(state.cleanup);
    await querySubagentStatusInternal(state.rootDir, state.callId, state.lineage, undefined, { lineage: state.lineage, deliveryHostAdapter: state.host });
    const first = await requestCallCleanupInternal(state.rootDir, state.callId, state.actor, "explicit_delete", { lineage: state.lineage, deliveryHostAdapter: state.host, fault: async (point) => { if (point === "after:call_cleanup_requested") throw new Error("kill:request"); } });
    assert.equal(first.status, "paused_integrity", name);
    const before = await snapshotFiles(state.rootDir);
    const resumed = wrongLineage ? await reconcileCleanupStartupInternal(state.rootDir, { lineage: wrongLineage }) : await reconcileCleanupStartupInternal(state.rootDir);
    assert.equal(resumed.resumed, 0, name);
    assert.deepEqual(await snapshotFiles(state.rootDir), before, `${name} must not change WAL, private files, or cleanup cursor`);
    const matched = await reconcileCleanupStartupInternal(state.rootDir, { lineage: state.lineage, deliveryHostAdapter: state.host });
    assert.ok(matched.resumed >= 1, name);
  }
});

test("parallel and chain whole cleanup preserve slot and cursor order", async (t) => {
  for (const mode of ["parallel", "chain"] as const) {
    const state = await setupMode(`order-${mode}`, mode); t.after(state.cleanup);
    await querySubagentStatusInternal(state.rootDir, state.callId, state.lineage, undefined, { lineage: state.lineage, deliveryHostAdapter: state.host });
    assert.equal((await requestCallCleanupInternal(state.rootDir, state.callId, state.actor, "explicit_delete", { lineage: state.lineage, deliveryHostAdapter: state.host })).status, "completed");
    const events = await wal(state.rootDir, state.callId);
    assert.deepEqual(events.filter((event) => event.type === "call_delegation_reference_released").map((event) => event.data.slotIndex), [0, 1]);
    assert.deepEqual(events.filter((event) => event.type === "cleanup_cursor_advanced").map((event) => event.data.slotIndex), [0, 1]);
    assert.deepEqual(events.filter((event) => event.type === "delegation_delete_requested").map((event) => event.delegationId), events.filter((event) => event.type === "call_delegation_reference_released").map((event) => event.delegationId));
  }
});

test("single cleanup resumes every durable kill point from startup and preserves the planned tombstone", async (t) => {
  const points = ["after:delegation_delete_planned", "after:call_aggregate_proof_created", "after:call_delegation_reference_released", "after:delegation_delete_requested", "after:delegation_prune", "after:delegation_private_deleted", "after:delegation_tombstone_file", "after:delegation_delete_completed"];
  for (const point of points) {
    const state = await setup(`single-kill-${point.replaceAll(":", "-")}`); t.after(state.cleanup);
    await querySubagentStatusInternal(state.rootDir, state.callId, state.lineage, undefined, { lineage: state.lineage, deliveryHostAdapter: state.host });
    let tripped = false;
    const fault = async (actual: string) => { if (!tripped && actual === point) { tripped = true; throw new Error(`kill:${point}`); } };
    const first = await requestDelegationDeleteInternal(state.rootDir, state.delegationId, state.actor, { lineage: state.lineage, deliveryHostAdapter: state.host, fault });
    assert.notEqual(first.status, "completed", point);
    const tombstoneDirectory = path.join(state.rootDir, "v2", "tombstones");
    if (point === "after:delegation_delete_planned") {
      const beforeLateAction = await wal(state.rootDir, state.callId);
      await reserveInitialInternal(state.rootDir, state.callId, state.delegationId, { lineage: state.lineage });
      assert.deepEqual(await wal(state.rootDir, state.callId), beforeLateAction, "late execution action must not append after plan");
    }
    if (point === "after:delegation_tombstone_file") {
      const files = await fs.readdir(path.join(state.rootDir, "v2", "tombstones")); assert.equal(files.length, 1);
      const before = await fs.readFile(path.join(state.rootDir, "v2", "tombstones", files[0]!));
      const resumed = await reconcileCleanupStartupInternal(state.rootDir, { lineage: state.lineage });
      assert.ok(resumed.resumed >= 1, point); assert.ok((await wal(state.rootDir, state.callId)).some((event) => event.type === "delegation_delete_completed")); assert.deepEqual(await fs.readFile(path.join(state.rootDir, "v2", "tombstones", files[0]!)), before);
    } else {
      const resumed = await reconcileCleanupStartupInternal(state.rootDir, { lineage: state.lineage });
      assert.ok(resumed.resumed >= 1, point);
    }
    const events = await wal(state.rootDir, state.callId);
    assert.equal(events.filter((event) => event.type === "delegation_delete_requested").length, 1, point);
    assert.equal(events.filter((event) => event.type === "delegation_delete_completed").length, 1, point);
    const tombstones = await fs.readdir(tombstoneDirectory); assert.equal(tombstones.length, 1, point);
    assert.equal(await fs.stat(path.join(tombstoneDirectory, tombstones[0]!)).then(() => true).catch(() => false), true);
  }
});

test("whole Call cleanup resumes request, release, delete, cursor, proof, private, tombstone and completion kills", async (t) => {
  const points = ["after:call_cleanup_requested", "after:call_delegation_reference_released", "after:delegation_delete_requested", "after:delegation_private_deleted", "after:delegation_tombstone_file", "after:delegation_delete_completed", "after:cleanup_cursor_advanced", "after:call_private_deleted", "after:call_proof_deleted", "after:call_tombstone_file", "after:cleanup_complete"];
  for (const point of points) {
    const state = await setup(`whole-kill-${point.replaceAll(":", "-")}`); t.after(state.cleanup);
    await querySubagentStatusInternal(state.rootDir, state.callId, state.lineage, undefined, { lineage: state.lineage, deliveryHostAdapter: state.host });
    let tripped = false;
    const first = await requestCallCleanupInternal(state.rootDir, state.callId, state.actor, "explicit_delete", { lineage: state.lineage, deliveryHostAdapter: state.host, fault: async (actual) => { if (!tripped && actual === point) { tripped = true; throw new Error(`kill:${point}`); } } });
    assert.notEqual(first.status, "completed", point);
    const startup = await reconcileCleanupStartupInternal(state.rootDir, { lineage: state.lineage });
    assert.ok(startup.resumed >= 1, point);
    const final = await requestCallCleanupInternal(state.rootDir, state.callId, state.actor, "explicit_delete", { lineage: state.lineage, deliveryHostAdapter: state.host });
    assert.equal(final.status, "completed", JSON.stringify({ point, final }));
    const events = await wal(state.rootDir, state.callId);
    assert.equal(events.filter((event) => event.type === "call_cleanup_requested").length, 1, point);
    assert.equal(events.filter((event) => event.type === "cleanup_cursor_advanced").length, 1, point);
    assert.equal(events.filter((event) => event.type === "cleanup_complete").length, 1, point);
  }
});

test("orphan cleanup rejects live references, resumes after request, and whole Call treats orphan completion as terminal", async (t) => {
  const live = await setup("orphan-live"); t.after(live.cleanup);
  const liveResult = await cleanupOrphanDelegationInternal(live.rootDir, live.delegationId, live.actor, { lineage: live.lineage });
  assert.equal(liveResult.status, "rejected"); assert.equal((await wal(live.rootDir, live.callId)).some((event) => event.type === "delegation_cleanup_requested"), false);

  const state = await setup("orphan-resume"); t.after(state.cleanup);
  await querySubagentStatusInternal(state.rootDir, state.callId, state.lineage, undefined, { lineage: state.lineage, deliveryHostAdapter: state.host });
  let tripped = false;
  const released = await requestDelegationDeleteInternal(state.rootDir, state.delegationId, state.actor, { lineage: state.lineage, deliveryHostAdapter: state.host, fault: async (point) => { if (!tripped && point === "after:call_delegation_reference_released") { tripped = true; throw new Error("kill:release"); } } });
  assert.equal(released.status, "paused_integrity");
  const startup = await reconcileCleanupStartupInternal(state.rootDir, { lineage: state.lineage }); assert.ok(startup.resumed >= 1);
  assert.ok((await wal(state.rootDir, state.callId)).some((event) => event.type === "delegation_delete_completed"));
  const beforeWhole = await wal(state.rootDir, state.callId);
  const whole = await requestCallCleanupInternal(state.rootDir, state.callId, state.actor, "explicit_delete", { lineage: state.lineage, deliveryHostAdapter: state.host });
  assert.equal(whole.status, "completed", JSON.stringify(whole));
  const afterWhole = await wal(state.rootDir, state.callId);
  assert.equal(afterWhole.filter((event) => event.type === "delegation_delete_requested").length, beforeWhole.filter((event) => event.type === "delegation_delete_requested").length);
  assert.equal(afterWhole.filter((event) => event.type === "cleanup_cursor_advanced").length, 1);
});

test("persistent:false cleanup removes action-adjacent private payloads without reviving the delegation", async (t) => {
  const state = await setup("ephemeral-cleanup", false); t.after(state.cleanup);
  await querySubagentStatusInternal(state.rootDir, state.callId, state.lineage, undefined, { lineage: state.lineage, deliveryHostAdapter: state.host });
  assert.equal((await requestDelegationDeleteInternal(state.rootDir, state.delegationId, state.actor, { lineage: state.lineage, deliveryHostAdapter: state.host })).status, "completed");
  const privateDir = path.join(state.rootDir, "v2", "private");
  assert.equal((await fs.readdir(privateDir)).some((file) => file === `${state.delegationId}.json`), false);
  assert.equal((await wal(state.rootDir, state.callId)).filter((event) => event.type === "delegation_delete_requested").length, 1);
});

test("cleanup authenticates the latest lineage after waiting for the Call lock", async (t) => {
  const state = await setup("lock-lineage-race"); t.after(state.cleanup);
  const before = await snapshotFiles(state.rootDir); const beforeWal = await wal(state.rootDir, state.callId);
  let entered!: () => void; let release!: () => void;
  const held = withCallLock(state.rootDir, state.callId, async () => { await new Promise<void>((resolve) => { entered = resolve; }); await new Promise<void>((resolve) => { release = resolve; }); return true; });
  await new Promise<void>((resolve) => { const check = () => entered ? (entered(), resolve()) : setImmediate(check); check(); });
  const deps: any = { lineage: state.lineage, cleanupBarrier: async () => { deps.lineage = { ...state.lineage, activeLineageId: "changed-lineage", activeBranchAnchor: "changed-branch", currentLeafId: "changed-branch", branchIds: ["changed-branch"] }; } };
  const pending = requestDelegationDeleteInternal(state.rootDir, state.delegationId, state.actor, deps);
  await new Promise((resolve) => setImmediate(resolve)); release(); await held;
  const result = await pending;
  assert.equal(result.status, "rejected"); assert.deepEqual(await wal(state.rootDir, state.callId), beforeWal); assert.deepEqual(await snapshotFiles(state.rootDir), before);
});

test("cleanup authenticates the latest owner-only Call binding after waiting for the Call lock", async (t) => {
  const state = await setup("lock-private-race"); t.after(state.cleanup);
  const beforeWal = await wal(state.rootDir, state.callId); const privateRef = String(beforeWal.find((event) => event.type === "call_admitted")?.data.privatePayloadRef).slice("private:".length); const privateFile = path.join(state.rootDir, "v2", "private", `${privateRef}.json`);
  let entered!: () => void; let release!: () => void;
  const held = withCallLock(state.rootDir, state.callId, async () => { await new Promise<void>((resolve) => { entered = resolve; }); await new Promise<void>((resolve) => { release = resolve; }); return true; });
  await new Promise<void>((resolve) => { const check = () => entered ? (entered(), resolve()) : setImmediate(check); check(); });
  const deps: any = { lineage: state.lineage, cleanupBarrier: async () => { const value = JSON.parse(await fs.readFile(privateFile, "utf8")); value.toolCallId = "tampered-after-preflight"; await fs.writeFile(privateFile, JSON.stringify(value), { mode: 0o600 }); } };
  const pending = requestCallCleanupInternal(state.rootDir, state.callId, state.actor, "explicit_delete", deps);
  await new Promise((resolve) => setImmediate(resolve)); release(); await held;
  const result = await pending;
  assert.equal(result.status, "rejected"); assert.deepEqual(await wal(state.rootDir, state.callId), beforeWal); assert.equal(await fs.stat(privateFile).then(() => true).catch(() => false), true);
});
