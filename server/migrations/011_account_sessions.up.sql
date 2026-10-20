-- Existing tokens have no session identity: require a fresh login after upgrade.
-- Keep historical rows; no operational data is removed.
CREATE TABLE account_sessions (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    user_agent VARCHAR(512) NOT NULL DEFAULT ''
);
CREATE INDEX account_sessions_user_idx ON account_sessions(user_id);
ALTER TABLE refresh_tokens ADD COLUMN session_id UUID REFERENCES account_sessions(id);
CREATE INDEX refresh_tokens_session_idx ON refresh_tokens(session_id);
CREATE INDEX refresh_tokens_hash_idx ON refresh_tokens(token_hash);
UPDATE refresh_tokens SET revoked = true WHERE revoked = false;
