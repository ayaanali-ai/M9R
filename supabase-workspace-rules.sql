-- OathLock v5.1 — persistent workspace rules.
-- Run after supabase-oathlock-phase1.sql and supabase-auth-foundation.sql.
--
-- This adds a NEW table dedicated to the v5 GeneratedRule lifecycle (rule_type /
-- confidence / status / health counters). It intentionally does NOT overload the
-- legacy `rules` table, whose leak_type/severity/is_active shape can't hold this
-- model without lossy normalization. Workspace == project (owner-scoped), so RLS
-- mirrors the existing project-owner policies exactly. Existing RLS is untouched.

CREATE TABLE IF NOT EXISTS workspace_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- A workspace rule lives in a project (workspace) the user owns.
  workspace_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- Provenance (optional). source_report_id is TEXT because in-browser reports
  -- carry client-generated ids that are not DB UUIDs.
  source_report_id TEXT,
  source_session_name TEXT,

  -- Core rule content.
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  rule_type TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'needs_review', 'low_confidence', 'retired')),

  evidence_summary TEXT,
  source_finding_id TEXT,
  expected_prevention TEXT,

  -- Lifecycle timestamps.
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ,
  promoted_at TIMESTAMPTZ DEFAULT NOW(),
  retired_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,

  -- Health / usage counters.
  times_seen INTEGER NOT NULL DEFAULT 0,
  times_exported INTEGER NOT NULL DEFAULT 0,
  times_helped INTEGER NOT NULL DEFAULT 0,

  notes TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL
);

COMMENT ON TABLE workspace_rules IS
  'Persistent, workspace-scoped rules promoted from Blackbox Reports (OathLock v5.1).';

CREATE INDEX IF NOT EXISTS idx_workspace_rules_workspace ON workspace_rules(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_rules_status ON workspace_rules(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_workspace_rules_type ON workspace_rules(workspace_id, rule_type);

-- ---------------------------------------------------------------------------
-- Row Level Security — mirrors the existing project-owner model. No public
-- access. A user may touch a workspace rule only when they own its workspace.
-- ---------------------------------------------------------------------------
ALTER TABLE workspace_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on workspace_rules" ON workspace_rules;
CREATE POLICY "Service role full access on workspace_rules" ON workspace_rules
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Users can read own workspace rules" ON workspace_rules;
CREATE POLICY "Users can read own workspace rules" ON workspace_rules
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT id FROM projects WHERE owner_id = auth.uid()));

DROP POLICY IF EXISTS "Users can insert own workspace rules" ON workspace_rules;
CREATE POLICY "Users can insert own workspace rules" ON workspace_rules
  FOR INSERT TO authenticated
  WITH CHECK (workspace_id IN (SELECT id FROM projects WHERE owner_id = auth.uid()));

DROP POLICY IF EXISTS "Users can update own workspace rules" ON workspace_rules;
CREATE POLICY "Users can update own workspace rules" ON workspace_rules
  FOR UPDATE TO authenticated
  USING (workspace_id IN (SELECT id FROM projects WHERE owner_id = auth.uid()))
  WITH CHECK (workspace_id IN (SELECT id FROM projects WHERE owner_id = auth.uid()));

DROP POLICY IF EXISTS "Users can delete own workspace rules" ON workspace_rules;
CREATE POLICY "Users can delete own workspace rules" ON workspace_rules
  FOR DELETE TO authenticated
  USING (workspace_id IN (SELECT id FROM projects WHERE owner_id = auth.uid()));

-- Data API access is explicit; RLS remains the authorization layer.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.workspace_rules TO authenticated;

-- Keep updated_at current on every change (the service also sets it, but this is
-- a safety net). Reuses gen_random_uuid()'s pgcrypto; no new extensions needed.
CREATE OR REPLACE FUNCTION public.touch_workspace_rules_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_workspace_rules_updated_at ON workspace_rules;
CREATE TRIGGER trg_workspace_rules_updated_at
  BEFORE UPDATE ON workspace_rules
  FOR EACH ROW EXECUTE PROCEDURE public.touch_workspace_rules_updated_at();
