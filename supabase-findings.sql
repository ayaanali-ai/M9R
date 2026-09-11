-- OathLock — Findings + Adoptions (V2 Phase 5: Reviewed Findings).
-- Run after supabase-agent-runs.sql.
--
-- A Finding is a structured observation an agent publishes from a Run. It is
-- NOT available to other runs until a human reviews it (review_state moves
-- observed -> available). Findings never become trusted solely because
-- agents agree — human review is the gate, same discipline as
-- workspace_rules (needs_review -> active only via human action).

CREATE TABLE IF NOT EXISTS findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  workspace_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  originating_run_id UUID NOT NULL,
  originating_sender TEXT NOT NULL,

  schema_version TEXT NOT NULL DEFAULT 'oathlock.finding.v1',
  title TEXT NOT NULL,
  applicable_environment TEXT NOT NULL,
  observed_behavior TEXT NOT NULL,
  evidence_level TEXT NOT NULL CHECK (evidence_level IN ('inferred', 'correlated', 'command_tied')),
  suggested_response TEXT NOT NULL,
  known_limitations TEXT[] NOT NULL DEFAULT '{}',

  review_state TEXT NOT NULL DEFAULT 'observed' CHECK (review_state IN ('observed', 'available', 'retired')),
  reviewed_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (id, workspace_id),
  FOREIGN KEY (originating_run_id, workspace_id)
    REFERENCES agent_runs(id, workspace_id) ON DELETE CASCADE
);

COMMENT ON TABLE findings IS
  'Agent-published, human-reviewed observations. Provenance only — never source/secrets (enforced before insert, not by this table).';

CREATE INDEX IF NOT EXISTS idx_findings_workspace_available ON findings(workspace_id, review_state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_findings_run ON findings(originating_run_id);

-- ---------------------------------------------------------------------------
-- findings_adoptions — a later reviewed run cited/used an available Finding.
--   Adoption is not an upvote and never implies causality (see
--   summarizeAdoptions() in finding.ts) — it means a later reviewed run cited
--   this Finding, nothing more.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS findings_adoptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  workspace_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  finding_id UUID NOT NULL,
  adopting_run_id UUID NOT NULL,
  confirmation TEXT CHECK (confirmation IN ('confirmed', 'needs_review', 'contradicted')),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  FOREIGN KEY (finding_id, workspace_id)
    REFERENCES findings(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (adopting_run_id, workspace_id)
    REFERENCES agent_runs(id, workspace_id) ON DELETE CASCADE
);

COMMENT ON TABLE findings_adoptions IS
  'A later reviewed run cited an available Finding. Never a popularity metric.';

-- A run adopts a given Finding at most once.
CREATE UNIQUE INDEX IF NOT EXISTS idx_findings_adoptions_unique ON findings_adoptions(finding_id, adopting_run_id);
CREATE INDEX IF NOT EXISTS idx_findings_adoptions_finding ON findings_adoptions(finding_id);

ALTER TABLE findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE findings_adoptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on findings" ON findings;
CREATE POLICY "Service role full access on findings" ON findings
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Users read own workspace findings" ON findings;
CREATE POLICY "Users read own workspace findings" ON findings
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT id FROM projects WHERE owner_id = auth.uid()));

DROP POLICY IF EXISTS "Service role full access on findings_adoptions" ON findings_adoptions;
CREATE POLICY "Service role full access on findings_adoptions" ON findings_adoptions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Users read own workspace findings_adoptions" ON findings_adoptions;
CREATE POLICY "Users read own workspace findings_adoptions" ON findings_adoptions
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT id FROM projects WHERE owner_id = auth.uid()));

GRANT SELECT ON public.findings TO authenticated;
GRANT SELECT ON public.findings_adoptions TO authenticated;
