/** Internal foundation seam. The package root and package exports intentionally do not expose this module. */
export {
  admitDispatchCallInternal,
  resolveDelegationInternal,
  acceptConfigRevisionInternal,
  reserveInitialInternal,
  reserveRecoveryCycleInternal,
  claimExecutionOwnerInternal,
  executeReattachedDelegationInternal,
  acceptContinuationInternal,
  bindChildSessionInternal,
  reconcileRunningChildInternal,
  executeDelegationInternal,
  markSpawnStartedInternal,
  markDelegationReturnedInternal,
  admitNextChainStepInternal,
  finalizeCallInternal,
  readDispatchCallInternal,
  readDelegationInternal,
  normalizeStartupInternal,
  normalizeExecutionStartupInternal,
  reconcilePrivateOrphans,
  projectDispatchCall,
  classifyOwnerIdentityObservation,
  probeOwnerDeathStable,
  delegationFoundationCapability,
} from "./delegation.ts";
export type { ConfigRevisionActor, DelegationFoundationDependencies, DelegationExecutionDependencies, DelegationExecutionResult, ChildInspection, OrphanReconciliationResult, OwnerIdentity, OwnerIdentityObservation, OwnerLiveness } from "./delegation.ts";
export type { OwnerClaim, OwnerIdentityProbeSafetyAdapter } from "./execution-supervisor.ts";
