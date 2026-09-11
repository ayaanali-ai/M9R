-- OathLock — distinguish a hard run-budget expiry from an agent failure.
-- Evidence and run history remain intact; expiry only stops further heartbeats.

ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_status_check;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_status_check
  CHECK (status IN ('started', 'working', 'blocked', 'waiting_for_human', 'submitted', 'completed', 'failed', 'expired', 'cancelled'));
