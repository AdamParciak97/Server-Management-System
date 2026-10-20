ALTER TABLE registration_tokens ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
ALTER TABLE registration_tokens ADD COLUMN IF NOT EXISTS revoked_by UUID REFERENCES users(id);
