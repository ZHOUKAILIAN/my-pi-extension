/** Internal v1 dispatcher policy. It is intentionally independent of gated v2 policy. */
import type { AgentConfig } from "./agents.ts";
import type { AttemptSource, FailureKind } from "./runner.ts";

export const MAX_PROVIDER_RETRIES = 2;

export interface DispatcherCandidateInput {
  agent: AgentConfig;
  requestedModel?: string;
  parentModel?: string;
}

export interface DispatcherCandidate {
  model?: string;
  source: AttemptSource;
}

export function executionCandidates(input: DispatcherCandidateInput): DispatcherCandidate[] {
  const values: DispatcherCandidate[] = input.requestedModel
    ? [{ model: input.requestedModel, source: "user_override" }]
    : [{ model: input.agent.model ?? input.parentModel, source: "initial" }];
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

export function isAbortRequested(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}
