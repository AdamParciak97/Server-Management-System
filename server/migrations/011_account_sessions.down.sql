-- Rolling back must never reactivate credentials invalidated by the upgrade.
UPDATE refresh_tokens SET revoked = true WHERE revoked = false;
ALTER TABLE refresh_tokens DROP COLUMN session_id;
DROP INDEX IF EXISTS refresh_tokens_hash_idx;
DROP TABLE account_sessions;
