-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── Users & Auth ──────────────────────────────────────────────────────────────
CREATE TYPE user_role AS ENUM ('admin', 'operator', 'readonly');

CREATE TABLE users (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username    VARCHAR(64) UNIQUE NOT NULL,
    email       VARCHAR(255) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role        user_role NOT NULL DEFAULT 'readonly',
    is_active   BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login  TIMESTAMPTZ
);

CREATE TABLE refresh_tokens (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked     BOOLEAN NOT NULL DEFAULT false
);

-- ─── Registration Tokens ───────────────────────────────────────────────────────
CREATE TABLE registration_tokens (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    token       TEXT UNIQUE NOT NULL,
    created_by  UUID REFERENCES users(id),
    used        BOOLEAN NOT NULL DEFAULT false,
    used_at     TIMESTAMPTZ,
    used_by     UUID,
    expires_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    note        TEXT
);

-- ─── Groups & Tags ─────────────────────────────────────────────────────────────
CREATE TABLE groups (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        VARCHAR(128) UNIQUE NOT NULL,
    description TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE tags (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        VARCHAR(64) UNIQUE NOT NULL,
    color       VARCHAR(16),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Agents / Servers ──────────────────────────────────────────────────────────
CREATE TABLE agents (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    hostname        TEXT NOT NULL,
    fqdn            TEXT,
    ip_addresses    TEXT[] NOT NULL DEFAULT '{}',
    os              TEXT,
    os_version      TEXT,
    architecture    TEXT,
    agent_version   TEXT,
    group_id        UUID REFERENCES groups(id),
    tags            UUID[] DEFAULT '{}',
    cert_fingerprint TEXT,
    last_seen       TIMESTAMPTZ,
    status          TEXT NOT NULL DEFAULT 'unknown', -- online, offline, unknown
    registered_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agents_status ON agents(status);
CREATE INDEX idx_agents_last_seen ON agents(last_seen);
CREATE INDEX idx_agents_group_id ON agents(group_id);

-- ─── Agent Reports ─────────────────────────────────────────────────────────────
CREATE TABLE agent_reports (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    timestamp   TIMESTAMPTZ NOT NULL,
    system_info JSONB NOT NULL,
    packages    JSONB,
    services    JSONB,
    service_configs JSONB,  -- encrypted
    security_agents JSONB,
    processes   JSONB,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_reports_agent_id ON agent_reports(agent_id);
CREATE INDEX idx_reports_timestamp ON agent_reports(timestamp DESC);

-- ─── Config Snapshots & Diffs ──────────────────────────────────────────────────
CREATE TABLE config_snapshots (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    report_id   UUID REFERENCES agent_reports(id),
    snapshot    JSONB NOT NULL,  -- encrypted
    hash        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_snapshots_agent_id ON config_snapshots(agent_id, created_at DESC);

CREATE TABLE config_diffs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    from_snapshot_id UUID REFERENCES config_snapshots(id),
    to_snapshot_id  UUID REFERENCES config_snapshots(id),
    diff            JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_diffs_agent_id ON config_diffs(agent_id, created_at DESC);

-- ─── Commands ──────────────────────────────────────────────────────────────────
CREATE TYPE command_priority AS ENUM ('critical', 'high', 'normal', 'low');
CREATE TYPE command_status AS ENUM ('pending', 'sent', 'running', 'success', 'error', 'timeout', 'cancelled');

CREATE TABLE commands (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id        UUID REFERENCES agents(id) ON DELETE CASCADE,
    group_id        UUID REFERENCES groups(id),
    type            TEXT NOT NULL,
    priority        command_priority NOT NULL DEFAULT 'normal',
    payload         JSONB NOT NULL,
    dry_run         BOOLEAN NOT NULL DEFAULT false,
    timeout_seconds INT NOT NULL DEFAULT 1800,
    status          command_status NOT NULL DEFAULT 'pending',
    output          TEXT,
    error           TEXT,
    exit_code       INT,
    duration_ms     BIGINT,
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_at         TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ
);

CREATE INDEX idx_commands_agent_id ON commands(agent_id, status);
CREATE INDEX idx_commands_status ON commands(status, priority);
CREATE INDEX idx_commands_created_at ON commands(created_at DESC);

-- ─── Scheduled Commands ────────────────────────────────────────────────────────
CREATE TABLE scheduled_commands (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            TEXT NOT NULL,
    cron_expr       TEXT NOT NULL,
    agent_id        UUID REFERENCES agents(id),
    group_id        UUID REFERENCES groups(id),
    type            TEXT NOT NULL,
    priority        command_priority NOT NULL DEFAULT 'normal',
    payload         JSONB NOT NULL,
    dry_run         BOOLEAN NOT NULL DEFAULT false,
    timeout_seconds INT NOT NULL DEFAULT 1800,
    enabled         BOOLEAN NOT NULL DEFAULT true,
    last_run        TIMESTAMPTZ,
    next_run        TIMESTAMPTZ,
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Alerts ────────────────────────────────────────────────────────────────────
CREATE TYPE alert_type AS ENUM (
    'agent_offline', 'config_changed', 'missing_security_agent',
    'critical_service_stopped', 'command_failed'
);
CREATE TYPE alert_severity AS ENUM ('critical', 'high', 'medium', 'low');

CREATE TABLE alerts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id        UUID REFERENCES agents(id) ON DELETE CASCADE,
    type            alert_type NOT NULL,
    severity        alert_severity NOT NULL DEFAULT 'medium',
    title           TEXT NOT NULL,
    message         TEXT NOT NULL,
    details         JSONB,
    acknowledged    BOOLEAN NOT NULL DEFAULT false,
    acknowledged_by UUID REFERENCES users(id),
    acknowledged_at TIMESTAMPTZ,
    resolved        BOOLEAN NOT NULL DEFAULT false,
    resolved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_alerts_agent_id ON alerts(agent_id);
CREATE INDEX idx_alerts_acknowledged ON alerts(acknowledged, resolved);
CREATE INDEX idx_alerts_created_at ON alerts(created_at DESC);

-- ─── Packages (distribution) ───────────────────────────────────────────────────
CREATE TABLE packages (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        TEXT NOT NULL,
    version     TEXT NOT NULL,
    os_target   TEXT,
    arch_target TEXT,
    file_path   TEXT NOT NULL,
    file_size   BIGINT,
    sha256      TEXT NOT NULL,
    description TEXT,
    uploaded_by UUID REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(name, version, os_target, arch_target)
);

-- ─── Required Security Agents (per group) ─────────────────────────────────────
CREATE TABLE required_security_agents (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    group_id    UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    agent_name  TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(group_id, agent_name)
);

-- ─── Audit Log ─────────────────────────────────────────────────────────────────
CREATE TABLE audit_log (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID REFERENCES users(id),
    username    TEXT,
    ip          TEXT,
    action      TEXT NOT NULL,
    resource    TEXT,
    resource_id TEXT,
    details     JSONB,
    result      TEXT NOT NULL DEFAULT 'success', -- success, failure
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_user_id ON audit_log(user_id);
CREATE INDEX idx_audit_created_at ON audit_log(created_at DESC);
CREATE INDEX idx_audit_action ON audit_log(action);

-- ─── Alert thresholds configuration ──────────────────────────────────────────
CREATE TABLE system_config (
    key     TEXT PRIMARY KEY,
    value   TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO system_config(key, value) VALUES
    ('offline_threshold_minutes', '10'),
    ('report_retention_days', '90'),
    ('alert_retention_days', '365');

-- ─── Default admin user (password: admin - change immediately!) ───────────────
INSERT INTO users(username, email, password_hash, role)
VALUES ('admin', 'admin@localhost',
    '$2a$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQyCNNEMwdGTMaKTFCeHxOVA2', -- "admin"
    'admin');
