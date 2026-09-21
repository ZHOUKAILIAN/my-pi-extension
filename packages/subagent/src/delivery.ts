/** Gated internal Call delivery/status foundation. Never imported by the public v1 facade. */
import { appendWal, appendWalStrictNoRepair, dirs, hash, loadView, loadViewReadOnly, materialize, privatePayload, readPrivate, writePrivate, withCallLock } from "./delegation-context.ts";
import type { ActiveLineage } from "./lineage.ts";
import type {
  CancelActor, CustomOutboxView, DeliveryAbandonReceipt, DeliveryCustomType, DeliveryHostAdapter, DeliveryPayload,
  DelegationFoundationDependencies, DispatchCallView, HostPersistedBranchEntry, InternalView,
} from "./delegation-types.ts";
import { lineageMatches } from "./lineage.ts";

const DELIVERY_ID_PREFIX = "delivery:";
const PROOF_PREFIX = "proof:";
const SAFE_REF = /^[A-Za-z0-9._:-]{1,128}$/;

type DeliveryOutcome = "success" | "failure" | "cancelled";
interface StoredDeliveryPayload extends DeliveryPayload { version: 1; }

function now(deps?: DelegationFoundationDependencies): string {
  const date = deps?.now?.() ?? new Date();
  if (!Number.isFinite(date.getTime())) throw new Error("invalid delivery clock");
  return date.toISOString();
}
function actorRef(actor: CancelActor): string { return hash(JSON.stringify([actor.parentSessionId, actor.activeLineageId, actor.activeBranchAnchor])); }
function proofRef(callId: string): string { return `${PROOF_PREFIX}${callId}`; }
function deliveryId(callId: string, customType: DeliveryCustomType, outcome: DeliveryOutcome): string {
  return `${DELIVERY_ID_PREFIX}${hash(JSON.stringify(["subagent-delivery-v1", callId, customType, outcome])).slice(0, 32)}`;
}
function payloadRef(id: string): string { return `private:delivery-${id.slice(DELIVERY_ID_PREFIX.length)}`; }
function ownerRef(deps?: DelegationFoundationDependencies): string {
  const owner = deps?.owner;
  return hash(JSON.stringify(["delivery-owner-v1", owner?.host ?? "local", owner?.pid ?? process.pid, owner?.birth ?? "local", owner?.parentSessionId ?? "delivery"]));
}
function validLineageForCall(call: DispatchCallView, lineage: ActiveLineage): boolean {
  return lineageMatches(call, lineage) && call.activeLineageId === lineage.activeLineageId && call.activeBranchAnchor === lineage.activeBranchAnchor;
}
function safePayload(call: DispatchCallView): StoredDeliveryPayload {
  const outcome = call.finalOutcome!;
  const customType: DeliveryCustomType = outcome === "cancelled" ? "subagent-cancelled" : "subagent-recovery-completion";
  const id = deliveryId(call.dispatchCallId, customType, outcome);
  return {
    version: 1,
    customType,
    deliveryId: id,
    dispatchCallId: call.dispatchCallId,
    proofRef: proofRef(call.dispatchCallId),
    outcome,
    originalToolCallStatus: "interrupted",
    deliverySemantics: "at-most-once",
    safeRefs: [`call:${call.dispatchCallId}`, proofRef(call.dispatchCallId), `outcome:${outcome}`],
  };
}
function outboxFrom(view: InternalView): CustomOutboxView | undefined { return view.call?.customOutbox; }
function matchingCustomReceipts(entries: readonly HostPersistedBranchEntry[], call: DispatchCallView, outbox: CustomOutboxView): { matches: HostPersistedBranchEntry[]; integrity: boolean } {
  const sameDelivery = entries.filter((entry) => entry.role === "customMessage" && entry.deliveryId === outbox.deliveryId);
  const matches = sameDelivery.filter((entry) => entry.customType === outbox.customType && entry.dispatchCallId === call.dispatchCallId && entry.parentSessionId === call.parentSessionId && entry.activeLineageId === call.activeLineageId && entry.activeBranchAnchor === call.activeBranchAnchor && entry.proofRef === outbox.proofRef);
  const integrity = sameDelivery.some((entry) => !matches.includes(entry)) || matches.some((entry) => !SAFE_REF.test(entry.entryRef));
  return { matches, integrity };
}
function validateDeliveryPayload(payload: unknown, call: DispatchCallView, outbox: CustomOutboxView): payload is StoredDeliveryPayload {
  return !!payload && typeof payload === "object" && !Array.isArray(payload) &&
    JSON.stringify(payload) === JSON.stringify({ version: 1, customType: outbox.customType, deliveryId: outbox.deliveryId, dispatchCallId: call.dispatchCallId, proofRef: outbox.proofRef, outcome: outbox.outcome, originalToolCallStatus: "interrupted", deliverySemantics: "at-most-once", safeRefs: [`call:${call.dispatchCallId}`, outbox.proofRef, `outcome:${outbox.outcome}`] });
}
async function scanEntries(adapter: DeliveryHostAdapter | undefined, lineage: ActiveLineage, entries?: readonly HostPersistedBranchEntry[]): Promise<readonly HostPersistedBranchEntry[] | undefined> {
  if (entries) return entries;
  if (!adapter) return undefined;
  return adapter.scanActiveBranch(lineage);
}

/** Must be called while the Call lock is held. */
export async function ensureInterruptedDeliveryPendingLocked(rootDir: string, view: InternalView, deps: DelegationFoundationDependencies = {}): Promise<InternalView> {
  if (!view.call || view.integrity || view.call.state !== "final" || view.call.originalToolCallStatus !== "interrupted" || view.call.customOutbox || !view.call.finalOutcome) return view;
  const payload = safePayload(view.call);
  const d = { ...payload };
  await writePrivate(privatePayload(dirs(rootDir), payloadRef(payload.deliveryId).slice(8)), d);
  await appendWal(rootDir, view.call.dispatchCallId, "delivery_pending", { deliveryId: payload.deliveryId, customType: payload.customType, payloadRef: payloadRef(payload.deliveryId), proofRef: payload.proofRef, outcome: payload.outcome, originalToolCallStatus: payload.originalToolCallStatus, deliverySemantics: payload.deliverySemantics }, undefined, deps);
  return (await loadView(rootDir, view.call.dispatchCallId));
}

export interface StatusQueryResult {
  state: "ok" | "rejected" | "paused_integrity" | "busy";
  dispatchCallId: string;
  originalToolCallStatus?: "running" | "interrupted";
  normalToolResultStatus?: "unobserved" | "observed";
  customOutbox?: Omit<CustomOutboxView, "payloadRef" | "ownerRef"> & { payloadRef?: string };
  integrityReason?: string;
}
function statusProjection(view: InternalView): StatusQueryResult {
  if (view.integrity) return { state: "paused_integrity", dispatchCallId: view.integrity.callId, integrityReason: "delivery identity or WAL integrity cannot be proven" };
  const call = view.call;
  if (!call) return { state: "rejected", dispatchCallId: "unknown" };
  const outbox = call.customOutbox;
  return {
    state: call.state === "paused_integrity" ? "paused_integrity" : "ok",
    dispatchCallId: call.dispatchCallId,
    originalToolCallStatus: call.originalToolCallStatus,
    normalToolResultStatus: call.normalToolResultStatus,
    ...(outbox ? { customOutbox: { deliveryId: outbox.deliveryId, customType: outbox.customType, status: outbox.status, proofRef: outbox.proofRef, outcome: outbox.outcome, ...(outbox.payloadRef ? { payloadRef: outbox.payloadRef } : {}) } } : {}),
    ...(call.state === "paused_integrity" ? { integrityReason: "delivery identity or WAL integrity cannot be proven" } : {}),
  };
}

type NormalObservationCheck =
  | { kind: "none" }
  | { kind: "integrity"; reason: string }
  | { kind: "match"; entry: HostPersistedBranchEntry };

async function inspectNormalObservation(rootDir: string, view: InternalView, lineage: ActiveLineage, entries: readonly HostPersistedBranchEntry[] | undefined): Promise<NormalObservationCheck> {
  const call = view.call;
  if (!call || !validLineageForCall(call, lineage) || call.originalToolCallStatus !== "running" || call.normalToolResultStatus === "observed" || call.state !== "final" || !entries) return { kind: "none" };
  let payload: { originalToolCallId: string };
  try {
    const privateCall = await readPrivate<{ originalToolCallId?: string; toolCallId?: string }>(privatePayload(dirs(rootDir), call.privatePayloadRef.slice(8)));
    if (typeof privateCall.originalToolCallId !== "string" || privateCall.originalToolCallId.length === 0 || privateCall.originalToolCallId !== privateCall.toolCallId) throw new Error("original tool identity mismatch");
    payload = { originalToolCallId: privateCall.originalToolCallId };
  } catch { return { kind: "integrity", reason: "original tool identity cannot be proven" }; }
  const proof = proofRef(call.dispatchCallId);
  const related = entries.filter((entry) => entry.role === "toolResult" && (
    (entry.dispatchCallId === call.dispatchCallId && entry.parentSessionId === call.parentSessionId && entry.activeLineageId === call.activeLineageId && entry.activeBranchAnchor === call.activeBranchAnchor && entry.proofRef === proof) ||
    entry.toolCallId === payload.originalToolCallId || entry.toolCallIdHash === call.toolCallIdHash
  ));
  if (related.length === 0) return { kind: "none" };
  const valid = related.filter((entry) => typeof entry.entryRef === "string" && entry.entryRef.length > 0 && SAFE_REF.test(entry.entryRef) && entry.toolCallId === payload.originalToolCallId && (entry.toolCallIdHash === undefined || entry.toolCallIdHash === call.toolCallIdHash) && entry.parentSessionId === call.parentSessionId && entry.activeLineageId === call.activeLineageId && entry.activeBranchAnchor === call.activeBranchAnchor && entry.dispatchCallId === call.dispatchCallId && entry.proofRef === proof);
  if (related.some((entry) => !valid.includes(entry)) || valid.length > 1) return { kind: "integrity", reason: "normal tool result identity is ambiguous" };
  return valid.length === 1 ? { kind: "match", entry: valid[0]! } : { kind: "none" };
}

async function scanForStatus(adapter: DeliveryHostAdapter | undefined, lineage: ActiveLineage, entries?: readonly HostPersistedBranchEntry[]): Promise<readonly HostPersistedBranchEntry[] | undefined> {
  if (entries) return entries;
  if (!adapter) return undefined;
  return scanEntries(adapter, lineage);
}

export async function querySubagentStatusInternal(rootDir: string, dispatchCallId: string, lineage: ActiveLineage, entries?: readonly HostPersistedBranchEntry[], deps: DelegationFoundationDependencies = {}): Promise<StatusQueryResult> {
  // First perform a genuinely read-only pass.  Only a strict, already-host-
  // persisted normal result is allowed to enter the call lock and append its
  // derived observation fact.
  let view = await loadViewReadOnly(rootDir, dispatchCallId);
  if (view.integrity) return statusProjection(view);
  if (!view.call || !validLineageForCall(view.call, lineage)) return { state: "rejected", dispatchCallId };
  let scanned: readonly HostPersistedBranchEntry[] | undefined;
  try { scanned = await scanForStatus(deps.deliveryHostAdapter, lineage, entries); } catch { return { state: "paused_integrity", dispatchCallId, integrityReason: "active branch scan cannot be proven" }; }
  const initial = await inspectNormalObservation(rootDir, view, lineage, scanned);
  if (initial.kind === "integrity") return { state: "paused_integrity", dispatchCallId, integrityReason: initial.reason };
  if (initial.kind === "none") return statusProjection(view);

  const result = await withCallLock(rootDir, dispatchCallId, async () => {
    view = await loadViewReadOnly(rootDir, dispatchCallId);
    if (view.integrity) return statusProjection(view);
    if (!view.call || !validLineageForCall(view.call, lineage)) return { state: "rejected" as const, dispatchCallId };
    try { scanned = await scanForStatus(deps.deliveryHostAdapter, lineage, entries); } catch { return { state: "paused_integrity" as const, dispatchCallId, integrityReason: "active branch scan cannot be proven" }; }
    const current = await inspectNormalObservation(rootDir, view, lineage, scanned);
    if (current.kind === "integrity") return { state: "paused_integrity" as const, dispatchCallId, integrityReason: current.reason };
    if (current.kind === "none") return statusProjection(view);
    try {
      await appendWalStrictNoRepair(rootDir, dispatchCallId, "normal_tool_result_observed", { toolCallIdHash: view.call.toolCallIdHash, hostEntryRef: current.entry.entryRef, proofRef: proofRef(dispatchCallId), observedAt: now(deps), activeLineageId: view.call.activeLineageId, activeBranchAnchor: view.call.activeBranchAnchor }, undefined, deps);
    } catch (error) {
      return { state: "paused_integrity" as const, dispatchCallId, integrityReason: error instanceof Error ? error.message : "normal observation WAL integrity cannot be proven" };
    }
    // Do not materialize from a status/query path. The WAL fact itself is the
    // only permitted write; a later maintenance/read path may project it.
    return statusProjection(await loadViewReadOnly(rootDir, dispatchCallId));
  });
  return result ?? { state: "busy", dispatchCallId };
}

async function claimDeliveryOwnerLocked(rootDir: string, view: InternalView, deps: DelegationFoundationDependencies): Promise<InternalView> {
  const call = view.call!; const outbox = outboxFrom(view)!; const ref = ownerRef(deps);
  if (outbox.ownerRef === ref && outbox.ownerGeneration !== undefined && outbox.fencingGeneration !== undefined) return view;
  const ownerGeneration = (outbox.ownerGeneration ?? 0) + 1;
  const fencingGeneration = (outbox.fencingGeneration ?? -1) + 1;
  await appendWal(rootDir, call.dispatchCallId, "delivery_owner_claimed", { deliveryId: outbox.deliveryId, ownerRef: ref, ownerGeneration, fencingGeneration, ...(outbox.ownerGeneration === undefined ? {} : { previousOwnerGeneration: outbox.ownerGeneration }) }, undefined, deps);
  return loadView(rootDir, call.dispatchCallId);
}
async function receiptScan(adapter: DeliveryHostAdapter | undefined, lineage: ActiveLineage, call: DispatchCallView, outbox: CustomOutboxView, entries?: readonly HostPersistedBranchEntry[]) {
  const scanned = await scanEntries(adapter, lineage, entries);
  if (!scanned) return { entries: undefined, matches: [], integrity: false };
  const receipt = matchingCustomReceipts(scanned, call, outbox);
  return { entries: scanned, matches: receipt.matches, integrity: receipt.integrity };
}

async function executeDeliveryLocked(rootDir: string, dispatchCallId: string, deliveryIdValue: string, lineage: ActiveLineage, adapter: DeliveryHostAdapter | undefined, entries: readonly HostPersistedBranchEntry[] | undefined, deps: DelegationFoundationDependencies): Promise<Record<string, unknown>> {
  let view = await loadView(rootDir, dispatchCallId);
  if (view.integrity || !view.call || !validLineageForCall(view.call, lineage)) return { state: "rejected", dispatchCallId };
  if (view.call.state === "paused_integrity") return { state: "paused_integrity", dispatchCallId, sendCount: 0 };
  let outbox = outboxFrom(view);
  if (!outbox || outbox.deliveryId !== deliveryIdValue) return { state: "rejected", dispatchCallId, reason: "delivery not found" };
  if (["receipted", "abandoned", "uncertain"].includes(outbox.status)) return { state: outbox.status, deliveryId: outbox.deliveryId, sendCount: 0 };
  if (!adapter) return { state: outbox.status, deliveryId: outbox.deliveryId, sendCount: 0 };
  let scan = await receiptScan(adapter, lineage, view.call, outbox, entries);
  if (scan.integrity) { await appendWal(rootDir, dispatchCallId, "delivery_integrity_paused", { deliveryId: outbox.deliveryId, reason: "multiple or mismatched custom receipts" }, undefined, deps); return { state: "paused_integrity", deliveryId: outbox.deliveryId, sendCount: 0 }; }
  view = await claimDeliveryOwnerLocked(rootDir, view, deps); outbox = outboxFrom(view)!;
  scan = await receiptScan(adapter, lineage, view.call!, outbox, entries);
  if (scan.integrity) { await appendWal(rootDir, dispatchCallId, "delivery_integrity_paused", { deliveryId: outbox.deliveryId, reason: "multiple or mismatched custom receipts" }, undefined, deps); return { state: "paused_integrity", deliveryId: outbox.deliveryId, sendCount: 0 }; }
  if (scan.matches.length === 1) {
    await appendWal(rootDir, dispatchCallId, "delivery_receipted", { deliveryId: outbox.deliveryId, ownerRef: outbox.ownerRef, ownerGeneration: outbox.ownerGeneration, fencingGeneration: outbox.fencingGeneration }, undefined, deps);
    await materialize(rootDir, await loadView(rootDir, dispatchCallId));
    return { state: "receipted", deliveryId: outbox.deliveryId, sendCount: 0 };
  }
  if (outbox.status === "sending") {
    await appendWal(rootDir, dispatchCallId, "delivery_uncertain", { deliveryId: outbox.deliveryId, ownerRef: outbox.ownerRef, ownerGeneration: outbox.ownerGeneration, fencingGeneration: outbox.fencingGeneration }, undefined, deps);
    await materialize(rootDir, await loadView(rootDir, dispatchCallId));
    return { state: "uncertain", deliveryId: outbox.deliveryId, sendCount: 0 };
  }
  const latest = await loadView(rootDir, dispatchCallId); const current = outboxFrom(latest);
  if (!current || current.status !== "pending" || current.ownerRef !== outbox.ownerRef || current.ownerGeneration !== outbox.ownerGeneration || current.fencingGeneration !== outbox.fencingGeneration) return { state: current?.status ?? "rejected", deliveryId: deliveryIdValue, sendCount: 0 };
  await appendWal(rootDir, dispatchCallId, "delivery_sending", { deliveryId: current.deliveryId, ownerRef: current.ownerRef, ownerGeneration: current.ownerGeneration, fencingGeneration: current.fencingGeneration }, undefined, deps);
  const sending = await loadView(rootDir, dispatchCallId); const sendingOutbox = outboxFrom(sending)!;
  let payload: StoredDeliveryPayload;
  try {
    payload = await readPrivate<StoredDeliveryPayload>(privatePayload(dirs(rootDir), sendingOutbox.payloadRef.slice(8)));
    if (!validateDeliveryPayload(payload, sending.call!, sendingOutbox)) throw new Error("delivery payload binding cannot be proven");
  } catch { await appendWal(rootDir, dispatchCallId, "delivery_uncertain", { deliveryId: sendingOutbox.deliveryId, ownerRef: sendingOutbox.ownerRef, ownerGeneration: sendingOutbox.ownerGeneration, fencingGeneration: sendingOutbox.fencingGeneration }, undefined, deps); return { state: "uncertain", deliveryId: deliveryIdValue, sendCount: 0 }; }
  if (!adapter) return { state: "sending", deliveryId: deliveryIdValue, sendCount: 0 };
  try { await adapter.appendCustomMessage(payload, lineage); } catch { await appendWal(rootDir, dispatchCallId, "delivery_uncertain", { deliveryId: sendingOutbox.deliveryId, ownerRef: sendingOutbox.ownerRef, ownerGeneration: sendingOutbox.ownerGeneration, fencingGeneration: sendingOutbox.fencingGeneration }, undefined, deps); return { state: "uncertain", deliveryId: deliveryIdValue, sendCount: 1 }; }
  const after = await loadView(rootDir, dispatchCallId); const afterOutbox = outboxFrom(after);
  if (!afterOutbox || afterOutbox.status !== "sending" || afterOutbox.ownerRef !== sendingOutbox.ownerRef || afterOutbox.ownerGeneration !== sendingOutbox.ownerGeneration || afterOutbox.fencingGeneration !== sendingOutbox.fencingGeneration) return { state: "stale", deliveryId: deliveryIdValue, sendCount: 1, walWrites: 0 };
  const post = await receiptScan(adapter, lineage, after.call!, afterOutbox);
  if (post.integrity) { await appendWal(rootDir, dispatchCallId, "delivery_integrity_paused", { deliveryId: deliveryIdValue, reason: "multiple or mismatched custom receipts" }, undefined, deps); return { state: "paused_integrity", deliveryId: deliveryIdValue, sendCount: 1 }; }
  if (post.matches.length !== 1) { await appendWal(rootDir, dispatchCallId, "delivery_uncertain", { deliveryId: deliveryIdValue, ownerRef: afterOutbox.ownerRef, ownerGeneration: afterOutbox.ownerGeneration, fencingGeneration: afterOutbox.fencingGeneration }, undefined, deps); return { state: "uncertain", deliveryId: deliveryIdValue, sendCount: 1 }; }
  await appendWal(rootDir, dispatchCallId, "delivery_receipted", { deliveryId: deliveryIdValue, ownerRef: afterOutbox.ownerRef, ownerGeneration: afterOutbox.ownerGeneration, fencingGeneration: afterOutbox.fencingGeneration }, undefined, deps);
  await materialize(rootDir, await loadView(rootDir, dispatchCallId));
  return { state: "receipted", deliveryId: deliveryIdValue, sendCount: 1 };
}

export async function executeDeliveryInternal(rootDir: string, dispatchCallId: string, deliveryIdValue: string, lineage: ActiveLineage, adapter: DeliveryHostAdapter | undefined, deps: DelegationFoundationDependencies = {}) {
  const result = await withCallLock(rootDir, dispatchCallId, async () => executeDeliveryLocked(rootDir, dispatchCallId, deliveryIdValue, lineage, adapter, undefined, deps));
  return result ?? { state: "busy", dispatchCallId, deliveryId: deliveryIdValue, sendCount: 0 };
}

export async function reconcileDeliveryStartupInternal(rootDir: string, dispatchCallId: string, lineage: ActiveLineage, adapter: DeliveryHostAdapter | undefined, deps: DelegationFoundationDependencies = {}) {
  const result = await withCallLock(rootDir, dispatchCallId, async () => {
    const view = await loadView(rootDir, dispatchCallId); const outbox = outboxFrom(view);
    if (!outbox || !validLineageForCall(view.call!, lineage)) return { state: "rejected", dispatchCallId, sendCount: 0 };
    if (outbox.status === "sending") {
      const scan = await receiptScan(adapter, lineage, view.call!, outbox);
      if (scan.integrity) { await appendWal(rootDir, dispatchCallId, "delivery_integrity_paused", { deliveryId: outbox.deliveryId, reason: "multiple or mismatched custom receipts" }, undefined, deps); return { state: "paused_integrity", dispatchCallId, sendCount: 0 }; }
      if (scan.matches.length === 1) { await appendWal(rootDir, dispatchCallId, "delivery_receipted", { deliveryId: outbox.deliveryId, ownerRef: outbox.ownerRef, ownerGeneration: outbox.ownerGeneration, fencingGeneration: outbox.fencingGeneration }, undefined, deps); return { state: "receipted", dispatchCallId, sendCount: 0 }; }
      await appendWal(rootDir, dispatchCallId, "delivery_uncertain", { deliveryId: outbox.deliveryId, ownerRef: outbox.ownerRef, ownerGeneration: outbox.ownerGeneration, fencingGeneration: outbox.fencingGeneration }, undefined, deps); return { state: "uncertain", dispatchCallId, sendCount: 0 };
    }
    if (outbox.status === "pending") return executeDeliveryLocked(rootDir, dispatchCallId, outbox.deliveryId, lineage, adapter, undefined, deps);
    return { state: outbox.status, dispatchCallId, sendCount: 0 };
  });
  return result ?? { state: "busy", dispatchCallId, sendCount: 0 };
}

export async function requestDeliveryAbandonInternal(rootDir: string, dispatchCallId: string, deliveryIdValue: string, action: string, actor: CancelActor, deps: DelegationFoundationDependencies = {}): Promise<DeliveryAbandonReceipt | { state: "paused_integrity" | "busy" | "rejected"; reason?: string }> {
  if (action !== "abandon") return { state: "rejected", reason: "delivery action schema only permits abandon" };
  const result = await withCallLock(rootDir, dispatchCallId, async () => {
    const view = await loadView(rootDir, dispatchCallId); const call = view.call; const outbox = outboxFrom(view);
    if (view.integrity) return { state: "paused_integrity" as const, reason: "WAL integrity cannot be proven" };
    if (!call || !outbox || outbox.deliveryId !== deliveryIdValue || !validLineageForCall(call, deps.lineage ?? ({ parentSessionId: "", activeLineageId: "", activeBranchAnchor: "", currentLeafId: "", branchIds: [], persistence: "in_process_only" } as ActiveLineage))) return { state: "rejected" as const, reason: "delivery actor lineage cannot be proven" };
    if (!actor || actor.parentSessionId !== call.parentSessionId || actor.activeLineageId !== call.activeLineageId || actor.activeBranchAnchor !== call.activeBranchAnchor) return { state: "rejected" as const, reason: "delivery actor lineage cannot be proven" };
    const ref = actorRef(actor);
    if (["receipted"].includes(outbox.status)) return { dispatchCallId, deliveryId: deliveryIdValue, actorRef: ref, status: "receipted" as const };
    if (outbox.status === "abandoned") return { dispatchCallId, deliveryId: deliveryIdValue, actorRef: ref, status: "already_abandoned" as const };
    await appendWal(rootDir, dispatchCallId, "delivery_abandoned", { deliveryId: deliveryIdValue, actorRef: ref, parentSessionId: actor.parentSessionId, activeLineageId: actor.activeLineageId, activeBranchAnchor: actor.activeBranchAnchor, abandonedAt: now(deps), noFutureSend: true }, undefined, deps);
    const abandoned = await loadView(rootDir, dispatchCallId); const event = abandoned.events.find((item) => item.type === "delivery_abandoned");
    await materialize(rootDir, abandoned);
    return { dispatchCallId, deliveryId: deliveryIdValue, actorRef: ref, walSeq: event?.seq, status: "abandoned" as const };
  });
  return result ?? { state: "busy" };
}

export function deterministicDeliveryId(dispatchCallId: string, outcome: DeliveryOutcome): string { return deliveryId(dispatchCallId, outcome === "cancelled" ? "subagent-cancelled" : "subagent-recovery-completion", outcome); }
export function deliveryProofRef(dispatchCallId: string): string { return proofRef(dispatchCallId); }
