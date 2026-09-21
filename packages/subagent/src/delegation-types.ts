import type { AgentConfig, AgentDiscoverySnapshot, AgentScope } from "./agents.ts";
import type { ActiveLineage } from "./lineage.ts";
import type { FastInheritanceConsumer } from "./fast-inheritance.ts";
import type { AttemptResult } from "./runner.ts";
import type { runPiAttempt } from "./runner.ts";

export type DispatchMode = "single" | "parallel" | "chain";
export type OriginalToolCallStatus = "running" | "interrupted";
export type NormalToolResultStatus = "unobserved" | "observed";
export type CustomOutboxStatus = "pending" | "sending" | "receipted" | "uncertain" | "abandoned";
export type DeliveryCustomType = "subagent-recovery-completion" | "subagent-cancelled";
export type DelegationState = "reserved" | "admitted" | "resolving" | "resolution_ready" | "bound" | "initial_ready" | "initial_running" | "recovery_ready" | "cycle_ready" | "recovery_running" | "reattach_only" | "cancel_requested" | "cancelled" | "returned" | "paused_configuration" | "paused_integrity" | "paused_uncertainty";
export type SlotState = "pending" | "admitted" | "initial_ready" | "initial_running" | "recovery_ready" | "cycle_ready" | "recovery_running" | "reattach_only" | "cancel_requested" | "cancelled" | "returned" | "not_admitted_due_to_call_cancel" | "paused_configuration" | "paused_integrity" | "paused_uncertainty";

export interface DispatchItemInput { agent: string; task: string; cwd?: string; model?: string; persistent?: boolean; }
export interface ProjectTrustBinding { parentSessionId: string; discoveryRootRealpath: string; snapshotDigest: string; }
export interface DispatchCallAdmissionRequest {
  parentSessionId: string;
  lineage: ActiveLineage;
  toolCallId: string;
  cwd: string;
  mode: DispatchMode;
  single?: DispatchItemInput;
  tasks?: DispatchItemInput[];
  chain?: DispatchItemInput[];
  agentScope?: AgentScope;
  projectTrust?: ProjectTrustBinding;
  persistent?: boolean;
}
export interface OwnerIdentity { host: string; pid: number; birth: string; parentSessionId: string; parentSessionPath: string; argvProof: string; }
export type OwnerLiveness = "alive" | "dead" | "unknown";
/** A process-birth probe result. `unreadable` is never treated as death. */
export type OwnerIdentityObservation =
  | { state: "present"; pid: number; birth: string }
  | { state: "absent"; pid: number }
  | { state: "unreadable"; pid: number };
export interface ChildIdentity { host: string; pid: number; birth: string; sessionPathHash: string; argvProof: string; }
export interface ChildInspection { state: "live" | "dead" | "unknown"; childSessionId: string; identity?: ChildIdentity; }
export interface DelegationFoundationDependencies {
  lineage?: ActiveLineage;
  now?: () => Date;
  fault?: (point: string) => void | Promise<void>;
  owner?: OwnerIdentity;
  inspectOwner?: (owner: OwnerIdentity) => Promise<OwnerLiveness>;
  /** Optional identity-tuple probe used by platform adapters; it must not signal a PID. */
  inspectOwnerIdentity?: (owner: OwnerIdentity) => Promise<OwnerIdentityObservation>;
  /** Optional audit adapter; probeOwnerDeathStable never invokes its signal hook. */
  ownerIdentityProbeSafety?: { signal?: (pid: number, signal: NodeJS.Signals) => void };
  inspectChild?: (child: ChildInspection) => Promise<ChildInspection["state"]>;
  allowLiveReattach?: boolean;
  childIdentity?: ChildIdentity;
  ownerDeathObservationDelayMs?: number;
  /** Internal callback used by the owner supervisor after a pre-spawn transfer. */
  recheckResolutionAfterTransfer?: (rootDir: string, callId: string, delegationId: string) => Promise<boolean>;
  /** Execution-side abort gate checked while the call fence is held. */
  signal?: AbortSignal;
  /** Internal host seam; never wired by the public v1 extension. */
  deliveryHostAdapter?: DeliveryHostAdapter;
}
export interface ConfigRevisionActor { actorId: string; parentSessionId: string; activeLineageId: string; activeBranchAnchor: string; }
export interface CancelActor { parentSessionId: string; activeLineageId: string; activeBranchAnchor: string; }
export type CancelScope = "item" | "call";
export interface CancelReceipt { target: string; scope: CancelScope; actorRef: string; walSeq: number; status: "requested" | "already_requested" | "completed"; }
export interface DeliveryAbandonReceipt { dispatchCallId: string; deliveryId: string; actorRef: string; walSeq?: number; status: "abandoned" | "already_abandoned" | "receipted" | "rejected"; }
export interface HostPersistedBranchEntry {
  entryRef: string;
  role: "toolResult" | "customMessage";
  parentSessionId: string;
  activeLineageId: string;
  activeBranchAnchor: string;
  dispatchCallId?: string;
  proofRef?: string;
  toolCallId?: string;
  toolCallIdHash?: string;
  customType?: DeliveryCustomType;
  deliveryId?: string;
}
export interface DeliveryHostAdapter {
  scanActiveBranch: (lineage: ActiveLineage) => Promise<readonly HostPersistedBranchEntry[]>;
  appendCustomMessage: (payload: DeliveryPayload, lineage: ActiveLineage) => Promise<void | { entryRef?: string }>;
}
export interface DeliveryPayload {
  version: 1;
  customType: DeliveryCustomType;
  deliveryId: string;
  dispatchCallId: string;
  proofRef: string;
  outcome: "success" | "failure" | "cancelled";
  originalToolCallStatus: "interrupted";
  deliverySemantics: "at-most-once";
  safeRefs: string[];
}
export interface CustomOutboxView {
  deliveryId: string;
  customType: DeliveryCustomType;
  status: CustomOutboxStatus;
  payloadRef: string;
  proofRef: string;
  outcome: "success" | "failure" | "cancelled";
  ownerGeneration?: number;
  fencingGeneration?: number;
  ownerRef?: string;
}
export type CallCancelSettlement = "returned_before_call_cancel" | "admitted_cancelled" | "not_admitted_due_to_call_cancel";
export interface DispatchSlotView { index: number; order: number; required: boolean; kind: "single" | "parallel" | "chain"; state: SlotState; delegationId?: string; terminalOutcome?: "success" | "failure" | "cancelled"; resultRef?: string; cancelSettlement?: CallCancelSettlement; }
export interface DispatchCallView {
  version: 1; dispatchCallId: string; parentSessionId: string; activeLineageId: string; activeBranchAnchor: string;
  persistence: "restart-durable" | "in_process_only"; toolCallIdHash: string; requestDigest: string; mode: DispatchMode; agentScope: AgentScope;
  projectTrustDigest?: string; slots: DispatchSlotView[]; chainCursor: number; privatePayloadRef: string;
  originalToolCallStatus: OriginalToolCallStatus; normalToolResultStatus: NormalToolResultStatus; customOutbox?: CustomOutboxView;
  state: CallState; cancelRequestedSeq?: number; cancelActorRef?: string; integrityReason?: string; finalOutcome?: "success" | "failure" | "cancelled"; finalizedAt?: string;
}
export interface DelegationView {
  version: 1; delegationId: string; dispatchCallId: string; slotIndex: number; parentSessionId: string;
  activeLineageId: string; activeBranchAnchor: string; effectiveCwdHash: string; requestedTarget: string;
  discoveryScope: AgentScope; state: DelegationState; privatePayloadRef: string;
  canonical?: { name: string; source: "user" | "project"; discoveryRootHash: string; fileHash: string; digest: string; aliases: string[] };
  pauseReason?: string; initialReservationId?: string; returnedOutcome?: "success" | "failure" | "cancelled"; resultRef?: string;
}
export interface CallAggregateProof { version: 1; dispatchCallId: string; mode: DispatchMode; slots: Array<{ index: number; order: number; state: SlotState; delegationId?: string; terminalOutcome?: "success" | "failure" | "cancelled"; resultRef?: string; cancelSettlement?: CallCancelSettlement }>; outcome: "success" | "failure" | "cancelled"; createdAt: string; finalizedAt: string; }
export interface StartupNormalizationResult { scanned: number; normalized: number; pausedIntegrity: number; spawnCount: 0; sendCount: 0; }
export interface InternalDelegation extends DelegationView {
  provenanceRef?: string; requiredIdentity: string; revisionIntent?: RevisionIntent; revisionObservation?: RevisionObservation; resolutionReasonCode?: string;
  cancelRequestedSeq?: number; cancelActorRef?: string;
  spawnId?: string; spawnStarted?: boolean; childSessionId?: string; childSessionPathHash?: string; childPid?: number; childIdentity?: ChildIdentity;
  runKind?: "initial" | "recovery"; recoveryCyclesUsed: number; logicalSpawnCount: number; continuationEpoch: number; fencingGeneration: number; ownerGeneration: number; owner?: OwnerIdentity;
  cleanupPending?: boolean; cleanupSessionRef?: string;
}
export interface RevisionIntent { revisionId: string; revisionEpoch: number; oldDigest: string; newDigest: string; actor: ConfigRevisionActor; }
export interface RevisionObservation { revisionId: string; revisionEpoch: number; oldDigest: string; newDigest: string; }
export interface RevisionLifecycle { revisionId: string; revisionEpoch: number; oldDigest: string; newDigest: string; phase: "observed" | "pending" | "accepted" | "published" | "superseded"; actor?: ConfigRevisionActor; }
export interface WalEvent { version: 1; seq: number; type: string; callId: string; delegationId?: string; data: Record<string, unknown>; prevChecksum: string; checksum: string; }
export interface InternalView { call?: DispatchCallView; delegations: Map<string, InternalDelegation>; revisionLifecycles: Map<string, RevisionLifecycle>; events: WalEvent[]; tornTail?: TornTail; integrity?: { callId: string; reason: string }; }
export interface TornTail { discardedBytes: number; tailHash: string; }
export interface OrphanReconciliationResult { state: "clean" | "paused_integrity" | "busy"; reasonCode?: "orphan_wal_untrusted" | "orphan_private_untrusted"; isolatedCallIds: string[]; deletedPayloads: number; }
export interface DelegationExecutionDependencies extends DelegationFoundationDependencies {
  runAttempt?: typeof runPiAttempt;
  sleep?: (milliseconds: number) => Promise<void>;
  onUpdate?: (attempt: AttemptResult) => void;
  signal?: AbortSignal;
  model?: string;
  parentModel?: string;
  fast?: FastInheritanceConsumer;
  cleanup?: (directory: string) => Promise<void>;
  reattachExecutor?: (options: { childSessionId: string; sessionPath?: string; spawnId: string; ownerGeneration: number; fencingGeneration: number }) => Promise<AttemptResult>;
  /** Internal hooks supplied by the facade; execution-supervisor never imports the control facade. */
  control?: DelegationExecutionControl;
}
export interface DelegationExecutionResult {
  state: "completed" | "recoverable_failed" | "paused_configuration" | "paused_uncertainty" | "paused_integrity" | "rejected" | "busy";
  dispatchCallId: string; delegationId: string; runKind?: "initial" | "recovery"; attempt?: AttemptResult; attempts: AttemptResult[]; recoveryCycle?: number; error?: string;
}
export interface DelegationExecutionControl {
  reserveInitial: (rootDir: string, dispatchCallId: string, delegationId: string, deps?: DelegationFoundationDependencies) => Promise<any>;
  reserveRecoveryCycle: (rootDir: string, dispatchCallId: string, delegationId: string, deps?: DelegationFoundationDependencies) => Promise<any>;
  markSpawnStarted: (rootDir: string, dispatchCallId: string, delegationId: string, runKind: "initial" | "recovery", deps?: DelegationFoundationDependencies) => Promise<any>;
  bindChildSession: (rootDir: string, dispatchCallId: string, delegationId: string, claim: import("./execution-supervisor.ts").OwnerClaim, childSessionId: string, sessionPath?: string, pid?: number, deps?: DelegationFoundationDependencies, attempt?: number) => Promise<any>;
  claimOwner: (rootDir: string, dispatchCallId: string, delegationId: string, identity: OwnerIdentity, deps?: DelegationFoundationDependencies) => Promise<any>;
  readCall: (rootDir: string, dispatchCallId: string, current?: ActiveLineage) => Promise<any>;
  reconcileStartup: (rootDir: string, view: InternalView, deps?: DelegationFoundationDependencies) => Promise<InternalView>;
}
type CallState = "admitted" | "cancel_requested" | "repair_required" | "final" | "paused_integrity" | "paused_configuration" | "paused_uncertainty";
