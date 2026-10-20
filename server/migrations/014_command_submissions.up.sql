-- Receipts and commands commit together. Keys never expire silently.
CREATE TABLE command_submissions (
    user_id UUID NOT NULL REFERENCES users(id),
    request_key UUID NOT NULL,
    request_hash TEXT NOT NULL,
    receipt JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, request_key)
);
