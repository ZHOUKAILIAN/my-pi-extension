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
  requestDelegationCancelInternal,
  requestDelegationCancelScopedInternal,
  requestCallCancelInternal,
  reconcileDelegationCancelInternal,
  reconcileCallCancellationInternal,
  reconcileCancellationInternal,
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
  SubagentControlService,
  markOriginalToolCallInterruptedInternal,
  querySubagentStatusInternal,
  requestDeliveryAbandonInternal,
  executeDeliveryInternal,
  reconcileDeliveryStartupInternal,
} from "./delegation.ts";
export { observeCustomReceiptInternal } from "./delivery.ts";
export {
  requestDelegationDeleteInternal,
  subagentDeleteInternal,
  requestCallCleanupInternal,
  subagentCallCleanupInternal,
  requestRetentionCleanupInternal,
  evaluateRetentionEligibilityInternal,
  cleanupOrphanDelegationInternal,
  reconcileCleanupStartupInternal,
  gcCleanupTombstonesInternal,
  computeActorScopeTag,
  cleanupActorSecretPath,
  retentionTombstonePath,
} from "./cleanup.ts";
export {
  adoptExistingV1Internal,
  adoptV1SessionInternal,
  rollbackAdoptedV1Internal,
  rollbackV1AdoptionInternal,
  hasLiveAdoptionReferenceSync,
  isAdoptionRecord,
} from "./adoption.ts";
export type { AdoptionActor, AdoptionDependencies, AdoptionRecord, AdoptionResult, AdoptionStatus, RollbackResult, RollbackStatus, V1AdoptionRequest, V1SourceLiveness, V2RollbackLiveness } from "./adoption.ts";
export { aggregateCapabilityGateInternal, capabilityGateAllowsPublicV2Internal, CAPABILITY_GATE_NAMES } from "./capability-gate.ts";
export type { CapabilityGate, CapabilityGateInput, CapabilityGateName } from "./capability-gate.ts";
export {
  buildSideEffectFenceExtensions,
  startSideEffectFenceServer,
  cleanupSideEffectFenceOrphans,
  sideEffectFenceExtensionPath,
  sideEffectFenceExtensionDigest,
  sideEffectFenceEnvironment,
  sideEffectFenceToolSetDigest,
  sideEffectFencePolicyDigest,
  sideEffectFenceBinding,
  sideEffectFenceBindingMatches,
  sideEffectFencePackageManifestDigest,
  sideEffectFenceSnapshotDigest,
  createSideEffectFenceTestSnapshot,
  createSideEffectFenceTestDeploymentProof,
  createSideEffectFenceTestReattachProof,
  sideEffectFenceReattachChannelDigest,
  createSideEffectFenceTestClientProof,
} from "./side-effect-fence.ts";
export type { SideEffectFenceConfig, SideEffectFenceClientConfig, SideEffectFenceExtensionSpec, SideEffectFenceInterceptorSpec, SideEffectFenceBinding, SideEffectFencePolicyDescriptor, SideEffectFencePolicySnapshot, SideEffectFenceServer, SideEffectFenceDeploymentProof, SideEffectFenceReattachProof, SideEffectFenceHandshakeBinding, SideEffectFenceLifecycleMetadata, SideEffectFenceCleanupOptions } from "./side-effect-fence.ts";
export {
  beginActionIntentInternal,
  finishActionResultInternal,
  replayActionPolicy,
  reconcileActionUnknownInternal,
  reconcileActionUnknownLocked,
  decideUncertaintyDispositionInternal,
  reconcileBeforeReturnInternal,
  readActionLedgerInternal,
  readActionPrivateInternal,
  actionIdFor,
  stableIdempotencyKeyFor,
  canonicalArgsDigest,
} from "./action-ledger.ts";
export type { CancelActor, CancelReceipt, CancelScope, ConfigRevisionActor, DelegationFoundationDependencies, DelegationExecutionDependencies, DelegationExecutionResult, ChildInspection, OrphanReconciliationResult, OwnerIdentity, OwnerIdentityObservation, OwnerLiveness, DeliveryAbandonReceipt, DeliveryHostAdapter, HostPersistedBranchEntry } from "./delegation.ts";
export type { DeleteActor, DeleteReceipt, DeleteTrigger, RetentionEligibility } from "./delegation-types.ts";
export type { StatusQueryResult } from "./delivery.ts";
export type { OwnerClaim, OwnerIdentityProbeSafetyAdapter } from "./execution-supervisor.ts";
export type { ActionIdentity, ActionIntentRequest, ActionPolicyClassification, ActionProjection, ActionReplayPolicy, ActionRetryPolicy, ActionResultRequest, ActionStatus, UncertaintyDisposition, ChildControlAdapter, ChildControlObservation } from "./delegation-types.ts";
