-- OathLock — add Bounded Assistance dispatch types + Linked Run columns
-- (V2 Phase 8). Run after supabase-dispatches.sql and supabase-agent-runs.sql.

ALTER TABLE dispatches DROP CONSTRAINT IF EXISTS dispatches_type_check;
ALTER TABLE dispatches ADD CONSTRAINT dispatches_type_check
  CHECK (type IN ('RUN_STARTED', 'SCOPE_ANNOUNCED', 'WORKING', 'PHASE_CHANGED', 'BLOCKED', 'HUMAN_DECISION_REQUIRED', 'EVIDENCE_READY', 'RUN_COMPLETED', 'HELP_REQUESTED', 'CHECK_REQUESTED', 'CHECK_RESULT_RETURNED'));

-- A Linked Run: a supporting run created to answer a HELP_REQUESTED /
-- CHECK_REQUESTED Dispatch from another run. Independent identity and scope
-- (its own row), but traceable back to the request it's answering.
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS parent_run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS run_mode TEXT NOT NULL DEFAULT 'solo' CHECK (run_mode IN ('solo', 'coordinated', 'assurance'));

CREATE INDEX IF NOT EXISTS idx_agent_runs_parent ON agent_runs(parent_run_id);

COMMENT ON COLUMN agent_runs.parent_run_id IS
  'Set only for a Linked (supporting) Run created to answer another run''s HELP_REQUESTED/CHECK_REQUESTED Dispatch.';
COMMENT ON COLUMN agent_runs.run_mode IS
  'Coordination policy for this run (run-mode.ts). Solo is the default and makes no additional coordination requests.';
