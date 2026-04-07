DROP TABLE IF EXISTS agent_baselines;

ALTER TABLE agent_reports
    DROP COLUMN IF EXISTS scheduled_tasks;
