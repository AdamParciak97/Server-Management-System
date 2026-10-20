-- Preserve receipts on rollback: deleting them would make old retries executable.
-- Older application versions ignore this additive table.
SELECT 1;
