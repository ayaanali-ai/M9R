-- OathLock — Responses (V2 Phase 3: Run Rooms).
-- Run after supabase-dispatches.sql.
--
-- A Response answers a Dispatch (or, when dispatch_id is null, stands alone as
-- a run-level note). Distinct from the existing human_review decision
-- (agent_run_events / run-review-decision-service.ts) — that is the FINAL
-- disposition of a run; a Response is a mid-run structured exchange that can
-- happen any number of times before the final review.

CREATE TABLE IF NOT EXISTS responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  workspace_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id UUID NOT NULL,
  dispatch_id UUID,

  schema_version TEXT NOT NULL DEFAULT 'oathlock.response.v1',
  type TEXT NOT NULL
    CHECK (type IN ('acknowledgement', 'clarification', 'finding', 'artifact', 'scope_decision', 'acceptance', 'dispute', 'human_instruction', 'resolution')),
  sender_role TEXT NOT NULL CHECK (sender_role IN ('agent', 'operator')),
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  body TEXT NOT NULL,
  scope TEXT[] NOT NULL DEFAULT '{}',
  resolution_state TEXT NOT NULL DEFAULT 'open' CHECK (resolution_state IN ('open', 'resolved')),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  FOREIGN KEY (run_id, workspace_id)
    REFERENCES agent_runs(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (dispatch_id, run_id, workspace_id)
    REFERENCES dispatches(id, run_id, workspace_id) ON DELETE SET NULL (dispatch_id)
);

COMMENT ON TABLE responses IS
  'Structured Run Room exchanges. Provenance only — never source/secrets (enforced before insert, not by this table).';

CREATE INDEX IF NOT EXISTS idx_responses_run ON responses(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_responses_dispatch ON responses(dispatch_id);
CREATE INDEX IF NOT EXISTS idx_responses_workspace_recent ON responses(workspace_id, created_at DESC);

ALTER TABLE responses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on responses" ON responses;
CREATE POLICY "Service role full access on responses" ON responses
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Users read own workspace responses" ON responses;
CREATE POLICY "Users read own workspace responses" ON responses
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT id FROM projects WHERE owner_id = auth.uid()));

GRANT SELECT ON public.responses TO authenticated;
