ALTER TABLE agent_reports
    ADD COLUMN IF NOT EXISTS scheduled_tasks JSONB;

CREATE TABLE IF NOT EXISTS agent_baselines (
    agent_id     UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
    report_id    UUID NOT NULL REFERENCES agent_reports(id) ON DELETE CASCADE,
    created_by   UUID REFERENCES users(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
