ALTER TABLE agent_reports
    ADD COLUMN IF NOT EXISTS event_logs JSONB;

CREATE TABLE IF NOT EXISTS command_templates (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            TEXT NOT NULL,
    description     TEXT,
    type            TEXT NOT NULL,
    priority        command_priority NOT NULL DEFAULT 'normal',
    payload         JSONB NOT NULL,
    dry_run         BOOLEAN NOT NULL DEFAULT false,
    timeout_seconds INT NOT NULL DEFAULT 1800,
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
    ALTER TYPE alert_type ADD VALUE IF NOT EXISTS 'critical_event';
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
