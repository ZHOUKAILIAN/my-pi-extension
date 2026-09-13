import type { AttemptResult, FailureKind } from "./runner.ts";

/** Internal control-plane marker. It is non-enumerable and not exported from the package entrypoint. */
const RETRY_CLASSIFICATION = Symbol("subagent.retryClassification");
type RetryClassification = "transient_provider" | "not_retryable";
type ClassifiedAttempt = AttemptResult & { [RETRY_CLASSIFICATION]?: RetryClassification };

export function markRetryClassification(attempt: AttemptResult, classification: RetryClassification): void {
  Object.defineProperty(attempt, RETRY_CLASSIFICATION, { value: classification, enumerable: false, configurable: true });
}

/** Mocks may provide only the public terminal kind; no diagnostic text is re-matched here. */
export function retryClassificationOf(attempt: AttemptResult): RetryClassification {
  const marked = (attempt as ClassifiedAttempt)[RETRY_CLASSIFICATION];
  if (marked) return marked;
  return (attempt.failureKind as FailureKind) === "transient_provider" ? "transient_provider" : "not_retryable";
}
