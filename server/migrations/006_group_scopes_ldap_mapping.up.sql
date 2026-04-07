CREATE TABLE IF NOT EXISTS user_group_scopes (
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    group_id    UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, group_id)
);

CREATE TABLE IF NOT EXISTS ldap_group_mappings (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ldap_group_dn TEXT NOT NULL UNIQUE,
    role          TEXT NOT NULL,
    group_id      UUID REFERENCES groups(id) ON DELETE CASCADE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
