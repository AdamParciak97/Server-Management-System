-- Keep the protective foreign keys on rollback. Restoring CASCADE could erase
-- the last scope and silently grant global access. Older code supports RESTRICT.
SELECT 1;
