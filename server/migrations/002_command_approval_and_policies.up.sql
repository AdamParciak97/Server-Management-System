ALTER TABLE commands
    ADD COLUMN IF NOT EXISTS requires_approval BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id),
    ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS approval_note TEXT;

CREATE TABLE IF NOT EXISTS compliance_policies (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name           TEXT NOT NULL,
    group_id       UUID REFERENCES groups(id) ON DELETE CASCADE,
    policy_type    TEXT NOT NULL,
    subject        TEXT NOT NULL,
    expected_value TEXT,
    severity       alert_severity NOT NULL DEFAULT 'medium',
    enabled        BOOLEAN NOT NULL DEFAULT true,
    created_by     UUID REFERENCES users(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_compliance_policies_group_id
    ON compliance_policies(group_id);

CREATE INDEX IF NOT EXISTS idx_compliance_policies_enabled
    ON compliance_policies(enabled, policy_type);
