-- OathLock — Dispatches (V2 Phase 2: the Wire).
-- Run after supabase-agent-runs.sql.
--
-- A Dispatch is a structured, idempotent work-update event, distinct from
-- agent_run_events (a redacted per-run status log with no dedup and no
-- cross-run reads). Dispatches are workspace-scoped and read across runs —
-- that's "the Wire".
--
-- Provenance/telemetry ONLY: every field has already passed
-- validateDispatch() (dispatch.ts) before this row is written — no secrets,
-- no active content, no raw source.

CREATE TABLE IF NOT EXISTS dispatches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  workspace_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id UUID NOT NULL,

  schema_version TEXT NOT NULL DEFAULT 'oathlock.dispatch.v1',
  type TEXT NOT NULL
    CHECK (type IN ('RUN_STARTED', 'SCOPE_ANNOUNCED', 'WORKING', 'PHASE_CHANGED', 'BLOCKED', 'HUMAN_DECISION_REQUIRED', 'EVIDENCE_READY', 'RUN_COMPLETED')),
  sender TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail JSONB,
  scope TEXT[] NOT NULL DEFAULT '{}',
  visibility TEXT NOT NULL DEFAULT 'workspace' CHECK (visibility IN ('workspace', 'run')),
  resolution_state TEXT NOT NULL DEFAULT 'open' CHECK (resolution_state IN ('open', 'resolved', 'expired')),
  expires_at TIMESTAMPTZ,

  -- Deterministic hash of (workspace, run, type, sender, scope, summary). A
  -- retried publish with the same content is a no-op, not a duplicate Wire
  -- entry — this is the guarantee agent_run_events never had.
  idempotency_key TEXT NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (id, run_id, workspace_id),
  FOREIGN KEY (run_id, workspace_id)
    REFERENCES agent_runs(id, workspace_id) ON DELETE CASCADE
);

COMMENT ON TABLE dispatches IS
  'Structured, idempotent Wire events. Provenance only — never source/secrets (enforced before insert, not by this table).';

-- One row per unique (run, idempotency_key). A retried publish with identical
-- content upserts onto the same row instead of creating a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatches_run_idempotency ON dispatches(run_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_dispatches_workspace_recent ON dispatches(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dispatches_run ON dispatches(run_id, created_at DESC);

ALTER TABLE dispatches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on dispatches" ON dispatches;
CREATE POLICY "Service role full access on dispatches" ON dispatches
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Users read own workspace dispatches" ON dispatches;
CREATE POLICY "Users read own workspace dispatches" ON dispatches
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT id FROM projects WHERE owner_id = auth.uid()));

GRANT SELECT ON public.dispatches TO authenticated;
