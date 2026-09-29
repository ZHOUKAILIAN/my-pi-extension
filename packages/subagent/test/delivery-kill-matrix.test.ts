import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDiscoverySnapshot } from "../src/agents.ts";
import { admitDispatchCallInternal, markOriginalToolCallInterruptedInternal, requestCallCancelInternal, querySubagentStatusInternal, executeDeliveryInternal, reconcileDeliveryStartupInternal } from "../src/delegation-internal.ts";
import type { ActiveLineage } from "../src/lineage.ts";
import type { DeliveryHostAdapter, DispatchCallAdmissionRequest, HostPersistedBranchEntry } from "../src/delegation-internal.ts";
const parentSessionId = "delivery-kill-parent";
const lineage: ActiveLineage = { parentSessionId, activeLineageId: "kill-lineage", activeBranchAnchor: "kill-anchor", currentLeafId: "kill-anchor", branchIds: ["root", "kill-anchor"], persistence: "in_process_only" };
const actor = { parentSessionId, activeLineageId: lineage.activeLineageId, activeBranchAnchor: lineage.activeBranchAnchor };
async function setup(name: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `subagent-kill-${name}-`)); const project = path.join(root, "agents"); await fs.mkdir(project, { recursive: true }); await fs.writeFile(path.join(project, "agent.md"), "---\nname: implement\ndescription: implement\n---\nInstructions"); const snapshot = getAgentDiscoverySnapshot(project)!;
  const request: DispatchCallAdmissionRequest = { parentSessionId, lineage, toolCallId: `kill-${name}`, cwd: project, mode: "single", agentScope: "project", projectTrust: { parentSessionId, discoveryRootRealpath: snapshot.rootRealpath, snapshotDigest: snapshot.digest }, single: { agent: "implement", task: "safe" } };
  const admitted = await admitDispatchCallInternal(request, root); assert.equal(admitted.state, "admitted"); const callId = admitted.dispatchCallId!; await markOriginalToolCallInterruptedInternal(root, callId, actor, { lineage }); await requestCallCancelInternal(root, callId, actor, { lineage }); const status = await querySubagentStatusInternal(root, callId, lineage, []); return { root, callId, deliveryId: status.customOutbox!.deliveryId, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}
function host(entries: HostPersistedBranchEntry[], callId: string, deliveryId: string, sent: { count: number }): DeliveryHostAdapter { return { scanActiveBranch: async () => entries, appendCustomMessage: async (payload, branch) => { sent.count += 1; entries.push({ entryRef: `entry:${sent.count}`, role: "customMessage", parentSessionId, activeLineageId: branch.activeLineageId, activeBranchAnchor: branch.activeBranchAnchor, dispatchCallId: callId, proofRef: `proof:${callId}`, customType: payload.customType, deliveryId }); } }; }

test("delivery startup kill matrix never duplicates custom send", async () => {
  for (const point of ["before:delivery_owner_claimed", "after:delivery_owner_claimed", "before:delivery_sending", "after:delivery_sending", "before:delivery_receipted", "after:delivery_receipted"]) {
    const state = await setup(point.replaceAll(":", "-")); try {
      const entries: HostPersistedBranchEntry[] = []; const sent = { count: 0 }; const adapter = host(entries, state.callId, state.deliveryId, sent);
      await assert.rejects(() => executeDeliveryInternal(state.root, state.callId, state.deliveryId, lineage, adapter, { lineage, fault: (name) => { if (name === point) throw new Error(`kill ${point}`); } }));
      const startup = await reconcileDeliveryStartupInternal(state.root, state.callId, lineage, adapter, { lineage });
      const expectedSendCount = point === "after:delivery_sending" ? 0 : 1;
      if (point === "after:delivery_sending") { assert.equal(startup.state, "uncertain"); } else { assert.equal(startup.state, "receipted"); }
      assert.equal(sent.count, expectedSendCount);
      const again = await reconcileDeliveryStartupInternal(state.root, state.callId, lineage, adapter, { lineage }); assert.equal(again.sendCount, 0); assert.equal(sent.count, expectedSendCount);
    } finally { await state.cleanup(); }
  }
});
