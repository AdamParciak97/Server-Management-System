-- Deliberately retain revocation state: dropping it would reactivate credentials.
-- Roll back application binaries only with registration disabled.
SELECT 1;
