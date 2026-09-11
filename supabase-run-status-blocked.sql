-- OathLock — add 'blocked' to agent_runs.status.
-- Run after supabase-agent-runs.sql.
--
-- Adds the one new CLI-assertable phase from the V2 Run lifecycle spec that the
-- raw status column can actually represent (the CLI can say "I'm blocked"; it
-- cannot say "evidence is ready for approval" — that's derived server-side from
-- real evidence/passport/review rows, not a status the CLI sets).

ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_status_check;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_status_check
  CHECK (status IN ('started', 'working', 'blocked', 'waiting_for_human', 'submitted', 'completed', 'failed'));
