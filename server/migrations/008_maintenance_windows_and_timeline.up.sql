CREATE TABLE maintenance_windows (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        TEXT NOT NULL,
    agent_id    UUID REFERENCES agents(id) ON DELETE CASCADE,
    group_id    UUID REFERENCES groups(id) ON DELETE CASCADE,
    timezone    TEXT NOT NULL DEFAULT 'UTC',
    days_of_week INT[] NOT NULL DEFAULT '{1,2,3,4,5}',
    start_time  TEXT NOT NULL,
    end_time    TEXT NOT NULL,
    enabled     BOOLEAN NOT NULL DEFAULT true,
    created_by  UUID REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT maintenance_window_target_chk CHECK (
        (agent_id IS NOT NULL AND group_id IS NULL) OR
        (agent_id IS NULL AND group_id IS NOT NULL)
    )
);

CREATE INDEX idx_maintenance_windows_agent_id ON maintenance_windows(agent_id);
CREATE INDEX idx_maintenance_windows_group_id ON maintenance_windows(group_id);
CREATE INDEX idx_maintenance_windows_enabled ON maintenance_windows(enabled);

ALTER TABLE scheduled_commands
    ADD COLUMN maintenance_window_id UUID REFERENCES maintenance_windows(id),
    ADD COLUMN last_skipped_at TIMESTAMPTZ,
    ADD COLUMN last_skip_reason TEXT NOT NULL DEFAULT '';

CREATE INDEX idx_scheduled_commands_maintenance_window_id ON scheduled_commands(maintenance_window_id);
