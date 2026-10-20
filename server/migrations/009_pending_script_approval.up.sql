-- Preserve commands and existing approvals; secure only unsent live scripts
-- created before approval became part of the command INSERT.
UPDATE commands
SET requires_approval = true
WHERE type = 'run_script'
  AND dry_run = false
  AND status = 'pending'
  AND requires_approval = false
  AND approved_at IS NULL;
