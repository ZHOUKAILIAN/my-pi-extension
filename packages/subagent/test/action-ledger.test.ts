import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { getAgentDiscoverySnapshot } from "../src/agents.ts";
import {
  admitDispatchCallInternal, resolveDelegationInternal, reserveInitialInternal, reserveRecoveryCycleInternal,
  markSpawnStartedInternal, bindChildSessionInternal, reconcileRunningChildInternal, acceptContinuationInternal, requestDelegationCancelInternal, claimExecutionOwnerInternal,
  reconcileDelegationCancelInternal, readDelegationInternal, readDispatchCallInternal, beginActionIntentInternal, finishActionResultInternal,
  markDelegationReturnedInternal, replayActionPolicy, decideUncertaintyDispositionInternal, readActionLedgerInternal, stableIdempotencyKeyFor, actionIdFor, reconcilePrivateOrphans, finalizeCallInternal,
} from "../src/delegation-internal.ts";
import type { ActiveLineage } from "../src/lineage.ts";
import type { DispatchCallAdmissionRequest, OwnerIdentity } from "../src/delegation-internal.ts";
import { WAL_CONTEXT } from "../src/delegation-context.ts";
import { readWal, replay, WalCorruption } from "../src/wal-replay.ts";

const parentSessionId = "action-parent";
const lineage: ActiveLineage = { parentSessionId, activeLineageId: "action-lineage", activeBranchAnchor: "action-anchor", currentLeafId: "action-anchor", branchIds: ["root", "action-anchor"], persistence: "in_process_only" };
const actor = { parentSessionId, activeLineageId: lineage.activeLineageId, activeBranchAnchor: lineage.activeBranchAnchor };
const definition = "---\nname: implement\ndescription: implement\n---\nInstructions";
function owner(birth: string): OwnerIdentity { return { host: os.hostname(), pid: process.pid, birth, parentSessionId, parentSessionPath: "/tmp/action-parent", argvProof: createHash("sha256").update(birth).digest("hex") }; }
function child(birth: string) { return { host: os.hostname(), pid: process.pid + 100, birth, sessionPathHash: createHash("sha256").update(birth).digest("hex").slice(0, 32), argvProof: createHash("sha256").update(`argv:${birth}`).digest("hex") }; }
async function setup(name: string) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), `subagent-action-${name}-`)); const project = path.join(rootDir, "agents"); await fs.mkdir(project, { recursive: true }); await fs.writeFile(path.join(project, "agent.md"), definition);
  const snapshot = getAgentDiscoverySnapshot(project)!; const request: DispatchCallAdmissionRequest = { parentSessionId, lineage, toolCallId: name, cwd: project, mode: "single", agentScope: "project", projectTrust: { parentSessionId, discoveryRootRealpath: snapshot.rootRealpath, snapshotDigest: snapshot.digest }, single: { agent: "implement", task: "action test" } };
  const admitted = await admitDispatchCallInternal(request, rootDir); const callId = admitted.dispatchCallId!; const delegationId = admitted.delegationIds![0]!; await resolveDelegationInternal(rootDir, callId, delegationId, { lineage }); const executionOwner = owner(`${name}-owner`); await reserveInitialInternal(rootDir, callId, delegationId, { lineage, owner: executionOwner }); const started = await markSpawnStartedInternal(rootDir, callId, delegationId, "initial", { lineage, owner: executionOwner }); assert.equal(started.state, "initial_running"); const claim = { owner: started.owner!, ownerGeneration: started.ownerGeneration!, fencingGeneration: started.fencingGeneration!, spawnId: started.spawnId! };
  return { rootDir, callId, delegationId, claim, cleanup: () => fs.rm(rootDir, { recursive: true, force: true }) };
}

async function appendForgedWal(rootDir: string, callId: string, type: string, delegationId: string | undefined, data: Record<string, unknown>): Promise<void> {
  const file = path.join(rootDir, "v2", "wal", `${callId}.jsonl`);
  const events = (await fs.readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { seq: number; checksum: string });
  const previous = events.at(-1)!;
  const body = { version: 1 as const, seq: previous.seq + 1, type, callId, ...(delegationId ? { delegationId } : {}), data, prevChecksum: previous.checksum };
  const checksum = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  await fs.appendFile(file, `${JSON.stringify({ ...body, checksum })}\n`);
}

test("action intent is durable before handler and result ACK failure becomes unknown", async () => {
  const state = await setup("ack-order"); try {
    const seen: string[] = []; const intent = await beginActionIntentInternal(state.rootDir, state.callId, state.delegationId, state.claim, { executionScope: `scope:${state.delegationId}`, toolCallOrdinal: 0, logicalCheckpoint: "checkpoint:0", finalToolName: "writeFile", finalArgs: { b: 2, a: 1 }, policy: "fenced_mutating" }, { lineage });
    assert.equal(intent.handler, 1); seen.push("intent-acked"); assert.deepEqual((await readActionLedgerInternal(state.rootDir, state.callId))?.map((item) => item.status), ["intent_acked"]);
    let watchdog = 0; const result = await finishActionResultInternal(state.rootDir, state.callId, state.delegationId, state.claim, { actionId: intent.actionId!, resultRef: "result:unknown", resultType: "tool", status: "success" }, { lineage, watchdogTerminate: async () => { watchdog += 1; }, fault: (point) => { if (point === "before:action_result_acked") throw new Error("durability failure"); } });
    assert.equal(result.state, "unknown"); assert.equal(watchdog, 1); assert.deepEqual((await readActionLedgerInternal(state.rootDir, state.callId))?.map((item) => item.status), ["unknown"]); assert.equal(seen[0], "intent-acked");
    const replay = replayActionPolicy((await readActionLedgerInternal(state.rootDir, state.callId))![0]!, { idempotent: true, stableIdempotencyKey: stableIdempotencyKeyFor(intent.logicalActionId!), externalSystemSupportsKey: true }); assert.equal(replay.retry, "same-key-eligible");
  } finally { await state.cleanup(); }
});

test("WAL replay rejects terminal events with intent, unknown, or still-unknown actions", async () => {
  for (const terminalType of ["execution_outcome_captured", "delegation_returned"] as const) {
    for (const status of ["intent_acked", "unknown", "still_unknown"] as const) {
      const state = await setup(`terminal-${terminalType}-${status}`);
      try {
        const intent = await beginActionIntentInternal(state.rootDir, state.callId, state.delegationId, state.claim, {
          executionScope: `scope:${status}`, toolCallOrdinal: 0, logicalCheckpoint: `checkpoint:${status}`, finalToolName: "publish", finalArgs: { status }, policy: "fenced_mutating",
        }, { lineage });
        assert.equal(intent.state, "allowed");
        if (status !== "intent_acked") {
          await finishActionResultInternal(state.rootDir, state.callId, state.delegationId, state.claim, { logicalActionId: intent.logicalActionId!, resultRef: `result:${status}`, resultType: "tool", status: "success" }, { lineage, fault: (point) => { if (point === "before:action_result_acked") throw new Error("result ACK unavailable"); } });
        }
        if (status === "still_unknown") {
          assert.equal((await decideUncertaintyDispositionInternal(state.rootDir, state.callId, state.delegationId, intent.logicalActionId!, "still_unknown", actor, { lineage })).state, "decided");
        }
        const terminalData = terminalType === "execution_outcome_captured"
          ? { outcome: "success", resultRef: "result:forged-terminal", failureKind: "success", spawnId: state.claim.spawnId, fencingGeneration: state.claim.fencingGeneration, ownerGeneration: state.claim.ownerGeneration }
          : { outcome: "success", resultRef: "result:forged-terminal", spawnId: state.claim.spawnId, fencingGeneration: state.claim.fencingGeneration, ownerGeneration: state.claim.ownerGeneration };
        await appendForgedWal(state.rootDir, state.callId, terminalType, state.delegationId, terminalData);
        const loaded = await readWal(path.join(state.rootDir, "v2", "wal", `${state.callId}.jsonl`), WAL_CONTEXT);
        assert.throws(() => replay(loaded.events, state.callId, WAL_CONTEXT), (error) => error instanceof WalCorruption);
        const call = await readDispatchCallInternal(state.rootDir, state.callId);
        assert.equal(call?.state, "paused_integrity");
        assert.equal((await readDelegationInternal(state.rootDir, state.callId, state.delegationId)), undefined);
        const projection = JSON.parse(await fs.readFile(path.join(state.rootDir, "v2", "calls", `${state.callId}.json`), "utf8")) as { state: string };
        assert.notEqual(projection.state, "final");
        const delegationProjection = JSON.parse(await fs.readFile(path.join(state.rootDir, "v2", "delegations", `${state.delegationId}.json`), "utf8")) as { state: string };
        assert.notEqual(delegationProjection.state, "returned");
        assert.equal(await fs.stat(path.join(state.rootDir, "v2", "proofs", `${state.callId}.json`)).then(() => true).catch(() => false), false);
      } finally { await state.cleanup(); }
    }
  }
});

test("Call finalization also rejects an unresolved action at replay authority", async () => {
  const state = await setup("final-unresolved-action");
  try {
    const intent = await beginActionIntentInternal(state.rootDir, state.callId, state.delegationId, state.claim, { executionScope: "scope:final", toolCallOrdinal: 0, logicalCheckpoint: "checkpoint:final", finalToolName: "publish", finalArgs: { final: true }, policy: "fenced_mutating" }, { lineage });
    assert.equal(intent.state, "allowed");
    await appendForgedWal(state.rootDir, state.callId, "call_finalized", undefined, { outcome: "success", finalizedAt: new Date().toISOString() });
    const loaded = await readWal(path.join(state.rootDir, "v2", "wal", `${state.callId}.jsonl`), WAL_CONTEXT);
    assert.throws(() => replay(loaded.events, state.callId, WAL_CONTEXT), (error) => error instanceof WalCorruption);
    assert.equal((await readDispatchCallInternal(state.rootDir, state.callId))?.state, "paused_integrity");
    assert.equal(await fs.stat(path.join(state.rootDir, "v2", "proofs", `${state.callId}.json`)).then(() => true).catch(() => false), false);
  } finally { await state.cleanup(); }
});

test("result-acked and confirmed-succeeded actions still permit normal return", async () => {
  const committed = await setup("terminal-result-acked");
  try {
    const intent = await beginActionIntentInternal(committed.rootDir, committed.callId, committed.delegationId, committed.claim, { executionScope: "scope:result-acked", toolCallOrdinal: 0, logicalCheckpoint: "checkpoint:result-acked", finalToolName: "publish", finalArgs: { ok: true }, policy: "fenced_mutating" }, { lineage });
    assert.equal((await finishActionResultInternal(committed.rootDir, committed.callId, committed.delegationId, committed.claim, { logicalActionId: intent.logicalActionId!, resultRef: "result:acked", resultType: "tool", status: "success" }, { lineage })).state, "result_acked");
    assert.equal((await markDelegationReturnedInternal(committed.rootDir, committed.callId, committed.delegationId, "success", "result:return-acked", committed.claim, { lineage })).state, "returned");
    assert.equal((await readDelegationInternal(committed.rootDir, committed.callId, committed.delegationId))?.state, "returned");
  } finally { await committed.cleanup(); }

  const confirmed = await setup("terminal-confirmed-succeeded");
  try {
    const identity = child("terminal-confirmed-child");
    assert.equal((await bindChildSessionInternal(confirmed.rootDir, confirmed.callId, confirmed.delegationId, confirmed.claim, "child", undefined, identity.pid, { lineage, childIdentity: identity })).state, "bound");
    const intent = await beginActionIntentInternal(confirmed.rootDir, confirmed.callId, confirmed.delegationId, confirmed.claim, { executionScope: "scope:confirmed", toolCallOrdinal: 0, logicalCheckpoint: "checkpoint:confirmed", finalToolName: "publish", finalArgs: { ok: true }, policy: "fenced_mutating" }, { lineage });
    await finishActionResultInternal(confirmed.rootDir, confirmed.callId, confirmed.delegationId, confirmed.claim, { logicalActionId: intent.logicalActionId!, resultRef: "result:unknown-confirmed", resultType: "tool", status: "success" }, { lineage, fault: (point) => { if (point === "before:action_result_acked") throw new Error("result ACK unavailable"); } });
    assert.equal((await decideUncertaintyDispositionInternal(confirmed.rootDir, confirmed.callId, confirmed.delegationId, intent.logicalActionId!, "confirmed_succeeded", actor, { lineage })).state, "decided");
    assert.equal((await readDelegationInternal(confirmed.rootDir, confirmed.callId, confirmed.delegationId))?.state, "reattach_only");
    assert.equal((await markDelegationReturnedInternal(confirmed.rootDir, confirmed.callId, confirmed.delegationId, "success", "result:return-confirmed", confirmed.claim, { lineage })).state, "returned");
    assert.equal((await readDelegationInternal(confirmed.rootDir, confirmed.callId, confirmed.delegationId))?.state, "returned");
  } finally { await confirmed.cleanup(); }
});

test("logical action identity excludes replacement coordinates but separates ordinal and checkpoint", () => {
  const base = { delegationId: "delegation", executionScope: "scope:one", reservationId: "reservation:one", continuationEpoch: 0, fencingGeneration: 0, toolCallOrdinal: 2, logicalCheckpoint: "checkpoint:2", finalToolName: "writeFile", canonicalArgsDigest: "a".repeat(64) };
  const replacement = { ...base, executionScope: "scope:two", reservationId: "reservation:two", continuationEpoch: 9, fencingGeneration: 4 };
  assert.equal(actionIdFor(base), actionIdFor(replacement));
  assert.equal(stableIdempotencyKeyFor(actionIdFor(base)), stableIdempotencyKeyFor(actionIdFor(replacement)));
  assert.notEqual(actionIdFor(base), actionIdFor({ ...base, toolCallOrdinal: 3 }));
  assert.notEqual(actionIdFor(base), actionIdFor({ ...base, logicalCheckpoint: "checkpoint:3" }));
});

test("private result remains referenced after an after-write fault and orphan scan", async () => {
  const state = await setup("private-after-write"); try {
    const intent = await beginActionIntentInternal(state.rootDir, state.callId, state.delegationId, state.claim, { executionScope: `scope:${state.delegationId}`, toolCallOrdinal: 0, logicalCheckpoint: "checkpoint:0", finalToolName: "writeFile", finalArgs: { a: 1 }, policy: "fenced_mutating" }, { lineage });
    const result = await finishActionResultInternal(state.rootDir, state.callId, state.delegationId, state.claim, { logicalActionId: intent.logicalActionId!, resultRef: "result:after-write", resultType: "tool", status: "success" }, { lineage, fault: (point) => { if (point === "after:action_result_private") throw new Error("after private write"); } });
    assert.equal(result.state, "unknown");
    const unknown = (await fs.readFile(path.join(state.rootDir, "v2", "wal", `${state.callId}.jsonl`), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> }).find((event) => event.type === "action_unknown");
    assert.equal(unknown?.data.resultPrivateRef, `private:action-${intent.logicalActionId!.slice(7)}-result`);
    const before = await fs.readdir(path.join(state.rootDir, "v2", "private")); assert.ok(before.includes(`action-${intent.logicalActionId!.slice(7)}-result.json`));
    const orphan = await reconcilePrivateOrphans(state.rootDir); assert.equal(orphan.state, "clean"); assert.equal(orphan.deletedPayloads, 0);
    const after = await fs.readdir(path.join(state.rootDir, "v2", "private")); assert.ok(after.includes(`action-${intent.logicalActionId!.slice(7)}-result.json`));
  } finally { await state.cleanup(); }
});

test("safe retry keeps the logical ID and idempotency key across a recovery reservation", async () => {
  const state = await setup("safe-retry"); try {
    const identity = child("safe-retry-child");
    assert.equal((await bindChildSessionInternal(state.rootDir, state.callId, state.delegationId, state.claim, "child", undefined, identity.pid, { lineage, childIdentity: identity })).state, "bound");
    const request = { executionScope: `scope:${state.delegationId}`, toolCallOrdinal: 0, logicalCheckpoint: "checkpoint:0", finalToolName: "writeFile", finalArgs: { a: 1 }, policy: "fenced_mutating" as const };
    const first = await beginActionIntentInternal(state.rootDir, state.callId, state.delegationId, state.claim, request, { lineage });
    await finishActionResultInternal(state.rootDir, state.callId, state.delegationId, state.claim, { logicalActionId: first.logicalActionId!, resultRef: "result:unknown-retry", resultType: "tool", status: "success" }, { lineage, fault: (point) => { if (point === "before:action_result_acked") throw new Error("unknown"); } });
    assert.equal((await reconcileRunningChildInternal(state.rootDir, state.callId, state.delegationId, async () => "dead", { lineage, owner: state.claim.owner, ownerDeathObservationDelayMs: 0 })).state, "paused_uncertainty");
    assert.equal((await decideUncertaintyDispositionInternal(state.rootDir, state.callId, state.delegationId, first.logicalActionId!, "confirmed_failed_safe_to_retry", actor, { lineage })).state, "decided");
    assert.equal((await acceptContinuationInternal(state.rootDir, state.callId, state.delegationId, "retry", { lineage, owner: state.claim.owner })).state, "accepted");
    const reserved = await reserveRecoveryCycleInternal(state.rootDir, state.callId, state.delegationId, { lineage, owner: state.claim.owner }); assert.equal(reserved.state, "reserved");
    const started = await markSpawnStartedInternal(state.rootDir, state.callId, state.delegationId, "recovery", { lineage, owner: state.claim.owner }); assert.equal(started.state, "recovery_running");
    const second = await beginActionIntentInternal(state.rootDir, state.callId, state.delegationId, { owner: started.owner!, ownerGeneration: started.ownerGeneration!, fencingGeneration: started.fencingGeneration!, spawnId: started.spawnId! }, { ...request, executionScope: "replacement-scope", reservationId: reserved.reservationId, continuationEpoch: reserved.continuationEpoch, fencingGeneration: started.fencingGeneration, retryPolicy: { allow: true, idempotent: true, externalSystemSupportsKey: true, stableIdempotencyKey: stableIdempotencyKeyFor(first.logicalActionId!) } }, { lineage });
    assert.equal(second.handler, 1, JSON.stringify(second)); assert.equal(second.logicalActionId, first.logicalActionId); assert.equal((await fs.readFile(path.join(state.rootDir, "v2", "wal", `${state.callId}.jsonl`), "utf8")).split("\n").filter((line) => line.includes("action_intent_acked")).length, 2);
  } finally { await state.cleanup(); }
});

test("all uncertainty dispositions preserve reservation and handler fences", async () => {
  const request = { executionScope: "action-scope", toolCallOrdinal: 4, logicalCheckpoint: "checkpoint:4", finalToolName: "publish", finalArgs: { id: 4 }, policy: "fenced_mutating" as const };
  const makeUnknown = async (name: string, withChild: boolean) => {
    const state = await setup(name);
    if (withChild) {
      const identity = child(`${name}-child`);
      assert.equal((await bindChildSessionInternal(state.rootDir, state.callId, state.delegationId, state.claim, "child", undefined, identity.pid, { lineage, childIdentity: identity })).state, "bound");
    }
    const intent = await beginActionIntentInternal(state.rootDir, state.callId, state.delegationId, state.claim, request, { lineage });
    await finishActionResultInternal(state.rootDir, state.callId, state.delegationId, state.claim, { logicalActionId: intent.logicalActionId!, resultRef: `result:${name}`, resultType: "tool", status: "success" }, { lineage, fault: (point) => { if (point === "before:action_result_acked") throw new Error("unknown"); } });
    return { state, actionId: intent.logicalActionId! };
  };
  const live = await makeUnknown("disposition-live", true); try {
    assert.equal((await decideUncertaintyDispositionInternal(live.state.rootDir, live.state.callId, live.state.delegationId, live.actionId, "confirmed_succeeded", actor, { lineage })).state, "decided");
    assert.equal((await readDelegationInternal(live.state.rootDir, live.state.callId, live.state.delegationId))?.state, "reattach_only");
    assert.equal((await reserveRecoveryCycleInternal(live.state.rootDir, live.state.callId, live.state.delegationId, { lineage, owner: live.state.claim.owner })).state, "rejected");
    const replay = await beginActionIntentInternal(live.state.rootDir, live.state.callId, live.state.delegationId, live.state.claim, request, { lineage }); assert.equal(replay.handler, 0); assert.equal(replay.state, "committed");
  } finally { await live.state.cleanup(); }
  const dead = await makeUnknown("disposition-dead", true); try {
    assert.equal((await reconcileRunningChildInternal(dead.state.rootDir, dead.state.callId, dead.state.delegationId, async () => "dead", { lineage, owner: dead.state.claim.owner, ownerDeathObservationDelayMs: 0 })).state, "paused_uncertainty");
    assert.equal((await decideUncertaintyDispositionInternal(dead.state.rootDir, dead.state.callId, dead.state.delegationId, dead.actionId, "confirmed_not_started", actor, { lineage })).state, "decided");
    assert.equal((await acceptContinuationInternal(dead.state.rootDir, dead.state.callId, dead.state.delegationId, "retry", { lineage, owner: dead.state.claim.owner })).state, "accepted");
    assert.equal((await reserveRecoveryCycleInternal(dead.state.rootDir, dead.state.callId, dead.state.delegationId, { lineage, owner: dead.state.claim.owner })).state, "reserved");
    const walText = await fs.readFile(path.join(dead.state.rootDir, "v2", "wal", `${dead.state.callId}.jsonl`), "utf8"); assert.equal(walText.split("\n").filter((line) => line.includes("cycle_reserved")).length, 1);
  } finally { await dead.state.cleanup(); }
  const unknown = await makeUnknown("disposition-unknown", false); try {
    assert.equal((await decideUncertaintyDispositionInternal(unknown.state.rootDir, unknown.state.callId, unknown.state.delegationId, unknown.actionId, "confirmed_succeeded", actor, { lineage })).state, "decided");
    assert.equal((await readDelegationInternal(unknown.state.rootDir, unknown.state.callId, unknown.state.delegationId))?.state, "paused_integrity");
    assert.equal((await reserveRecoveryCycleInternal(unknown.state.rootDir, unknown.state.callId, unknown.state.delegationId, { lineage, owner: unknown.state.claim.owner })).state, "rejected");
  } finally { await unknown.state.cleanup(); }
  for (const [name, disposition, expectedState] of [["disposition-still", "still_unknown", "paused_uncertainty"], ["disposition-cancel", "cancel", "cancel_requested"]] as const) {
    const item = await makeUnknown(name, false); try {
      assert.equal((await decideUncertaintyDispositionInternal(item.state.rootDir, item.state.callId, item.state.delegationId, item.actionId, disposition, actor, { lineage })).state, "decided");
      assert.equal((await readDelegationInternal(item.state.rootDir, item.state.callId, item.state.delegationId))?.state, expectedState);
      assert.ok(["unknown", "still_unknown"].includes((await readActionLedgerInternal(item.state.rootDir, item.state.callId))![0]!.status));
    } finally { await item.state.cleanup(); }
  }
});

test("unresolved action blocks continuation, recovery, claim, spawn and remains WAL=0 until manual settlement", async () => {
  const makeUnknown = async (name: string) => {
    const state = await setup(name); const identity = child(`${name}-child`);
    assert.equal((await bindChildSessionInternal(state.rootDir, state.callId, state.delegationId, state.claim, "child", undefined, identity.pid, { lineage, childIdentity: identity })).state, "bound");
    const intent = await beginActionIntentInternal(state.rootDir, state.callId, state.delegationId, state.claim, { executionScope: `${name}:scope`, toolCallOrdinal: 0, logicalCheckpoint: `${name}:checkpoint`, finalToolName: "publish", finalArgs: { name }, policy: "fenced_mutating" }, { lineage });
    await finishActionResultInternal(state.rootDir, state.callId, state.delegationId, state.claim, { logicalActionId: intent.logicalActionId!, resultRef: `result:${name}`, resultType: "tool", status: "success" }, { lineage, fault: (point) => { if (point === "before:action_result_acked") throw new Error("unknown"); } });
    assert.equal((await reconcileRunningChildInternal(state.rootDir, state.callId, state.delegationId, async () => "dead", { lineage, owner: state.claim.owner, ownerDeathObservationDelayMs: 0 })).state, "paused_uncertainty");
    return state;
  };
  const unknown = await makeUnknown("gate-unknown"); try {
    const before = await fs.readFile(path.join(unknown.rootDir, "v2", "wal", `${unknown.callId}.jsonl`), "utf8");
    for (const result of [
      await acceptContinuationInternal(unknown.rootDir, unknown.callId, unknown.delegationId, "retry", { lineage, owner: unknown.claim.owner }),
      await reserveInitialInternal(unknown.rootDir, unknown.callId, unknown.delegationId, { lineage, owner: unknown.claim.owner }),
      await reserveRecoveryCycleInternal(unknown.rootDir, unknown.callId, unknown.delegationId, { lineage, owner: unknown.claim.owner }),
      await claimExecutionOwnerInternal(unknown.rootDir, unknown.callId, unknown.delegationId, unknown.claim.owner, { lineage }),
      await markSpawnStartedInternal(unknown.rootDir, unknown.callId, unknown.delegationId, "recovery", { lineage, owner: unknown.claim.owner }),
    ]) assert.equal(result.state, "rejected");
    assert.equal(await fs.readFile(path.join(unknown.rootDir, "v2", "wal", `${unknown.callId}.jsonl`), "utf8"), before);
  } finally { await unknown.cleanup(); }

  const still = await makeUnknown("gate-still-unknown"); try {
    assert.equal((await decideUncertaintyDispositionInternal(still.rootDir, still.callId, still.delegationId, (await readActionLedgerInternal(still.rootDir, still.callId))![0]!.logicalActionId, "still_unknown", actor, { lineage })).state, "decided");
    const before = await fs.readFile(path.join(still.rootDir, "v2", "wal", `${still.callId}.jsonl`), "utf8");
    assert.equal((await acceptContinuationInternal(still.rootDir, still.callId, still.delegationId, "retry", { lineage, owner: still.claim.owner })).state, "rejected");
    assert.equal((await reserveRecoveryCycleInternal(still.rootDir, still.callId, still.delegationId, { lineage, owner: still.claim.owner })).state, "rejected");
    assert.equal(await fs.readFile(path.join(still.rootDir, "v2", "wal", `${still.callId}.jsonl`), "utf8"), before);
  } finally { await still.cleanup(); }

  const confirmed = await makeUnknown("gate-confirmed"); try {
    const actionId = (await readActionLedgerInternal(confirmed.rootDir, confirmed.callId))![0]!.logicalActionId;
    assert.equal((await decideUncertaintyDispositionInternal(confirmed.rootDir, confirmed.callId, confirmed.delegationId, actionId, "confirmed_not_started", actor, { lineage })).state, "decided");
    assert.equal((await acceptContinuationInternal(confirmed.rootDir, confirmed.callId, confirmed.delegationId, "retry", { lineage, owner: confirmed.claim.owner })).state, "accepted");
    assert.equal((await reserveRecoveryCycleInternal(confirmed.rootDir, confirmed.callId, confirmed.delegationId, { lineage, owner: confirmed.claim.owner })).state, "reserved");
  } finally { await confirmed.cleanup(); }

  const cancelled = await makeUnknown("gate-cancel"); try {
    assert.equal((await requestDelegationCancelInternal(cancelled.rootDir, cancelled.callId, cancelled.delegationId, actor, { lineage })).status, "requested");
    assert.equal((await reconcileDelegationCancelInternal(cancelled.rootDir, cancelled.callId, cancelled.delegationId, { lineage, childControlAdapter: { inspect: async () => ({ state: "dead" as const }) } })).state, "cancel_requested");
    assert.equal((await readDelegationInternal(cancelled.rootDir, cancelled.callId, cancelled.delegationId))?.state, "cancel_requested");
    const actionId = (await readActionLedgerInternal(cancelled.rootDir, cancelled.callId))![0]!.logicalActionId;
    assert.equal((await decideUncertaintyDispositionInternal(cancelled.rootDir, cancelled.callId, cancelled.delegationId, actionId, "confirmed_succeeded", actor, { lineage })).state, "decided");
    assert.equal((await readDelegationInternal(cancelled.rootDir, cancelled.callId, cancelled.delegationId))?.state, "cancelled");
  } finally { await cancelled.cleanup(); }
});

test("action intent rejects a caller-supplied digest that does not match canonical final args", async () => {
  const state = await setup("digest-mismatch"); try {
    const result = await beginActionIntentInternal(state.rootDir, state.callId, state.delegationId, state.claim, { executionScope: `scope:${state.delegationId}`, toolCallOrdinal: 0, logicalCheckpoint: "checkpoint:0", finalToolName: "writeFile", finalArgs: { a: 1 }, canonicalArgsDigest: "0".repeat(64), policy: "fenced_mutating" }, { lineage });
    assert.equal(result.state, "rejected"); assert.equal((await readActionLedgerInternal(state.rootDir, state.callId))?.length, 0);
  } finally { await state.cleanup(); }
});

test("post-spawn cancel requires death proof, never signals a reused PID, and settles committed cancel", async () => {
  const state = await setup("post-cancel"); try {
    const identity = child("post-cancel-child"); assert.equal((await bindChildSessionInternal(state.rootDir, state.callId, state.delegationId, state.claim, "child", undefined, identity.pid, { lineage, childIdentity: identity })).state, "bound"); assert.equal((await requestDelegationCancelInternal(state.rootDir, state.callId, state.delegationId, actor, { lineage })).status, "requested");
    let terminate = 0; let inspect = 0; const result = await reconcileDelegationCancelInternal(state.rootDir, state.callId, state.delegationId, { lineage, childControlAdapter: { inspect: async () => ({ state: inspect++ === 0 ? "live" : "dead", identity: inspect === 1 ? identity : undefined }), waitForDeath: async () => ({ state: "dead" }), requestTerminate: async () => { terminate += 1; return { acknowledged: true }; } } });
    assert.equal(result.state, "cancelled"); assert.equal(terminate, 1); assert.equal((await readActionLedgerInternal(state.rootDir, state.callId))?.length, 0);
    const replay = await reconcileDelegationCancelInternal(state.rootDir, state.callId, state.delegationId, { lineage, childControlAdapter: { inspect: async () => ({ state: "dead" }), requestTerminate: async () => { throw new Error("must not signal after settlement"); } } }); assert.equal(replay.state, "rejected");
  } finally { await state.cleanup(); }
});

test("cancel fence settles post-spawn action unknowns without continuation, while still-unknown remains paused", async () => {
  const request = { executionScope: "cancel-action-scope", toolCallOrdinal: 0, logicalCheckpoint: "checkpoint:cancel", finalToolName: "publish", finalArgs: { id: 5 }, policy: "fenced_mutating" as const };
  const prepare = async (name: string) => {
    const state = await setup(name); const identity = child(`${name}-child`);
    assert.equal((await bindChildSessionInternal(state.rootDir, state.callId, state.delegationId, state.claim, "child", undefined, identity.pid, { lineage, childIdentity: identity })).state, "bound");
    const intent = await beginActionIntentInternal(state.rootDir, state.callId, state.delegationId, state.claim, request, { lineage });
    assert.equal((await requestDelegationCancelInternal(state.rootDir, state.callId, state.delegationId, actor, { lineage })).status, "requested");
    const reconciled = await reconcileDelegationCancelInternal(state.rootDir, state.callId, state.delegationId, { lineage, childControlAdapter: {
      inspect: async () => ({ state: "live" as const, identity }),
      requestTerminate: async () => ({ acknowledged: true }),
      waitForDeath: async () => ({ state: "dead" as const }),
    } });
    assert.equal(reconciled.state, "cancel_requested");
    assert.equal((await readActionLedgerInternal(state.rootDir, state.callId))?.[0]?.status, "unknown");
    return { state, actionId: intent.logicalActionId! };
  };

  const succeeded = await prepare("cancel-confirmed-succeeded"); try {
    const decided = await decideUncertaintyDispositionInternal(succeeded.state.rootDir, succeeded.state.callId, succeeded.state.delegationId, succeeded.actionId, "confirmed_succeeded", actor, { lineage });
    assert.equal(decided.state, "decided");
    assert.equal((await readDelegationInternal(succeeded.state.rootDir, succeeded.state.callId, succeeded.state.delegationId))?.state, "cancelled");
    assert.equal((await readActionLedgerInternal(succeeded.state.rootDir, succeeded.state.callId))?.[0]?.status, "confirmed_succeeded");
    assert.equal((await acceptContinuationInternal(succeeded.state.rootDir, succeeded.state.callId, succeeded.state.delegationId, "must-not-spawn", { lineage, owner: succeeded.state.claim.owner })).state, "rejected");
    assert.equal((await reserveRecoveryCycleInternal(succeeded.state.rootDir, succeeded.state.callId, succeeded.state.delegationId, { lineage, owner: succeeded.state.claim.owner })).state, "rejected");
    assert.equal((await finalizeCallInternal(succeeded.state.rootDir, succeeded.state.callId)).state, "final");
  } finally { await succeeded.state.cleanup(); }

  for (const [name, disposition] of [["cancel-confirmed-not-started", "confirmed_not_started"], ["cancel-confirmed-failed", "confirmed_failed_safe_to_retry"]] as const) {
    const item = await prepare(name); try {
      assert.equal((await decideUncertaintyDispositionInternal(item.state.rootDir, item.state.callId, item.state.delegationId, item.actionId, disposition, actor, { lineage })).state, "decided");
      assert.equal((await readDelegationInternal(item.state.rootDir, item.state.callId, item.state.delegationId))?.state, "cancelled");
      assert.equal((await readActionLedgerInternal(item.state.rootDir, item.state.callId))?.[0]?.status, disposition);
      assert.equal((await fs.readFile(path.join(item.state.rootDir, "v2", "wal", `${item.state.callId}.jsonl`), "utf8")).includes('"disposition":"cancel"'), false);
    } finally { await item.state.cleanup(); }
  }

  const still = await prepare("cancel-still-unknown"); try {
    assert.equal((await decideUncertaintyDispositionInternal(still.state.rootDir, still.state.callId, still.state.delegationId, still.actionId, "still_unknown", actor, { lineage })).state, "decided");
    assert.equal((await readDelegationInternal(still.state.rootDir, still.state.callId, still.state.delegationId))?.state, "paused_uncertainty");
    assert.equal((await readActionLedgerInternal(still.state.rootDir, still.state.callId))?.[0]?.status, "still_unknown");
    const beforeWrongActor = await fs.readFile(path.join(still.state.rootDir, "v2", "wal", `${still.state.callId}.jsonl`), "utf8");
    assert.equal((await decideUncertaintyDispositionInternal(still.state.rootDir, still.state.callId, still.state.delegationId, still.actionId, "confirmed_succeeded", { ...actor, activeBranchAnchor: "other-branch" }, { lineage })).state, "rejected");
    assert.equal(await fs.readFile(path.join(still.state.rootDir, "v2", "wal", `${still.state.callId}.jsonl`), "utf8"), beforeWrongActor);
    assert.equal((await decideUncertaintyDispositionInternal(still.state.rootDir, still.state.callId, still.state.delegationId, still.actionId, "cancel", actor, { lineage })).state, "already_decided");
    assert.equal((await requestDelegationCancelInternal(still.state.rootDir, still.state.callId, still.state.delegationId, actor, { lineage })).status, "already_requested");
    assert.equal((await fs.readFile(path.join(still.state.rootDir, "v2", "wal", `${still.state.callId}.jsonl`), "utf8")).includes('"disposition":"cancel"'), false);
  } finally { await still.state.cleanup(); }
});

test("post-spawn unknown child liveness enters integrity instead of cancelling", async () => {
  const state = await setup("cancel-child-unknown"); try {
    const identity = child("cancel-child-unknown-child");
    assert.equal((await bindChildSessionInternal(state.rootDir, state.callId, state.delegationId, state.claim, "child", undefined, identity.pid, { lineage, childIdentity: identity })).state, "bound");
    assert.equal((await requestDelegationCancelInternal(state.rootDir, state.callId, state.delegationId, actor, { lineage })).status, "requested");
    const result = await reconcileDelegationCancelInternal(state.rootDir, state.callId, state.delegationId, { lineage, childControlAdapter: { inspect: async () => ({ state: "unknown" as const }) } });
    assert.equal(result.state, "paused_integrity");
    assert.equal((await fs.readFile(path.join(state.rootDir, "v2", "wal", `${state.callId}.jsonl`), "utf8")).includes("child_identity_or_liveness_unreadable"), true);
  } finally { await state.cleanup(); }
});

test("same logical action policy or idempotency conflicts fail closed before writing WAL", async () => {
  const state = await setup("action-attribute-conflict"); try {
    const request = { executionScope: "conflict-scope", toolCallOrdinal: 0, logicalCheckpoint: "checkpoint:conflict", finalToolName: "publish", finalArgs: { id: 1 }, policy: "fenced_mutating" as const };
    const first = await beginActionIntentInternal(state.rootDir, state.callId, state.delegationId, state.claim, request, { lineage }); assert.equal(first.handler, 1);
    const beforePolicy = await fs.readFile(path.join(state.rootDir, "v2", "wal", `${state.callId}.jsonl`), "utf8");
    const policyConflict = await beginActionIntentInternal(state.rootDir, state.callId, state.delegationId, state.claim, { ...request, policy: "read_only" as const }, { lineage });
    assert.equal(policyConflict.handler, 0); assert.equal(policyConflict.state, "paused_integrity");
    assert.equal(await fs.readFile(path.join(state.rootDir, "v2", "wal", `${state.callId}.jsonl`), "utf8"), beforePolicy);
    const beforeIdempotency = await fs.readFile(path.join(state.rootDir, "v2", "wal", `${state.callId}.jsonl`), "utf8");
    const idempotencyConflict = await beginActionIntentInternal(state.rootDir, state.callId, state.delegationId, state.claim, { ...request, retryPolicy: { allow: true, idempotent: true, externalSystemSupportsKey: true, stableIdempotencyKey: "idempotency:wrong" } }, { lineage });
    assert.equal(idempotencyConflict.handler, 0); assert.equal(idempotencyConflict.state, "rejected");
    assert.equal(await fs.readFile(path.join(state.rootDir, "v2", "wal", `${state.callId}.jsonl`), "utf8"), beforeIdempotency);
  } finally { await state.cleanup(); }

  const retryState = await setup("action-idempotency-retry-conflict"); try {
    const identity = child("action-idempotency-retry-child");
    assert.equal((await bindChildSessionInternal(retryState.rootDir, retryState.callId, retryState.delegationId, retryState.claim, "child", undefined, identity.pid, { lineage, childIdentity: identity })).state, "bound");
    const request = { executionScope: "retry-scope", toolCallOrdinal: 0, logicalCheckpoint: "checkpoint:retry-conflict", finalToolName: "publish", finalArgs: { id: 2 }, policy: "fenced_mutating" as const };
    const first = await beginActionIntentInternal(retryState.rootDir, retryState.callId, retryState.delegationId, retryState.claim, request, { lineage });
    await finishActionResultInternal(retryState.rootDir, retryState.callId, retryState.delegationId, retryState.claim, { logicalActionId: first.logicalActionId!, resultRef: "result:retry-conflict", resultType: "tool", status: "success" }, { lineage, fault: (point) => { if (point === "before:action_result_acked") throw new Error("unknown"); } });
    assert.equal((await reconcileRunningChildInternal(retryState.rootDir, retryState.callId, retryState.delegationId, async () => "dead", { lineage, owner: retryState.claim.owner, ownerDeathObservationDelayMs: 0 })).state, "paused_uncertainty");
    assert.equal((await decideUncertaintyDispositionInternal(retryState.rootDir, retryState.callId, retryState.delegationId, first.logicalActionId!, "confirmed_not_started", actor, { lineage })).state, "decided");
    assert.equal((await acceptContinuationInternal(retryState.rootDir, retryState.callId, retryState.delegationId, "retry", { lineage, owner: retryState.claim.owner })).state, "accepted");
    const reserved = await reserveRecoveryCycleInternal(retryState.rootDir, retryState.callId, retryState.delegationId, { lineage, owner: retryState.claim.owner });
    const started = await markSpawnStartedInternal(retryState.rootDir, retryState.callId, retryState.delegationId, "recovery", { lineage, owner: retryState.claim.owner });
    const beforeRetry = await fs.readFile(path.join(retryState.rootDir, "v2", "wal", `${retryState.callId}.jsonl`), "utf8");
    const retryConflict = await beginActionIntentInternal(retryState.rootDir, retryState.callId, retryState.delegationId, { owner: started.owner!, ownerGeneration: started.ownerGeneration!, fencingGeneration: started.fencingGeneration!, spawnId: started.spawnId! }, { ...request, executionScope: "replacement-scope", reservationId: reserved.reservationId, continuationEpoch: reserved.continuationEpoch, fencingGeneration: started.fencingGeneration, retryPolicy: { allow: true, idempotent: true, externalSystemSupportsKey: true, stableIdempotencyKey: "idempotency:wrong" } }, { lineage });
    assert.equal(retryConflict.handler, 0); assert.equal(retryConflict.state, "rejected");
    assert.equal(await fs.readFile(path.join(retryState.rootDir, "v2", "wal", `${retryState.callId}.jsonl`), "utf8"), beforeRetry);
  } finally { await retryState.cleanup(); }
});

test("manual uncertainty dispositions are durable, monotonic, and contradictory decisions fail closed", async () => {
  const state = await setup("manual"); try {
    const intent = await beginActionIntentInternal(state.rootDir, state.callId, state.delegationId, state.claim, { executionScope: `scope:${state.delegationId}`, toolCallOrdinal: 1, logicalCheckpoint: "checkpoint:1", finalToolName: "publish", finalArgs: { id: 1 }, policy: "fenced_mutating" }, { lineage });
    await finishActionResultInternal(state.rootDir, state.callId, state.delegationId, state.claim, { actionId: intent.actionId!, resultRef: "result:manual", resultType: "publish", status: "success" }, { lineage, fault: (point) => { if (point === "before:action_result_acked") throw new Error("unknown"); } });
    const decision = await decideUncertaintyDispositionInternal(state.rootDir, state.callId, state.delegationId, intent.actionId!, "confirmed_succeeded", actor, { lineage }); assert.equal(decision.state, "decided"); assert.equal((await readActionLedgerInternal(state.rootDir, state.callId))![0]!.status, "confirmed_succeeded");
    const duplicate = await decideUncertaintyDispositionInternal(state.rootDir, state.callId, state.delegationId, intent.actionId!, "confirmed_succeeded", actor, { lineage }); assert.equal(duplicate.state, "already_decided");
    const contradiction = await decideUncertaintyDispositionInternal(state.rootDir, state.callId, state.delegationId, intent.actionId!, "still_unknown", actor, { lineage }); assert.equal(contradiction.state, "rejected");
  } finally { await state.cleanup(); }
});
