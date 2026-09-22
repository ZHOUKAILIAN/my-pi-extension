import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDiscoverySnapshot } from "../src/agents.ts";
import {
  admitDispatchCallInternal, finalizeCallInternal, markDelegationReturnedInternal, markOriginalToolCallInterruptedInternal,
  markSpawnStartedInternal, querySubagentStatusInternal, requestCallCancelInternal, requestDeliveryAbandonInternal,
  resolveDelegationInternal, reserveInitialInternal, executeDeliveryInternal, reconcileDeliveryStartupInternal,
} from "../src/delegation-internal.ts";
import type { ActiveLineage } from "../src/lineage.ts";
import type { DeliveryHostAdapter, DispatchCallAdmissionRequest, HostPersistedBranchEntry, OwnerIdentity } from "../src/delegation-internal.ts";

const parentSessionId = "delivery-parent";
const lineage: ActiveLineage = { parentSessionId, activeLineageId: "delivery-lineage", activeBranchAnchor: "delivery-anchor", currentLeafId: "delivery-anchor", branchIds: ["root", "delivery-anchor"], persistence: "in_process_only" };
const actor = { parentSessionId, activeLineageId: lineage.activeLineageId, activeBranchAnchor: lineage.activeBranchAnchor };
const definition = "---\nname: implement\ndescription: implement\n---\nInstructions";
function owner(birth: string): OwnerIdentity { return { host: "test", pid: process.pid, birth, parentSessionId, parentSessionPath: "/tmp/delivery-parent", argvProof: "a".repeat(64) }; }
async function setup(toolCallId: string) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-delivery-"));
  const project = path.join(rootDir, "agents"); await fs.mkdir(project, { recursive: true }); await fs.writeFile(path.join(project, "agent.md"), definition);
  const snapshot = getAgentDiscoverySnapshot(project)!;
  const request: DispatchCallAdmissionRequest = { parentSessionId, lineage, toolCallId, cwd: project, mode: "single", agentScope: "project", projectTrust: { parentSessionId, discoveryRootRealpath: snapshot.rootRealpath, snapshotDigest: snapshot.digest }, single: { agent: "implement", task: "safe task" } };
  const admitted = await admitDispatchCallInternal(request, rootDir); assert.equal(admitted.state, "admitted");
  return { rootDir, callId: admitted.dispatchCallId!, delegationId: admitted.delegationIds![0]!, cleanup: () => fs.rm(rootDir, { recursive: true, force: true }) };
}
async function complete(state: Awaited<ReturnType<typeof setup>>) {
  assert.equal((await resolveDelegationInternal(state.rootDir, state.callId, state.delegationId, { lineage })).state, "resolved");
  const o = owner("execution"); await reserveInitialInternal(state.rootDir, state.callId, state.delegationId, { lineage, owner: o });
  const started = await markSpawnStartedInternal(state.rootDir, state.callId, state.delegationId, "initial", { lineage, owner: o }); assert.equal(started.state, "initial_running");
  await markDelegationReturnedInternal(state.rootDir, state.callId, state.delegationId, "success", "ref:result", { owner: started.owner!, ownerGeneration: started.ownerGeneration!, fencingGeneration: started.fencingGeneration!, spawnId: started.spawnId! }, { lineage });
  assert.equal((await finalizeCallInternal(state.rootDir, state.callId)).state, "final");
}
function toolResult(state: Awaited<ReturnType<typeof setup>>, overrides: Partial<HostPersistedBranchEntry> = {}): HostPersistedBranchEntry {
  return { entryRef: "entry:tool", role: "toolResult", parentSessionId, activeLineageId: lineage.activeLineageId, activeBranchAnchor: lineage.activeBranchAnchor, dispatchCallId: state.callId, proofRef: `proof:${state.callId}`, toolCallId: "original-tool", toolCallIdHash: undefined, ...overrides };
}
function adapter(entries: HostPersistedBranchEntry[], sent: { count: number }): DeliveryHostAdapter { return { scanActiveBranch: async () => entries, appendCustomMessage: async (payload, branch) => { sent.count += 1; entries.push({ entryRef: `entry:${sent.count}`, role: "customMessage", parentSessionId, activeLineageId: branch.activeLineageId, activeBranchAnchor: branch.activeBranchAnchor, dispatchCallId: payload.dispatchCallId, proofRef: payload.proofRef, customType: payload.customType, deliveryId: payload.deliveryId }); } }; }

test("normal status observes only one matching host tool result and never treats execute return as proof", async () => {
  const state = await setup("original-tool"); try { await complete(state);
    const empty = await querySubagentStatusInternal(state.rootDir, state.callId, lineage, []); assert.equal(empty.normalToolResultStatus, "unobserved");
    const projectionBefore = await fs.readFile(path.join(state.rootDir, "v2", "calls", `${state.callId}.json`), "utf8");
    const observed = await querySubagentStatusInternal(state.rootDir, state.callId, lineage, [toolResult(state)]); assert.equal(observed.normalToolResultStatus, "observed");
    assert.equal(await fs.readFile(path.join(state.rootDir, "v2", "calls", `${state.callId}.json`), "utf8"), projectionBefore);
    const again = await querySubagentStatusInternal(state.rootDir, state.callId, lineage, [toolResult(state)]); assert.equal(again.normalToolResultStatus, "observed");
  } finally { await state.cleanup(); }
});

test("normal observation fails closed for zero, multiple, cross-lineage and wrong proof", async () => {
  const state = await setup("original-tool"); try { await complete(state);
    const wrong = await querySubagentStatusInternal(state.rootDir, state.callId, lineage, [toolResult(state, { proofRef: "proof:wrong" })]); assert.equal(wrong.state, "paused_integrity");
    const cross = await querySubagentStatusInternal(state.rootDir, state.callId, lineage, [toolResult(state, { activeLineageId: "sibling" })]); assert.equal(cross.state, "paused_integrity");
    const many = await querySubagentStatusInternal(state.rootDir, state.callId, lineage, [toolResult(state), toolResult(state, { entryRef: "entry:tool-2" })]); assert.equal(many.state, "paused_integrity");
  } finally { await state.cleanup(); }
});

test("normal observation requires raw host toolCallId equal to private originalToolCallId", async () => {
  for (const entry of [
    (state: Awaited<ReturnType<typeof setup>>) => toolResult(state, { toolCallId: undefined }),
    (state: Awaited<ReturnType<typeof setup>>) => toolResult(state, { toolCallId: undefined, toolCallIdHash: createHash("sha256").update("original-tool").digest("hex") }),
    (state: Awaited<ReturnType<typeof setup>>) => toolResult(state, { toolCallId: "wrong-tool", toolCallIdHash: createHash("sha256").update("original-tool").digest("hex") }),
  ]) {
    const state = await setup("original-tool"); try {
      await complete(state);
      const wal = path.join(state.rootDir, "v2", "wal", `${state.callId}.jsonl`);
      const before = await fs.readFile(wal, "utf8");
      const result = await querySubagentStatusInternal(state.rootDir, state.callId, lineage, [entry(state)]);
      assert.notEqual(result.normalToolResultStatus, "observed");
      const after = await fs.readFile(wal, "utf8");
      assert.equal(after, before);
      assert.equal(after.includes("normal_tool_result_observed"), false);
    } finally { await state.cleanup(); }
  }
});

test("final unobserved Call can be interrupted, then creates pending outbox and receipts once", async () => {
  const state = await setup("final-before-host"); try {
    await complete(state);
    const before = await querySubagentStatusInternal(state.rootDir, state.callId, lineage, []);
    assert.equal(before.normalToolResultStatus, "unobserved");
    assert.equal((await markOriginalToolCallInterruptedInternal(state.rootDir, state.callId, actor, { lineage })).state, "interrupted");
    const pending = await querySubagentStatusInternal(state.rootDir, state.callId, lineage, []);
    assert.equal(pending.originalToolCallStatus, "interrupted");
    assert.equal(pending.normalToolResultStatus, "unobserved");
    assert.equal(pending.customOutbox?.status, "pending");
    const sent = { count: 0 }; const entries: HostPersistedBranchEntry[] = [];
    const receipt = await executeDeliveryInternal(state.rootDir, state.callId, pending.customOutbox!.deliveryId, lineage, adapter(entries, sent), { lineage });
    assert.equal(receipt.state, "receipted"); assert.equal(sent.count, 1);
    const final = await querySubagentStatusInternal(state.rootDir, state.callId, lineage, []);
    assert.equal(final.customOutbox?.status, "receipted");
  } finally { await state.cleanup(); }
});

test("observed normal delivery wins and interruption is rejected", async () => {
  const state = await setup("original-tool"); try {
    await complete(state);
    const observed = await querySubagentStatusInternal(state.rootDir, state.callId, lineage, [toolResult(state)]);
    assert.equal(observed.normalToolResultStatus, "observed");
    const interrupted = await markOriginalToolCallInterruptedInternal(state.rootDir, state.callId, actor, { lineage });
    assert.equal(interrupted.state, "rejected");
    const after = await querySubagentStatusInternal(state.rootDir, state.callId, lineage, []);
    assert.equal(after.normalToolResultStatus, "observed");
    assert.equal(after.originalToolCallStatus, "running");
    assert.equal(after.customOutbox, undefined);
  } finally { await state.cleanup(); }
});

test("observation and interruption are linearized by the Call lock", async () => {
  const state = await setup("original-tool"); try {
    await complete(state);
    const entries = [toolResult(state)];
    const [observation, interruption] = await Promise.all([
      querySubagentStatusInternal(state.rootDir, state.callId, lineage, entries),
      markOriginalToolCallInterruptedInternal(state.rootDir, state.callId, actor, { lineage }),
    ]);
    const status = await querySubagentStatusInternal(state.rootDir, state.callId, lineage, []);
    const events = (await fs.readFile(path.join(state.rootDir, "v2", "wal", `${state.callId}.jsonl`), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string });
    const normalObserved = events.filter((event) => event.type === "normal_tool_result_observed").length;
    const interrupted = events.filter((event) => event.type === "original_tool_call_interrupted").length;
    assert.equal(normalObserved + interrupted, 1);
    if (status.normalToolResultStatus === "observed") {
      assert.equal(status.originalToolCallStatus, "running");
      assert.equal(interruption.state, "rejected");
    } else {
      assert.equal(status.originalToolCallStatus, "interrupted");
      assert.equal(status.normalToolResultStatus, "unobserved");
      assert.equal(observation.state, "ok");
    }
    assert.ok(observation.state === "ok" || observation.state === "paused_integrity" || observation.state === "rejected");
    assert.ok(interruption.state === "interrupted" || interruption.state === "rejected");
  } finally { await state.cleanup(); }
});

test("interrupted Call is irreversible and creates a private at-most-once outbox on cancel", async () => {
  const state = await setup("original-tool"); try {
    assert.equal((await markOriginalToolCallInterruptedInternal(state.rootDir, state.callId, actor, { lineage })).state, "interrupted");
    assert.equal((await markOriginalToolCallInterruptedInternal(state.rootDir, state.callId, actor, { lineage })).state, "interrupted");
    const cancelled = await requestCallCancelInternal(state.rootDir, state.callId, actor, { lineage }); assert.equal(cancelled.status, "requested");
    const status = await querySubagentStatusInternal(state.rootDir, state.callId, lineage, []); assert.equal(status.originalToolCallStatus, "interrupted"); assert.equal(status.customOutbox?.status, "pending"); assert.equal(status.customOutbox?.customType, "subagent-cancelled");
    const publicStatus = JSON.stringify(status); assert.equal(publicStatus.includes("original-tool"), false); assert.equal(publicStatus.includes("safe task"), false); assert.equal(publicStatus.includes(state.rootDir), false);
    const privateFiles = (await fs.readdir(path.join(state.rootDir, "v2", "private"))).filter((name) => name.startsWith("delivery-")); assert.equal(privateFiles.length, 1); const payload = JSON.parse(await fs.readFile(path.join(state.rootDir, "v2", "private", privateFiles[0]! ), "utf8")); assert.equal(JSON.stringify(payload).includes("original-tool"), false); assert.equal(JSON.stringify(payload).includes("safe task"), false);
    const sent = { count: 0 }; const entries: HostPersistedBranchEntry[] = []; const result = await executeDeliveryInternal(state.rootDir, state.callId, status.customOutbox!.deliveryId, lineage, adapter(entries, sent), { lineage }); assert.equal(result.state, "receipted"); assert.equal(sent.count, 1);
    const again = await executeDeliveryInternal(state.rootDir, state.callId, status.customOutbox!.deliveryId, lineage, adapter(entries, sent), { lineage }); assert.equal(again.state, "receipted"); assert.equal(sent.count, 1);
  } finally { await state.cleanup(); }
});

test("status replay is read-only for torn WAL and corruption", async () => {
  for (const suffix of ["partial", "{\\\"corrupt\\\":true}\\n"]) {
    const state = await setup(`status-integrity-${suffix.length}`); try {
      const wal = path.join(state.rootDir, "v2", "wal", `${state.callId}.jsonl`);
      const original = await fs.readFile(wal, "utf8");
      await fs.appendFile(wal, suffix, "utf8");
      const before = await fs.readFile(wal, "utf8");
      const result = await querySubagentStatusInternal(state.rootDir, state.callId, lineage, []);
      assert.equal(result.state, "paused_integrity");
      assert.equal(await fs.readFile(wal, "utf8"), before);
      assert.equal((await fs.readFile(wal, "utf8")).includes("wal_torn_tail_repaired"), false);
      assert.equal((await fs.readFile(wal, "utf8")).startsWith(original), true);
    } finally { await state.cleanup(); }
  }
});

test("sending recovery is uncertain and startup never resends; abandon is terminal", async () => {
  const state = await setup("original-tool"); try {
    await markOriginalToolCallInterruptedInternal(state.rootDir, state.callId, actor, { lineage }); await requestCallCancelInternal(state.rootDir, state.callId, actor, { lineage });
    const status = await querySubagentStatusInternal(state.rootDir, state.callId, lineage, []); const sent = { count: 0 }; const entries: HostPersistedBranchEntry[] = [];
    await assert.rejects(() => executeDeliveryInternal(state.rootDir, state.callId, status.customOutbox!.deliveryId, lineage, adapter(entries, sent), { lineage, fault: (point) => { if (point === "after:delivery_sending") throw new Error("kill"); } }));
    const startup = await reconcileDeliveryStartupInternal(state.rootDir, state.callId, lineage, adapter(entries, sent), { lineage }); assert.equal(startup.state, "uncertain"); assert.equal(sent.count, 0);
    const abandoned = await requestDeliveryAbandonInternal(state.rootDir, state.callId, status.customOutbox!.deliveryId, "abandon", actor, { lineage }); assert.equal(abandoned.status, "abandoned");
    const after = await executeDeliveryInternal(state.rootDir, state.callId, status.customOutbox!.deliveryId, lineage, adapter(entries, sent), { lineage }); assert.equal(after.state, "abandoned"); assert.equal(sent.count, 0);
  } finally { await state.cleanup(); }
});
