/** Internal owner-fenced cleanup lifecycle; never exposed from the package root. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AttemptResult } from "./runner.ts";
import type { DelegationFoundationDependencies } from "./delegation-types.ts";

export function sessionRefFor(delegationId: string): string {
  return `v2:sessions/${delegationId}`;
}

export function sessionDirectory(rootDir: string, delegationId: string): string {
  return path.join(rootDir, "v2", "sessions", delegationId);
}

export async function removeSessionDirectory(rootDir: string, delegationId: string): Promise<void> {
  await fs.rm(sessionDirectory(rootDir, delegationId), { recursive: true, force: true });
}

export interface CleanupFence {
  spawnId: string;
  fencingGeneration: number;
  ownerGeneration: number;
  sessionRef: string;
}

export interface CleanupLifecycleContext {
  rootDir: string;
  dispatchCallId: string;
  delegationId: string;
  appendWal: (type: string, data: Record<string, unknown>, deps?: DelegationFoundationDependencies) => Promise<void>;
  materialize: () => Promise<void>;
  cleanup?: (directory: string) => Promise<void>;
  /** Re-read the durable outcome fence while the caller holds the call lock. */
  readFence?: () => Promise<CleanupFence | undefined>;
  deps: DelegationFoundationDependencies;
}

/** Capture the ephemeral outcome and perform its durable cleanup under one owner fence. */
export async function capturePersistentFalseOutcome(
  context: CleanupLifecycleContext,
  attempt: AttemptResult,
  resultRef: string,
  spawnId: string,
  fencingGeneration: number,
  ownerGeneration: number,
): Promise<{ state: "completed"; error?: string }> {
  const outcome = attempt.failureKind === "success" ? "success" : "failure";
  await context.appendWal("execution_outcome_captured", {
    outcome,
    resultRef,
    failureKind: attempt.failureKind,
    spawnId,
    fencingGeneration,
    ownerGeneration,
    cleanupRequired: true,
    sessionRef: sessionRefFor(context.delegationId),
  }, context.deps);
  try {
    await (context.cleanup ?? ((directory: string) => removeSessionDirectory(context.rootDir, context.delegationId)))(sessionDirectory(context.rootDir, context.delegationId));
    await context.appendWal("cleanup_completed", { spawnId, fencingGeneration, ownerGeneration, sessionRef: sessionRefFor(context.delegationId) }, context.deps);
  } catch {
    await context.materialize();
    return { state: "completed", error: "session cleanup pending" };
  }
  await context.materialize();
  return { state: "completed" };
}

/** Retry a previously captured persistent:false cleanup during startup.
 *
 * This is deliberately an outcome-fenced reconciler, not an execution-owner
 * transfer. The fence is checked before and after the filesystem operation so
 * an old retry can never append completion for another spawn/generation.
 */
export async function retryPendingCleanup(
  context: CleanupLifecycleContext,
  fence: CleanupFence,
): Promise<boolean> {
  const matches = (current: CleanupFence | undefined): boolean => !!current &&
    current.spawnId === fence.spawnId && current.fencingGeneration === fence.fencingGeneration &&
    current.ownerGeneration === fence.ownerGeneration && current.sessionRef === fence.sessionRef &&
    fence.sessionRef === sessionRefFor(context.delegationId);
  try {
    if (context.readFence && !matches(await context.readFence())) return false;
    await (context.cleanup ?? ((directory: string) => removeSessionDirectory(context.rootDir, context.delegationId)))(sessionDirectory(context.rootDir, context.delegationId));
    if (context.readFence && !matches(await context.readFence())) return false;
    await context.appendWal("cleanup_completed", { spawnId: fence.spawnId, fencingGeneration: fence.fencingGeneration, ownerGeneration: fence.ownerGeneration, sessionRef: fence.sessionRef }, context.deps);
    await context.materialize();
    return true;
  } catch {
    await context.materialize();
    return false;
  }
}
