-- OathLock — Evidence Records (V2 Phase 1: Evidence Contract).
-- Run after supabase-agent-runs.sql and supabase-agent-join.sql.
--
-- One row per validated, human-approved Evidence Contract. Distinct from
-- agent_sessions (which stores the legacy free-text-parsed evidence and
-- counts-only rule_health/behavior snapshots) — this table stores the
-- structured, versioned contract itself, post-validation.
--
-- Provenance/telemetry ONLY: every string field here has already passed
-- evidence-contract.ts validation (no secrets, no active content, no raw
-- source code, no self-approval).

CREATE TABLE IF NOT EXISTS evidence_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  run_id UUID NOT NULL,
  session_id UUID REFERENCES agent_sessions(id) ON DELETE SET NULL,
  workspace_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  schema_version TEXT NOT NULL DEFAULT 'oathlock.evidence.v1',

  -- The full validated, normalized contract (task/changes/verification/
  -- failed_commands/limitations/sensitive_areas). Already passed
  -- validateEvidenceContract() before this row is written.
  contract JSONB NOT NULL,

  -- Soft validation flags surfaced to the human reviewer (e.g. "no files
  -- listed for a change", "scope changes reported"). Never blocks storage.
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Set true only once, at insert time, from the same human_approved_submission
  -- gate the session route already enforces. Evidence records are never created
  -- for unapproved submissions, so this is always true in practice; kept as an
  -- explicit column so future review flows can query on it without re-deriving.
  human_approved_submission BOOLEAN NOT NULL CHECK (human_approved_submission = true),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  FOREIGN KEY (run_id, workspace_id)
    REFERENCES agent_runs(id, workspace_id) ON DELETE CASCADE
);

COMMENT ON TABLE evidence_records IS
  'Validated, versioned Evidence Contracts. Provenance only — never source/secrets (enforced before insert, not by this table).';

CREATE INDEX IF NOT EXISTS idx_evidence_records_run ON evidence_records(run_id);
CREATE INDEX IF NOT EXISTS idx_evidence_records_workspace ON evidence_records(workspace_id, created_at DESC);

ALTER TABLE evidence_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on evidence_records" ON evidence_records;
CREATE POLICY "Service role full access on evidence_records" ON evidence_records
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Users read own evidence records" ON evidence_records;
CREATE POLICY "Users read own evidence records" ON evidence_records
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT id FROM projects WHERE owner_id = auth.uid()));

GRANT SELECT ON public.evidence_records TO authenticated;
