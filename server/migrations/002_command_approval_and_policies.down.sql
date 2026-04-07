DROP INDEX IF EXISTS idx_compliance_policies_enabled;
DROP INDEX IF EXISTS idx_compliance_policies_group_id;
DROP TABLE IF EXISTS compliance_policies;

ALTER TABLE commands
    DROP COLUMN IF EXISTS approval_note,
    DROP COLUMN IF EXISTS approved_at,
    DROP COLUMN IF EXISTS approved_by,
    DROP COLUMN IF EXISTS requires_approval;
