-- Fix Metrics PoC slice, migration 0002: published-revision history (review P1.5).
-- Every revision that wins a publication pointer write is recorded here, so an EARLIER published
-- revision stays readable by its snapshotId after the pointer moves on, while a same-window row
-- that was stored but never published has no pointer and no history row and is never served.
-- One statement per line; no embedded semicolons.

CREATE TABLE fix_metric_snapshot_publication_history (
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  definition_version TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  snapshot_at TEXT NOT NULL,
  published_at TEXT NOT NULL,
  PRIMARY KEY (window_start, window_end, snapshot_id),
  FOREIGN KEY (snapshot_id) REFERENCES fix_metric_snapshots(snapshot_id)
);

CREATE INDEX idx_fix_pub_history_snapshot ON fix_metric_snapshot_publication_history(snapshot_id);
