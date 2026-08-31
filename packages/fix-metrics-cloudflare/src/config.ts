// Runtime configuration for the Fix Metrics PoC slice (synthetic-data-only).
//
// The synthetic-data-only guard lives here:
//   - POC_SYNTHETIC_ONLY is a compile-time constant for this slice. A later production slice must
//     deliberately change this constant AND remove the ingest gate before any real telemetry can
//     be received.
//   - readRuntimeConfig() reads the environment, defaulting FIX_METRICS_SYNTHETIC_ONLY to true.
//   - assertSyntheticOnly() is called on the ingest path and fails closed: when the worker is not
//     in synthetic-only mode, POST /api/v1/events returns 503 and accepts nothing.

export const POC_SYNTHETIC_ONLY = true;

// Public low-sample protection threshold (approved default k=5).
export const LOW_SAMPLE_K = 5;

// Ingest bounds (bounded batch input).
export const MAX_EVENTS_PER_BATCH = 100;
export const MAX_REQUEST_BODY_BYTES = 256 * 1024;

// Time validation defaults (approved defaults; changing them requires a definition-version bump).
export const DEFAULT_LATE_EVENT_WINDOW_MS = 24 * 60 * 60 * 1000; // ordinary lateness; beyond -> quarantine
export const DEFAULT_FUTURE_SKEW_WINDOW_MS = 5 * 60 * 1000; // occurredAt far in the future -> quarantine
// Synthetic runs place occurredAt up to ~1h before receipt (report-style backstory), so the
// "late label" used by dataQuality is deliberately loose in this PoC: only events arriving more
// than 2h after their occurredAt are flagged. The much stricter 24h quarantine window is what
// actually rejects unhealthy events.
export const LATE_EVENT_LABEL_MS = 2 * 60 * 60 * 1000;

export const FIX_FUNNEL_DEFINITION_VERSION = 'fix-funnel-v1';
export const FUNNEL_STEPS = [
  'run_started',
  'investigation_review_passed',
  'resolution_completed',
  'verification_passed',
  'run_accepted',
] as const;

export interface RuntimeConfig {
  syntheticOnly: boolean;
  ingestTokens: ReadonlySet<string>;
  lateEventWindowMs: number;
  futureSkewWindowMs: number;
  lowSampleK: number;
}

export function readRuntimeConfig(
  env: Record<string, string | undefined> = {},
): RuntimeConfig {
  const raw = env.FIX_METRICS_SYNTHETIC_ONLY ?? 'true';
  const syntheticOnly = !(raw === 'false' || raw === '0');
  const ingestTokens = new Set<string>();
  if (env.INGEST_TOKEN_CURRENT) ingestTokens.add(env.INGEST_TOKEN_CURRENT);
  if (env.INGEST_TOKEN_PREVIOUS) ingestTokens.add(env.INGEST_TOKEN_PREVIOUS);
  return {
    syntheticOnly,
    ingestTokens,
    lateEventWindowMs: DEFAULT_LATE_EVENT_WINDOW_MS,
    futureSkewWindowMs: DEFAULT_FUTURE_SKEW_WINDOW_MS,
    lowSampleK: LOW_SAMPLE_K,
  };
}

export class SyntheticOnlyError extends Error {
  constructor() {
    super('production telemetry is not enabled in this PoC slice');
    this.name = 'SyntheticOnlyError';
  }
}

export function assertSyntheticOnly(cfg: Pick<RuntimeConfig, 'syntheticOnly'>): void {
  // POC_SYNTHETIC_ONLY is the hard PoC block; cfg.syntheticOnly is the environment-level guard.
  // Real telemetry requires this slice to be replaced by a reviewed production slice.
  if (!POC_SYNTHETIC_ONLY || !cfg.syntheticOnly) {
    throw new SyntheticOnlyError();
  }
}