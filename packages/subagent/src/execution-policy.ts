import type { AgentConfig } from "./agents.ts";
import type { AttemptSource, FailureKind } from "./runner.ts";

/** Gated v2 execution policy. v1 dispatcher policy lives in dispatcher-policy.ts. */
export const MAX_PROVIDER_RETRIES = 2;

export interface ExecutionCandidateInput {
  agent: AgentConfig;
  requestedModel?: string;
  parentModel?: string;
}

export interface ExecutionCandidate {
  model?: string;
  source: AttemptSource;
}

export function executionCandidates(input: ExecutionCandidateInput): ExecutionCandidate[] {
  const values: ExecutionCandidate[] = input.requestedModel
    ? [{ model: input.requestedModel, source: "user_override" as const }]
    : [{ model: input.agent.model ?? input.parentModel, source: "initial" as const }];
  for (const model of input.agent.fallbackModels ?? []) values.push({ model, source: "fallback" });
  const seen = new Set<string>();
  return values.filter((candidate) => {
    const key = candidate.model ?? "<default>";
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function continuationTask(task: string, firstAttempt: boolean): string {
  return firstAttempt ? task : `Continue the same task. Preserve the existing work and respond to this instruction:\n${task}`;
}

export function isRetryableProviderFailure(kind: FailureKind): boolean {
  return kind === "transient_provider";
}

/** The gated v2 executor checks this abort gate before another attempt. */
export function isAbortRequested(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}
