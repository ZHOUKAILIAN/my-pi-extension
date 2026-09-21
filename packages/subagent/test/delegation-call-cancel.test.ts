import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDiscoverySnapshot } from "../src/agents.ts";
import {
  admitDispatchCallInternal, admitNextChainStepInternal, markDelegationReturnedInternal,
  markSpawnStartedInternal, normalizeStartupInternal, readDelegationInternal, readDispatchCallInternal,
  reconcileCallCancellationInternal, requestCallCancelInternal, requestDelegationCancelScopedInternal,
  resolveDelegationInternal, reserveInitialInternal,
} from "../src/delegation-internal.ts";
import type { ActiveLineage } from "../src/lineage.ts";
import type { DispatchCallAdmissionRequest, OwnerIdentity } from "../src/delegation.ts";

const parentSessionId = "call-cancel-parent";
const lineage: ActiveLineage = { parentSessionId, activeLineageId: "call-cancel-lineage", activeBranchAnchor: "call-cancel-anchor", currentLeafId: "call-cancel-anchor", branchIds: ["root", "call-cancel-anchor"], persistence: "in_process_only" };
const actor = { parentSessionId, activeLineageId: lineage.activeLineageId, activeBranchAnchor: lineage.activeBranchAnchor };
const definition = "---\nname: implement\ndescription: implement\n---\nInstructions";

function owner(birth: string): OwnerIdentity { return { host: os.hostname(), pid: process.pid, birth, parentSessionId, parentSessionPath: "/tmp/call-cancel-parent", argvProof: createHash("sha256").update(birth).digest("hex") }; }
async function setup(mode: "single" | "parallel" | "chain", toolCallId: string, failPoint?: string) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-call-cancel-"));
  const project = path.join(rootDir, "agents"); await fs.mkdir(project, { recursive: true, mode: 0o755 }); await fs.writeFile(path.join(project, "agent.md"), definition, { mode: 0o644 });
  const snapshot = getAgentDiscoverySnapshot(project)!; const projectTrust = { parentSessionId, discoveryRootRealpath: snapshot.rootRealpath, snapshotDigest: snapshot.digest };
  const item = (task: string) => ({ agent: "implement", task });
  const request: DispatchCallAdmissionRequest = { parentSessionId, lineage, toolCallId, cwd: project, mode, agentScope: "project", projectTrust, ...(mode === "single" ? { single: item("single") } : mode === "parallel" ? { tasks: [item("one"), item("two"), item("three")] } : { chain: [item("one"), item("two"), item("three")] }) };
  let remaining = failPoint ? 2 : 0;
  const admitted = await admitDispatchCallInternal(request, rootDir, failPoint ? { fault: (point) => { if (point === failPoint && --remaining === 0) throw new Error(`kill ${point}`); } } : undefined).catch(() => undefined);
  if (admitted) return { rootDir, project, callId: admitted.dispatchCallId!, delegationIds: admitted.delegationIds ?? [], cleanup: () => fs.rm(rootDir, { recursive: true, force: true }) };
  if (failPoint) { const files = (await fs.readdir(path.join(rootDir, "v2", "wal"))).filter((name) => name.endsWith(".jsonl")); const callId = files[0]!.slice(0, -6); const view = await readDispatchCallInternal(rootDir, callId); return { rootDir, project, callId, delegationIds: view?.slots.flatMap((slot) => slot.delegationId ? [slot.delegationId] : []), cleanup: () => fs.rm(rootDir, { recursive: true, force: true }) }; }
  const repaired = await admitDispatchCallInternal(request, rootDir);
  return { rootDir, project, callId: repaired.dispatchCallId!, delegationIds: repaired.delegationIds ?? [], cleanup: () => fs.rm(rootDir, { recursive: true, force: true }) };
}
async function wal(rootDir: string, callId: string): Promise<any[]> { return (await fs.readFile(path.join(rootDir, "v2", "wal", `${callId}.jsonl`), "utf8")).trim().split("\n").map(JSON.parse); }
async function resolveAndReturn(state: Awaited<ReturnType<typeof setup>>, id: string, ref: string) {
  assert.equal((await resolveDelegationInternal(state.rootDir, state.callId, id, { lineage })).state, "resolved");
  const reserved = await reserveInitialInternal(state.rootDir, state.callId, id, { lineage, owner: owner(`owner-${id}`) }); assert.equal(reserved.state, "reserved");
  const started = await markSpawnStartedInternal(state.rootDir, state.callId, id, "initial", { lineage, owner: owner(`owner-${id}`) });
  assert.equal(started.state, "initial_running");
  const returned = await markDelegationReturnedInternal(state.rootDir, state.callId, id, "success", ref, { owner: started.owner!, ownerGeneration: started.ownerGeneration!, fencingGeneration: started.fencingGeneration!, spawnId: started.spawnId! }, { lineage });
  assert.equal(returned.state, "returned");
}

test("single pre-spawn call cancel finalizes cancelled proof without raw result", async () => {
  const state = await setup("single", "single-call-cancel");
  try {
    const receipt = await requestCallCancelInternal(state.rootDir, state.callId, actor, { lineage });
    assert.equal(receipt.status, "requested");
    const call = await readDispatchCallInternal(state.rootDir, state.callId);
    assert.equal(call?.state, "final"); assert.equal(call?.finalOutcome, "cancelled");
    assert.equal((await readDelegationInternal(state.rootDir, state.callId, state.delegationIds[0]!))?.state, "cancelled");
    const proof = JSON.parse(await fs.readFile(path.join(state.rootDir, "v2", "proofs", `${state.callId}.json`), "utf8"));
    assert.equal(proof.outcome, "cancelled"); assert.equal(proof.slots[0].cancelSettlement, "admitted_cancelled"); assert.equal(JSON.stringify(proof).includes("Instructions"), false);
    assert.equal((await requestCallCancelInternal(state.rootDir, state.callId, actor, { lineage })).status, "completed");
  } finally { await state.cleanup(); }
});

test("parallel call cancel mixes returned, admitted-cancelled, and not-admitted in stable order", async () => {
  const state = await setup("parallel", "parallel-three", "after:delegation_admitted");
  try {
    const first = state.delegationIds[0]!; await resolveAndReturn(state, first, "safe:return");
    const receipt = await requestCallCancelInternal(state.rootDir, state.callId, actor, { lineage }); assert.equal(receipt.scope, "call");
    const view = await readDispatchCallInternal(state.rootDir, state.callId);
    assert.equal(view?.state, "final"); assert.equal(view?.finalOutcome, "cancelled");
    assert.deepEqual(view?.slots.map((slot) => [slot.index, slot.state, slot.cancelSettlement]), [[0, "returned", "returned_before_call_cancel"], [1, "cancelled", "admitted_cancelled"], [2, "not_admitted_due_to_call_cancel", "not_admitted_due_to_call_cancel"]]);
    const events = await wal(state.rootDir, state.callId); assert.equal(events.filter((event) => event.type === "returned_before_call_cancel").length, 1); assert.equal(events.filter((event) => event.type === "call_cancel_admitted_cancelled").length, 1); assert.equal(events.filter((event) => event.type === "not_admitted_due_to_call_cancel").length, 1);
    assert.equal(events.some((event) => event.type === "delegation_admitted" && event.data.slotIndex === 2), false);
  } finally { await state.cleanup(); }
});

test("chain current cancellation settles every future required slot and permanently rejects advance", async () => {
  const state = await setup("chain", "chain-call-cancel");
  try {
    const current = state.delegationIds[0]!; const receipt = await requestCallCancelInternal(state.rootDir, state.callId, actor, { lineage }); assert.equal(receipt.scope, "call");
    const view = await readDispatchCallInternal(state.rootDir, state.callId); assert.equal(view?.state, "final"); assert.equal(view?.finalOutcome, "cancelled");
    assert.deepEqual(view?.slots.map((slot) => slot.cancelSettlement), ["admitted_cancelled", "not_admitted_due_to_call_cancel", "not_admitted_due_to_call_cancel"]);
    assert.equal((await admitNextChainStepInternal(state.rootDir, state.callId, lineage)).state, "rejected");
    assert.equal((await resolveDelegationInternal(state.rootDir, state.callId, current, { lineage })).state, "rejected");
  } finally { await state.cleanup(); }
});

test("return/cancel race is linearized and a late return cannot rewrite cancelled slot", async () => {
  const state = await setup("single", "return-cancel-race");
  try {
    const id = state.delegationIds[0]!; assert.equal((await resolveDelegationInternal(state.rootDir, state.callId, id, { lineage })).state, "resolved"); const o = owner("race-owner"); const reserved = await reserveInitialInternal(state.rootDir, state.callId, id, { lineage, owner: o }); const started = await markSpawnStartedInternal(state.rootDir, state.callId, id, "initial", { lineage, owner: o }); const claim = { owner: started.owner!, ownerGeneration: started.ownerGeneration!, fencingGeneration: started.fencingGeneration!, spawnId: started.spawnId! };
    const [cancel, returned] = await Promise.all([requestCallCancelInternal(state.rootDir, state.callId, actor, { lineage }), markDelegationReturnedInternal(state.rootDir, state.callId, id, "success", "race:return", claim, { lineage })]);
    assert.ok(cancel.status === "requested" || cancel.status === "already_requested"); assert.ok(returned.state === "returned" || returned.state === "rejected");
    const events = await wal(state.rootDir, state.callId); assert.ok(events.filter((event) => event.type === "delegation_returned").length <= 1); assert.equal(events.filter((event) => event.type === "returned_before_call_cancel").length + events.filter((event) => event.type === "call_cancel_admitted_cancelled").length, 1);
    const final = await readDispatchCallInternal(state.rootDir, state.callId); assert.equal(final?.finalOutcome, "cancelled");
  } finally { await state.cleanup(); }
});

test("call cancellation freezes resolution, reserve, spawn, continuation and late return", async () => {
  const state = await setup("single", "late-actions");
  try {
    const id = state.delegationIds[0]!; assert.equal((await requestCallCancelInternal(state.rootDir, state.callId, actor, { lineage })).status, "requested");
    assert.equal((await resolveDelegationInternal(state.rootDir, state.callId, id, { lineage })).state, "rejected"); assert.equal((await reserveInitialInternal(state.rootDir, state.callId, id, { lineage })).state, "rejected");
    const events = await wal(state.rootDir, state.callId); assert.equal(events.some((event) => ["delegation_resolving", "initial_reserved", "spawn_started", "delegation_returned"].includes(event.type)), false);
  } finally { await state.cleanup(); }
});

test("post-spawn call cancel remains non-final until post-spawn reconciliation exists", async () => {
  const state = await setup("single", "post-spawn-call-cancel");
  try {
    const id = state.delegationIds[0]!; assert.equal((await resolveDelegationInternal(state.rootDir, state.callId, id, { lineage })).state, "resolved"); const o = owner("live-child"); const reserved = await reserveInitialInternal(state.rootDir, state.callId, id, { lineage, owner: o }); assert.equal(reserved.state, "reserved", JSON.stringify(reserved)); const started = await markSpawnStartedInternal(state.rootDir, state.callId, id, "initial", { lineage, owner: o }); assert.equal(started.state, "initial_running", JSON.stringify(started));
    await requestCallCancelInternal(state.rootDir, state.callId, actor, { lineage }); assert.equal((await reconcileCallCancellationInternal(state.rootDir, state.callId)).call?.state, "cancel_requested"); assert.equal((await readDispatchCallInternal(state.rootDir, state.callId))?.finalOutcome, undefined);
  } finally { await state.cleanup(); }
});

test("call cancellation kill points replay without duplicate settlements", async () => {
  for (const point of ["after:returned_before_call_cancel", "after:call_cancel_admitted_cancelled", "after:not_admitted_due_to_call_cancel"]) {
    const state = await setup("parallel", `kill-${point}`, "after:delegation_admitted");
    try {
      await resolveAndReturn(state, state.delegationIds[0]!, "kill:return");
      await assert.rejects(() => requestCallCancelInternal(state.rootDir, state.callId, actor, { lineage, fault: (name) => { if (name === point) throw new Error(`kill ${point}`); } }));
      await normalizeStartupInternal(state.rootDir, lineage);
      const events = await wal(state.rootDir, state.callId); for (const type of ["returned_before_call_cancel", "call_cancel_admitted_cancelled", "not_admitted_due_to_call_cancel"]) assert.ok(events.filter((event) => event.type === type).length <= 1);
      assert.equal((await readDispatchCallInternal(state.rootDir, state.callId))?.finalOutcome, "cancelled");
    } finally { await state.cleanup(); }
  }
});

test("wrong index or contradictory duplicate call settlement quarantines the WAL", async () => {
  const state = await setup("single", "call-cancel-corruption");
  try {
    await requestCallCancelInternal(state.rootDir, state.callId, actor, { lineage }); const file = path.join(state.rootDir, "v2", "wal", `${state.callId}.jsonl`); const events = await wal(state.rootDir, state.callId); const prior = events.at(-1)!; const body = { version: 1, seq: prior.seq + 1, type: "not_admitted_due_to_call_cancel", callId: state.callId, data: { index: 99, cancelSeq: 1, settlement: "not_admitted_due_to_call_cancel" }, prevChecksum: prior.checksum }; const checksum = createHash("sha256").update(JSON.stringify(body)).digest("hex"); await fs.appendFile(file, `${JSON.stringify({ ...body, checksum })}\n`); const view = await readDispatchCallInternal(state.rootDir, state.callId); assert.equal(view?.state, "paused_integrity");
  } finally { await state.cleanup(); }
});
