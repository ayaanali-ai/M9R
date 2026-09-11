-- OathLock — add 'cancelled' to agent_runs.status.
-- Run after supabase-run-status-blocked.sql.
--
-- Distinct from 'failed': 'failed' means the agent reported it could not
-- complete the work; 'cancelled' means a human stopped the run before it
-- finished. Conflating the two into 'failed' would make every operator-
-- cancelled test/throwaway run indistinguishable from a genuine agent
-- failure in the Run Passport / Run Ledger record.

ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_status_check;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_status_check
  CHECK (status IN ('started', 'working', 'blocked', 'waiting_for_human', 'submitted', 'completed', 'failed', 'cancelled'));
