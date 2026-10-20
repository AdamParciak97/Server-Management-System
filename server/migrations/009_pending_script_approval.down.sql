-- Deliberately retain approval requirements on rollback. We cannot distinguish
-- repaired flags from operator-created flags without weakening approval safety.
SELECT 1;
