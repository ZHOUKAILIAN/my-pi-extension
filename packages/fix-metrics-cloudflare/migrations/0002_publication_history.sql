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

-- Upgrade-path backfill (review P1.2): deployments from migration 0001 already have publication
-- pointer rows without a history table. The current pointer target of every window is backfilled
-- as its first history row so pre-upgrade published revisions stay readable after the upgrade
-- (an upgrade must never strand an already-published revision as unreadable).
INSERT OR IGNORE INTO fix_metric_snapshot_publication_history (window_start, window_end, definition_version, snapshot_id, snapshot_at, published_at)
SELECT window_start, window_end, definition_version, published_snapshot_id, snapshot_at, updated_at
FROM fix_metric_snapshot_publication;
