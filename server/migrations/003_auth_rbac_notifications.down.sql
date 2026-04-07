ALTER TABLE alerts
    DROP COLUMN IF EXISTS notification_error,
    DROP COLUMN IF EXISTS notified_at;

DROP TABLE IF EXISTS user_permissions;

ALTER TABLE users
    DROP COLUMN IF EXISTS auth_source;
