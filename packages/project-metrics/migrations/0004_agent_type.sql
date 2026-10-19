ALTER TABLE project_metric_events ADD COLUMN agent_type TEXT;
CREATE INDEX IF NOT EXISTS project_metric_events_agent_type ON project_metric_events(dataset, agent_type, ingest_seq);
