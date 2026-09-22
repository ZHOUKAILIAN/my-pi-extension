import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDiscoverySnapshot } from "../src/agents.ts";
import { admitDispatchCallInternal, markOriginalToolCallInterruptedInternal, requestCallCancelInternal, querySubagentStatusInternal, executeDeliveryInternal } from "../src/delegation-internal.ts";
import type { ActiveLineage } from "../src/lineage.ts";
import type { DeliveryHostAdapter, DispatchCallAdmissionRequest, HostPersistedBranchEntry } from "../src/delegation-internal.ts";
const parentSessionId = "delivery-existing-parent";
const lineage: ActiveLineage = { parentSessionId, activeLineageId: "existing-lineage", activeBranchAnchor: "existing-anchor", currentLeafId: "existing-anchor", branchIds: ["root", "existing-anchor"], persistence: "in_process_only" };
const actor = { parentSessionId, activeLineageId: lineage.activeLineageId, activeBranchAnchor: lineage.activeBranchAnchor };
test("existing custom receipt completes pending outbox without send", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-existing-receipt-"));
  try {
    const project = path.join(root, "agents"); await fs.mkdir(project, { recursive: true }); await fs.writeFile(path.join(project, "agent.md"), "---\nname: implement\ndescription: implement\n---\nInstructions"); const snapshot = getAgentDiscoverySnapshot(project)!;
    const request: DispatchCallAdmissionRequest = { parentSessionId, lineage, toolCallId: "receipt-tool", cwd: project, mode: "single", agentScope: "project", projectTrust: { parentSessionId, discoveryRootRealpath: snapshot.rootRealpath, snapshotDigest: snapshot.digest }, single: { agent: "implement", task: "x" } };
    const admitted = await admitDispatchCallInternal(request, root); assert.equal(admitted.state, "admitted"); const callId = admitted.dispatchCallId!;
    await markOriginalToolCallInterruptedInternal(root, callId, actor, { lineage }); await requestCallCancelInternal(root, callId, actor, { lineage }); const status = await querySubagentStatusInternal(root, callId, lineage, []); const outbox = status.customOutbox!;
    const entries: HostPersistedBranchEntry[] = [{ entryRef: "entry:existing", role: "customMessage", parentSessionId, activeLineageId: lineage.activeLineageId, activeBranchAnchor: lineage.activeBranchAnchor, dispatchCallId: callId, proofRef: `proof:${callId}`, customType: outbox.customType, deliveryId: outbox.deliveryId }]; let sends = 0;
    const host: DeliveryHostAdapter = { scanActiveBranch: async () => entries, appendCustomMessage: async () => { sends += 1; } };
    const result = await executeDeliveryInternal(root, callId, outbox.deliveryId, lineage, host, { lineage }); assert.equal(result.state, "receipted"); assert.equal(result.sendCount, 0); assert.equal(sends, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
