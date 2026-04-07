ALTER TABLE users
    ADD COLUMN IF NOT EXISTS auth_source TEXT NOT NULL DEFAULT 'local';

CREATE TABLE IF NOT EXISTS user_permissions (
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission  TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, permission)
);

ALTER TABLE alerts
    ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS notification_error TEXT;
