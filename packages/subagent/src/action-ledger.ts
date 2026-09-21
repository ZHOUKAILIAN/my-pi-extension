/**
 * Gated side-effect action ledger.  This file is deliberately internal: it is
 * a durable contract/facade for a future Pi middleware adapter, not a runner
 * or a tool implementation.
 */
import type {
  ActionChildState, ActionIdentity, ActionIntentRequest, ActionPolicyClassification, ActionProjection,
  ActionReplayPolicy, ActionResultRequest, ActionStatus,
  DelegationFoundationDependencies, InternalDelegation, InternalView, OwnerIdentity, UncertaintyDisposition,
} from "./delegation-types.ts";
import { appendWal, dirs, hash, loadView, materialize, privatePayload, readPrivate, writePrivate, withCallLock, validResultRef, pausedResult } from "./delegation-context.ts";
import type { OwnerClaim } from "./execution-supervisor.ts";
import { durableChildState } from "./wal-replay.ts";
import { hasUnresolvedActionForDelegation, unresolvedActionsForDelegation } from "./action-predicate.ts";

// Kept local so this module does not import the execution supervisor at runtime.
export type ActionUnknownReason = "result_ack_failed" | "child_death" | "return_with_unresolved_action" | "integrity" | "manual";
const ACTION_ID_PREFIX = "action:";
const ACTION_ID_RE = /^action:[0-9a-f]{64}$/;
const SAFE_RESULT_TYPE = /^[A-Za-z0-9._:-]{1,64}$/;

function sameOwner(left: OwnerIdentity | undefined, right: OwnerIdentity): boolean {
  return !!left && left.host === right.host && left.pid === right.pid && left.birth === right.birth && left.parentSessionId === right.parentSessionId && left.parentSessionPath === right.parentSessionPath && left.argvProof === right.argvProof;
}
function claimMatches(delegation: InternalDelegation | undefined, claim: OwnerClaim | undefined): boolean {
  return !!claim && !!delegation?.owner && sameOwner(delegation.owner, claim.owner) && delegation.ownerGeneration === claim.ownerGeneration && delegation.fencingGeneration === claim.fencingGeneration && delegation.spawnId === claim.spawnId;
}

function canonical(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("action args contain non-finite number"); return value; }
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonical(record[key])]));
  }
  throw new Error("action args contain unsupported value");
}
function canonicalJson(value: unknown): string { return JSON.stringify(canonical(value)); }
export function canonicalArgsDigest(args: unknown): string { return hash(canonicalJson(args)); }
function logicalIdentityDigest(identity: Pick<ActionIdentity, "delegationId" | "toolCallOrdinal" | "logicalCheckpoint" | "finalToolName" | "canonicalArgsDigest">): string {
  return hash(JSON.stringify([identity.delegationId, identity.toolCallOrdinal, identity.logicalCheckpoint, identity.finalToolName, identity.canonicalArgsDigest]));
}
function identityDigest(identity: ActionIdentity): string { return logicalIdentityDigest(identity); }
export function actionIdFor(identity: ActionIdentity): string { return `${ACTION_ID_PREFIX}${logicalIdentityDigest(identity)}`; }
export function stableIdempotencyKeyFor(logicalActionId: string): string { return `idempotency:${hash(logicalActionId)}`; }
function safeNameHash(name: string): string { return hash(name); }
function safeScopeHash(scope: string): string { return hash(scope).slice(0, 32); }
function safeReservationHash(reservation: string): string { return hash(reservation).slice(0, 32); }
function resultHash(ref: string): string { return hash(ref); }
function privateFileId(actionId: string): string { return actionId.slice(ACTION_ID_PREFIX.length); }
function actionPrivateRef(actionId: string): string { return `private:action-${privateFileId(actionId)}`; }
function actionResultPrivateRef(actionId: string): string { return `private:action-${privateFileId(actionId)}-result`; }
function isOutcomeDisposition(value: UncertaintyDisposition): value is "confirmed_succeeded" | "confirmed_not_started" | "confirmed_failed_safe_to_retry" { return value === "confirmed_succeeded" || value === "confirmed_not_started" || value === "confirmed_failed_safe_to_retry"; }
function childStateForAction(view: InternalView, delegation: InternalDelegation): ActionChildState { return durableChildState(view, delegation); }
function validActionIdentity(value: unknown): value is ActionIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v.delegationId === "string" && v.delegationId.length > 0 && typeof v.logicalCheckpoint === "string" && v.logicalCheckpoint.length > 0 && typeof v.executionScope === "string" && v.executionScope.length > 0 && v.executionScope.length <= 256 && typeof v.reservationId === "string" && v.reservationId.length > 0 && Number.isSafeInteger(v.continuationEpoch) && Number(v.continuationEpoch) >= 0 && Number.isSafeInteger(v.fencingGeneration) && Number(v.fencingGeneration) >= 0 && Number.isSafeInteger(v.toolCallOrdinal) && Number(v.toolCallOrdinal) >= 0 && typeof v.finalToolName === "string" && v.finalToolName.length > 0 && /^[0-9a-f]{64}$/.test(String(v.canonicalArgsDigest));
}
function projectionFromIntent(data: Record<string, unknown>): ActionProjection {
  const policy = data.policy;
  if (!validPolicy(policy)) throw new Error("action intent policy is invalid");
  return {
    actionId: String(data.actionId), logicalActionId: String(data.logicalActionId), identityDigest: String(data.identityDigest), delegationId: String(data.delegationId), logicalCheckpoint: String(data.logicalCheckpoint), executionScopeHash: String(data.executionScopeHash), reservationIdHash: String(data.reservationIdHash), continuationEpoch: Number(data.continuationEpoch), fencingGeneration: Number(data.fencingGeneration), ownerGeneration: Number(data.ownerGeneration), spawnId: String(data.spawnId), toolCallOrdinal: Number(data.toolCallOrdinal), finalToolNameHash: String(data.finalToolNameHash), canonicalArgsDigest: String(data.canonicalArgsDigest), stableIdempotencyKey: String(data.stableIdempotencyKey), policy, status: "intent_acked",
  };
}
function hasAction(view: InternalView, actionId: string): ActionProjection | undefined { return view.actions?.get(actionId); }
export function unresolvedActions(view: InternalView, delegationId: string): ActionProjection[] { return unresolvedActionsForDelegation(view, delegationId); }
function sameLogicalIdentity(action: ActionProjection, request: ActionIntentRequest, actionId: string): boolean {
  return action.actionId === actionId && action.logicalActionId === actionId && action.identityDigest === identityDigest(request) && action.delegationId === request.delegationId && action.logicalCheckpoint === request.logicalCheckpoint && action.toolCallOrdinal === request.toolCallOrdinal && action.finalToolNameHash === safeNameHash(request.finalToolName) && action.canonicalArgsDigest === request.canonicalArgsDigest && action.policy === request.policy && action.stableIdempotencyKey === stableIdempotencyKeyFor(actionId);
}
function validPolicy(value: unknown): value is ActionPolicyClassification { return value === "read_only" || value === "fenced_mutating" || value === "unsupported"; }

export interface ActionBeginResult { state: "allowed" | "committed" | "rejected" | "paused_integrity" | "busy"; actionId?: string; logicalActionId?: string; handler: 0 | 1; reason?: string; policy?: ActionPolicyClassification; }
export interface ActionFinishResult { state: "result_acked" | "unknown" | "rejected" | "paused_integrity" | "busy"; actionId: string; logicalActionId?: string; watchdogRequested?: boolean; reason?: string; }

async function appendUnknownLocked(rootDir: string, dispatchCallId: string, action: ActionProjection, reason: ActionUnknownReason, deps: DelegationFoundationDependencies, resultPrivateRef?: string, watchdog = true): Promise<boolean> {
  const current = await loadView(rootDir, dispatchCallId);
  const existing = current.actions?.get(action.actionId);
  if (!existing) return false;
  if (["unknown", "still_unknown", "confirmed_succeeded", "confirmed_not_started", "confirmed_failed_safe_to_retry", "result_acked"].includes(existing.status)) return existing.status === "unknown" || existing.status === "still_unknown";
  const safeResultRef = resultPrivateRef === actionResultPrivateRef(action.actionId) ? resultPrivateRef : undefined;
  let durable = false;
  try {
    await appendWal(rootDir, dispatchCallId, "action_unknown", { actionId: action.logicalActionId, logicalActionId: action.logicalActionId, identityDigest: action.identityDigest, reason, ownerGeneration: action.ownerGeneration, fencingGeneration: action.fencingGeneration, ...(safeResultRef ? { resultPrivateRef: safeResultRef } : {}) }, action.delegationId, { ...deps, fault: undefined });
    durable = true;
  } catch {
    // An after-write fault can leave action_unknown durable.  Re-read before
    // attempting the stronger integrity pause, and always request the child
    // watchdog while the outcome remains unresolved.
    const recovered = await loadView(rootDir, dispatchCallId);
    const recoveredAction = recovered.actions?.get(action.actionId);
    durable = recoveredAction?.status === "unknown";
    if (!durable && !recovered.integrity) {
      try { await appendWal(rootDir, dispatchCallId, "delegation_integrity_paused", { reasonCode: "action_unknown_durability_failed" }, action.delegationId, { ...deps, fault: undefined }); } catch { /* remain fail-closed if the pause itself cannot be appended */ }
    }
  }
  if (watchdog) { try { await deps.watchdogTerminate?.({ delegationId: action.delegationId, actionId: action.actionId, reason, ownerGeneration: action.ownerGeneration, fencingGeneration: action.fencingGeneration }); } catch { /* watchdog failure never converts uncertainty into success */ } }
  return durable;
}

async function verifiedResultPrivateRef(rootDir: string, action: ActionProjection, request: ActionResultRequest): Promise<string | undefined> {
  const ref = actionResultPrivateRef(action.logicalActionId);
  try {
    const value = await readPrivate<Record<string, unknown>>(privatePayload(dirs(rootDir), `action-${privateFileId(action.logicalActionId)}-result`));
    if (value.version !== 1 || value.actionId !== action.logicalActionId || value.logicalActionId !== action.logicalActionId || value.executionScopeHash !== action.executionScopeHash || value.reservationIdHash !== action.reservationIdHash || Number(value.continuationEpoch) !== action.continuationEpoch || Number(value.fencingGeneration) !== action.fencingGeneration || value.resultRef !== request.resultRef || value.resultType !== request.resultType || value.status !== request.status || resultHash(String(value.resultRef)) !== resultHash(request.resultRef)) return undefined;
    return ref;
  } catch { return undefined; }
}

async function reconcileResultAckFailure(rootDir: string, dispatchCallId: string, action: ActionProjection, request: ActionResultRequest, deps: DelegationFoundationDependencies): Promise<ActionFinishResult> {
  const resultPrivateRef = await verifiedResultPrivateRef(rootDir, action, request);
  const reconciled = await loadView(rootDir, dispatchCallId);
  if (reconciled.integrity) return { state: "paused_integrity", actionId: action.actionId, reason: reconciled.integrity.reason };
  const current = reconciled.actions?.get(action.actionId);
  // The append may have completed before reporting a fault. Never append an
  // opposite action_unknown fact after a durable result ACK.
  if (current?.status === "result_acked") return { state: "result_acked", actionId: action.actionId };
  const unknown = await appendUnknownLocked(rootDir, dispatchCallId, action, "result_ack_failed", deps, resultPrivateRef);
  const finalView = await loadView(rootDir, dispatchCallId);
  const finalAction = finalView.actions?.get(action.actionId);
  if (finalAction?.status === "result_acked") return { state: "result_acked", actionId: action.actionId };
  return { state: unknown ? "unknown" : "paused_integrity", actionId: action.actionId, watchdogRequested: unknown, reason: "final middleware result ACK failed" };
}

export async function beginActionIntentInternal(rootDir: string, dispatchCallId: string, delegationId: string, claim: OwnerClaim, request: Omit<ActionIntentRequest, "delegationId" | "reservationId" | "continuationEpoch" | "fencingGeneration"> & Partial<Pick<ActionIntentRequest, "delegationId" | "reservationId" | "continuationEpoch" | "fencingGeneration">>, deps: DelegationFoundationDependencies = {}): Promise<ActionBeginResult> {
  const result = await withCallLock(rootDir, dispatchCallId, async () => {
    const view = await loadView(rootDir, dispatchCallId);
    if (view.integrity) return { state: "paused_integrity" as const, handler: 0 as const, reason: view.integrity.reason };
    const delegation = view.delegations.get(delegationId);
    if (!delegation || !claimMatches(delegation, claim)) return { state: "rejected" as const, handler: 0 as const, reason: "current owner claim cannot be proven" };
    if (!["initial_running", "recovery_running", "reattach_only"].includes(delegation.state) || hasCancel(view, delegationId)) return { state: "rejected" as const, handler: 0 as const, reason: "action scope is not running" };
    let computedArgsDigest: string;
    try { computedArgsDigest = canonicalArgsDigest(request.finalArgs); } catch { return { state: "rejected" as const, handler: 0 as const, reason: "action args cannot be canonically encoded" }; }
    if (request.canonicalArgsDigest !== undefined && request.canonicalArgsDigest !== computedArgsDigest) return { state: "rejected" as const, handler: 0 as const, reason: "canonical args digest does not match final args" };
    const full: ActionIntentRequest = { ...request, delegationId, reservationId: request.reservationId ?? delegation.initialReservationId ?? "", continuationEpoch: request.continuationEpoch ?? delegation.continuationEpoch, fencingGeneration: request.fencingGeneration ?? delegation.fencingGeneration, canonicalArgsDigest: computedArgsDigest } as ActionIntentRequest;
    if (!full.reservationId || full.fencingGeneration !== delegation.fencingGeneration || full.continuationEpoch !== delegation.continuationEpoch || !validPolicy(full.policy) || !Number.isSafeInteger(full.toolCallOrdinal) || full.toolCallOrdinal < 0 || !full.logicalCheckpoint || !full.finalToolName) return { state: "rejected" as const, handler: 0 as const, reason: "action identity or policy is invalid" };
    const actionId = actionIdFor(full); const logicalActionId = actionId; const existing = hasAction(view, actionId);
    if (existing) {
      if (!sameLogicalIdentity(existing, full, actionId)) return { state: "paused_integrity" as const, actionId, logicalActionId, handler: 0 as const, reason: "logical action identity conflict" };
      if (existing.status === "result_acked" || existing.status === "confirmed_succeeded") return { state: "committed" as const, actionId, logicalActionId, handler: 0 as const, policy: full.policy };
      if (["unknown", "still_unknown"].includes(existing.status)) return { state: "rejected" as const, actionId, logicalActionId, handler: 0 as const, reason: "logical action outcome is unresolved" };
      const retry = full.retryPolicy;
      const sameKey = retry?.stableIdempotencyKey === stableIdempotencyKeyFor(logicalActionId);
      const explicitlyAllowed = retry?.allow === true && (full.policy === "read_only" || (retry.idempotent === true && retry.externalSystemSupportsKey === true && sameKey));
      if (!["confirmed_not_started", "confirmed_failed_safe_to_retry"].includes(existing.status) || !explicitlyAllowed) return { state: "rejected" as const, actionId, logicalActionId, handler: 0 as const, policy: full.policy, reason: "safe retry requires explicit policy and the same idempotency key" };
    }
    if (hasUnresolvedActionForDelegation(view, delegationId)) return { state: "rejected" as const, actionId, logicalActionId, handler: 0 as const, reason: "Delegation has an unresolved action" };
    // An unsupported classification is explicit policy, never inferred from a name.
    if (full.policy === "unsupported") return { state: "rejected" as const, actionId, logicalActionId, handler: 0 as const, policy: full.policy, reason: "policy does not admit this tool" };
    const privateRef = actionPrivateRef(logicalActionId);
    try { await writePrivate(privatePayload(dirs(rootDir), `action-${privateFileId(logicalActionId)}`), { version: 1, actionId: logicalActionId, logicalActionId, identityDigest: identityDigest(full), identity: full, stableIdempotencyKey: stableIdempotencyKeyFor(logicalActionId), rawFinalArgs: full.finalArgs, rawArgsRef: full.rawArgsRef }); } catch { return { state: "rejected" as const, actionId, logicalActionId, handler: 0 as const, policy: full.policy, reason: "action intent private durability ACK failed" }; }
    try {
      const retryAllowed = !!existing;
      await appendWal(rootDir, dispatchCallId, "action_intent_acked", { actionId, logicalActionId, identityDigest: identityDigest(full), delegationId, logicalCheckpoint: full.logicalCheckpoint, executionScopeHash: safeScopeHash(full.executionScope), reservationIdHash: safeReservationHash(full.reservationId), continuationEpoch: full.continuationEpoch, fencingGeneration: full.fencingGeneration, ownerGeneration: claim.ownerGeneration, spawnId: claim.spawnId, toolCallOrdinal: full.toolCallOrdinal, finalToolNameHash: safeNameHash(full.finalToolName), canonicalArgsDigest: full.canonicalArgsDigest, stableIdempotencyKey: stableIdempotencyKeyFor(logicalActionId), retryAllowed, policy: full.policy, privateRef }, delegationId, deps);
    } catch {
      return { state: "rejected" as const, actionId, logicalActionId, handler: 0 as const, policy: full.policy, reason: "action intent durability ACK failed" };
    }
    return { state: "allowed" as const, actionId, logicalActionId, handler: 1 as const, policy: full.policy };
  });
  return result ?? { state: "busy", handler: 0, reason: "call lock busy" };
}

export async function finishActionResultInternal(rootDir: string, dispatchCallId: string, delegationId: string, claim: OwnerClaim, request: ActionResultRequest, deps: DelegationFoundationDependencies = {}): Promise<ActionFinishResult> {
  const logicalActionId = request.logicalActionId ?? request.actionId;
  const result = await withCallLock(rootDir, dispatchCallId, async () => {
    const view = await loadView(rootDir, dispatchCallId); const action = logicalActionId ? view.actions?.get(logicalActionId) : undefined;
    if (view.integrity) return { state: "paused_integrity" as const, actionId: logicalActionId ?? "", logicalActionId, reason: view.integrity.reason };
    const delegation = view.delegations.get(delegationId);
    if (!action || !delegation || action.delegationId !== delegationId || !claimMatches(delegation, claim)) return { state: "rejected" as const, actionId: logicalActionId ?? "", logicalActionId, reason: "action result claim cannot be proven" };
    if (request.actionId !== undefined && request.actionId !== action.logicalActionId) return { state: "paused_integrity" as const, actionId: action.actionId, logicalActionId: action.logicalActionId, reason: "action and logical action IDs conflict" };
    if (action.status === "result_acked") {
      if (action.resultRefHash !== resultHash(request.resultRef) || action.resultType !== request.resultType || action.resultStatus !== request.status) return { state: "paused_integrity" as const, actionId: action.actionId, logicalActionId: action.logicalActionId, reason: "action result identity conflict" };
      return { state: "result_acked" as const, actionId: action.actionId, logicalActionId: action.logicalActionId };
    }
    if (["unknown", "still_unknown", "confirmed_succeeded", "confirmed_not_started", "confirmed_failed_safe_to_retry"].includes(action.status)) return { state: "rejected" as const, actionId: action.actionId, logicalActionId: action.logicalActionId, reason: "action is already closed" };
    if (action.status !== "intent_acked") return { state: "rejected" as const, actionId: action.actionId, logicalActionId: action.logicalActionId, reason: "action intent is not durable" };
    if (!validResultRef(request.resultRef) || !SAFE_RESULT_TYPE.test(request.resultType)) return { state: "rejected" as const, actionId: action.actionId, logicalActionId: action.logicalActionId, reason: "result reference/type is invalid" };
    try {
      await writePrivate(privatePayload(dirs(rootDir), `action-${privateFileId(action.logicalActionId)}-result`), { version: 1, actionId: action.logicalActionId, logicalActionId: action.logicalActionId, executionScopeHash: action.executionScopeHash, reservationIdHash: action.reservationIdHash, continuationEpoch: action.continuationEpoch, fencingGeneration: action.fencingGeneration, rawResultRef: request.rawResultRef ?? request.resultRef, resultRef: request.resultRef, resultType: request.resultType, status: request.status });
      await deps.fault?.("after:action_result_private");
    } catch { return reconcileResultAckFailure(rootDir, dispatchCallId, action, request, deps); }
    try {
      await appendWal(rootDir, dispatchCallId, "action_result_acked", { actionId: action.logicalActionId, logicalActionId: action.logicalActionId, identityDigest: action.identityDigest, resultRefHash: resultHash(request.resultRef), resultType: request.resultType, resultStatus: request.status, ownerGeneration: action.ownerGeneration, fencingGeneration: action.fencingGeneration }, delegationId, deps);
      return { state: "result_acked" as const, actionId: action.actionId, logicalActionId: action.logicalActionId };
    } catch {
      return reconcileResultAckFailure(rootDir, dispatchCallId, action, request, deps);
    }
  });
  return result ?? { state: "busy", actionId: logicalActionId ?? "", logicalActionId, reason: "call lock busy" };
}

function hasCancel(view: InternalView, delegationId: string): boolean { return view.events.some((event) => event.type === "cancel_requested" && event.delegationId === delegationId) || view.delegations.get(delegationId)?.state === "cancel_requested" || view.delegations.get(delegationId)?.state === "cancelled"; }

export type ActionReplayDisposition = { actionId: string; status: ActionStatus; retry: "never" | "same-key-eligible" | "paused_uncertainty"; reason: string };
export function replayActionPolicy(action: ActionProjection, policy: ActionReplayPolicy = {}): ActionReplayDisposition {
  if (["result_acked", "confirmed_succeeded"].includes(action.status)) return { actionId: action.logicalActionId, status: action.status, retry: "never", reason: "committed logical action is never replayed" };
  if (["unknown", "still_unknown"].includes(action.status)) {
    const sameKey = policy.stableIdempotencyKey === action.stableIdempotencyKey;
    const eligible = action.policy === "fenced_mutating" && !!policy.idempotent && sameKey && policy.externalSystemSupportsKey === true;
    if (action.policy === "read_only" && policy.readOnlyRetry !== "allowed") return { actionId: action.logicalActionId, status: action.status, retry: "paused_uncertainty", reason: "read-only retry requires explicit policy" };
    return { actionId: action.logicalActionId, status: action.status, retry: eligible || (action.policy === "read_only" && policy.readOnlyRetry === "allowed" && sameKey) ? "same-key-eligible" : "paused_uncertainty", reason: "replay requires explicit idempotency proof" };
  }
  return { actionId: action.logicalActionId, status: action.status, retry: "paused_uncertainty", reason: "intent has no result; action_unknown reconciliation is required" };
}

export async function reconcileActionUnknownLocked(rootDir: string, dispatchCallId: string, delegationId: string, deps: DelegationFoundationDependencies = {}, reason: ActionUnknownReason = "child_death") {
  const view = await loadView(rootDir, dispatchCallId); if (view.integrity) return 0;
  let count = 0; for (const action of unresolvedActions(view, delegationId)) if (await appendUnknownLocked(rootDir, dispatchCallId, action, reason, deps)) count += 1;
  return count;
}
export async function reconcileActionUnknownInternal(rootDir: string, dispatchCallId: string, delegationId: string, deps: DelegationFoundationDependencies = {}) {
  const result = await withCallLock(rootDir, dispatchCallId, async () => {
    const view = await loadView(rootDir, dispatchCallId); if (view.integrity) return pausedResult(dispatchCallId, view.integrity.reason);
    const count = await reconcileActionUnknownLocked(rootDir, dispatchCallId, delegationId, deps);
    const replayed = await loadView(rootDir, dispatchCallId); await materialize(rootDir, replayed); return { state: count ? "paused_uncertainty" as const : "settled" as const, count };
  });
  return result ?? { state: "busy" as const, count: 0 };
}

export async function decideUncertaintyDispositionInternal(rootDir: string, dispatchCallId: string, delegationId: string, actionId: string, disposition: UncertaintyDisposition, actor: { parentSessionId: string; activeLineageId: string; activeBranchAnchor: string }, deps: DelegationFoundationDependencies = {}) {
  const result = await withCallLock(rootDir, dispatchCallId, async () => {
    const view = await loadView(rootDir, dispatchCallId); const action = view.actions?.get(actionId); const delegation = view.delegations.get(delegationId);
    if (view.integrity) return pausedResult(dispatchCallId, view.integrity.reason);
    const cancelEvent = view.events.find((event) => event.type === "cancel_requested" && event.delegationId === delegationId);
    const priorEvents = view.events.filter((event) => event.type === "action_disposition" && event.delegationId === delegationId && event.data.actionId === actionId);
    const priorOutcome = priorEvents.find((event) => event.data.disposition !== "cancel");
    if (!action || !delegation || action.delegationId !== delegationId) return { state: "rejected" as const, reason: "action target cannot be proven" };
    if (!view.call || actor.parentSessionId !== view.call.parentSessionId || actor.activeLineageId !== view.call.activeLineageId || actor.activeBranchAnchor !== view.call.activeBranchAnchor) return { state: "rejected" as const, reason: "decision actor lineage cannot be proven" };
    const actorRef = hash(JSON.stringify([actor.parentSessionId, actor.activeLineageId, actor.activeBranchAnchor]));
    if (cancelEvent && String(cancelEvent.data.actorRef) !== actorRef) return { state: "rejected" as const, reason: "decision actor does not match durable cancel" };

    // Cancellation is its own durable control fact. It never closes the action
    // ledger entry, and repeated cancel decisions only reuse that fact.
    if (disposition === "cancel") {
      if (cancelEvent) {
        await materialize(rootDir, view);
        return { state: "already_decided" as const, actionId, continuationEpoch: delegation.continuationEpoch, controlReceipt: { target: delegationId, scope: "item" as const, actorRef: String(cancelEvent.data.actorRef), walSeq: cancelEvent.seq, status: "already_requested" as const } };
      }
      if (!["unknown", "still_unknown"].includes(action.status)) return { state: "rejected" as const, reason: "action is not awaiting disposition" };
      await appendWal(rootDir, dispatchCallId, "cancel_requested", { target: delegationId, scope: "item", actorRef, parentSessionId: actor.parentSessionId, activeLineageId: actor.activeLineageId, activeBranchAnchor: actor.activeBranchAnchor, priorState: delegation.state }, delegationId, { ...deps, fault: undefined });
      const requested = await loadView(rootDir, dispatchCallId); const durableCancel = requested.events.find((event) => event.type === "cancel_requested" && event.delegationId === delegationId);
      if (!durableCancel) return pausedResult(dispatchCallId, "cancel control receipt cannot be proven");
      await materialize(rootDir, requested);
      return { state: "decided" as const, actionId, disposition, continuationEpoch: delegation.continuationEpoch, controlReceipt: { target: delegationId, scope: "item" as const, actorRef: String(durableCancel.data.actorRef), walSeq: durableCancel.seq, status: "requested" as const } };
    }

    if (priorOutcome) return priorOutcome.data.disposition === disposition ? { state: "already_decided" as const, actionId, continuationEpoch: Number(priorOutcome.data.continuationEpoch) } : { state: "rejected" as const, reason: "contradictory action disposition" };
    if (!["unknown", "still_unknown"].includes(action.status)) return { state: "rejected" as const, reason: "action is not awaiting disposition" };
    const cancelContext = !!cancelEvent;
    const continuationEpoch = isOutcomeDisposition(disposition) && !cancelContext ? delegation.continuationEpoch + 1 : delegation.continuationEpoch;
    const childState = childStateForAction(view, delegation);
    await appendWal(rootDir, dispatchCallId, "action_disposition", { actionId: action.logicalActionId, logicalActionId: action.logicalActionId, identityDigest: action.identityDigest, disposition, actorRef, parentSessionId: actor.parentSessionId, activeLineageId: actor.activeLineageId, activeBranchAnchor: actor.activeBranchAnchor, continuationEpoch, childState, ownerGeneration: action.ownerGeneration, fencingGeneration: action.fencingGeneration }, delegationId, deps);
    let replayed = await loadView(rootDir, dispatchCallId);
    if (cancelContext && !hasUnresolvedActionForDelegation(replayed, delegationId)) {
      // The disposition is durable first; the cancel reconciler then owns the
      // death/seal/terminal transition and never opens normal recovery.
      const control = await import("./delegation-control.ts");
      // decideUncertaintyDispositionInternal already owns the call lock; use
      // the locked reconciler rather than attempting a nested lock.
      await control.reconcileDelegationCancelLocked(rootDir, dispatchCallId, delegationId, deps);
      replayed = await loadView(rootDir, dispatchCallId);
    }
    await materialize(rootDir, replayed);
    return { state: "decided" as const, actionId, disposition, continuationEpoch, ...(cancelContext ? { cancelRequested: true as const } : {}) };
  });
  return result ?? { state: "busy" as const };
}

export async function reconcileBeforeReturnInternal(rootDir: string, dispatchCallId: string, delegationId: string, deps: DelegationFoundationDependencies = {}): Promise<boolean> {
  const view = await loadView(rootDir, dispatchCallId); const actions = unresolvedActions(view, delegationId); if (actions.length === 0) return true;
  for (const action of actions) await appendUnknownLocked(rootDir, dispatchCallId, action, "return_with_unresolved_action", deps);
  const replayed = await loadView(rootDir, dispatchCallId); await materialize(rootDir, replayed); return false;
}

export async function readActionLedgerInternal(rootDir: string, dispatchCallId: string): Promise<readonly ActionProjection[] | undefined> { const view = await loadView(rootDir, dispatchCallId); return view.integrity ? undefined : [...(view.actions?.values() ?? [])].map((action) => ({ ...action })); }
export async function readActionPrivateInternal(rootDir: string, actionId: string): Promise<unknown> {
  if (!ACTION_ID_RE.test(actionId)) return undefined;
  try {
    const value = await readPrivate<Record<string, unknown>>(privatePayload(dirs(rootDir), `action-${privateFileId(actionId)}`));
    if (value.actionId !== actionId || value.logicalActionId !== actionId || value.stableIdempotencyKey !== stableIdempotencyKeyFor(actionId) || !validActionIdentity(value.identity) || value.identityDigest !== identityDigest(value.identity as ActionIdentity)) return undefined;
    return value;
  } catch { return undefined; }
}
