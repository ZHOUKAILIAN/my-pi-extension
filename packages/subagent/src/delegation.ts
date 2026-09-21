/** Publicly reachable delegation facade. Control, orphan, and execution implementations live in internal modules. */
import type { AgentConfig } from "./agents.ts";
import type { AttemptResult } from "./runner.ts";
import type { ActiveLineage } from "./lineage.ts";
import { reconcilePrivateOrphans } from "./delegation-orphans.ts";
import * as control from "./delegation-control.ts";
import * as supervisor from "./execution-supervisor.ts";
import type {
  CallAggregateProof, ChildInspection, ConfigRevisionActor, DelegationExecutionControl, DelegationExecutionDependencies, DelegationExecutionResult,
  DelegationFoundationDependencies, DelegationState, DelegationView, DispatchCallAdmissionRequest, DispatchCallView, DispatchItemInput, DispatchMode,
  DispatchSlotView, InternalDelegation, InternalView, OrphanReconciliationResult, OwnerIdentity, OwnerIdentityObservation, OwnerLiveness, ProjectTrustBinding, RevisionIntent,
  RevisionLifecycle, RevisionObservation, SlotState, StartupNormalizationResult, TornTail, WalEvent,
} from "./delegation-types.ts";

export type {
  CallAggregateProof, CancelActor, CancelReceipt, CancelScope, ChildInspection, ConfigRevisionActor, DelegationExecutionDependencies, DelegationExecutionResult, DelegationFoundationDependencies,
  DelegationState, DelegationView, DispatchCallAdmissionRequest, DispatchCallView, DispatchItemInput, DispatchMode, DispatchSlotView, InternalDelegation,
  InternalView, OrphanReconciliationResult, OwnerIdentity, OwnerIdentityObservation, OwnerLiveness, ProjectTrustBinding, RevisionIntent, RevisionLifecycle, RevisionObservation,
  SlotState, StartupNormalizationResult, TornTail, WalEvent,
} from "./delegation-types.ts";
export type { OwnerClaim, OwnerIdentityProbeSafetyAdapter } from "./execution-supervisor.ts";
export const classifyOwnerIdentityObservation = supervisor.classifyOwnerIdentityObservation;
export const probeOwnerDeathStable = supervisor.probeOwnerDeathStable;

const executionControl: DelegationExecutionControl = {
  reserveInitial: control.reserveInitialInternal,
  reserveRecoveryCycle: control.reserveRecoveryCycleInternal,
  markSpawnStarted: supervisor.markSpawnStartedInternal,
  bindChildSession: supervisor.bindChildSessionInternal,
  claimOwner: supervisor.claimExecutionOwnerInternal,
  readCall: control.readDispatchCallInternal,
  reconcileStartup: control.reconcileStartupInternal,
};

function executionDeps(deps: DelegationExecutionDependencies = {}): DelegationExecutionDependencies {
  return { ...deps, control: executionControl };
}
function ownerDeps(deps: DelegationFoundationDependencies = {}): DelegationFoundationDependencies {
  return { ...deps, recheckResolutionAfterTransfer: control.recheckResolutionAfterTransfer };
}

export const admitDispatchCallInternal = control.admitDispatchCallInternal;
export const resolveDelegationInternal = control.resolveDelegationInternal;
export const acceptConfigRevisionInternal = control.acceptConfigRevisionInternal;
export const reserveInitialInternal = control.reserveInitialInternal;
export const reserveRecoveryCycleInternal = control.reserveRecoveryCycleInternal;
export const acceptContinuationInternal = control.acceptContinuationInternal;
export const requestDelegationCancelInternal = control.requestDelegationCancelInternal;
export const requestDelegationCancelScopedInternal = control.requestDelegationCancelScopedInternal;
export const reconcileDelegationCancelInternal = control.reconcileDelegationCancelInternal;
export const reconcileCancellationInternal = control.reconcileCancellationInternal;
export { SubagentControlService } from "./delegation-control.ts";
export const admitNextChainStepInternal = control.admitNextChainStepInternal;
export const finalizeCallInternal = control.finalizeCallInternal;

export async function claimExecutionOwnerInternal(rootDir: string, dispatchCallId: string, delegationId: string, identity: OwnerIdentity, deps: DelegationFoundationDependencies = {}) {
  return supervisor.claimExecutionOwnerInternal(rootDir, dispatchCallId, delegationId, identity, ownerDeps(deps));
}
export async function bindChildSessionInternal(rootDir: string, dispatchCallId: string, delegationId: string, claim: supervisor.OwnerClaim, childSessionId: string, sessionPath?: string, pid?: number, deps: DelegationFoundationDependencies = {}, attempt?: number) {
  return supervisor.bindChildSessionInternal(rootDir, dispatchCallId, delegationId, claim, childSessionId, sessionPath, pid, ownerDeps(deps), attempt);
}
export async function markSpawnStartedInternal(rootDir: string, dispatchCallId: string, delegationId: string, runKind: "initial" | "recovery", deps: DelegationFoundationDependencies = {}) {
  return supervisor.markSpawnStartedInternal(rootDir, dispatchCallId, delegationId, runKind, ownerDeps(deps));
}
export async function markDelegationReturnedInternal(rootDir: string, dispatchCallId: string, delegationId: string, outcome: "success" | "failure" | "cancelled", resultRef: string, claim: supervisor.OwnerClaim, deps: DelegationFoundationDependencies = {}) {
  return supervisor.markDelegationReturnedInternal(rootDir, dispatchCallId, delegationId, outcome, resultRef, claim, ownerDeps(deps));
}
export async function executeDelegationInternal(rootDir: string, dispatchCallId: string, delegationId: string, agent: AgentConfig, deps: DelegationExecutionDependencies = {}): Promise<DelegationExecutionResult> {
  return supervisor.executeDelegationInternal(rootDir, dispatchCallId, delegationId, agent, executionDeps(deps));
}
export async function executeReattachedDelegationInternal(rootDir: string, dispatchCallId: string, delegationId: string, executor: (options: { childSessionId: string; sessionPath?: string; spawnId: string; ownerGeneration: number; fencingGeneration: number }) => Promise<AttemptResult>, deps: DelegationExecutionDependencies = {}): Promise<DelegationExecutionResult> {
  return supervisor.executeReattachedDelegationInternal(rootDir, dispatchCallId, delegationId, executor, executionDeps(deps));
}
export const reattachRunningChildInternal = executeReattachedDelegationInternal;
export async function reconcileRunningChildInternal(rootDir: string, dispatchCallId: string, delegationId: string, inspect: (child: ChildInspection) => Promise<"live" | "dead" | "unknown">, deps: DelegationFoundationDependencies = {}) {
  return supervisor.reconcileRunningChildInternal(rootDir, dispatchCallId, delegationId, inspect, ownerDeps(deps));
}
export async function normalizeStartupInternal(rootDir: string, current: ActiveLineage, deps: DelegationFoundationDependencies = {}): Promise<StartupNormalizationResult> {
  return supervisor.normalizeStartupInternal(rootDir, current, executionDeps(deps as DelegationExecutionDependencies));
}
export async function normalizeExecutionStartupInternal(rootDir: string, current: ActiveLineage, inspect: (child: ChildInspection) => Promise<"live" | "dead" | "unknown">, deps: DelegationExecutionDependencies = {}): Promise<StartupNormalizationResult> {
  return supervisor.normalizeExecutionStartupInternal(rootDir, current, inspect, executionDeps(deps));
}

export const readDispatchCallInternal = control.readDispatchCallInternal;
export const readDelegationInternal = control.readDelegationInternal;
export function projectDispatchCall(view: DispatchCallView): Record<string, unknown> {
  return { version: 1, dispatchCallId: view.dispatchCallId, mode: view.mode, state: view.state, persistence: view.persistence, toolCallHash: view.toolCallIdHash.slice(0, 16), slots: view.slots.map(({ index, state, delegationId }) => ({ index, state, ...(delegationId ? { delegationId } : {}) })), chainCursor: view.chainCursor, ...(view.integrityReason ? { integrityReason: view.integrityReason } : {}) };
}
export { reconcilePrivateOrphans };
export function delegationFoundationCapability(): { enabled: false; executionWired: false; recoveryWired: false } { return { enabled: false, executionWired: false, recoveryWired: false }; }
