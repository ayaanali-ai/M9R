-- GitHub linkage (V2 Phase 10). Optional, agent-declared references to the
-- resulting GitHub artifacts. M9R does not verify these against GitHub's
-- API and does not claim ownership of them -- a Run remains valid with
-- none of these set.
--
-- This was originally shipped as a loose root-level supabase-github-links.sql
-- file outside supabase/migrations/, so it was never actually applied. Found
-- during an audit of all ~19 root-level supabase-*.sql files (same class of
-- gap as the agent_connections.capabilities miss). The real app code
-- (github-link-service.ts) both reads and writes these 4 columns from a live
-- API route (/api/agent/runs/[id]/github-links) -- notably, that code has a
-- defensive isMissingColumnError() catch that silently returned "success"
-- while doing nothing whenever these columns didn't exist, so the practical
-- impact was silent data loss (a caller believed its GitHub links were
-- saved) rather than a visible error. Verified with a scoped round-trip
-- write/read/revert against a real (pre-existing) run row after applying.

ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS github_commit TEXT;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS github_branch TEXT;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS github_pr_url TEXT;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS github_ci_url TEXT;

COMMENT ON COLUMN agent_runs.github_commit IS 'Agent-declared commit SHA. Not independently verified against GitHub.';
COMMENT ON COLUMN agent_runs.github_pr_url IS 'Agent-declared pull request URL. Not independently verified against GitHub.';
