CREATE TABLE IF NOT EXISTS project_metrics_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), namespace TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS project_metric_events (ingest_seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, dataset TEXT NOT NULL, kind TEXT NOT NULL, occurred_at TEXT, duration_ms REAL, outcome TEXT, model TEXT, provider TEXT, unknown_reason TEXT, canonical_hash TEXT NOT NULL, received_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS project_metric_events_received ON project_metric_events(dataset, received_at, ingest_seq);
CREATE INDEX IF NOT EXISTS project_metric_events_occurred ON project_metric_events(dataset, occurred_at, ingest_seq);
CREATE INDEX IF NOT EXISTS project_metric_events_kind ON project_metric_events(dataset, kind, ingest_seq);
