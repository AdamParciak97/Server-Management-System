DROP TABLE IF EXISTS command_templates;

ALTER TABLE agent_reports
    DROP COLUMN IF EXISTS event_logs;
