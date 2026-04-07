CREATE TABLE IF NOT EXISTS compliance_exceptions (
    id UUID PRIMARY KEY,
    policy_id UUID NOT NULL REFERENCES compliance_policies(id) ON DELETE CASCADE,
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    expires_at TIMESTAMPTZ,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_compliance_exceptions_policy_agent
    ON compliance_exceptions(policy_id, agent_id);
