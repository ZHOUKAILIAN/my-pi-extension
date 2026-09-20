/** Internal owner, execution, and startup supervisor. */
import * as fs from "node:fs/promises";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import { findSessionFile, runPiAttempt, sanitizeAttemptResult, validateSessionFile, type AttemptResult } from "./runner.ts";
import { continuationTask, executionCandidates, isAbortRequested, isRetryableProviderFailure, MAX_PROVIDER_RETRIES } from "./execution-policy.ts";
import { capturePersistentFalseOutcome, retryPendingCleanup, sessionRefFor, type CleanupFence } from "./owner-cleanup.ts";
import type { ActiveLineage } from "./lineage.ts";
import type { ChildInspection, DelegationExecutionDependencies, DelegationExecutionResult, DelegationFoundationDependencies, InternalDelegation, InternalView, OwnerIdentity, OwnerIdentityObservation, OwnerLiveness, StartupNormalizationResult } from "./delegation-types.ts";
import { appendWal, callPayload, ensureStore, hash, hashPath, isHex, loadView, loadViewForOwnerClaimPreflight, materialize, pausedResult, privatePayload, readDelegationPayload, readPrivate, validResultRef, WalAppendGuardRejected, withCallLock, withOrphanCoordination } from "./delegation-context.ts";
import { ownerFileSync, readStableOwnerFileSync } from "./secure-fs.ts";
import { lineageMatches } from "./lineage.ts";

export interface OwnerClaim {
  owner: OwnerIdentity;
  ownerGeneration: number;
  fencingGeneration: number;
  spawnId: string;
}
export interface OwnerSupervisorContext {
  appendWal: typeof appendWal;
  sameOwner: typeof sameOwner;
  validOwnerIdentity: typeof validOwnerIdentity;
  recheckResolutionAfterTransfer?: (rootDir: string, callId: string, delegationId: string) => Promise<boolean>;
}
export function makeOwnerSupervisorContext(recheckResolutionAfterTransfer?: OwnerSupervisorContext["recheckResolutionAfterTransfer"]): OwnerSupervisorContext {
  return { appendWal, sameOwner, validOwnerIdentity, recheckResolutionAfterTransfer };
}

export function ownerClaimMatches(claim: OwnerClaim, owner: OwnerIdentity | undefined, ownerGeneration: number, fencingGeneration: number, spawnId: string | undefined, sameOwnerFn: typeof sameOwner): boolean { return sameOwnerFn(owner, claim.owner) && ownerGeneration === claim.ownerGeneration && fencingGeneration === claim.fencingGeneration && spawnId === claim.spawnId; }

const PROCESS_BIRTH = `${Math.floor(Date.now() - process.uptime() * 1000)}`;

export function currentOwnerIdentity(parentSessionId: string, parentSessionPath?: string): OwnerIdentity {
  const pid = process.pid;
  return { host: os.hostname(), pid, birth: PROCESS_BIRTH, parentSessionId, parentSessionPath: path.resolve(parentSessionPath ?? process.argv[1] ?? process.cwd()), argvProof: createHash("sha256").update(JSON.stringify(process.argv)).digest("hex") };
}

export function sameOwner(left: OwnerIdentity | undefined, right: OwnerIdentity): boolean {
  return !!left && left.host === right.host && left.pid === right.pid && left.birth === right.birth && left.parentSessionId === right.parentSessionId && left.parentSessionPath === right.parentSessionPath && left.argvProof === right.argvProof;
}

export function validOwnerIdentity(value: unknown): value is OwnerIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const owner = value as Record<string, unknown>;
  return Object.keys(owner).length === 6 && typeof owner.host === "string" && owner.host.length > 0 && Number.isSafeInteger(owner.pid) && Number(owner.pid) > 0 && typeof owner.birth === "string" && owner.birth.length > 0 && typeof owner.parentSessionId === "string" && owner.parentSessionId.length > 0 && typeof owner.parentSessionPath === "string" && path.isAbsolute(owner.parentSessionPath) && typeof owner.argvProof === "string" && /^[0-9a-f]{64}$/.test(owner.argvProof);
}

function validCurrentLineageShape(lineage: ActiveLineage): boolean {
  return lineage.parentSessionId.length > 0 && lineage.activeLineageId.length > 0 && lineage.activeBranchAnchor.length > 0 && lineage.currentLeafId.length > 0 && lineage.branchIds.length > 0 && lineage.branchIds.at(-1) === lineage.currentLeafId && lineage.branchIds.includes(lineage.activeBranchAnchor) && new Set(lineage.branchIds).size === lineage.branchIds.length;
}

/**
 * Every execution-side WAL action uses this proof while its call lock is held.
 * In particular, a caller cannot omit lineage and rely on the durable view as
 * an implicit authorization.  Restart-durable calls also require the parent
 * session file recorded at admission to be the currently readable owner-only
 * file; this is deliberately a proof, not a best-effort hint.
 */
export async function validateCurrentExecutionContext(
  rootDir: string,
  view: InternalView,
  deps: DelegationFoundationDependencies,
  identity?: OwnerIdentity,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const current = deps.lineage;
  if (!view.call || !current || !validCurrentLineageShape(current) || !lineageMatches(view.call, current)) return { ok: false, reason: "active lineage cannot be proven" };
  let payload: Awaited<ReturnType<typeof callPayload>>;
  try { payload = await callPayload(rootDir, view.call); } catch { return { ok: false, reason: "call private lineage binding cannot be proven" }; }
  if (payload.lineage.parentSessionId !== current.parentSessionId || payload.lineage.activeLineageId !== current.activeLineageId || payload.lineage.activeBranchAnchor !== current.activeBranchAnchor) return { ok: false, reason: "active lineage does not match the admitted call" };
  if (view.call.persistence === "restart-durable") {
    if (current.persistence !== "restart-durable" || !current.parentSessionFile || !payload.lineage.parentSessionFile || path.resolve(current.parentSessionFile) !== path.resolve(payload.lineage.parentSessionFile) || !ownerFileSync(current.parentSessionFile) || !ownerFileSync(payload.lineage.parentSessionFile)) return { ok: false, reason: "durable parent session cannot be proven" };
  }
  if (identity) {
    if (!validOwnerIdentity(identity) || identity.parentSessionId !== view.call.parentSessionId) return { ok: false, reason: "owner parent cannot be proven" };
    if (view.call.persistence === "restart-durable" && (!current.parentSessionFile || path.resolve(identity.parentSessionPath) !== path.resolve(current.parentSessionFile))) return { ok: false, reason: "owner parent session path cannot be proven" };
  }
  return { ok: true };
}

export async function inspectOwnerDefault(owner: OwnerIdentity): Promise<OwnerLiveness> {
  if (owner.host !== os.hostname()) return "unknown";
  try { process.kill(owner.pid, 0); return owner.pid === process.pid ? "alive" : "unknown"; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown"; }
}

/**
 * Interpret an injected process identity tuple without ever acting on the PID.
 * A readable same-PID birth mismatch proves that the recorded owner is gone,
 * while an unreadable tuple remains unknown.
 */
export function classifyOwnerIdentityObservation(owner: OwnerIdentity, observation: OwnerIdentityObservation): OwnerLiveness {
  if (!observation || (observation.state !== "present" && observation.state !== "absent" && observation.state !== "unreadable")) return "unknown";
  if (observation.state === "unreadable") return "unknown";
  if (!Number.isSafeInteger(observation.pid) || observation.pid <= 0 || observation.pid !== owner.pid) return "unknown";
  if (observation.state === "absent") return "dead";
  if (typeof observation.birth !== "string" || observation.birth.length === 0) return "unknown";
  return observation.birth === owner.birth ? "alive" : "dead";
}

export interface OwnerIdentityProbeSafetyAdapter {
  /** Test/platform audit hook. The probe must never invoke this signal path. */
  signal?: (pid: number, signal: NodeJS.Signals) => void;
}

/**
 * The owner death predicate is deliberately observation-only. Both samples
 * must agree; in particular a PID reuse birth mismatch is death proof and is
 * never followed by a signal to that reused PID. The optional safety adapter
 * makes that negative property observable in contract tests; its signal hook
 * is intentionally not called by this function.
 */
export async function probeOwnerDeathStable(
  owner: OwnerIdentity,
  inspect: (owner: OwnerIdentity) => Promise<OwnerIdentityObservation>,
  delayMs = 1,
  safetyAdapter?: OwnerIdentityProbeSafetyAdapter,
): Promise<OwnerLiveness> {
  const observe = async (): Promise<OwnerLiveness> => {
    try {
      const sample = await inspect(owner);
      return classifyOwnerIdentityObservation(owner, sample);
    } catch {
      return "unknown";
    }
  };
  // Keep the adapter referenced in the API contract without ever invoking its
  // signal hook: a birth mismatch is observation-only and cannot authorize a
  // signal to the reused PID.
  void safetyAdapter;
  const first = await observe();
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  const second = await observe();
  return first === second ? first : "unknown";
}

async function inspectOwnerSafely(inspect: (owner: OwnerIdentity) => Promise<OwnerLiveness>, owner: OwnerIdentity): Promise<OwnerLiveness> {
  try {
    const state = await inspect(owner);
    return state === "alive" || state === "dead" || state === "unknown" ? state : "unknown";
  } catch {
    return "unknown";
  }
}

function hasDurableExecutionAction(view: InternalView, delegationId: string): boolean {
  // There is no separate action table in the v2 projection.  These WAL records
  // are the complete execution action protocol, so an intent is an outstanding
  // action unless the history has already reached spawn_started (which is
  // handled separately as historical spawn).
  return view.events.some((event) => event.delegationId === delegationId && ["spawn_intent", "spawn_started"].includes(event.type));
}

function isStrictPreSpawn(delegation: InternalDelegation, view: InternalView, delegationId: string): boolean {
  const historicalSpawn = view.events.some((event) => event.type === "spawn_started" && event.delegationId === delegationId);
  return !historicalSpawn && !delegation.spawnStarted && !delegation.childSessionId && !delegation.childSessionPathHash && delegation.childPid === undefined && !delegation.childIdentity && !hasDurableExecutionAction(view, delegationId);
}

interface PreSpawnAbsenceSnapshot {
  state: InternalDelegation["state"];
  pauseReason: string | undefined;
  ownerGeneration: number;
  fencingGeneration: number;
  owner: OwnerIdentity;
  targetEventSeq: number;
  targetEventChecksum: string;
}

function samePreSpawnAbsenceSnapshot(snapshot: PreSpawnAbsenceSnapshot, view: InternalView, delegationId: string): boolean {
  const delegation = view.delegations.get(delegationId);
  const targetEvents = view.events.filter((event) => event.delegationId === delegationId);
  const latestTarget = targetEvents.at(-1);
  return !!delegation && !view.integrity && latestTarget?.seq === snapshot.targetEventSeq && latestTarget.checksum === snapshot.targetEventChecksum && delegation.state === snapshot.state && delegation.pauseReason === snapshot.pauseReason && delegation.ownerGeneration === snapshot.ownerGeneration && delegation.fencingGeneration === snapshot.fencingGeneration && sameOwner(delegation.owner, snapshot.owner) && isStrictPreSpawn(delegation, view, delegationId);
}

/**
 * Re-read and replay the WAL twice after the old owner death proof.  This is
 * intentionally separate from the owner probe: child absence is a durable
 * no-ref/no-action conclusion, not a child-death observation.
 */
async function provePreSpawnChildAbsence(rootDir: string, dispatchCallId: string, delegationId: string, snapshot: PreSpawnAbsenceSnapshot, delayMs: number): Promise<boolean> {
  for (let observation = 0; observation < 2; observation += 1) {
    const current = await loadView(rootDir, dispatchCallId);
    if (!samePreSpawnAbsenceSnapshot(snapshot, current, delegationId)) return false;
    if (observation === 0 && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return true;
}

function hasCurrentPreSpawnAbsenceProof(view: InternalView, delegationId: string, snapshot: PreSpawnAbsenceSnapshot): boolean {
  const delegation = view.delegations.get(delegationId);
  const targetEvents = view.events.filter((event) => event.delegationId === delegationId);
  const latest = targetEvents.at(-1);
  return !!delegation && latest?.type === "pre_spawn_child_absence_proved" && latest.data.state === snapshot.state && latest.data.pauseReason === snapshot.pauseReason && Number(latest.data.ownerGeneration) === snapshot.ownerGeneration && Number(latest.data.fencingGeneration) === snapshot.fencingGeneration;
}

export async function claimExecutionOwnerUnlocked(rootDir: string, dispatchCallId: string, delegationId: string, identity: OwnerIdentity, deps: DelegationFoundationDependencies, view: InternalView, context: OwnerSupervisorContext): Promise<{ state: "claimed" | "already_owned" | "transferred" | "rejected" | "paused_integrity"; ownerGeneration?: number; fencingGeneration?: number; reason?: string }> {
  const delegation = view.delegations.get(delegationId);
  if (!delegation || !context.validOwnerIdentity(identity)) return { state: "rejected", reason: "owner identity is invalid" };
  const executionContext = await validateCurrentExecutionContext(rootDir, view, deps, identity);
  if (!executionContext.ok) return { state: "rejected", reason: executionContext.reason };
  if (!view.call || identity.parentSessionId !== view.call.parentSessionId) return { state: "rejected", reason: "owner parent cannot be proven" };
  if (context.sameOwner(delegation.owner, identity)) {
    // Recovery after a crash immediately following owner_transferred must not
    // leave a repaired resolution stuck in the old pause forever.
    if (isStrictPreSpawn(delegation, view, delegationId) && delegation.state === "paused_configuration" && delegation.pauseReason === "resolution" && context.recheckResolutionAfterTransfer) {
      let repaired = false;
      try { repaired = await context.recheckResolutionAfterTransfer(rootDir, dispatchCallId, delegationId); } catch { repaired = false; }
      if (repaired) await context.appendWal(rootDir, dispatchCallId, "resolution_ready", {}, delegationId, deps);
    }
    return { state: "already_owned", ownerGeneration: delegation.ownerGeneration, fencingGeneration: delegation.fencingGeneration };
  }
  if (!delegation.owner) {
    // The initial claim adopts the durable generation (normally zero); only a
    // successful takeover advances the execution fence.
    await context.appendWal(rootDir, dispatchCallId, "owner_claimed", { ownerGeneration: 1, fencingGeneration: delegation.fencingGeneration, owner: identity }, delegationId, deps);
    return { state: "claimed", ownerGeneration: 1, fencingGeneration: delegation.fencingGeneration };
  }
  // A durable persistent:false outcome proves execution is over. Cleanup is
  // reconciled by the independent cleanup fence, never by owner takeover.
  // Before the first spawn, takeover is intentionally narrower than the
  // normal execution-owner recovery path: only a resolution pause is
  // transferable.  In particular, a bound/configuration pause must not be
  // turned into permission to reserve or spawn work.
  const historicalSpawn = view.events.some((event) => event.type === "spawn_started" && event.delegationId === delegationId);
  const strictPreSpawn = isStrictPreSpawn(delegation, view, delegationId);
  const resolutionPreSpawn = strictPreSpawn && delegation.state === "paused_configuration" && delegation.pauseReason === "resolution";
  const postSpawnTransfer = historicalSpawn && ["initial_running", "recovery_running", "reattach_only", "recovery_ready"].includes(delegation.state);
  if (!resolutionPreSpawn && !postSpawnTransfer) return { state: "rejected", reason: "owner transfer is not allowed in the current state" };
  const inspect = deps.inspectOwner ?? inspectOwnerDefault;
  const delay = deps.ownerDeathObservationDelayMs ?? 1;
  if (deps.inspectOwnerIdentity) {
    if (await probeOwnerDeathStable(delegation.owner, deps.inspectOwnerIdentity, delay, deps.ownerIdentityProbeSafety) !== "dead") return { state: "rejected", reason: "execution owner death is not stable" };
  } else {
    const first = await inspectOwnerSafely(inspect, delegation.owner);
    if (first !== "dead") return { state: "rejected", reason: "execution owner is still live or cannot be proven dead" };
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const second = await inspectOwnerSafely(inspect, delegation.owner);
    if (second !== "dead") return { state: "rejected", reason: "execution owner death is not stable" };
  }
  if (resolutionPreSpawn) {
    const latestTarget = view.events.filter((event) => event.delegationId === delegationId).at(-1);
    const snapshot: PreSpawnAbsenceSnapshot = { state: delegation.state, pauseReason: delegation.pauseReason, ownerGeneration: delegation.ownerGeneration, fencingGeneration: delegation.fencingGeneration, owner: delegation.owner!, targetEventSeq: latestTarget?.seq ?? 0, targetEventChecksum: latestTarget?.checksum ?? "" };
    if (!await provePreSpawnChildAbsence(rootDir, dispatchCallId, delegationId, snapshot, delay)) return { state: "rejected", reason: "pre-spawn child absence is not stable" };
    // appendWal replays under the same call identity lock.  The transition
    // predicate below also requires this fact to remain the latest target
    // event, so a stale/concurrent spawn or owner fact cannot cross the proof.
    const verified = await loadView(rootDir, dispatchCallId);
    if (!samePreSpawnAbsenceSnapshot(snapshot, verified, delegationId)) return { state: "rejected", reason: "pre-spawn child absence proof is stale" };
    if (!hasCurrentPreSpawnAbsenceProof(verified, delegationId, snapshot)) {
      await context.appendWal(rootDir, dispatchCallId, "pre_spawn_child_absence_proved", {
        state: snapshot.state,
        pauseReason: snapshot.pauseReason,
        ownerGeneration: snapshot.ownerGeneration,
        fencingGeneration: snapshot.fencingGeneration,
        childRefObservation1: "absent",
        childRefObservation2: "absent",
      }, delegationId, deps);
    }
  }
  const childMustBeProvenDead = delegation.spawnStarted || !!delegation.childSessionId || (historicalSpawn && (delegation.state === "recovery_ready" || (delegation.state === "returned" && delegation.cleanupPending === true)));
  let childDeathObservation1: "dead" | "live" | undefined;
  let childDeathObservation2: "dead" | "live" | undefined;
  if (childMustBeProvenDead) {
    if (!delegation.childIdentity || !deps.inspectChild) return { state: "rejected", reason: "child death cannot be proven" };
    const child = { state: "unknown" as const, childSessionId: delegation.childSessionId ?? "", identity: delegation.childIdentity };
    const firstChild = await deps.inspectChild(child);
    if (firstChild === "live" && deps.allowLiveReattach) {
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      if (await deps.inspectChild(child) !== "live") return { state: "rejected", reason: "child liveness is not stable" };
      const fencingGeneration = delegation.fencingGeneration + 1;
      await context.appendWal(rootDir, dispatchCallId, "owner_reattached", { ownerGeneration: delegation.ownerGeneration + 1, previousOwnerGeneration: delegation.ownerGeneration, fencingGeneration, owner: identity, deathObservation1: "dead", deathObservation2: "dead", childDeathObservation1: "live", childDeathObservation2: "live" }, delegationId, deps);
      return { state: "transferred", ownerGeneration: delegation.ownerGeneration + 1, fencingGeneration };
    }
    if (firstChild !== "dead") return { state: "rejected", reason: "child is still live or cannot be proven dead" };
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    if (await deps.inspectChild(child) !== "dead") return { state: "rejected", reason: "child death is not stable" };
    childDeathObservation1 = "dead"; childDeathObservation2 = "dead";
  }
  const fencingGeneration = delegation.fencingGeneration + 1;
  await context.appendWal(rootDir, dispatchCallId, "owner_transferred", { ownerGeneration: delegation.ownerGeneration + 1, previousOwnerGeneration: delegation.ownerGeneration, fencingGeneration, owner: identity, deathObservation1: "dead", deathObservation2: "dead", ...(childMustBeProvenDead ? { childDeathObservation1, childDeathObservation2 } : {}) }, delegationId, deps);
  // The transfer itself is durable before the current configuration is
  // rechecked.  A crash between these records therefore leaves the safe
  // resolution pause in place and a retry can converge it to resolution_ready.
  if (resolutionPreSpawn && context.recheckResolutionAfterTransfer) {
    let repaired = false;
    try { repaired = await context.recheckResolutionAfterTransfer(rootDir, dispatchCallId, delegationId); } catch { repaired = false; }
    if (repaired) await context.appendWal(rootDir, dispatchCallId, "resolution_ready", {}, delegationId, deps);
  }
  return { state: "transferred", ownerGeneration: delegation.ownerGeneration + 1, fencingGeneration };
}



export async function normalizeStartupInternal(rootDir: string, current: ActiveLineage, deps: DelegationExecutionDependencies = {}): Promise<StartupNormalizationResult> {
  const d = await ensureStore(rootDir); let entries: nodeFs.Dirent[]; try { entries = await fs.readdir(d.wal, { withFileTypes: true }); } catch { return { scanned: 0, normalized: 0, pausedIntegrity: 0, spawnCount: 0, sendCount: 0 }; }
  let scanned = 0; let normalized = 0; let pausedIntegrity = 0;
  for (const entry of entries) { if (!entry.name.endsWith(".jsonl")) continue; const callId = entry.name.slice(0, -6); const result = await withOrphanCoordination(rootDir, async () => withCallLock(rootDir, callId, async () => { let view = await loadView(rootDir, callId); if (view.integrity) { await materialize(rootDir, view); return { scanned: false, normalized: 0, paused: true }; } if (!view.call || view.call.parentSessionId !== current.parentSessionId || view.call.activeLineageId !== current.activeLineageId || !current.branchIds.includes(view.call.activeBranchAnchor)) return { scanned: false, normalized: 0, paused: false }; view = await ((deps as DelegationExecutionDependencies).control?.reconcileStartup(rootDir, view) ?? view); if (view.integrity) { await materialize(rootDir, view); return { scanned: false, normalized: 0, paused: true }; } await materialize(rootDir, view); let count = 0; for (const delegation of view.delegations.values()) if (delegation.state === "admitted" || delegation.state === "resolving" || (delegation.state === "paused_configuration" && delegation.pauseReason === "resolution")) { const owner = deps.owner ?? currentOwnerIdentity(view.call!.parentSessionId, current.parentSessionFile); const claimed = await claimExecutionOwnerUnlocked(rootDir, callId, delegation.delegationId, owner, { ...deps, lineage: current }, view, makeOwnerSupervisorContext(deps.recheckResolutionAfterTransfer)); if (claimed.state === "rejected") continue; const owned = await loadView(rootDir, callId); const currentDelegation = owned.delegations.get(delegation.delegationId); if (!currentDelegation || !(currentDelegation.state === "admitted" || currentDelegation.state === "resolving" || (currentDelegation.state === "paused_configuration" && currentDelegation.pauseReason === "resolution"))) continue; await appendWal(rootDir, callId, "resolution_ready", {}, delegation.delegationId); count += 1; } if (count) await materialize(rootDir, await loadView(rootDir, callId)); return { scanned: true, normalized: count, paused: false }; })); if (result?.scanned) scanned += 1; normalized += result?.normalized ?? 0; if (result?.paused) pausedIntegrity += 1; }
  return { scanned, normalized, pausedIntegrity, spawnCount: 0, sendCount: 0 };
}
type ChildIntegrityObservation = Pick<InternalDelegation, "state" | "childSessionId" | "childIdentity" | "fencingGeneration" | "ownerGeneration" | "spawnId">;
function sameChildIntegrityObservation(left: ChildIntegrityObservation, right: InternalDelegation): boolean {
  return left.state === right.state && left.childSessionId === right.childSessionId && left.fencingGeneration === right.fencingGeneration && left.ownerGeneration === right.ownerGeneration && left.spawnId === right.spawnId && JSON.stringify(left.childIdentity) === JSON.stringify(right.childIdentity);
}
async function appendChildIntegrityObserverIfCurrent(rootDir: string, dispatchCallId: string, delegationId: string, expected: ChildIntegrityObservation, reasonCode: string, deps?: DelegationFoundationDependencies): Promise<boolean> {
  const latest = await loadView(rootDir, dispatchCallId);
  if (latest.integrity) return true;
  const current = latest.delegations.get(delegationId);
  if (!current || !sameChildIntegrityObservation(expected, current)) return false;
  await appendWal(rootDir, dispatchCallId, "delegation_integrity_paused", { reasonCode }, delegationId, deps);
  const replayed = await loadView(rootDir, dispatchCallId); await materialize(rootDir, replayed);
  return true;
}
async function pausedChildIntegrity(rootDir: string, dispatchCallId: string, reason: string): Promise<ReturnType<typeof pausedResult>> {
  const replayed = await loadView(rootDir, dispatchCallId); await materialize(rootDir, replayed); return pausedResult(dispatchCallId, reason);
}

export async function reconcileRunningChildInternal(rootDir: string, dispatchCallId: string, delegationId: string, inspect: (child: ChildInspection) => Promise<"live" | "dead" | "unknown">, deps?: DelegationFoundationDependencies) {
  const result = await withCallLock(rootDir, dispatchCallId, async () => {
    const view = await loadView(rootDir, dispatchCallId);
    if (view.integrity) return pausedResult(dispatchCallId, view.integrity.reason);
    const executionContext = await validateCurrentExecutionContext(rootDir, view, deps ?? {}, deps?.owner);
    if (!executionContext.ok) return { state: "rejected" as const, reason: executionContext.reason };
    const delegation = view.delegations.get(delegationId);
    if (!delegation || !["initial_running", "recovery_running"].includes(delegation.state) || !delegation.childSessionId) return { state: "rejected" as const, reason: "running child is not reconcilable" };
    const expected: ChildIntegrityObservation = { state: delegation.state, childSessionId: delegation.childSessionId, childIdentity: delegation.childIdentity, fencingGeneration: delegation.fencingGeneration, ownerGeneration: delegation.ownerGeneration, spawnId: delegation.spawnId };
    const pause = async (reasonCode: string, reason: string) => {
      // This observer is a CAS on the complete child/fence tuple. It never
      // consults the proposed owner, so a stale or unreadable owner cannot
      // block the integrity pause.
      await appendChildIntegrityObserverIfCurrent(rootDir, dispatchCallId, delegationId, expected, reasonCode, deps);
      return pausedChildIntegrity(rootDir, dispatchCallId, reason);
    };
    if (!delegation.childIdentity) return pause("child_identity_unproven", "child identity cannot be proven");
    const child = { state: "unknown" as const, childSessionId: delegation.childSessionId, identity: delegation.childIdentity };
    const safelyInspect = async (candidate: ChildInspection): Promise<{ state: "live" | "dead" | "unknown"; readable: boolean }> => {
      try {
        const state = await inspect(candidate);
        if (state === "live" || state === "dead") return { state, readable: true };
        return { state: "unknown", readable: false };
      } catch {
        return { state: "unknown", readable: false };
      }
    };
    const first = await safelyInspect(child);
    if (!first.readable || first.state === "unknown") return pause("child_liveness_unproven", "child liveness cannot be proven");
    const delay = deps?.ownerDeathObservationDelayMs ?? 1;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const second = await safelyInspect(child);
    if (!second.readable) return first.state === "dead" ? pause("child_death_unstable", "child death is not stable") : pause("child_liveness_unproven", "child liveness cannot be proven");
    if (first.state === "live" && second.state !== "live") return pause("child_liveness_unproven", "child liveness is not stable");
    if (first.state === "dead" && second.state !== "dead") return pause("child_death_unstable", "child death is not stable");
    const identity = deps?.owner ?? currentOwnerIdentity(view.call?.parentSessionId ?? "unknown", deps?.lineage?.parentSessionFile);
    // All child observations are complete before this claim. Reusing the
    // stable result prevents claim-time inspection from creating an
    // unobserved exception/claim window.
    const claimDeps = { ...(deps ?? {}), inspectChild: async (_candidate: ChildInspection) => second.state };
    const claimed = await claimExecutionOwnerUnlocked(rootDir, dispatchCallId, delegationId, identity, first.state === "live" ? { ...claimDeps, allowLiveReattach: true } : claimDeps, view, makeOwnerSupervisorContext());
    if (claimed.state === "rejected") return claimed;
    if (first.state === "live") {
      const owned = await loadView(rootDir, dispatchCallId); const current = owned.delegations.get(delegationId)!;
      await appendWal(rootDir, dispatchCallId, "delegation_reattach_verified", { childSessionId: current.childSessionId!, spawnId: current.spawnId!, fencingGeneration: current.fencingGeneration, ownerGeneration: current.ownerGeneration }, delegationId, deps);
      const replayed = await loadView(rootDir, dispatchCallId); await materialize(rootDir, replayed); return { state: "reattach_only" as const, childSessionId: current.childSessionId! };
    }
    const owned = await loadView(rootDir, dispatchCallId); const current = owned.delegations.get(delegationId)!;
    await appendWal(rootDir, dispatchCallId, "execution_interrupted", { reason: "child dead during startup", failureKind: "transient_provider", resultRef: "", spawnId: current.spawnId!, fencingGeneration: current.fencingGeneration, ownerGeneration: current.ownerGeneration }, delegationId, deps);
    const replayed = await loadView(rootDir, dispatchCallId); await materialize(rootDir, replayed); return { state: "recovery_ready" as const };
  }); return result ?? { state: "busy" as const };
}

export async function claimExecutionOwnerInternal(rootDir: string, dispatchCallId: string, delegationId: string, identity: OwnerIdentity, deps: DelegationFoundationDependencies = {}) {
  const result = await withCallLock(rootDir, dispatchCallId, async () => {
    const view = await loadView(rootDir, dispatchCallId); if (view.integrity) return pausedResult(dispatchCallId, view.integrity.reason);
    const claimed = await claimExecutionOwnerUnlocked(rootDir, dispatchCallId, delegationId, identity, deps, view, makeOwnerSupervisorContext(deps.recheckResolutionAfterTransfer)); const replayed = await loadView(rootDir, dispatchCallId); await materialize(rootDir, replayed); return claimed;
  });
  return result ?? { state: "busy" as const };
}

export async function bindChildSessionInternal(rootDir: string, dispatchCallId: string, delegationId: string, claim: OwnerClaim, childSessionId: string, sessionPath?: string, pid?: number, deps: DelegationFoundationDependencies = {}, attempt?: number) {
  const result = await withCallLock(rootDir, dispatchCallId, async () => {
    const view = await loadViewForOwnerClaimPreflight(rootDir, dispatchCallId); if (view.integrity) return pausedResult(dispatchCallId, view.integrity.reason);
    const executionContext = await validateCurrentExecutionContext(rootDir, view, deps, claim?.owner);
    if (!executionContext.ok) return { state: "rejected" as const, reason: executionContext.reason };
    const delegation = view.delegations.get(delegationId);
    // Binding is a production callback contract, not a best-effort test seam.
    // All four durable coordinates are compared while the call fence is held;
    // a stale owner therefore returns before appendWal and produces zero WAL.
    if (!validOwnerIdentity(claim?.owner) || !Number.isSafeInteger(claim?.ownerGeneration) || claim.ownerGeneration < 1 || !Number.isSafeInteger(claim?.fencingGeneration) || claim.fencingGeneration < 0 || typeof claim.spawnId !== "string" || claim.spawnId.length === 0 || !delegation || !["initial_running", "recovery_running"].includes(delegation.state) || !ownerClaimMatches(claim, delegation.owner, delegation.ownerGeneration, delegation.fencingGeneration, delegation.spawnId, sameOwner) || (delegation.childSessionId && delegation.childSessionId !== childSessionId)) return { state: "rejected" as const, reason: "child binding owner claim is not current" };
    const childIdentity = deps.childIdentity;
    if (delegation.childSessionId && attempt === undefined) return { state: "rejected" as const, reason: "child rebound attempt is required" };
    if (childIdentity && (childIdentity.pid !== pid || (sessionPath && childIdentity.sessionPathHash !== hashPath(sessionPath)))) return { state: "rejected" as const, reason: "child identity does not match binding" };
    await appendWal(rootDir, dispatchCallId, delegation.childSessionId ? "child_session_rebound" : "child_session_bound", { spawnId: claim.spawnId, childSessionId, fencingGeneration: claim.fencingGeneration, ownerGeneration: claim.ownerGeneration, ...(sessionPath ? { sessionPathHash: hashPath(sessionPath) } : childIdentity ? { sessionPathHash: childIdentity.sessionPathHash } : {}), ...(pid !== undefined ? { pid } : {}), ...(childIdentity ? { childHost: childIdentity.host, childBirth: childIdentity.birth, childArgvProof: childIdentity.argvProof } : {}), attempt: attempt ?? 1 }, delegationId, deps);
    const replayed = await loadView(rootDir, dispatchCallId); await materialize(rootDir, replayed); return { state: "bound" as const, childSessionId };
  }); return result ?? { state: "busy" as const };
}

export async function markSpawnStartedInternal(rootDir: string, dispatchCallId: string, delegationId: string, runKind: "initial" | "recovery", deps: DelegationFoundationDependencies = {}) {
  const result = await withCallLock(rootDir, dispatchCallId, async () => {
    let view = await loadView(rootDir, dispatchCallId); if (view.integrity) return pausedResult(dispatchCallId, view.integrity.reason);
    const context = await validateCurrentExecutionContext(rootDir, view, deps);
    if (!context.ok) return { state: "rejected" as const, reason: context.reason };
    const delegation = view.delegations.get(delegationId); const expectedState = runKind === "initial" ? "initial_ready" : "cycle_ready";
    if (!delegation || delegation.state !== expectedState || !delegation.initialReservationId) return { state: "rejected" as const, reason: "spawn lifecycle precondition is not met" };
    if (runKind === "recovery" && delegation.continuationEpoch < 1) return { state: "rejected" as const, reason: "recovery startup proof is incomplete" };
    const identity = deps.owner ?? currentOwnerIdentity(view.call?.parentSessionId ?? "unknown", deps.lineage?.parentSessionFile);
    const claimed = await claimExecutionOwnerUnlocked(rootDir, dispatchCallId, delegationId, identity, deps, view, makeOwnerSupervisorContext());
    if (claimed.state === "rejected" || claimed.state === "paused_integrity") return claimed;
    view = await loadView(rootDir, dispatchCallId); const current = view.delegations.get(delegationId)!;
    const reservationId = current.initialReservationId!; const continuationEpoch = current.continuationEpoch; const fencingGeneration = current.fencingGeneration; const ownerGeneration = current.ownerGeneration;
    const priorIntent = view.events.find((event) => event.type === "spawn_intent" && event.delegationId === delegationId && event.data.reservationId === reservationId && event.data.continuationEpoch === continuationEpoch && event.data.fencingGeneration === fencingGeneration && event.data.ownerGeneration === ownerGeneration);
    const spawnId = priorIntent ? String(priorIntent.data.spawnId) : randomUUID();
    // This is the final pre-spawn fence. The reservation happened in an
    // earlier lock scope, so the signal must be checked again after the
    // current-lineage and owner-fence preflight and at the WAL write boundary.
    // Keep the interruption append under this same call lock: never release
    // the fence and then decide whether to spawn.
    const interruptBeforeSpawnIfProven = async (candidate: InternalView) => {
      const candidateDelegation = candidate.delegations.get(delegationId);
      const currentContext = await validateCurrentExecutionContext(rootDir, candidate, deps, candidateDelegation?.owner);
      const ownerFence = !!candidateDelegation?.owner && sameOwner(candidateDelegation.owner, identity) && candidateDelegation.ownerGeneration === claimed.ownerGeneration && candidateDelegation.fencingGeneration === claimed.fencingGeneration;
      const noSpawnAction = !candidateDelegation?.spawnStarted && !candidateDelegation?.childSessionId && !hasDurableExecutionAction(candidate, delegationId);
      if (candidate.integrity || !currentContext.ok || !ownerFence || !noSpawnAction) return { state: "rejected" as const, reason: "abort fence cannot prove pre-spawn absence" };
      await appendWal(rootDir, dispatchCallId, "execution_interrupted_before_spawn", { reason: "abort requested before spawn", failureKind: "unknown_transport", resultRef: "", spawnId: "none", ownerGeneration: 0 }, delegationId, deps);
      const interrupted = await loadView(rootDir, dispatchCallId); await materialize(rootDir, interrupted);
      return { state: "paused_uncertainty" as const, reason: "abort requested before spawn" };
    };
    if (isAbortRequested(deps.signal) && !priorIntent) return interruptBeforeSpawnIfProven(view);
    if (!priorIntent) {
      try {
        await appendWal(rootDir, dispatchCallId, "spawn_intent", { spawnId, runKind, reservationId, continuationEpoch, fencingGeneration, ownerGeneration }, delegationId, deps, {
          // appendRecords has completed all async open/validation work before
          // invoking this synchronous guard. No await can run between this
          // check and issuing the first WAL write on this thread.
          beforeFirstWrite: () => { if (isAbortRequested(deps.signal)) throw new WalAppendGuardRejected(); },
        });
      } catch (error) {
        if (!(error instanceof WalAppendGuardRejected)) throw error;
        const afterGuard = await loadView(rootDir, dispatchCallId);
        const intentAfterGuard = afterGuard.events.some((event) => event.type === "spawn_intent" && event.delegationId === delegationId && event.data.reservationId === reservationId && event.data.continuationEpoch === continuationEpoch && event.data.fencingGeneration === fencingGeneration && event.data.ownerGeneration === ownerGeneration);
        // The guard rejects before the write. If a future append primitive ever
        // reports the guard after issuing a write, treat that intent as
        // post-intent and finish the paired spawn_started transition instead
        // of falsely recording intent=0.
        if (!intentAfterGuard) return interruptBeforeSpawnIfProven(afterGuard);
      }
    }
    await appendWal(rootDir, dispatchCallId, "spawn_started", { spawnId, runKind, reservationId, continuationEpoch, fencingGeneration, ownerGeneration }, delegationId, deps);
    const replayed = await loadView(rootDir, dispatchCallId); await materialize(rootDir, replayed); return { state: runKind === "initial" ? "initial_running" as const : "recovery_running" as const, spawnId, fencingGeneration, ownerGeneration, owner: current.owner! };
  }); return result ?? { state: "busy" as const };
}
export async function markDelegationReturnedInternal(rootDir: string, dispatchCallId: string, delegationId: string, outcome: "success" | "failure" | "cancelled", resultRef: string, claim: OwnerClaim, deps: DelegationFoundationDependencies = {}) {
  const result = await withCallLock(rootDir, dispatchCallId, async () => {
    const view = await loadViewForOwnerClaimPreflight(rootDir, dispatchCallId); if (view.integrity) return pausedResult(dispatchCallId, view.integrity.reason);
    const executionContext = await validateCurrentExecutionContext(rootDir, view, deps, claim?.owner);
    if (!executionContext.ok) return { state: "rejected" as const, reason: executionContext.reason };
    const delegation = view.delegations.get(delegationId);
    // Return is a callback from a particular execution.  Do not derive any
    // part of its identity from the current owner: transfer may have happened
    // since the callback was created.  The complete claim is a CAS under the
    // call lock, so every rejected stale callback performs zero WAL writes.
    if (!validOwnerIdentity(claim?.owner) || !Number.isSafeInteger(claim?.ownerGeneration) || claim.ownerGeneration < 1 || !Number.isSafeInteger(claim?.fencingGeneration) || claim.fencingGeneration < 0 || typeof claim.spawnId !== "string" || claim.spawnId.length === 0 || (deps.owner !== undefined && !sameOwner(deps.owner, claim.owner)) || !delegation || !delegation.owner || !["initial_running", "recovery_running", "reattach_only"].includes(delegation.state) || !delegation.initialReservationId || !delegation.spawnStarted || outcome === "cancelled" || !validResultRef(resultRef) || !ownerClaimMatches(claim, delegation.owner, delegation.ownerGeneration, delegation.fencingGeneration, delegation.spawnId, sameOwner)) return { state: "rejected" as const, reason: "delegation return owner claim is not current" };
    await appendWal(rootDir, dispatchCallId, "delegation_returned", { outcome, resultRef, spawnId: claim.spawnId, fencingGeneration: claim.fencingGeneration, ownerGeneration: claim.ownerGeneration }, delegationId, deps); const replayed = await loadView(rootDir, dispatchCallId); await materialize(rootDir, replayed); return { state: "returned" as const };
  }); return result ?? { state: "busy" as const };
}
function executionRef(attempt: AttemptResult): string { return `ref:${hash(JSON.stringify({ failureKind: attempt.failureKind, attempt: attempt.attempt, sessionId: attempt.sessionId })) .slice(0, 16)}`; }
function durableInterruptionFailureKind(failureKind: AttemptResult["failureKind"], parentAbort: boolean): "unknown_transport" | "transient_provider" | "non_transient_provider" {
  if (parentAbort || failureKind === "cancelled") return "unknown_transport";
  return failureKind === "transient_provider" || failureKind === "non_transient_provider" ? failureKind : "unknown_transport";
}
function durableInterruptionReason(failureKind: AttemptResult["failureKind"], parentAbort: boolean): string {
  if (parentAbort) return "abort requested";
  return failureKind === "cancelled" ? "child aborted" : failureKind;
}
function canonicalAgentMatches(agent: AgentConfig, canonical: NonNullable<InternalDelegation["canonical"]>): boolean {
  if (agent.name !== canonical.name || agent.source !== canonical.source) return false;
  const stable = readStableOwnerFileSync(agent.fileRealpath ?? agent.filePath); if (!stable || hashPath(stable.realpath) !== canonical.fileHash || stable.digest !== canonical.digest) return false;
  if (agent.fileRealpath !== undefined && agent.fileRealpath !== stable.realpath) return false;
  if (agent.discoveryRootRealpath !== undefined && hashPath(agent.discoveryRootRealpath) !== canonical.discoveryRootHash) return false;
  if (agent.digest !== undefined && agent.digest !== canonical.digest) return false;
  const parsed = parseFrontmatter<Record<string, unknown>>(stable.content); if (parsed.body !== agent.systemPrompt) return false;
  return true;
}
async function interruptBeforeSpawn(rootDir: string, dispatchCallId: string, delegationId: string, agent: AgentConfig, deps: DelegationExecutionDependencies): Promise<"paused_uncertainty" | "busy" | "rejected"> {
  const result = await withCallLock(rootDir, dispatchCallId, async () => {
    const view = await loadView(rootDir, dispatchCallId); if (view.integrity) return "rejected" as const;
    const identity = deps.owner ?? currentOwnerIdentity(view.call?.parentSessionId ?? "unknown", deps.lineage?.parentSessionFile);
    const context = await validateCurrentExecutionContext(rootDir, view, deps, identity);
    if (!context.ok) return "rejected" as const;
    const delegation = view.delegations.get(delegationId);
    if (!delegation || delegation.spawnStarted || !["bound", "initial_ready", "recovery_ready", "cycle_ready"].includes(delegation.state)) return delegation?.state === "paused_uncertainty" ? "paused_uncertainty" as const : "rejected" as const;
    if (delegation.owner && !sameOwner(delegation.owner, identity)) return "rejected" as const;
    if (!delegation.canonical || !canonicalAgentMatches(agent, delegation.canonical)) return "rejected" as const;
    await appendWal(rootDir, dispatchCallId, "execution_interrupted_before_spawn", { reason: "abort requested before spawn", failureKind: "unknown_transport", resultRef: "", spawnId: "none", ownerGeneration: 0 }, delegationId, deps);
    const replayed = await loadView(rootDir, dispatchCallId); await materialize(rootDir, replayed); return "paused_uncertainty" as const;
  }); return result ?? "busy";
}
async function runExecutionCycle(rootDir: string, dispatchCallId: string, delegationId: string, runKind: "initial" | "recovery", agent: AgentConfig, task: string, deps: DelegationExecutionDependencies, childSessionId: string, claim: OwnerClaim): Promise<{ attempt: AttemptResult; attempts: AttemptResult[] }> {
  // This claim is captured at spawn start and is immutable for the whole
  // execution.  In particular, callbacks must not switch to a later owner.
  const { spawnId, fencingGeneration, ownerGeneration } = claim;
  const run = deps.runAttempt ?? runPiAttempt; const candidates = executionCandidates({ agent, requestedModel: deps.model, parentModel: deps.parentModel }); const attempts: AttemptResult[] = []; let number = 0; let sessionFile: string | undefined; const sessionDir = path.join(rootDir, "v2", "sessions", delegationId);
  await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });
  for (const candidate of candidates) {
    for (let retry = 0; retry <= MAX_PROVIDER_RETRIES; retry += 1) {
      if (isAbortRequested(deps.signal)) { const cancelled: AttemptResult = { agent: agent.name, agentSource: agent.source, exitCode: null, messages: [], toolResults: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }, requestedModel: candidate.model ?? "unknown", actualModel: "unknown", source: "retry", attempt: ++number, failureKind: "cancelled", errorMessage: "cancelled", cwdScope: "cwd:unknown" }; attempts.push(cancelled); return { attempt: cancelled, attempts }; }
      const firstAttempt = number === 0; const prompt = continuationTask(task, firstAttempt);
      const attemptNumber = ++number; const raw = await run({ cwd: path.resolve((await readDelegationPayload(rootDir, await loadView(rootDir, dispatchCallId), (await loadView(rootDir, dispatchCallId)).delegations.get(delegationId)!)).effectiveCwd), agent, task: prompt, model: candidate.model, attempt: attemptNumber, source: retry > 0 ? "retry" : candidate.source, sessionDir, childSessionId, sessionFile, signal: deps.signal, env: deps.fast?.environment(agent, runKind === "initial" && firstAttempt), firstLogicalChildSpawn: runKind === "initial" && firstAttempt, parentFastRequested: deps.fast?.requestedFast ?? false, onChildProcess: async (child: { pid: number; identity: string; sessionPath?: string }) => { const binding = await deps.control!.bindChildSession(rootDir, dispatchCallId, delegationId, claim, child.identity, child.sessionPath, child.pid, deps, attemptNumber); if (binding.state !== "bound") throw new Error("child binding was not durably accepted"); }, onUpdate: deps.onUpdate });
      const attempt = sanitizeAttemptResult(raw); const boundView = await loadView(rootDir, dispatchCallId); const boundAttempt = boundView.events.some((event) => (event.type === "child_session_bound" || event.type === "child_session_rebound") && event.delegationId === delegationId && event.data.spawnId === spawnId && Number(event.data.fencingGeneration) === fencingGeneration && Number(event.data.ownerGeneration) === ownerGeneration && Number(event.data.attempt) === attemptNumber); if (!boundAttempt || boundView.integrity || !boundView.delegations.get(delegationId)?.childSessionId) { attempt.failureKind = "unknown_transport"; attempt.errorMessage = "child attempt binding cannot be proven"; } attempts.push(attempt); deps.onUpdate?.(attempt);
      const executionCwd = path.resolve((await readDelegationPayload(rootDir, await loadView(rootDir, dispatchCallId), (await loadView(rootDir, dispatchCallId)).delegations.get(delegationId)!)).effectiveCwd);
      const discovered = await findSessionFile(sessionDir, childSessionId); if (discovered && await validateSessionFile(discovered, childSessionId, executionCwd)) sessionFile = discovered;
      if (!sessionFile || !(await validateSessionFile(sessionFile, childSessionId, executionCwd))) { attempt.failureKind = "unknown_transport"; attempt.errorMessage = "session file is missing or invalid"; }
      if (attempt.failureKind === "success" || attempt.failureKind === "incomplete" || attempt.failureKind === "cancelled" || attempt.failureKind === "non_transient_provider" || attempt.failureKind === "task_failure" || attempt.failureKind === "unknown_transport") return { attempt, attempts };
      if (isRetryableProviderFailure(attempt.failureKind) && retry < MAX_PROVIDER_RETRIES) await deps.sleep?.(50);
    }
  }
  return { attempt: attempts.at(-1)!, attempts };
}
async function commitTerminalOutcome(rootDir: string, dispatchCallId: string, delegationId: string, attempt: AttemptResult, resultRef: string, claim: OwnerClaim, ephemeral: boolean, deps: DelegationExecutionDependencies): Promise<{ state: "completed" | "rejected" | "paused_uncertainty"; error?: string }> {
  const { spawnId, fencingGeneration, ownerGeneration } = claim;
  const outcome = attempt.failureKind === "success" ? "success" : "failure";
  const committed = await withCallLock(rootDir, dispatchCallId, async () => {
    const view = await loadView(rootDir, dispatchCallId); const delegation = view.delegations.get(delegationId);
    if (view.integrity) return { state: "rejected" as const, error: view.integrity.reason };
    const executionContext = await validateCurrentExecutionContext(rootDir, view, deps, claim.owner);
    if (!executionContext.ok) return { state: "rejected" as const, error: executionContext.reason };
    if (!delegation || !ownerClaimMatches(claim, delegation.owner, delegation.ownerGeneration, delegation.fencingGeneration, delegation.spawnId, sameOwner) || view.events.some((event) => event.type === "execution_outcome_captured" && event.delegationId === delegationId && event.data.spawnId === spawnId)) return { state: "rejected" as const, error: "terminal commit fenced by a newer owner or spawn" };
    if (ephemeral) {
      return capturePersistentFalseOutcome({
        rootDir,
        dispatchCallId,
        delegationId,
        appendWal: (type, data, appendDeps) => appendWal(rootDir, dispatchCallId, type, data, delegationId, appendDeps),
        materialize: async () => materialize(rootDir, await loadView(rootDir, dispatchCallId)),
        cleanup: deps.cleanup,
        deps,
      }, attempt, resultRef, spawnId, fencingGeneration, ownerGeneration);
    } else {
      await appendWal(rootDir, dispatchCallId, "delegation_returned", { outcome, resultRef, spawnId, fencingGeneration, ownerGeneration }, delegationId, deps);
    }
    const replayed = await loadView(rootDir, dispatchCallId); await materialize(rootDir, replayed); return { state: "completed" as const };
  });
  return committed ?? { state: "rejected", error: "execution owner lock is busy" };
}

export async function executeDelegationInternal(rootDir: string, dispatchCallId: string, delegationId: string, agent: AgentConfig, deps: DelegationExecutionDependencies = {}): Promise<DelegationExecutionResult> {
  let view = await loadView(rootDir, dispatchCallId); if (view.integrity) return { state: "rejected", dispatchCallId, delegationId, attempts: [], error: view.integrity.reason }; const before = view.delegations.get(delegationId);
  if (!before) return { state: "rejected", dispatchCallId, delegationId, attempts: [], error: "delegation not found" };
  if (before.state === "returned") return { state: "rejected", dispatchCallId, delegationId, attempts: [], error: "delegation already has a durable outcome" };
  if (isAbortRequested(deps.signal)) { const aborted = await interruptBeforeSpawn(rootDir, dispatchCallId, delegationId, agent, deps); return { state: aborted === "busy" ? "busy" : aborted === "rejected" ? "rejected" : "paused_uncertainty", dispatchCallId, delegationId, attempts: [], error: "abort requested before spawn" }; }
  if (!before.canonical || !canonicalAgentMatches(agent, before.canonical)) return { state: "rejected", dispatchCallId, delegationId, attempts: [], error: "canonical execution identity cannot be proven" };
  let runKind: "initial" | "recovery"; let recoveryCycle: number | undefined;
  if (before.state === "bound") { const reserved = await deps.control!.reserveInitial(rootDir, dispatchCallId, delegationId, deps); if (reserved.state !== "reserved" && reserved.state !== "ready") return { state: reserved.state === "paused_configuration" ? "paused_configuration" : "rejected", dispatchCallId, delegationId, attempts: [], error: (reserved as any).reason ?? (reserved as any).error }; runKind = "initial"; }
  else if (before.state === "initial_ready") runKind = "initial";
  else if (before.state === "recovery_ready") { if (!deps.lineage || !lineageMatches(before, deps.lineage)) return { state: "rejected", dispatchCallId, delegationId, attempts: [], error: "active lineage cannot be proven for recovery" }; const reserved = await deps.control!.reserveRecoveryCycle(rootDir, dispatchCallId, delegationId, deps); if (reserved.state !== "reserved") return { state: reserved.state === "busy" ? "busy" : "rejected", dispatchCallId, delegationId, attempts: [], error: (reserved as any).reason }; runKind = "recovery"; recoveryCycle = reserved.cycle; }
  else if (before.state === "cycle_ready") { if (!deps.lineage || !lineageMatches(before, deps.lineage)) return { state: "rejected", dispatchCallId, delegationId, attempts: [], error: "active lineage cannot be proven for recovery" }; runKind = "recovery"; recoveryCycle = before.recoveryCyclesUsed; }
  else return { state: "rejected", dispatchCallId, delegationId, attempts: [], error: "delegation is not executable" };
  const started = await deps.control!.markSpawnStarted(rootDir, dispatchCallId, delegationId, runKind, deps); if (started.state !== "initial_running" && started.state !== "recovery_running") return { state: started.state === "busy" ? "busy" : started.state === "paused_uncertainty" ? "paused_uncertainty" : "rejected", dispatchCallId, delegationId, runKind, recoveryCycle, attempts: [], error: (started as any).reason ?? (started as any).error };
  const spawnId = String((started as { spawnId: string }).spawnId); const fencingGeneration = Number((started as { fencingGeneration?: number }).fencingGeneration ?? 0); const ownerGeneration = Number((started as { ownerGeneration?: number }).ownerGeneration ?? 0); const startupClaim: OwnerClaim = { owner: (started as { owner: OwnerIdentity }).owner, ownerGeneration, fencingGeneration, spawnId }; const childSessionId = randomUUID(); let cycle: { attempt: AttemptResult; attempts: AttemptResult[] };
  try { const current = await loadView(rootDir, dispatchCallId); const payload = await readDelegationPayload(rootDir, current, current.delegations.get(delegationId)!); cycle = await runExecutionCycle(rootDir, dispatchCallId, delegationId, runKind, agent, payload.item.task, deps, childSessionId, startupClaim); }
  catch { const fallback: AttemptResult = { agent: agent.name, agentSource: agent.source, exitCode: null, messages: [], toolResults: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }, requestedModel: deps.model ?? agent.model ?? "unknown", actualModel: "unknown", source: "initial", attempt: 1, failureKind: "unknown_transport", errorMessage: "child process failed", cwdScope: "cwd:unknown", sessionId: childSessionId }; cycle = { attempt: fallback, attempts: [fallback] }; }
  const resultRef = executionRef(cycle.attempt);
  // Abort wins the terminal race. A successful child result is not returned
  // once an AbortSignal has fired; the controller records an interruption.
  if (isAbortRequested(deps.signal)) cycle.attempt.failureKind = "cancelled";
  const latestForRetention = await loadView(rootDir, dispatchCallId);
  const callPrivate = latestForRetention.call ? await callPayload(rootDir, latestForRetention.call).catch(() => undefined) : undefined;
  const retentionDelegation = latestForRetention.delegations.get(delegationId);
  const retentionPayload = retentionDelegation ? await readDelegationPayload(rootDir, latestForRetention, retentionDelegation).catch(() => undefined) : undefined;
  const ephemeral = callPrivate?.persistent === false || retentionPayload?.item.persistent === false;
  const executionView = await loadView(rootDir, dispatchCallId);
  if (cycle.attempt.failureKind === "unknown_transport" && !executionView.delegations.get(delegationId)?.childSessionId) {
    const paused = await withCallLock(rootDir, dispatchCallId, async () => {
      const latest = await loadView(rootDir, dispatchCallId);
      const current = latest.delegations.get(delegationId);
      const context = await validateCurrentExecutionContext(rootDir, latest, deps, startupClaim.owner);
      if (context.ok && !latest.integrity && current?.state === (runKind === "initial" ? "initial_running" : "recovery_running") && current.spawnId === spawnId && current.fencingGeneration === fencingGeneration && current.ownerGeneration === ownerGeneration) {
        await appendWal(rootDir, dispatchCallId, "execution_interrupted", { reason: "child binding cannot be proven", failureKind: "unknown_transport", resultRef, spawnId, fencingGeneration, ownerGeneration }, delegationId, deps);
      }
      const replayed = await loadView(rootDir, dispatchCallId);
      await materialize(rootDir, replayed);
      return replayed.integrity?.reason ?? "child binding cannot be proven";
    });
    return { state: "paused_uncertainty", dispatchCallId, delegationId, runKind, recoveryCycle, attempt: cycle.attempt, attempts: cycle.attempts, error: paused ?? "child binding cannot be proven" };
  }
  const terminal = ["success", "incomplete", "task_failure"].includes(cycle.attempt.failureKind);
  if (terminal) { const committed = await commitTerminalOutcome(rootDir, dispatchCallId, delegationId, cycle.attempt, resultRef, startupClaim, ephemeral, deps); return { state: committed.state === "completed" ? "completed" : "rejected", dispatchCallId, delegationId, runKind, recoveryCycle, attempt: cycle.attempt, attempts: cycle.attempts, error: committed.error }; }
  const interruptionState = await withCallLock(rootDir, dispatchCallId, async () => { const latest = await loadView(rootDir, dispatchCallId); const context = await validateCurrentExecutionContext(rootDir, latest, deps, startupClaim.owner); const latestDelegation = latest.delegations.get(delegationId); if (context.ok && !latest.integrity && latestDelegation?.state === (runKind === "initial" ? "initial_running" : "recovery_running") && latestDelegation.spawnId === spawnId && latestDelegation.fencingGeneration === fencingGeneration && latestDelegation.ownerGeneration === ownerGeneration) await appendWal(rootDir, dispatchCallId, "execution_interrupted", { reason: durableInterruptionReason(cycle.attempt.failureKind, isAbortRequested(deps.signal)), failureKind: durableInterruptionFailureKind(cycle.attempt.failureKind, isAbortRequested(deps.signal)), resultRef, spawnId, fencingGeneration, ownerGeneration }, delegationId, deps); const replayed = await loadView(rootDir, dispatchCallId); await materialize(rootDir, replayed); return context.ok ? replayed.delegations.get(delegationId)?.state : "rejected" as const; });
  const state = interruptionState === "rejected" ? "rejected" : interruptionState === "paused_configuration" || cycle.attempt.failureKind === "non_transient_provider" ? "paused_configuration" : interruptionState === "paused_integrity" ? "paused_integrity" : interruptionState === "paused_uncertainty" ? "paused_uncertainty" : "recoverable_failed";
  return { state, dispatchCallId, delegationId, runKind, recoveryCycle, attempt: cycle.attempt, attempts: cycle.attempts, error: cycle.attempt.errorMessage };
}

export async function executeReattachedDelegationInternal(rootDir: string, dispatchCallId: string, delegationId: string, executor: (options: { childSessionId: string; sessionPath?: string; spawnId: string; ownerGeneration: number; fencingGeneration: number }) => Promise<AttemptResult>, deps: DelegationExecutionDependencies = {}): Promise<DelegationExecutionResult> {
  const view = await loadView(rootDir, dispatchCallId); const delegation = view.delegations.get(delegationId);
  if (!delegation || !["reattach_only", "initial_running", "recovery_running"].includes(delegation.state) || !delegation.childSessionId || !delegation.spawnId || !delegation.childIdentity || !deps.inspectChild) return { state: "rejected", dispatchCallId, delegationId, attempts: [], error: "live child identity is not reattachable" };
  const observed = await deps.inspectChild({ state: "unknown", childSessionId: delegation.childSessionId, identity: delegation.childIdentity }); if (observed !== "live") return { state: "rejected", dispatchCallId, delegationId, attempts: [], error: "live child cannot be proven" };
  if (isAbortRequested(deps.signal)) { const interrupted = await withCallLock(rootDir, dispatchCallId, async () => { const current = await loadView(rootDir, dispatchCallId); const identity = deps.owner ?? currentOwnerIdentity(current.call?.parentSessionId ?? "unknown", deps.lineage?.parentSessionFile); const context = await validateCurrentExecutionContext(rootDir, current, deps, identity); if (!context.ok) return "rejected" as const; const item = current.delegations.get(delegationId); if (!current.integrity && item?.owner && !sameOwner(item.owner, identity)) return "rejected" as const; if (!current.integrity && item?.owner && item.spawnId && item.spawnStarted) await appendWal(rootDir, dispatchCallId, "execution_interrupted", { reason: "abort requested before reattach", failureKind: "unknown_transport", resultRef: "", spawnId: item.spawnId, fencingGeneration: item.fencingGeneration, ownerGeneration: item.ownerGeneration }, delegationId, deps); const replayed = await loadView(rootDir, dispatchCallId); await materialize(rootDir, replayed); return replayed.delegations.get(delegationId)?.state; }); return { state: interrupted === "paused_integrity" ? "paused_integrity" : interrupted === "rejected" ? "rejected" : "paused_uncertainty", dispatchCallId, delegationId, attempts: [], error: "abort requested before reattach" }; }
  const owned = await deps.control!.claimOwner(rootDir, dispatchCallId, delegationId, deps.owner ?? currentOwnerIdentity(view.call?.parentSessionId ?? "unknown", deps.lineage?.parentSessionFile), { ...deps, allowLiveReattach: true });
  if (owned.state === "busy") return { state: "busy", dispatchCallId, delegationId, attempts: [], error: "execution owner lock is busy" };
  if (owned.state === "rejected" || owned.state === "paused_integrity") return { state: "rejected", dispatchCallId, delegationId, attempts: [], error: (owned as any).reason ?? (owned as any).error ?? "execution owner claim rejected" };
  const current = await loadView(rootDir, dispatchCallId); const currentDelegation = current.delegations.get(delegationId)!; const revalidated = await deps.inspectChild({ state: "unknown", childSessionId: currentDelegation.childSessionId!, identity: currentDelegation.childIdentity! }); if (revalidated !== "live") { const reconciled = await withCallLock(rootDir, dispatchCallId, async () => { const latest = await loadView(rootDir, dispatchCallId); const item = latest.delegations.get(delegationId); if (!latest.integrity && item?.ownerGeneration === currentDelegation.ownerGeneration && item.spawnId === currentDelegation.spawnId && ["reattach_only", "initial_running", "recovery_running"].includes(item.state)) { if (revalidated === "dead") await appendWal(rootDir, dispatchCallId, "execution_interrupted", { reason: "reattached child died", failureKind: "transient_provider", resultRef: "", spawnId: item.spawnId!, fencingGeneration: item.fencingGeneration, ownerGeneration: item.ownerGeneration }, delegationId, deps); else await appendWal(rootDir, dispatchCallId, "delegation_integrity_paused", { reasonCode: "reattached_child_liveness_unproven" }, delegationId, deps); } const replayed = await loadView(rootDir, dispatchCallId); await materialize(rootDir, replayed); return replayed.delegations.get(delegationId)?.state; }); return { state: revalidated === "dead" ? "recoverable_failed" : "paused_integrity", dispatchCallId, delegationId, attempts: [], error: reconciled === "paused_configuration" ? "reattached child liveness is unproven" : "reattached child is no longer live" }; }
  let attempt: AttemptResult;
  try { attempt = sanitizeAttemptResult(await executor({ childSessionId: currentDelegation.childSessionId!, spawnId: currentDelegation.spawnId!, ownerGeneration: currentDelegation.ownerGeneration, fencingGeneration: currentDelegation.fencingGeneration })); } catch { attempt = { agent: "unknown", agentSource: "unknown", exitCode: null, messages: [], toolResults: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }, requestedModel: "unknown", actualModel: "unknown", source: "initial", attempt: 1, failureKind: "unknown_transport", errorMessage: "child process failed", cwdScope: "cwd:unknown", sessionId: currentDelegation.childSessionId }; }
  const resultRef = executionRef(attempt); if (isAbortRequested(deps.signal)) attempt.failureKind = "cancelled"; const payload = current.call ? await readDelegationPayload(rootDir, current, currentDelegation).catch(() => undefined) : undefined; const persistent = current.call ? (await callPayload(rootDir, current.call).catch(() => undefined))?.persistent !== false && payload?.item.persistent !== false : true;
  if (["success", "incomplete", "task_failure"].includes(attempt.failureKind)) { const startupClaim: OwnerClaim = { owner: currentDelegation.owner!, ownerGeneration: currentDelegation.ownerGeneration, fencingGeneration: currentDelegation.fencingGeneration, spawnId: currentDelegation.spawnId! }; const committed = await commitTerminalOutcome(rootDir, dispatchCallId, delegationId, attempt, resultRef, startupClaim, !persistent, deps); return { state: committed.state === "completed" ? "completed" : "rejected", dispatchCallId, delegationId, attempt, attempts: [attempt], error: committed.error }; }
  const interrupted = await withCallLock(rootDir, dispatchCallId, async () => { const latest = await loadView(rootDir, dispatchCallId); const context = await validateCurrentExecutionContext(rootDir, latest, deps, currentDelegation.owner); const item = latest.delegations.get(delegationId); if (context.ok && !latest.integrity && item && item.spawnId === currentDelegation.spawnId && item.ownerGeneration === currentDelegation.ownerGeneration) await appendWal(rootDir, dispatchCallId, "execution_interrupted", { reason: durableInterruptionReason(attempt.failureKind, isAbortRequested(deps.signal)), failureKind: durableInterruptionFailureKind(attempt.failureKind, isAbortRequested(deps.signal)), resultRef, spawnId: item.spawnId!, fencingGeneration: item.fencingGeneration, ownerGeneration: item.ownerGeneration }, delegationId, deps); const replayed = await loadView(rootDir, dispatchCallId); await materialize(rootDir, replayed); return context.ok ? replayed.delegations.get(delegationId)?.state : "rejected" as const; });
  return { state: interrupted === "paused_integrity" ? "paused_integrity" : interrupted === "rejected" ? "rejected" : "paused_uncertainty", dispatchCallId, delegationId, attempt, attempts: [attempt], error: attempt.errorMessage };
}

/** Alias used by startup/restart callers; the reattach path is intentionally separate from spawning. */
export const reattachRunningChildInternal = executeReattachedDelegationInternal;

export async function normalizeExecutionStartupInternal(rootDir: string, current: ActiveLineage, inspect: (child: ChildInspection) => Promise<"live" | "dead" | "unknown">, deps: DelegationExecutionDependencies = {}): Promise<StartupNormalizationResult> {
  const base = await normalizeStartupInternal(rootDir, current, { ...deps, lineage: current }); let normalized = base.normalized; let pausedIntegrity = base.pausedIntegrity; const d = await ensureStore(rootDir); let entries: nodeFs.Dirent[];
  try { entries = await fs.readdir(d.wal, { withFileTypes: true }); } catch { return base; }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue; const callId = entry.name.slice(0, -6);
    await withCallLock(rootDir, callId, async () => {
      const view = await loadView(rootDir, callId);
      if (!view.call || view.integrity || view.call.parentSessionId !== current.parentSessionId || view.call.activeLineageId !== current.activeLineageId || !current.branchIds.includes(view.call.activeBranchAnchor)) return;
      for (const item of view.delegations.values()) {
        if (item.state !== "returned" || !item.cleanupPending || item.cleanupSessionRef !== sessionRefFor(item.delegationId) || !item.spawnId) continue;
        const outcome = view.events.find((event) => event.type === "execution_outcome_captured" && event.delegationId === item.delegationId);
        if (!outcome || outcome.data.cleanupRequired !== true || outcome.data.sessionRef !== sessionRefFor(item.delegationId) || outcome.data.spawnId !== item.spawnId || Number(outcome.data.fencingGeneration) !== item.fencingGeneration || Number(outcome.data.ownerGeneration) !== item.ownerGeneration) continue;
        const fence: CleanupFence = { spawnId: item.spawnId, fencingGeneration: item.fencingGeneration, ownerGeneration: item.ownerGeneration, sessionRef: item.cleanupSessionRef };
        await retryPendingCleanup({
          rootDir,
          dispatchCallId: callId,
          delegationId: item.delegationId,
          appendWal: (type, data, appendDeps) => appendWal(rootDir, callId, type, data, item.delegationId, appendDeps),
          materialize: async () => materialize(rootDir, await loadView(rootDir, callId)),
          readFence: async () => {
            const latest = await loadView(rootDir, callId);
            const currentItem = latest.delegations.get(item.delegationId);
            const latestOutcome = latest.events.find((event) => event.type === "execution_outcome_captured" && event.delegationId === item.delegationId);
            if (!currentItem || currentItem.state !== "returned" || !currentItem.cleanupPending || currentItem.cleanupSessionRef !== sessionRefFor(item.delegationId) || !latestOutcome || latestOutcome.data.cleanupRequired !== true || latestOutcome.data.sessionRef !== sessionRefFor(item.delegationId) || latestOutcome.data.spawnId !== currentItem.spawnId || Number(latestOutcome.data.fencingGeneration) !== currentItem.fencingGeneration || Number(latestOutcome.data.ownerGeneration) !== currentItem.ownerGeneration || !currentItem.spawnId) return undefined;
            return { spawnId: currentItem.spawnId, fencingGeneration: currentItem.fencingGeneration, ownerGeneration: currentItem.ownerGeneration, sessionRef: currentItem.cleanupSessionRef };
          },
          cleanup: deps.cleanup,
          deps,
        }, fence);
      }
    });
    await withCallLock(rootDir, callId, async () => { const view = await loadView(rootDir, callId); if (!view.call || view.integrity || view.call.parentSessionId !== current.parentSessionId || view.call.activeLineageId !== current.activeLineageId || !current.branchIds.includes(view.call.activeBranchAnchor)) return; for (const item of view.delegations.values()) if (["initial_running", "recovery_running"].includes(item.state) && !item.childSessionId && item.spawnId && item.ownerGeneration > 0) {
      // This is an independent safety reconciler.  It deliberately does not
      // claim/transfer the execution owner: spawn_started without a durable
      // binding makes the outcome unknowable, not the child provably dead.
      const latest = await loadView(rootDir, callId); const currentItem = latest.delegations.get(item.delegationId);
      if (!currentItem || currentItem.state !== item.state || currentItem.childSessionId || currentItem.spawnId !== item.spawnId || currentItem.ownerGeneration !== item.ownerGeneration || currentItem.fencingGeneration !== item.fencingGeneration) continue;
      await appendWal(rootDir, callId, "paused_uncertainty", { reason: "spawn outcome unknown", spawnId: item.spawnId, fencingGeneration: item.fencingGeneration, ownerGeneration: item.ownerGeneration }, item.delegationId, deps);
      const replayed = await loadView(rootDir, callId); await materialize(rootDir, replayed);
    } });
    const call = await deps.control!.readCall(rootDir, callId, current); if (!call || call.state === "paused_integrity" || call.parentSessionId !== current.parentSessionId || call.activeLineageId !== current.activeLineageId || !current.branchIds.includes(call.activeBranchAnchor)) continue;
    for (const slot of call.slots) {
      if (!slot.delegationId || !["initial_running", "recovery_running"].includes(slot.state)) continue;
      const result = await reconcileRunningChildInternal(rootDir, callId, slot.delegationId, inspect, { ...deps, lineage: current, inspectChild: deps.inspectChild ?? (async (child: ChildInspection) => inspect(child)) });
      if (result.state === "reattach_only" || result.state === "recovery_ready") normalized += 1; else if (result.state === "paused_integrity") pausedIntegrity += 1;
    }
  }
  return { ...base, normalized, pausedIntegrity };
}
