-- OathLock — GitHub linkage (V2 Phase 10). Run after supabase-agent-runs.sql.
--
-- Optional, agent-declared references to the resulting GitHub artifacts.
-- OathLock does not verify these against GitHub's API and does not claim
-- ownership of them — a Run remains valid with none of these set.

ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS github_commit TEXT;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS github_branch TEXT;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS github_pr_url TEXT;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS github_ci_url TEXT;

COMMENT ON COLUMN agent_runs.github_commit IS 'Agent-declared commit SHA. Not independently verified against GitHub.';
COMMENT ON COLUMN agent_runs.github_pr_url IS 'Agent-declared pull request URL. Not independently verified against GitHub.';
