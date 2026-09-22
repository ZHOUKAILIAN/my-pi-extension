/** Gated internal delete/retention lifecycle. WAL is the recovery truth; files
 * are pruned only after a durable owner-fenced transition. */
import * as fs from "node:fs/promises";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  appendWalStrictNoRepair, callPayload, dirs, hash, loadViewReadOnly, materialize,
  privatePayload, proofPath, readActorScopeSecret, readDelegationPayload, withCallLock,
} from "./delegation-context.ts";
import { aggregateSlotDigest, cleanupReferenceOrderDigest, isCallTerminal } from "./wal-replay.ts";
import { hasUnresolvedActionForCall, hasUnresolvedActionForDelegation } from "./action-predicate.ts";
import { observeCustomReceiptLockedInternal, querySubagentStatusLockedInternal } from "./delivery.ts";
import { lineageMatches, type ActiveLineage } from "./lineage.ts";
import { ownerFileSync, ownerDirectorySync, syncDirectory, atomicOwnerJson } from "./secure-fs.ts";
import type {
  CallAggregateProof, DeleteActor, DeleteReceipt, DeleteTrigger, DelegationFoundationDependencies,
  DispatchCallView, InternalDelegation, InternalView, RetentionEligibility,
} from "./delegation-types.ts";

export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const HEX = /^[0-9a-f]{64}$/;
const PRIVATE_REF = /^private:[A-Za-z0-9._:-]+$/;
const BLOCKED_CUSTOM = new Set(["pending", "sending", "uncertain"]);
class CleanupIntegrityError extends Error {}

type ObjectKind = "call" | "delegation";
function validActor(actor: unknown): actor is DeleteActor {
  return !!actor && typeof actor === "object" && !Array.isArray(actor) &&
    Object.keys(actor).length === 3 && Object.values(actor as Record<string, unknown>).every((value) => typeof value === "string" && value.length > 0);
}
function prefixed(parts: readonly string[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) { const bytes = Buffer.from(part, "utf8"); const length = Buffer.allocUnsafe(4); length.writeUInt32BE(bytes.byteLength, 0); chunks.push(length, bytes); }
  return Buffer.concat(chunks);
}
export function computeActorScopeTag(secret: Uint8Array | string, actor: DeleteActor, objectId: string): string {
  const key = typeof secret === "string" ? Buffer.from(secret, "utf8") : Buffer.from(secret);
  return createHmac("sha256", key).update(prefixed([actor.parentSessionId, actor.activeLineageId, objectId, "1"])).digest("hex");
}
function constantTimeEquals(left: unknown, right: unknown): boolean {
  if (typeof left !== "string" || typeof right !== "string" || !HEX.test(left) || !HEX.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
function secretFor(rootDir: string, _deps: DelegationFoundationDependencies): Buffer | undefined {
  return readActorScopeSecret(rootDir);
}
function fallbackLineage(call: DispatchCallView): ActiveLineage {
  return { parentSessionId: call.parentSessionId, activeLineageId: call.activeLineageId, activeBranchAnchor: call.activeBranchAnchor, currentLeafId: call.activeBranchAnchor, branchIds: [call.activeBranchAnchor], persistence: "in_process_only" };
}
function actorFor(call: DispatchCallView): DeleteActor {
  return { parentSessionId: call.parentSessionId, activeLineageId: call.activeLineageId, activeBranchAnchor: call.activeBranchAnchor };
}
function objectHash(id: string): string { return hash(id); }
function journalPath(rootDir: string, kind: ObjectKind, id: string): string { return path.join(dirs(rootDir).cleanupJournal, `${hash(`${kind}:${id}`)}.json`); }
function tombstonePath(rootDir: string, kind: ObjectKind, id: string): string { return path.join(dirs(rootDir).tombstones, `${objectHash(id)}.json`); }
function now(deps?: DelegationFoundationDependencies): Date { const date = deps?.now?.() ?? new Date(); if (!Number.isFinite(date.getTime())) throw new CleanupIntegrityError("invalid cleanup clock"); return date; }
function nowIso(deps?: DelegationFoundationDependencies): string { return now(deps).toISOString(); }
function strictLoad(rootDir: string, callId: string): Promise<InternalView> { return loadViewReadOnly(rootDir, callId); }
function validStartupLineage(value: ActiveLineage | undefined): value is ActiveLineage {
  if (!value || typeof value.parentSessionId !== "string" || value.parentSessionId.length === 0 || typeof value.activeLineageId !== "string" || value.activeLineageId.length === 0 || typeof value.activeBranchAnchor !== "string" || value.activeBranchAnchor.length === 0 || typeof value.currentLeafId !== "string" || value.currentLeafId.length === 0 || !Array.isArray(value.branchIds) || value.branchIds.length === 0 || value.branchIds.at(-1) !== value.currentLeafId || !value.branchIds.every((id) => typeof id === "string" && id.length > 0) || new Set(value.branchIds).size !== value.branchIds.length || !value.branchIds.includes(value.activeBranchAnchor) || !["restart-durable", "in_process_only"].includes(value.persistence)) return false;
  return value.parentSessionFile === undefined || typeof value.parentSessionFile === "string";
}
function strictAppend(rootDir: string, callId: string, type: string, data: Record<string, unknown>, delegationId: string | undefined, deps: DelegationFoundationDependencies): Promise<void> {
  return appendWalStrictNoRepair(rootDir, callId, type, data, delegationId, deps);
}

async function resolveTarget(rootDir: string, target: string): Promise<{ callId: string; delegationId?: string } | undefined> {
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(target)) return undefined;
  const d = dirs(rootDir);
  try {
    const stat = await fs.lstat(path.join(d.wal, `${target}.jsonl`));
    if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && ownerFileSync(path.join(d.wal, `${target}.jsonl`))) {
      const view = await strictLoad(rootDir, target);
      if (view.call?.dispatchCallId === target || view.integrity?.callId === target) return { callId: target };
    }
  } catch { /* scan below without mutating the store */ }
  let names: string[];
  try { names = (await fs.readdir(d.wal)).filter((name) => name.endsWith(".jsonl")); } catch { return undefined; }
  for (const name of names.sort()) {
    const callId = name.slice(0, -6); const view = await strictLoad(rootDir, callId);
    if (view.delegations.has(target)) return { callId, delegationId: target };
  }
  return undefined;
}
function persistedTag(view: InternalView, kind: ObjectKind, id: string): string | undefined {
  const types = kind === "call" ? ["call_cleanup_requested", "retention_eligible", "call_tombstone_written"] : ["delegation_delete_planned", "delegation_delete_requested", "delegation_cleanup_requested", "delegation_tombstone_written"];
  return view.events.filter((event) => types.includes(event.type) && (!event.delegationId || event.delegationId === id)).at(-1)?.data.actorScopeTag as string | undefined;
}
function plannedTombstone(view: InternalView, kind: ObjectKind, id: string): Record<string, unknown> | undefined {
  const types = kind === "call" ? ["call_cleanup_requested"] : ["delegation_delete_planned", "delegation_delete_requested", "delegation_cleanup_requested"];
  const value = view.events.filter((event) => types.includes(event.type) && (!event.delegationId || event.delegationId === id)).find((event) => kind === "delegation" && event.type === "delegation_delete_planned")?.data
    ?? view.events.filter((event) => types.includes(event.type) && (!event.delegationId || event.delegationId === id)).at(-1)?.data;
  if (!value || value.idHash !== objectHash(id) || value.objectKind !== kind || value.schemaVersion !== 1 || value.status !== "deleted" || typeof value.deletedAt !== "string" || !Number.isFinite(Date.parse(value.deletedAt)) || typeof value.actorScopeTag !== "string") return undefined;
  return tombstoneValue(kind, id, value.actorScopeTag, value.deletedAt);
}
function delegationDeletePlan(view: InternalView, delegationId: string): Record<string, unknown> | undefined {
  return view.events.find((event) => event.type === "delegation_delete_planned" && event.delegationId === delegationId)?.data;
}
function tombstoneValue(kind: ObjectKind, id: string, tag: string, deletedAt: string): Record<string, unknown> {
  return { idHash: objectHash(id), objectKind: kind, schemaVersion: 1, deletedAt, status: "deleted", actorScopeTag: tag };
}
function exactTombstone(value: unknown, expected: Record<string, unknown>): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join(",") === Object.keys(expected).sort().join(",") && JSON.stringify(record) === JSON.stringify(expected);
}
async function readTombstone(rootDir: string, kind: ObjectKind, id: string, expectedTag: string, expectedEvent?: Record<string, unknown>): Promise<boolean> {
  const file = tombstonePath(rootDir, kind, id);
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !ownerFileSync(file)) throw new CleanupIntegrityError("unsafe tombstone");
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    if (!constantTimeEquals((value as Record<string, unknown>).actorScopeTag, expectedTag)) throw new CleanupIntegrityError("tombstone actor mismatch");
    if (expectedEvent) return exactTombstone(value, expectedEvent);
    return value.objectKind === kind && value.idHash === objectHash(id) && value.schemaVersion === 1 && value.status === "deleted" && Object.keys(value).length === 6;
  } catch (error) {
    if (error instanceof CleanupIntegrityError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function writeTombstone(rootDir: string, kind: ObjectKind, id: string, tag: string, deletedAt: string): Promise<void> {
  const expected = tombstoneValue(kind, id, tag, deletedAt); const file = tombstonePath(rootDir, kind, id);
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !ownerFileSync(file)) throw new CleanupIntegrityError("unsafe tombstone");
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    if (!exactTombstone(value, expected)) throw new CleanupIntegrityError("tombstone conflict");
    return;
  } catch (error) { if (error instanceof CleanupIntegrityError) throw error; if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await atomicOwnerJson(file, expected);
}
async function writeJournal(rootDir: string, kind: ObjectKind, id: string, value: Record<string, unknown>): Promise<void> {
  await atomicOwnerJson(journalPath(rootDir, kind, id), { version: 1, objectKind: kind, objectId: id, ...value });
}
async function secureUnlink(file: string): Promise<boolean> {
  let stat: nodeFs.Stats; try { stat = await fs.lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !ownerFileSync(file)) throw new CleanupIntegrityError(`unsafe cleanup file: ${path.basename(file)}`);
  await fs.unlink(file); await syncDirectory(path.dirname(file)); return true;
}
async function secureRemoveDirectory(directory: string): Promise<boolean> {
  let stat: nodeFs.Stats; try { stat = await fs.lstat(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.nlink !== 1 || !ownerDirectorySync(directory)) throw new CleanupIntegrityError(`unsafe cleanup directory: ${path.basename(directory)}`);
  for (const entry of await fs.readdir(directory)) { const child = path.join(directory, entry); const childStat = await fs.lstat(child); if (childStat.isSymbolicLink() || childStat.nlink !== 1 || !ownerFileSync(child)) throw new CleanupIntegrityError(`unsafe cleanup child: ${entry}`); await fs.unlink(child); }
  await fs.rmdir(directory); await syncDirectory(path.dirname(directory)); return true;
}
function actionIds(view: InternalView, delegationIds: readonly string[]): string[] {
  const selected = new Set(delegationIds); const ids = new Set<string>();
  for (const [id, action] of view.actions ?? []) if (selected.has(action.delegationId) && /^action:[0-9a-f]{64}$/.test(id)) ids.add(id);
  for (const event of view.events) {
    if (!event.delegationId || !selected.has(event.delegationId)) continue;
    for (const field of ["actionId", "logicalActionId"]) { const value = event.data[field]; if (typeof value === "string" && /^action:[0-9a-f]{64}$/.test(value)) ids.add(value); }
  }
  return [...ids].sort();
}
function knownPrivateFiles(rootDir: string, view: InternalView, delegationIds: readonly string[], includeCall: boolean): string[] {
  const refs = new Set<string>(); const selected = new Set(delegationIds);
  if (includeCall && view.call?.privatePayloadRef) refs.add(view.call.privatePayloadRef);
  for (const id of delegationIds) { const item = view.delegations.get(id); if (item?.privatePayloadRef) refs.add(item.privatePayloadRef); }
  for (const event of view.events) {
    const belongs = includeCall || (event.delegationId !== undefined && selected.has(event.delegationId));
    if (!belongs) continue;
    for (const field of ["auditRef", "revisionRef", "payloadRef", "privateRef", "resultPrivateRef"]) {
      const value = event.data[field]; if (typeof value === "string" && PRIVATE_REF.test(value)) refs.add(value);
    }
  }
  const files = [...refs].filter((ref) => PRIVATE_REF.test(ref)).map((ref) => privatePayload(dirs(rootDir), ref.slice("private:".length)));
  for (const actionId of actionIds(view, delegationIds)) {
    const suffix = actionId.slice("action:".length); files.push(privatePayload(dirs(rootDir), `action-${suffix}`), privatePayload(dirs(rootDir), `action-${suffix}-result`));
  }
  return [...new Set(files)];
}
async function pruneKnown(rootDir: string, view: InternalView, delegationIds: readonly string[], includeCall: boolean): Promise<void> {
  for (const file of knownPrivateFiles(rootDir, view, delegationIds, includeCall)) await secureUnlink(file);
  for (const id of delegationIds) {
    await secureRemoveDirectory(path.join(rootDir, "v2", "sessions", id));
    await secureRemoveDirectory(path.join(rootDir, "v2", "fences", id));
    await secureUnlink(path.join(dirs(rootDir).delegations, `${id}.json`));
  }
  if (includeCall && view.call) await secureUnlink(path.join(dirs(rootDir).calls, `${view.call.dispatchCallId}.json`));
}
function stableProof(view: InternalView): CallAggregateProof {
  const call = view.call!; const finalizedAt = String(view.events.find((event) => event.type === "call_finalized")?.data.finalizedAt);
  return { version: 1, dispatchCallId: call.dispatchCallId, mode: call.mode, slots: call.slots.slice().sort((a, b) => a.order - b.order).map((slot) => ({ index: slot.index, order: slot.order, state: slot.state, ...(slot.delegationId ? { delegationId: slot.delegationId } : {}), ...(slot.terminalOutcome ? { terminalOutcome: slot.terminalOutcome } : {}), ...(slot.resultRef !== undefined ? { resultRef: slot.resultRef } : {}), ...(slot.cancelSettlement ? { cancelSettlement: slot.cancelSettlement } : {}) })), outcome: call.finalOutcome!, createdAt: String(view.events.find((event) => event.type === "call_admitted")?.data.createdAt), finalizedAt };
}
function validProof(value: unknown, expected: CallAggregateProof): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(value) !== JSON.stringify(expected)) return false;
  const record = value as Record<string, unknown>; return Object.keys(record).sort().join(",") === "createdAt,dispatchCallId,finalizedAt,mode,outcome,slots,version";
}
async function ensureProof(rootDir: string, view: InternalView, deps: DelegationFoundationDependencies): Promise<InternalView> {
  if (!view.call || view.call.state !== "final" || !view.call.finalOutcome) throw new CleanupIntegrityError("Call Aggregate Proof requires a final Call");
  const proof = stableProof(view); if (!HEX.test(aggregateSlotDigest(view.call))) throw new CleanupIntegrityError("proof slot digest invalid");
  const file = proofPath(dirs(rootDir), view.call.dispatchCallId); const proofEventExists = view.events.some((event) => event.type === "call_aggregate_proof_created"); let existing: unknown;
  try {
    const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !ownerFileSync(file)) throw new CleanupIntegrityError("unsafe Call Aggregate Proof");
    existing = JSON.parse(await fs.readFile(file, "utf8")); if (!validProof(existing, proof)) throw new CleanupIntegrityError("Call Aggregate Proof conflicts with replay");
  } catch (error) { if (error instanceof CleanupIntegrityError) throw error; if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; if (proofEventExists) throw new CleanupIntegrityError("durable Call Aggregate Proof file is missing"); await atomicOwnerJson(file, proof); }
  let current = await strictLoad(rootDir, view.call.dispatchCallId); if (current.integrity) throw new CleanupIntegrityError(current.integrity.reason);
  if (!current.events.some((event) => event.type === "call_aggregate_proof_created")) {
    await strictAppend(rootDir, view.call.dispatchCallId, "call_aggregate_proof_created", { proofRef: `proof:${view.call.dispatchCallId}`, slotDigest: aggregateSlotDigest(view.call), outcome: proof.outcome, createdAt: proof.createdAt, finalizedAt: proof.finalizedAt }, undefined, deps);
    current = await strictLoad(rootDir, view.call.dispatchCallId);
  }
  if (current.integrity) throw new CleanupIntegrityError(current.integrity.reason);
  return current;
}
function expectedDeliveryComplete(view: InternalView): boolean {
  const call = view.call; if (!call) return false;
  return call.originalToolCallStatus === "running" ? call.normalToolResultStatus === "observed" : !!call.customOutbox && ["receipted", "abandoned"].includes(call.customOutbox.status);
}
function activeClaimOrChild(delegation: InternalDelegation): boolean {
  const activeState = ["reserved", "admitted", "resolving", "resolution_ready", "bound", "initial_ready", "initial_running", "recovery_ready", "cycle_ready", "recovery_running", "reattach_only", "cancel_requested", "paused_configuration", "paused_integrity", "paused_uncertainty"].includes(delegation.state);
  return (activeState && !!delegation.owner) || !!delegation.childSessionId || !!delegation.childSessionPathHash || delegation.childPid !== undefined;
}
function blocker(view: InternalView, delegation?: InternalDelegation): string | undefined {
  if (!view.call || view.call.state !== "final" || !isCallTerminal(view)) return "call is not terminal";
  if (!expectedDeliveryComplete(view)) return "final delivery is not complete";
  if (view.call.customOutbox && BLOCKED_CUSTOM.has(view.call.customOutbox.status)) return "custom delivery is pending or uncertain";
  if (hasUnresolvedActionForCall(view)) return "an action is unresolved or uncertain";
  if (delegation) {
    if (delegation.state === "cancel_requested" || view.events.some((event) => event.type === "cancel_requested" && event.delegationId === delegation.delegationId && delegation.state !== "cancelled")) return "delegation cancellation is incomplete";
    if (activeClaimOrChild(delegation)) return "delegation has an active claim or child";
    if (hasUnresolvedActionForDelegation(view, delegation.delegationId)) return "delegation action is unresolved or uncertain";
    if (delegation.deleteRequested && !delegation.deleteCompleted) return "delegation cleanup is already in progress";
  }
  return undefined;
}
function requiredTerminal(view: InternalView): boolean { return !!view.call && view.call.slots.filter((slot) => slot.required).every((slot) => ["returned", "cancelled"].includes(slot.state)); }
/** Must be called while the Call lock is held. */
async function observeDeliveryBeforeCleanupLocked(rootDir: string, view: InternalView, deps: DelegationFoundationDependencies): Promise<InternalView> {
  if (!view.call || !deps.lineage || !deps.deliveryHostAdapter) return view;
  if (view.call.originalToolCallStatus === "running" && view.call.normalToolResultStatus !== "observed") await querySubagentStatusLockedInternal(rootDir, view.call.dispatchCallId, deps.lineage, undefined, deps);
  if (view.call.originalToolCallStatus === "interrupted" && view.call.customOutbox && !["receipted", "abandoned", "uncertain"].includes(view.call.customOutbox.status)) await observeCustomReceiptLockedInternal(rootDir, view.call.dispatchCallId, deps.lineage, deps.deliveryHostAdapter, deps);
  return strictLoad(rootDir, view.call.dispatchCallId);
}
function referenceIsReleased(view: InternalView, id: string): boolean {
  const delegation = view.delegations.get(id);
  if (!delegation) return false;
  const slot = view.call?.slots[delegation.slotIndex];
  const added = view.events.some((event) => event.type === "call_delegation_reference_added" && event.delegationId === id && Number(event.data.slotIndex) === delegation.slotIndex);
  const released = view.events.some((event) => event.type === "call_delegation_reference_released" && event.delegationId === id && event.data.delegationId === id && Number(event.data.slotIndex) === delegation.slotIndex && slot?.delegationId === id && event.data.proofRef === `proof:${view.call?.dispatchCallId}`);
  return added && released;
}
function validDelegationDeletePlan(view: InternalView, delegationId: string, actorScopeTag?: string): boolean {
  const call = view.call; const delegation = view.delegations.get(delegationId); const plan = delegationDeletePlan(view, delegationId);
  return !!call && !!delegation && !!plan && plan.delegationId === delegationId && Number(plan.slotIndex) === delegation.slotIndex && plan.proofRef === `proof:${call.dispatchCallId}` && plan.referenceOrderDigest === cleanupReferenceOrderDigest(call) && plan.idHash === objectHash(delegationId) && plan.objectKind === "delegation" && plan.schemaVersion === 1 && plan.status === "deleted" && typeof plan.deletedAt === "string" && Number.isFinite(Date.parse(plan.deletedAt)) && typeof plan.actorScopeTag === "string" && (actorScopeTag === undefined || constantTimeEquals(plan.actorScopeTag, actorScopeTag));
}
function referenceReleaseMatchesPlan(view: InternalView, id: string): boolean {
  if (!referenceIsReleased(view, id) || !validDelegationDeletePlan(view, id)) return false;
  const delegation = view.delegations.get(id)!; const plan = delegationDeletePlan(view, id)!;
  const release = view.events.find((event) => event.type === "call_delegation_reference_released" && event.delegationId === id);
  return !!release && Number(release.data.slotIndex) === delegation.slotIndex && release.data.delegationId === id && release.data.proofRef === plan.proofRef && release.data.actorScopeTag === plan.actorScopeTag;
}
async function verifyPrivateBinding(rootDir: string, view: InternalView, kind: ObjectKind, id: string): Promise<boolean> {
  try {
    // The Call payload is the owner-only binding for every cleanup target.  It
    // must be checked from the current locked view, even when a prior cleanup
    // plan exists.  A delegation payload is additionally checked while its
    // private record is still expected to exist; after prune, the durable plan
    // and the Call payload are the only remaining continuation proof.
    await callPayload(rootDir, view.call!);
    if (kind === "delegation") {
      const delegation = view.delegations.get(id); if (!delegation) return false;
      const privateDeleted = view.events.some((event) => event.type === "delegation_private_deleted" && event.delegationId === id);
      if (!privateDeleted) await readDelegationPayload(rootDir, view, delegation);
    }
    return true;
  } catch { return false; }
}
async function authenticateLocked(rootDir: string, view: InternalView, kind: ObjectKind, id: string, actor: DeleteActor, deps: DelegationFoundationDependencies): Promise<{ tag: string } | { reason: string }> {
  const call = view.call;
  const current = deps.lineage;
  if (!call || view.integrity) return { reason: view.integrity?.reason ?? "call not found" };
  if (!validStartupLineage(current) || !validActor(actor) || !lineageMatches(call, current)) return { reason: "authenticated current lineage is required" };
  if (actor.parentSessionId !== current.parentSessionId || actor.activeLineageId !== current.activeLineageId || actor.activeBranchAnchor !== current.activeBranchAnchor || actor.parentSessionId !== call.parentSessionId || actor.activeLineageId !== call.activeLineageId || actor.activeBranchAnchor !== call.activeBranchAnchor || !current.branchIds.includes(call.activeBranchAnchor)) return { reason: "actor scope does not match authenticated lineage" };
  const secret = secretFor(rootDir, deps); if (!secret) return { reason: "actor scope secret cannot be proven" };
  if (!(await verifyPrivateBinding(rootDir, view, kind, id))) {
    // The Call private record is intentionally removed near the end of a
    // durable Call cleanup.  Startup continuation may use the already durable
    // plan only after that exact deletion marker; every other write requires
    // the owner-only payload to remain present.
    const postPrivateDeletion = kind === "call" && call.cleanupRequested && view.events.some((event) => event.type === "call_private_deleted");
    if (!postPrivateDeletion) return { reason: "private identity binding cannot be proven" };
  }
  const tag = computeActorScopeTag(secret, actor, id); const saved = persistedTag(view, kind, id);
  if (saved !== undefined && !constantTimeEquals(saved, tag)) return { reason: "durable actor scope tag mismatch" };
  return { tag };
}
async function cleanupBarrier(deps: DelegationFoundationDependencies): Promise<void> {
  await deps.cleanupBarrier?.("before-call-lock");
}
function countEvents(before: InternalView, after: InternalView): number { return Math.max(0, after.events.length - before.events.length); }

async function deleteDelegationLocked(rootDir: string, callId: string, delegationId: string, actorScopeTag: string, deps: DelegationFoundationDependencies, ownedByCallCleanup = false): Promise<DeleteReceipt> {
  let view = await strictLoad(rootDir, callId); const delegation = view.delegations.get(delegationId);
  if (view.integrity || !view.call || !delegation) return { target: delegationId, objectKind: "delegation", actorScopeTag, status: "paused_integrity", walWrites: 0, deleteCount: 0, reason: view.integrity?.reason ?? "delegation not found" };
  const saved = persistedTag(view, "delegation", delegationId); if (saved && !constantTimeEquals(saved, actorScopeTag)) return { target: delegationId, objectKind: "delegation", actorScopeTag, status: "paused_integrity", walWrites: 0, deleteCount: 0, reason: "durable actor scope tag mismatch" };
  if (delegation.deleteCompleted || delegation.orphanCleanupComplete) {
    if (!referenceIsReleased(view, delegationId)) return { target: delegationId, objectKind: "delegation", actorScopeTag, status: "paused_integrity", walWrites: 0, deleteCount: 0, reason: "completed delegation has a live Call reference" };
    const completionType = delegation.deleteCompleted ? "delegation_delete_completed" : "delegation_cleanup_complete";
    const event = view.events.find((item) => item.type === "delegation_tombstone_written" && item.delegationId === delegationId);
    const ok = event && await readTombstone(rootDir, "delegation", delegationId, actorScopeTag, event.data).catch(() => false);
    return ok ? { target: delegationId, objectKind: "delegation", actorScopeTag, status: "completed", walWrites: 0, deleteCount: 0 } : { target: delegationId, objectKind: "delegation", actorScopeTag, status: "paused_integrity", walWrites: 0, deleteCount: 0, reason: `${completionType} tombstone cannot be proven` };
  }
  if (delegation.orphanCleanupRequested) return finishDelegationCleanupLocked(rootDir, callId, delegationId, actorScopeTag, deps, "delegation_cleanup_complete");
  if (!ownedByCallCleanup && (delegation.deletePlanned || delegation.deleteRequested) && !validDelegationDeletePlan(view, delegationId, actorScopeTag)) return { target: delegationId, objectKind: "delegation", actorScopeTag, status: "paused_integrity", walWrites: 0, deleteCount: 0, reason: "delegation delete plan cannot be proven" };
  if (!delegation.deleteRequested) {
    let writes = 0;
    let current = await strictLoad(rootDir, callId); if (current.integrity) return { target: delegationId, objectKind: "delegation", actorScopeTag, status: "paused_integrity", walWrites: 0, deleteCount: 0, reason: current.integrity.reason };
    if (current.call?.cleanupRequested && !ownedByCallCleanup) return { target: delegationId, objectKind: "delegation", actorScopeTag, status: "rejected", walWrites: 0, deleteCount: 0, reason: "Call cleanup owns this delegation" };
    const alreadyPlanned = current.delegations.get(delegationId)?.deletePlanned === true;
    if (!alreadyPlanned) {
      const blocked = ownedByCallCleanup && current.call?.cleanupRequested ? undefined : blocker(current, delegation);
      if (blocked) return { target: delegationId, objectKind: "delegation", actorScopeTag, status: "rejected", walWrites: 0, deleteCount: 0, reason: blocked };
      const plan = { delegationId, slotIndex: delegation.slotIndex, proofRef: `proof:${callId}`, referenceOrderDigest: cleanupReferenceOrderDigest(current.call!), ...tombstoneValue("delegation", delegationId, actorScopeTag, nowIso(deps)) };
      await strictAppend(rootDir, callId, "delegation_delete_planned", plan, delegationId, deps); writes += 1;
      current = await strictLoad(rootDir, callId);
    }
    if (!validDelegationDeletePlan(current, delegationId, actorScopeTag)) return { target: delegationId, objectKind: "delegation", actorScopeTag, status: "paused_integrity", walWrites: 0, deleteCount: 0, reason: current.integrity?.reason ?? "delegation delete plan conflicts with Call or slot" };
    const before = current; current = await ensureProof(rootDir, current, deps); writes += countEvents(before, current);
    if (referenceIsReleased(current, delegationId)) {
      if (!referenceReleaseMatchesPlan(current, delegationId)) return { target: delegationId, objectKind: "delegation", actorScopeTag, status: "paused_integrity", walWrites: writes, deleteCount: 0, reason: "delegation reference release conflicts with delete plan" };
    } else {
      await strictAppend(rootDir, callId, "call_delegation_reference_released", { slotIndex: delegation.slotIndex, delegationId, proofRef: `proof:${callId}`, actorScopeTag }, delegationId, deps); writes += 1;
    }
    current = await strictLoad(rootDir, callId); const plan = plannedTombstone(current, "delegation", delegationId);
    if (!plan) return { target: delegationId, objectKind: "delegation", actorScopeTag, status: "paused_integrity", walWrites: writes, deleteCount: 0, reason: "fixed delete timestamp cannot be proven" };
    if (!current.events.some((event) => event.type === "delegation_delete_requested" && event.delegationId === delegationId)) { await strictAppend(rootDir, callId, "delegation_delete_requested", plan, delegationId, deps); writes += 1; }
    view = await strictLoad(rootDir, callId); const result = await finishDelegationCleanupLocked(rootDir, callId, delegationId, actorScopeTag, deps, "delegation_delete_completed");
    return { ...result, walWrites: result.walWrites + writes };
  }
  return finishDelegationCleanupLocked(rootDir, callId, delegationId, actorScopeTag, deps, "delegation_delete_completed");
}

async function finishDelegationCleanupLocked(rootDir: string, callId: string, delegationId: string, actorScopeTag: string, deps: DelegationFoundationDependencies, completionType: "delegation_delete_completed" | "delegation_cleanup_complete"): Promise<DeleteReceipt> {
  let view = await strictLoad(rootDir, callId); const delegation = view.delegations.get(delegationId);
  if (view.integrity || !view.call || !delegation) return { target: delegationId, objectKind: "delegation", actorScopeTag, status: "paused_integrity", walWrites: 0, deleteCount: 0, reason: view.integrity?.reason ?? (!view.call ? "call missing" : "delegation missing") };
  const plan = plannedTombstone(view, "delegation", delegationId);
  if (!plan || !constantTimeEquals(String(plan.actorScopeTag), actorScopeTag) || !referenceIsReleased(view, delegationId) || (completionType === "delegation_delete_completed" && !referenceReleaseMatchesPlan(view, delegationId))) return { target: delegationId, objectKind: "delegation", actorScopeTag, status: "paused_integrity", walWrites: 0, deleteCount: 0, reason: "delegation cleanup plan or released reference cannot be proven" };
  let writes = 0;
  if (!view.events.some((event) => event.type === "delegation_private_deleted" && event.delegationId === delegationId)) {
    // Record the durable authorization before unlinking.  A crash after the
    // file operation but before the fact would otherwise leave startup unable
    // to authenticate the continuation because the private binding is gone.
    await strictAppend(rootDir, callId, "delegation_private_deleted", { actorScopeTag }, delegationId, deps); writes += 1;
    await deps.fault?.("before:delegation_prune"); await pruneKnown(rootDir, view, [delegationId], false); await deps.fault?.("after:delegation_prune");
  }
  view = await strictLoad(rootDir, callId);
  if (!view.events.some((event) => event.type === "delegation_tombstone_written" && event.delegationId === delegationId)) {
    await deps.fault?.("before:delegation_tombstone_file"); await writeTombstone(rootDir, "delegation", delegationId, actorScopeTag, String(plan.deletedAt)); await deps.fault?.("after:delegation_tombstone_file");
    await strictAppend(rootDir, callId, "delegation_tombstone_written", plan, delegationId, deps); writes += 1;
  }
  view = await strictLoad(rootDir, callId);
  if (!view.events.some((event) => event.type === completionType && event.delegationId === delegationId)) { await strictAppend(rootDir, callId, completionType, { actorScopeTag }, delegationId, deps); writes += 1; }
  await writeJournal(rootDir, "delegation", delegationId, { actorScopeTag, phase: "cleanup_complete", callId, slotIndex: delegation.slotIndex });
  return { target: delegationId, objectKind: "delegation", actorScopeTag, status: "completed", walWrites: writes, deleteCount: 1 };
}

function orderedSlots(call: DispatchCallView) { return call.slots.filter((slot) => slot.required).slice().sort((a, b) => a.order - b.order); }
async function callCleanupLocked(rootDir: string, callId: string, actorScopeTag: string, trigger: DeleteTrigger, deps: DelegationFoundationDependencies): Promise<DeleteReceipt> {
  let view = await strictLoad(rootDir, callId); if (view.integrity || !view.call) return { target: callId, objectKind: "call", actorScopeTag, status: "paused_integrity", walWrites: 0, deleteCount: 0, reason: view.integrity?.reason ?? "call not found" };
  const saved = persistedTag(view, "call", callId); if (saved && !constantTimeEquals(saved, actorScopeTag)) return { target: callId, objectKind: "call", actorScopeTag, status: "paused_integrity", walWrites: 0, deleteCount: 0, reason: "durable actor scope tag mismatch" };
  if (view.call.cleanupComplete) {
    const event = view.events.find((item) => item.type === "call_tombstone_written"); const ok = event && await readTombstone(rootDir, "call", callId, actorScopeTag, event.data).catch(() => false);
    return ok ? { target: callId, objectKind: "call", actorScopeTag, status: "completed", walWrites: 0, deleteCount: 0 } : { target: callId, objectKind: "call", actorScopeTag, status: "paused_integrity", walWrites: 0, deleteCount: 0, reason: "Call tombstone cannot be proven" };
  }
  if (!view.call.cleanupRequested) {
    const reason = blocker(view); if (reason || !requiredTerminal(view)) return { target: callId, objectKind: "call", actorScopeTag, status: "rejected", walWrites: 0, deleteCount: 0, reason: reason ?? "required slots are not terminal" };
    // This is deliberately before call_cleanup_requested. A torn/corrupt WAL
    // or an invalid proof therefore cannot freeze a cleanup request.
    view = await ensureProof(rootDir, view, deps);
    const requestCall = view.call!;
    const callPlan = tombstoneValue("call", callId, actorScopeTag, nowIso(deps));
    await strictAppend(rootDir, callId, "call_cleanup_requested", { trigger, actorScopeTag, referenceOrderDigest: cleanupReferenceOrderDigest(requestCall), cursor: 0, ...callPlan }, undefined, deps);
    view = await strictLoad(rootDir, callId); if (view.integrity || !view.call) return { target: callId, objectKind: "call", actorScopeTag, status: "paused_integrity", walWrites: 1, deleteCount: 0, reason: "Call disappeared or WAL integrity failed after cleanup request" }; await writeJournal(rootDir, "call", callId, { actorScopeTag, trigger, phase: "cleanup_requested", cursor: 0 });
  }
  if (view.integrity || !view.call) return { target: callId, objectKind: "call", actorScopeTag, status: "paused_integrity", walWrites: 0, deleteCount: 0, reason: "Call cannot be replayed or WAL integrity failed" };
  if (!view.call.proofDeleted && !view.events.some((event) => event.type === "call_proof_deleted")) view = await ensureProof(rootDir, view, deps);
  const slots = orderedSlots(view.call!); let writes = 0;
  while ((view.call!.cleanupCursor ?? 0) < slots.length) {
    const cursor = view.call!.cleanupCursor ?? 0; const slot = slots[cursor]!; const id = slot.delegationId;
    view = await strictLoad(rootDir, callId); if (view.integrity) return { target: callId, objectKind: "call", actorScopeTag, status: "paused_integrity", walWrites: writes, deleteCount: 0, reason: view.integrity.reason };
    if (id) {
      const secret = secretFor(rootDir, deps); if (!secret) return { target: callId, objectKind: "call", actorScopeTag, status: "paused_integrity", walWrites: writes, deleteCount: 0, reason: "actor scope secret cannot be proven" };
      const delegationTag = computeActorScopeTag(secret, actorFor(view.call!), id); const result = await deleteDelegationLocked(rootDir, callId, id, delegationTag, deps, true);
      writes += result.walWrites; if (result.status !== "completed") return { target: callId, objectKind: "call", actorScopeTag, status: result.status === "rejected" ? "rejected" : "paused_integrity", walWrites: writes, deleteCount: 0, reason: result.reason };
    }
    view = await strictLoad(rootDir, callId); if (view.integrity || !view.call) return { target: callId, objectKind: "call", actorScopeTag, status: "paused_integrity", walWrites: writes, deleteCount: 0, reason: view.integrity?.reason ?? "Call cannot be replayed" };
    await strictAppend(rootDir, callId, "cleanup_cursor_advanced", { cursor, nextCursor: cursor + 1, slotIndex: slot.index, delegationId: id ?? null, referenceOrderDigest: view.call.cleanupReferenceOrderDigest ?? cleanupReferenceOrderDigest(view.call) }, undefined, deps);
    writes += 1; view = await strictLoad(rootDir, callId);
  }
  const delegationIds = slots.map((slot) => slot.delegationId).filter((id): id is string => typeof id === "string");
  view = await strictLoad(rootDir, callId); if (delegationIds.some((id) => {
    const item = view.delegations.get(id); return !item || (!item.deleteCompleted && !item.orphanCleanupComplete) || !referenceIsReleased(view, id) || item.slotIndex !== view.call!.slots.find((slot) => slot.delegationId === id)?.index;
  })) return { target: callId, objectKind: "call", actorScopeTag, status: "paused_integrity", walWrites: writes, deleteCount: 0, reason: "cursor completed without exact delegation cleanup" };
  if (!view.events.some((event) => event.type === "call_private_deleted")) {
    // As with delegation private deletion, the WAL fact precedes unlink so a
    // startup continuation can use the already authenticated cleanup plan.
    await strictAppend(rootDir, callId, "call_private_deleted", { actorScopeTag }, undefined, deps); writes += 1;
    await pruneKnown(rootDir, view, delegationIds, true);
  }
  view = await strictLoad(rootDir, callId);
  if (!view.events.some((event) => event.type === "call_proof_deleted")) { await secureUnlink(proofPath(dirs(rootDir), callId)); await strictAppend(rootDir, callId, "call_proof_deleted", { proofRef: `proof:${callId}`, actorScopeTag }, undefined, deps); writes += 1; }
  view = await strictLoad(rootDir, callId);
  const callPlan = plannedTombstone(view, "call", callId);
  if (!callPlan || !constantTimeEquals(String(callPlan.actorScopeTag), actorScopeTag)) return { target: callId, objectKind: "call", actorScopeTag, status: "paused_integrity", walWrites: writes, deleteCount: 0, reason: "Call tombstone plan cannot be proven" };
  if (!view.events.some((event) => event.type === "call_tombstone_written")) { await deps.fault?.("before:call_tombstone_file"); await writeTombstone(rootDir, "call", callId, actorScopeTag, String(callPlan.deletedAt)); await deps.fault?.("after:call_tombstone_file"); await strictAppend(rootDir, callId, "call_tombstone_written", callPlan, undefined, deps); writes += 1; }
  view = await strictLoad(rootDir, callId); if (!view.events.some((event) => event.type === "cleanup_complete")) { await strictAppend(rootDir, callId, "cleanup_complete", { actorScopeTag }, undefined, deps); writes += 1; }
  await materialize(rootDir, await strictLoad(rootDir, callId));
  return { target: callId, objectKind: "call", actorScopeTag, status: "completed", walWrites: writes, deleteCount: 1 };
}

export async function requestDelegationDeleteInternal(rootDir: string, target: string, actor: DeleteActor, deps: DelegationFoundationDependencies = {}): Promise<DeleteReceipt | { status: "rejected" | "paused_integrity" | "busy"; reason?: string }> {
  const resolved = await resolveTarget(rootDir, target); if (!resolved?.delegationId) return { status: "rejected", reason: "target must be an exact delegationId" };
  const view = await strictLoad(rootDir, resolved.callId); if (view.integrity || !view.call) return { status: "paused_integrity", reason: view.integrity?.reason ?? "target WAL cannot be proven" };
  await cleanupBarrier(deps);
  try {
    const result = await withCallLock(rootDir, resolved.callId, async () => {
      let current = await strictLoad(rootDir, resolved.callId);
      let auth = await authenticateLocked(rootDir, current, "delegation", resolved.delegationId!, actor, deps);
      if ("reason" in auth) return { status: "rejected" as const, reason: auth.reason };
      current = await observeDeliveryBeforeCleanupLocked(rootDir, current, deps);
      current = await strictLoad(rootDir, resolved.callId);
      auth = await authenticateLocked(rootDir, current, "delegation", resolved.delegationId!, actor, deps);
      if ("reason" in auth) return { status: "rejected" as const, reason: auth.reason };
      return deleteDelegationLocked(rootDir, resolved.callId, resolved.delegationId!, auth.tag, deps);
    });
    return result ?? { status: "busy" };
  } catch (error) { return { status: "paused_integrity", reason: error instanceof Error ? error.message : "cleanup integrity cannot be proven" }; }
}
export const subagentDeleteInternal = requestDelegationDeleteInternal;

export async function requestCallCleanupInternal(rootDir: string, target: string, actor: DeleteActor, trigger: DeleteTrigger = "explicit_delete", deps: DelegationFoundationDependencies = {}): Promise<DeleteReceipt | { status: "rejected" | "paused_integrity" | "busy"; reason?: string }> {
  const resolved = await resolveTarget(rootDir, target); if (!resolved || resolved.delegationId) return { status: "rejected", reason: "target must be an exact dispatchCallId" };
  const view = await strictLoad(rootDir, resolved.callId); if (view.integrity || !view.call) return { status: "paused_integrity", reason: view.integrity?.reason ?? "Call WAL cannot be proven" };
  await cleanupBarrier(deps);
  try {
    const result = await withCallLock(rootDir, resolved.callId, async () => {
      let current = await strictLoad(rootDir, resolved.callId);
      let auth = await authenticateLocked(rootDir, current, "call", resolved.callId, actor, deps);
      if ("reason" in auth) return { status: "rejected" as const, reason: auth.reason };
      current = await observeDeliveryBeforeCleanupLocked(rootDir, current, deps);
      current = await strictLoad(rootDir, resolved.callId);
      auth = await authenticateLocked(rootDir, current, "call", resolved.callId, actor, deps);
      if ("reason" in auth) return { status: "rejected" as const, reason: auth.reason };
      return callCleanupLocked(rootDir, resolved.callId, auth.tag, trigger, deps);
    });
    return result ?? { status: "busy" };
  } catch (error) { return { status: "paused_integrity", reason: error instanceof Error ? error.message : "cleanup integrity cannot be proven" }; }
}
export const subagentCallCleanupInternal = requestCallCleanupInternal;

function eventActivityDates(view: InternalView): number[] {
  const dates: number[] = []; const keys = ["activityAt", "createdAt", "finalizedAt", "observedAt", "abandonedAt", "eligibleAt", "deletedAt"];
  for (const event of view.events) for (const key of keys) { const value = event.data[key]; if (typeof value === "string") { const time = Date.parse(value); if (Number.isFinite(time)) dates.push(time); } }
  return dates;
}
async function ownerFileMtime(files: readonly string[]): Promise<number | undefined> {
  let latest: number | undefined;
  for (const file of files) {
    try { const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !ownerFileSync(file)) return -1; latest = Math.max(latest ?? 0, stat.mtimeMs); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return -1; }
  }
  return latest;
}
async function walMtime(rootDir: string, callId: string): Promise<number | undefined> {
  return ownerFileMtime([path.join(dirs(rootDir).wal, `${callId}.jsonl`)]);
}
async function evaluateRetentionEligibilityLocked(rootDir: string, target: string, deps: DelegationFoundationDependencies = {}): Promise<RetentionEligibility> {
  const resolved = await resolveTarget(rootDir, target); if (!resolved || resolved.delegationId) return { target, objectKind: "call", eligible: false, reason: "target is not a Call" };
  let view = await strictLoad(rootDir, resolved.callId); if (view.integrity || !view.call) return { target, objectKind: "call", eligible: false, reason: "integrity cannot be proven" };
  let auth = await authenticateLocked(rootDir, view, "call", resolved.callId, actorFor(view.call), deps); if ("reason" in auth) return { target: resolved.callId, objectKind: "call", eligible: false, reason: auth.reason };
  view = await observeDeliveryBeforeCleanupLocked(rootDir, view, deps); view = await strictLoad(rootDir, resolved.callId); if (view.integrity || !view.call) return { target: resolved.callId, objectKind: "call", eligible: false, reason: "integrity cannot be proven" };
  auth = await authenticateLocked(rootDir, view, "call", resolved.callId, actorFor(view.call!), deps); if ("reason" in auth) return { target: resolved.callId, objectKind: "call", eligible: false, reason: auth.reason }; if (view.integrity || !view.call) return { target, objectKind: "call", eligible: false, reason: "integrity cannot be proven" };
  const dates = eventActivityDates(view); if (!deps.now) {
    const mtime = await walMtime(rootDir, resolved.callId); if (mtime === -1) return { target: resolved.callId, objectKind: "call", eligible: false, reason: "WAL activity identity cannot be proven" }; if (mtime !== undefined) dates.push(mtime);
    const privateMtime = await ownerFileMtime(knownPrivateFiles(rootDir, view, [...view.delegations.keys()], true)); if (privateMtime === -1) return { target: resolved.callId, objectKind: "call", eligible: false, reason: "private activity identity cannot be proven" }; if (privateMtime !== undefined) dates.push(privateMtime);
    const proofMtime = await ownerFileMtime([proofPath(dirs(rootDir), resolved.callId)]); if (proofMtime === -1) return { target: resolved.callId, objectKind: "call", eligible: false, reason: "proof activity identity cannot be proven" }; if (proofMtime !== undefined) dates.push(proofMtime);
  }
  const lastTime = dates.length ? Math.max(...dates) : NaN; const last = Number.isFinite(lastTime) ? new Date(lastTime).toISOString() : undefined; const age = lastTime;
  const blocked = blocker(view); const eligible = Number.isFinite(age) && now(deps).getTime() - age >= RETENTION_MS && !blocked && requiredTerminal(view);
  return { target: resolved.callId, objectKind: "call", eligible, ...(last ? { lastDurableActivity: last } : {}), ...(eligible ? {} : { reason: Number.isFinite(age) && now(deps).getTime() - age < RETENTION_MS ? "retention window has not elapsed" : blocked ?? "required slots are not terminal" }) };
}
export async function evaluateRetentionEligibilityInternal(rootDir: string, target: string, deps: DelegationFoundationDependencies = {}): Promise<RetentionEligibility> {
  const resolved = await resolveTarget(rootDir, target); if (!resolved || resolved.delegationId) return { target, objectKind: "call", eligible: false, reason: "target is not a Call" };
  const view = await strictLoad(rootDir, resolved.callId); if (view.integrity || !view.call) return { target: resolved.callId, objectKind: "call", eligible: false, reason: "integrity cannot be proven" };
  await cleanupBarrier(deps);
  try {
    const result = await withCallLock(rootDir, resolved.callId, () => evaluateRetentionEligibilityLocked(rootDir, resolved.callId, deps));
    return result ?? { target: resolved.callId, objectKind: "call", eligible: false, reason: "Call lock is busy" };
  } catch (error) { return { target: resolved.callId, objectKind: "call", eligible: false, reason: error instanceof Error ? error.message : "cleanup integrity cannot be proven" }; }
}
export async function requestRetentionCleanupInternal(rootDir: string, target: string, deps: DelegationFoundationDependencies = {}): Promise<DeleteReceipt | { status: "rejected" | "paused_integrity" | "busy"; reason?: string }> {
  const resolved = await resolveTarget(rootDir, target); if (!resolved || resolved.delegationId) return { status: "rejected", reason: "target is not a Call" };
  const initial = await strictLoad(rootDir, resolved.callId); if (initial.integrity || !initial.call) return { status: "paused_integrity", reason: initial.integrity?.reason ?? "Call WAL cannot be proven" };
  await cleanupBarrier(deps);
  try {
    const result = await withCallLock(rootDir, resolved.callId, async () => {
      const eligibility = await evaluateRetentionEligibilityLocked(rootDir, resolved.callId, deps);
      if (!eligibility.eligible || !eligibility.lastDurableActivity) return { status: "rejected" as const, reason: eligibility.reason };
      let current = await strictLoad(rootDir, resolved.callId); if (current.integrity || !current.call) return { status: "paused_integrity" as const, reason: "Call WAL cannot be proven" };
      current = await ensureProof(rootDir, current, deps);
      let auth = await authenticateLocked(rootDir, current, "call", resolved.callId, actorFor(current.call!), deps);
      if ("reason" in auth) return { status: "rejected" as const, reason: auth.reason };
      if (!current.events.some((event) => event.type === "retention_eligible")) await strictAppend(rootDir, resolved.callId, "retention_eligible", { lastDurableActivity: eligibility.lastDurableActivity!, eligibleAt: new Date(Date.parse(eligibility.lastDurableActivity!) + RETENTION_MS).toISOString(), actorScopeTag: auth.tag }, undefined, deps);
      current = await strictLoad(rootDir, resolved.callId);
      auth = await authenticateLocked(rootDir, current, "call", resolved.callId, actorFor(current.call!), deps);
      if ("reason" in auth) return { status: "rejected" as const, reason: auth.reason };
      return callCleanupLocked(rootDir, resolved.callId, auth.tag, "retention", deps);
    });
    return result ?? { status: "busy" };
  } catch (error) { return { status: "paused_integrity", reason: error instanceof Error ? error.message : "cleanup integrity cannot be proven" }; }
}

export async function cleanupOrphanDelegationInternal(rootDir: string, delegationId: string, actor: DeleteActor, deps: DelegationFoundationDependencies = {}): Promise<DeleteReceipt | { status: "rejected" | "paused_integrity" | "busy"; reason?: string }> {
  const resolved = await resolveTarget(rootDir, delegationId); if (!resolved?.delegationId) return { status: "rejected", reason: "orphan target cannot be resolved" };
  const view = await strictLoad(rootDir, resolved.callId); const delegation = view.delegations.get(delegationId); if (view.integrity || !view.call || !delegation) return { status: "paused_integrity", reason: view.integrity?.reason ?? "orphan WAL cannot be proven" };
  if (!referenceIsReleased(view, delegationId)) return { status: "rejected", reason: "live Call reference exists" };
  if (delegation.deleteRequested) return { status: "rejected", reason: "single delegation delete is already in progress" };
  await cleanupBarrier(deps);
  let result: DeleteReceipt | { status: "paused_integrity"; reason: string } | undefined;
  try { result = await withCallLock(rootDir, resolved.callId, async () => {
    let current = await strictLoad(rootDir, resolved.callId); const item = current.delegations.get(delegationId);
    const auth = await authenticateLocked(rootDir, current, "delegation", delegationId, actor, deps);
    if ("reason" in auth) return { target: delegationId, objectKind: "delegation" as const, actorScopeTag: "", status: "rejected" as const, walWrites: 0, deleteCount: 0, reason: auth.reason };
    if (!item || current.integrity) return { target: delegationId, objectKind: "delegation" as const, actorScopeTag: auth.tag, status: "paused_integrity" as const, walWrites: 0, deleteCount: 0, reason: current.integrity?.reason ?? "orphan WAL cannot be proven" };
    if (!referenceIsReleased(current, delegationId)) return { target: delegationId, objectKind: "delegation" as const, actorScopeTag: auth.tag, status: "rejected" as const, walWrites: 0, deleteCount: 0, reason: "live Call reference exists" };
    if (item.deleteRequested) return { target: delegationId, objectKind: "delegation" as const, actorScopeTag: auth.tag, status: "rejected" as const, walWrites: 0, deleteCount: 0, reason: "single delegation delete is already in progress" };
    if (item.orphanCleanupComplete) return { target: delegationId, objectKind: "delegation" as const, actorScopeTag: auth.tag, status: "completed" as const, walWrites: 0, deleteCount: 0 };
    let writes = 0;
    if (!item.orphanCleanupRequested) {
      if (current.call?.cleanupRequested) return { target: delegationId, objectKind: "delegation" as const, actorScopeTag: auth.tag, status: "rejected" as const, walWrites: 0, deleteCount: 0, reason: "Call cleanup owns this delegation" };
      const reason = blocker(current, item); if (reason) return { target: delegationId, objectKind: "delegation" as const, actorScopeTag: auth.tag, status: "rejected" as const, walWrites: 0, deleteCount: 0, reason };
      const plan = tombstoneValue("delegation", delegationId, auth.tag, nowIso(deps));
      await strictAppend(rootDir, resolved.callId, "delegation_cleanup_requested", plan, delegationId, deps); writes += 1;
    }
    const finished = await finishDelegationCleanupLocked(rootDir, resolved.callId, delegationId, auth.tag, deps, "delegation_cleanup_complete");
    return { ...finished, walWrites: finished.walWrites + writes };
  }); } catch (error) { return { status: "paused_integrity", reason: error instanceof Error ? error.message : "orphan cleanup integrity cannot be proven" }; }
  return result ?? { status: "busy" };
}

export async function reconcileCleanupStartupInternal(rootDir: string, deps: DelegationFoundationDependencies = {}): Promise<{ resumed: number; pausedIntegrity: number; sendCount: 0; spawnCount: 0 }> {
  const currentLineage = deps.lineage;
  if (!validStartupLineage(currentLineage)) return { resumed: 0, pausedIntegrity: 0, sendCount: 0, spawnCount: 0 };
  let resumed = 0; let pausedIntegrity = 0; let names: string[]; try { names = (await fs.readdir(dirs(rootDir).wal)).filter((name) => name.endsWith(".jsonl")); } catch { return { resumed: 0, pausedIntegrity: 1, sendCount: 0, spawnCount: 0 }; }
  const secret = secretFor(rootDir, deps); if (!secret) return { resumed: 0, pausedIntegrity: names.length || 1, sendCount: 0, spawnCount: 0 };
  for (const name of names.sort()) {
    const callId = name.slice(0, -6); const view = await strictLoad(rootDir, callId);
    if (view.integrity || !view.call) { if (view.integrity) pausedIntegrity += 1; continue; }
    if (!lineageMatches(view.call, currentLineage)) continue;
    try {
      const result = await withCallLock(rootDir, callId, async () => {
        let current = await strictLoad(rootDir, callId); if (current.integrity || !current.call) return undefined;
        const callAuth = await authenticateLocked(rootDir, current, "call", callId, actorFor(current.call), deps);
        if ("reason" in callAuth) return { status: "paused_integrity" as const };
        if (current.call.cleanupRequested && !current.call.cleanupComplete) return callCleanupLocked(rootDir, callId, callAuth.tag, current.call.cleanupTrigger ?? "explicit_delete", deps);
        for (const item of [...current.delegations.values()].filter((candidate) => (candidate.deletePlanned || candidate.deleteRequested || candidate.orphanCleanupRequested) && !candidate.deleteCompleted && !candidate.orphanCleanupComplete)) {
          current = await strictLoad(rootDir, callId); const latest = current.delegations.get(item.delegationId); if (!latest) return { status: "paused_integrity" as const };
          const delegationAuth = await authenticateLocked(rootDir, current, "delegation", item.delegationId, actorFor(current.call!), deps);
          if ("reason" in delegationAuth) return { status: "paused_integrity" as const };
          const finished = latest.deletePlanned || latest.deleteRequested
            ? await deleteDelegationLocked(rootDir, callId, item.delegationId, delegationAuth.tag, deps)
            : await finishDelegationCleanupLocked(rootDir, callId, item.delegationId, delegationAuth.tag, deps, "delegation_cleanup_complete");
          if (finished.status !== "completed") return finished;
          resumed += 1;
        }
        return { status: "completed" as const };
      });
      if (result?.status === "completed") resumed += 1; else if (result?.status === "paused_integrity") pausedIntegrity += 1;
    } catch { pausedIntegrity += 1; }
  }
  return { resumed, pausedIntegrity, sendCount: 0, spawnCount: 0 };
}
export async function gcCleanupTombstonesInternal(rootDir: string, at: Date = new Date()): Promise<{ collected: number; pausedIntegrity: number }> {
  let collected = 0; let pausedIntegrity = 0; let entries: string[]; try { entries = await fs.readdir(dirs(rootDir).tombstones); } catch { return { collected, pausedIntegrity }; }
  for (const entry of entries.sort()) {
    if (!/^[a-f0-9]{64}\.json$/.test(entry)) continue; const file = path.join(dirs(rootDir).tombstones, entry);
    try {
      const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !ownerFileSync(file)) throw new CleanupIntegrityError("unsafe tombstone");
      const value = JSON.parse(await fs.readFile(file, "utf8")); if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "actorScopeTag,deletedAt,idHash,objectKind,schemaVersion,status" || !HEX.test(value.idHash) || !["call", "delegation"].includes(value.objectKind) || value.schemaVersion !== 1 || value.status !== "deleted" || !HEX.test(value.actorScopeTag) || typeof value.deletedAt !== "string" || !Number.isFinite(Date.parse(value.deletedAt))) throw new CleanupIntegrityError("tombstone schema invalid");
      if (at.getTime() - Date.parse(value.deletedAt) < RETENTION_MS) continue; await fs.unlink(file); await syncDirectory(dirs(rootDir).tombstones); collected += 1;
    } catch { pausedIntegrity += 1; }
  }
  return { collected, pausedIntegrity };
}
export function retentionTombstonePath(rootDir: string, objectKind: ObjectKind, objectId: string): string { return tombstonePath(rootDir, objectKind, objectId); }
export function cleanupActorSecretPath(rootDir: string): string { return dirs(rootDir).actorSecret; }
