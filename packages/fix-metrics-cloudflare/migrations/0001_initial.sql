-- Fix Metrics PoC slice (synthetic-data-only), migration 0001.
-- Subset of the approved design's D1 model (docs/归档/研究/2026-08-28-fix-telemetry-cloudflare-technical-proposal.md §6.7):
--   fix_metric_events        append-only accepted raw events (eventId PK, business-key unique, canonical-hash conflict check)
--   fix_metric_quarantine    invalid/unsafe events that are durable but never projected
--   fix_metric_snapshots     immutable published as-of aggregates (revision-hash unique)
--   fix_metric_snapshot_publication  latest-revision pointer per UTC window (generation CAS)
-- Trust roots/source keys, replay audit, retention audit and resolution-cycle projection tables are
-- later slices; this PoC does not declare them implemented.
-- One statement per line; no embedded semicolons (the local test runner splits on ';').

CREATE TABLE fix_metric_events (
  event_id TEXT PRIMARY KEY,
  event_business_key TEXT NOT NULL,
  event_canonical_hash TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  run_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  workflow_definition_version TEXT NOT NULL,
  policy_digest TEXT NOT NULL,
  metric_definition_version TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  fix_classification TEXT NOT NULL,
  bug_category TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  source_version TEXT,
  stage TEXT NOT NULL,
  stage_from TEXT,
  stage_to TEXT,
  wait_reason TEXT,
  terminal_outcome TEXT,
  node_id TEXT,
  node_execution_id TEXT,
  artifact_id TEXT,
  candidate_revision TEXT,
  review_cycle_id TEXT,
  resolution_cycle_id TEXT,
  disposition_outcome TEXT,
  worker_id TEXT,
  source_key_id TEXT,
  source_signature TEXT,
  role TEXT,
  control_ref TEXT,
  supersedes_event_id TEXT,
  resolution_type TEXT,
  outcome TEXT,
  decision TEXT,
  reason_code TEXT,
  payload_json TEXT NOT NULL
);

CREATE INDEX idx_fix_events_type_time ON fix_metric_events(event_type, occurred_at);
CREATE INDEX idx_fix_events_run_time ON fix_metric_events(run_id, occurred_at);
CREATE UNIQUE INDEX uq_fix_events_business_key ON fix_metric_events(event_business_key);

CREATE TABLE fix_metric_quarantine (
  event_id TEXT PRIMARY KEY,
  fact_id TEXT NOT NULL,
  run_id TEXT,
  event_business_key TEXT NOT NULL,
  event_canonical_hash TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  received_at TEXT NOT NULL,
  event_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'quarantined',
  occurred_at TEXT NOT NULL
);

CREATE UNIQUE INDEX uq_fix_quarantine_business_key ON fix_metric_quarantine(event_business_key);

CREATE TABLE fix_metric_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  parent_snapshot_id TEXT,
  rebuild_task_id TEXT,
  definition_version TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  snapshot_at TEXT NOT NULL,
  maturity_at TEXT NOT NULL,
  status TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revision_hash TEXT NOT NULL UNIQUE,
  CHECK (status IN ('pending_maturity', 'calculable', 'needs_confirmation', 'blocked'))
);

CREATE INDEX idx_fix_snapshots_window ON fix_metric_snapshots(definition_version, window_start, window_end, snapshot_at);

CREATE TABLE fix_metric_snapshot_publication (
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  snapshot_at TEXT NOT NULL,
  definition_version TEXT NOT NULL,
  published_snapshot_id TEXT NOT NULL,
  publication_generation INTEGER NOT NULL DEFAULT 0,
  published_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (window_start, window_end),
  UNIQUE (published_snapshot_id),
  FOREIGN KEY (published_snapshot_id) REFERENCES fix_metric_snapshots(snapshot_id)
);