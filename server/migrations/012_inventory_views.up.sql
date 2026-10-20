CREATE TABLE inventory_views (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(80) NOT NULL CHECK (length(trim(name)) > 0),
    filters JSONB NOT NULL CHECK (jsonb_typeof(filters) = 'object'),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX inventory_views_owner_idx ON inventory_views(user_id);
CREATE INDEX agents_inventory_name_idx ON agents(lower(hostname), id);
CREATE INDEX agents_inventory_group_name_idx ON agents(group_id, lower(hostname), id);
