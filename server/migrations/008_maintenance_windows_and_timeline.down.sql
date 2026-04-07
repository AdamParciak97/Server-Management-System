DROP INDEX IF EXISTS idx_scheduled_commands_maintenance_window_id;

ALTER TABLE scheduled_commands
    DROP COLUMN IF EXISTS last_skip_reason,
    DROP COLUMN IF EXISTS last_skipped_at,
    DROP COLUMN IF EXISTS maintenance_window_id;

DROP INDEX IF EXISTS idx_maintenance_windows_enabled;
DROP INDEX IF EXISTS idx_maintenance_windows_group_id;
DROP INDEX IF EXISTS idx_maintenance_windows_agent_id;

DROP TABLE IF EXISTS maintenance_windows;
