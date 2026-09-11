-- ============================================================================
-- OathLock Phase 1 — Supabase (Postgres) Schema
-- ============================================================================
-- Purpose: Clean, normalized database schema for the core OathLock entities.
--
-- Entities:
--   • users            — OathLock user accounts
--   • projects         — Workspaces that scope traces, reports, and rules
--   • traces           — Raw agent execution data uploaded by users
--   • blackbox_reports — Forensic analysis results for a trace
--   • rules            — Persistent, queryable improvement rules derived from reports
--   • rule_applications— Record of a rule being applied/evaluated against a trace
--   • security_signals — Security / MTM observations (conservative, evidence-based)
--
-- This file is safe to run on a Supabase Postgres database that already has
-- the legacy RunLeak schema (supabase-schema.sql). All CREATEs use IF NOT EXISTS.
--
-- Key design decisions for Phase 1:
--   • UUID primary keys everywhere (DEFAULT gen_random_uuid())
--   • Strong foreign keys with appropriate cascade / set null behavior
--   • created_at + updated_at (with trigger) on mutable tables
--   • Soft deletes (deleted_at) on users, projects, traces, and rules
--   • Raw trace stored as JSONB for fidelity + re-processing
--   • Findings, evidence, and signals stored as JSONB (flexible, queryable)
--   • Rules are deliberately easy to query by (project, leak_type, is_active)
--   • RuleApplications provide bidirectional history (rule → traces, trace → rules)
--   • SecuritySignals capture basic MTM and safety flags with evidence_level
--   • RLS policies included (owner-based + service_role full access)
--
-- Compatibility note:
--   The existing schema has a `profiles` table. In a real deployment you may:
--     - Use this `users` table as the canonical OathLock identity, or
--     - Point foreign keys at `profiles` instead (change REFERENCES users → profiles)
--     - Or populate `users.id` from `profiles.id` on first login.
--   The `auth_user_id` column supports linking to auth.users(id).
--
-- Run this in the Supabase SQL Editor.
-- ============================================================================

-- Enable pgcrypto for gen_random_uuid() if not already available (usually is on Supabase)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- USERS
-- ============================================================================
-- Primary user record for OathLock. In Supabase, this can be linked to
-- auth.users via auth_user_id. For Phase 1 we keep a separate table for
-- flexibility (email can be the login identity or we use Supabase Auth).
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Link to Supabase Auth user if using built-in authentication.
  auth_user_id UUID UNIQUE,

  email TEXT NOT NULL,
  name TEXT,
  company TEXT,

  -- Optional metadata for future use (plan, role, etc.)
  metadata JSONB,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

COMMENT ON TABLE users IS 'OathLock users. Primary owner of projects, traces, reports, and rules.';
COMMENT ON COLUMN users.auth_user_id IS 'Optional link to auth.users(id) when using Supabase Authentication.';
COMMENT ON COLUMN users.metadata IS 'Flexible bag for Phase 1 (avatar, preferences, etc.).';

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_users_auth_user_id ON users(auth_user_id) WHERE auth_user_id IS NOT NULL;

-- ============================================================================
-- PROJECTS / WORKSPACES
-- ============================================================================
-- A project (workspace) scopes traces, reports, and rules.
-- Phase 1: single owner (owner_id). Sharing can be added later.
-- ============================================================================

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  slug TEXT,                    -- Optional human-readable identifier within owner scope
  description TEXT,

  -- Future: plan limits, settings, etc.
  settings JSONB,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

COMMENT ON TABLE projects IS 'Projects (workspaces) that group traces, reports, and rules.';
COMMENT ON COLUMN projects.owner_id IS 'The user who owns this project. For Phase 1 there is a single owner.';

CREATE INDEX IF NOT EXISTS idx_projects_owner_id ON projects(owner_id);
CREATE INDEX IF NOT EXISTS idx_projects_created_at ON projects(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_owner_slug
  ON projects(owner_id, slug) WHERE slug IS NOT NULL AND deleted_at IS NULL;

-- ============================================================================
-- TRACES (raw agent execution data)
-- ============================================================================
-- The uploaded raw trace from an AI agent run. This is the source of truth
-- for forensic analysis. We store the original payload for re-processing.
-- ============================================================================

CREATE TABLE IF NOT EXISTS traces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Ownership
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- Trace identity from the source data
  session_id TEXT,                     -- e.g. "ol_sess_34529ff1a4594276"
  task_summary TEXT,

  -- Provenance & format
  schema TEXT,                         -- e.g. "oathlock.trace.v0"
  format TEXT,                         -- e.g. "oathlock.trace.v0", "generic-steps", "claude-code"
  variant TEXT,                        -- "clean" | "messy"
  provenance TEXT,                     -- Free-text note about origin

  -- Timing (from the trace when available)
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,

  -- High-level aggregates (denormalized for fast listing / filtering)
  step_count INTEGER NOT NULL DEFAULT 0,
  failed_step_count INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  distinct_actors TEXT[],              -- e.g. ['human','agent','tool']

  -- Usage metadata presence (critical for honest reporting)
  has_token_usage BOOLEAN NOT NULL DEFAULT FALSE,
  has_cost_data BOOLEAN NOT NULL DEFAULT FALSE,
  total_input_tokens BIGINT,
  total_output_tokens BIGINT,
  total_estimated_cost_usd NUMERIC(12, 6),

  -- The raw uploaded trace. Store as JSONB for structured access + re-analysis.
  -- For very large traces, consider moving payload to object storage later.
  raw_payload JSONB,

  -- Optional: original file metadata
  original_filename TEXT,
  content_type TEXT,
  byte_size BIGINT,

  -- Soft delete: important for user-uploaded forensic artifacts
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

COMMENT ON TABLE traces IS 'Raw agent execution traces uploaded for forensic analysis.';
COMMENT ON COLUMN traces.raw_payload IS 'The complete original trace JSON. Used for re-normalization and historical fidelity.';
COMMENT ON COLUMN traces.has_token_usage IS 'True if any step contained explicit token usage. Drives "unknown" waste logic.';
COMMENT ON COLUMN traces.has_cost_data IS 'True if any step contained explicit cost data.';

CREATE INDEX IF NOT EXISTS idx_traces_user_id ON traces(user_id);
CREATE INDEX IF NOT EXISTS idx_traces_project_id ON traces(project_id);
CREATE INDEX IF NOT EXISTS idx_traces_created_at ON traces(created_at);
CREATE INDEX IF NOT EXISTS idx_traces_session_id ON traces(session_id);
CREATE INDEX IF NOT EXISTS idx_traces_project_created ON traces(project_id, created_at);

-- Partial index for active (non-deleted) traces
CREATE INDEX IF NOT EXISTS idx_traces_active_project ON traces(project_id, created_at)
  WHERE deleted_at IS NULL;

-- ============================================================================
-- BLACKBOX REPORTS
-- ============================================================================
-- The forensic analysis output for a trace. One trace can have multiple
-- reports over time (re-runs, different detector versions).
-- ============================================================================

CREATE TABLE IF NOT EXISTS blackbox_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  trace_id UUID NOT NULL REFERENCES traces(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- High-level verdict
  failure_type TEXT,
  failure_summary TEXT,

  -- Waste estimates (honest: "known" flag + value + note)
  token_waste_known BOOLEAN NOT NULL DEFAULT FALSE,
  token_waste_value BIGINT,
  token_waste_note TEXT,

  cost_waste_known BOOLEAN NOT NULL DEFAULT FALSE,
  cost_waste_value NUMERIC(12, 6),
  cost_waste_note TEXT,

  -- Summary stats
  high_severity_count INTEGER NOT NULL DEFAULT 0,
  fix_first TEXT,                      -- Top recommended first action
  prevention_plan JSONB,               -- Array of strings (de-duplicated)

  -- Full findings as structured data for rendering + querying
  findings JSONB,                      -- Array of finding objects with evidenceLevel

  -- Full report snapshot (for exact reproduction / export)
  report_data JSONB,

  -- Optional report versioning / provenance
  report_version TEXT,
  generated_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE blackbox_reports IS 'Forensic Blackbox Reports produced from traces.';
COMMENT ON COLUMN blackbox_reports.findings IS 'Array of detector findings. Each should include evidenceLevel (Claimed/Observed/Correlated/Unprovable).';
COMMENT ON COLUMN blackbox_reports.report_data IS 'Complete serialized BlackboxReport for round-tripping and exports.';

CREATE INDEX IF NOT EXISTS idx_blackbox_reports_trace_id ON blackbox_reports(trace_id);
CREATE INDEX IF NOT EXISTS idx_blackbox_reports_project_id ON blackbox_reports(project_id);
CREATE INDEX IF NOT EXISTS idx_blackbox_reports_user_id ON blackbox_reports(user_id);
CREATE INDEX IF NOT EXISTS idx_blackbox_reports_created_at ON blackbox_reports(created_at);

-- ============================================================================
-- RULES (persistent improvement rules)
-- ============================================================================
-- Rules are durable, queryable recommendations derived from reports.
-- The key requirement is that rules can be easily fetched and applied
-- (or suggested) against future traces.
--
-- A rule captures:
--   - What problem it addresses (leak_type)
--   - How bad it is (severity)
--   - Concrete actions (fix_now, prompt_fix, policy_rule)
--   - What evidence is required to evaluate it
--   - Provenance back to the report(s) that created it
-- ============================================================================

CREATE TABLE IF NOT EXISTS rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Scope: rules live inside a project for Phase 1.
  -- A null project_id could later mean "organization template".
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,

  -- Core classification (used for fast lookup + application)
  leak_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high')),

  title TEXT NOT NULL,
  cause TEXT NOT NULL,
  fix_now TEXT NOT NULL,
  prompt_fix TEXT NOT NULL,
  policy_rule TEXT NOT NULL,

  -- Structured requirements and limitations (JSONB for arrays/objects)
  evidence_needed JSONB,
  limitations JSONB,

  -- Evidence strength of the source analysis
  evidence_level TEXT NOT NULL CHECK (evidence_level IN ('Claimed', 'Observed', 'Correlated', 'Unprovable')),

  -- Provenance: which report(s) originally motivated this rule
  source_report_ids UUID[],

  -- Lifecycle
  is_active BOOLEAN NOT NULL DEFAULT TRUE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

COMMENT ON TABLE rules IS 'Persistent improvement rules derived from Blackbox Reports. Designed for easy querying and application to future traces.';
COMMENT ON COLUMN rules.leak_type IS 'Classifier matching detector/finding types (e.g. repeated_context, retry_spiral). Primary lookup key.';
COMMENT ON COLUMN rules.evidence_level IS 'Strength of evidence from the originating report. Weak evidence should not become strong rules.';
COMMENT ON COLUMN rules.source_report_ids IS 'Array of blackbox_report IDs that contributed to creating this rule.';
COMMENT ON COLUMN rules.is_active IS 'Soft toggle for enabling/disabling a rule without deleting it.';

-- Fast queries for "active rules for this project of this leak type"
CREATE INDEX IF NOT EXISTS idx_rules_project_active_leak ON rules(project_id, leak_type)
  WHERE is_active = TRUE AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_rules_project_id ON rules(project_id);
CREATE INDEX IF NOT EXISTS idx_rules_leak_type ON rules(leak_type);
CREATE INDEX IF NOT EXISTS idx_rules_created_by ON rules(created_by);

-- ============================================================================
-- RULE APPLICATIONS
-- ============================================================================
-- Records when a rule was evaluated against (or recommended for) a trace.
-- This is the join table that makes "applied rules" queryable in both directions:
--   - Which rules have been suggested/applied to a given trace?
--   - On which traces has a given rule been applied?
-- ============================================================================

CREATE TABLE IF NOT EXISTS rule_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  rule_id UUID NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  trace_id UUID NOT NULL REFERENCES traces(id) ON DELETE CASCADE,

  -- The report that was current when the rule was applied (optional)
  report_id UUID REFERENCES blackbox_reports(id) ON DELETE SET NULL,

  -- Outcome of the application
  status TEXT NOT NULL DEFAULT 'suggested'
    CHECK (status IN ('suggested', 'applied', 'dismissed', 'auto_applied', 'ignored')),

  -- Optional free-text context (why it was dismissed, custom note, etc.)
  note TEXT,

  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE rule_applications IS 'Audit of rule evaluations / applications against traces. Enables history and effectiveness tracking.';
COMMENT ON COLUMN rule_applications.status IS 'suggested = shown to user; applied = user accepted; dismissed = user rejected; auto_applied = system applied.';

CREATE INDEX IF NOT EXISTS idx_rule_applications_rule_id ON rule_applications(rule_id);
CREATE INDEX IF NOT EXISTS idx_rule_applications_trace_id ON rule_applications(trace_id);
CREATE INDEX IF NOT EXISTS idx_rule_applications_report_id ON rule_applications(report_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rule_applications_rule_trace ON rule_applications(rule_id, trace_id);

-- ============================================================================
-- SECURITY SIGNALS (basic MTM / safety flags)
-- ============================================================================
-- Conservative, evidence-backed security or safety observations extracted
-- from a trace. Examples: secrets in output, unusual model switches (MTM),
-- excessive privilege, prompt injection risk signals, etc.
--
-- These are *observations*, not verdicts. evidence_level is required.
-- ============================================================================

CREATE TABLE IF NOT EXISTS security_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  trace_id UUID NOT NULL REFERENCES traces(id) ON DELETE CASCADE,
  report_id UUID REFERENCES blackbox_reports(id) ON DELETE SET NULL,

  -- Classification
  kind TEXT NOT NULL CHECK (kind IN (
    'secret_in_output',
    'prompt_injection_risk',
    'excessive_privilege',
    'policy_violation',
    'unusual_model_switch',     -- MTM-related
    'sensitive_data_access',
    'other'
  )),

  title TEXT NOT NULL,
  description TEXT NOT NULL,

  -- Evidence strength and operational severity
  evidence_level TEXT NOT NULL CHECK (evidence_level IN ('Claimed', 'Observed', 'Correlated', 'Unprovable')),
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high')),

  -- Where it was seen
  affected_steps JSONB,         -- Array of step numbers or identifiers
  evidence JSONB,               -- Redacted evidence snippets

  -- Actionable guidance
  recommended_action TEXT,

  -- Heuristic flag: true when the signal is known to be noisy
  heuristic BOOLEAN NOT NULL DEFAULT FALSE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE security_signals IS 'Security and safety observations derived from traces (conservative, evidence-based).';
COMMENT ON COLUMN security_signals.kind IS 'Category of signal. unusual_model_switch captures basic MTM handoff concerns.';
COMMENT ON COLUMN security_signals.heuristic IS 'True if generated by a heuristic that may produce false positives.';

CREATE INDEX IF NOT EXISTS idx_security_signals_trace_id ON security_signals(trace_id);
CREATE INDEX IF NOT EXISTS idx_security_signals_report_id ON security_signals(report_id);
CREATE INDEX IF NOT EXISTS idx_security_signals_kind ON security_signals(kind);
CREATE INDEX IF NOT EXISTS idx_security_signals_severity ON security_signals(severity);

-- ============================================================================
-- UPDATED_AT TRIGGER (optional helper)
-- ============================================================================
-- Keeps updated_at fresh when rows are modified.
-- Application code can also manage the column; this trigger is a convenience.
-- ============================================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Attach triggers to tables that have updated_at
DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_projects_updated_at ON projects;
CREATE TRIGGER trg_projects_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_traces_updated_at ON traces;
CREATE TRIGGER trg_traces_updated_at
  BEFORE UPDATE ON traces
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_blackbox_reports_updated_at ON blackbox_reports;
CREATE TRIGGER trg_blackbox_reports_updated_at
  BEFORE UPDATE ON blackbox_reports
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_rules_updated_at ON rules;
CREATE TRIGGER trg_rules_updated_at
  BEFORE UPDATE ON rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================================
-- Basic policies for authenticated users (owner-based) + service role full access.
-- These are intentionally conservative for Phase 1. Adjust as product needs evolve.
--
-- Important: The policies below assume that `users.id`, `projects.owner_id`,
-- `traces.user_id`, etc. contain values that match `auth.uid()` when the user
-- is the direct owner. Common patterns:
--   • Create the `users` row with `id = auth.uid()` on signup, or
--   • Join through `users` table in policies, or
--   • Use service_role for all writes (recommended for intake + analysis paths).
--
-- Service role policies are the primary path for server-side operations today.
-- ============================================================================

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE traces ENABLE ROW LEVEL SECURITY;
ALTER TABLE blackbox_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE rule_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_signals ENABLE ROW LEVEL SECURITY;

-- Service role: full access (used by server-side API routes)
DROP POLICY IF EXISTS "Service role full access on users" ON users;
CREATE POLICY "Service role full access on users" ON users
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on projects" ON projects;
CREATE POLICY "Service role full access on projects" ON projects
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on traces" ON traces;
CREATE POLICY "Service role full access on traces" ON traces
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on blackbox_reports" ON blackbox_reports;
CREATE POLICY "Service role full access on blackbox_reports" ON blackbox_reports
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on rules" ON rules;
CREATE POLICY "Service role full access on rules" ON rules
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on rule_applications" ON rule_applications;
CREATE POLICY "Service role full access on rule_applications" ON rule_applications
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on security_signals" ON security_signals;
CREATE POLICY "Service role full access on security_signals" ON security_signals
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Owner-based policies for authenticated users (example starting point).
-- These assume user_id / owner_id columns match auth.uid() after proper mapping.

-- Users can read and update their own user row
DROP POLICY IF EXISTS "Users can read own user row" ON users;
CREATE POLICY "Users can read own user row" ON users
  FOR SELECT TO authenticated USING (id = auth.uid() OR auth_user_id = auth.uid());

DROP POLICY IF EXISTS "Users can update own user row" ON users;
CREATE POLICY "Users can update own user row" ON users
  FOR UPDATE TO authenticated USING (id = auth.uid() OR auth_user_id = auth.uid())
  WITH CHECK (id = auth.uid() OR auth_user_id = auth.uid());

-- Projects: owner can do everything
DROP POLICY IF EXISTS "Users can read own projects" ON projects;
CREATE POLICY "Users can read own projects" ON projects
  FOR SELECT TO authenticated USING (owner_id = auth.uid());

DROP POLICY IF EXISTS "Users can insert own projects" ON projects;
CREATE POLICY "Users can insert own projects" ON projects
  FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid());

DROP POLICY IF EXISTS "Users can update own projects" ON projects;
CREATE POLICY "Users can update own projects" ON projects
  FOR UPDATE TO authenticated USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

DROP POLICY IF EXISTS "Users can delete own projects" ON projects;
CREATE POLICY "Users can delete own projects" ON projects
  FOR DELETE TO authenticated USING (owner_id = auth.uid());

-- Traces: user who owns the trace (via user_id) or project owner
DROP POLICY IF EXISTS "Users can read own traces" ON traces;
CREATE POLICY "Users can read own traces" ON traces
  FOR SELECT TO authenticated USING (
    user_id = auth.uid() OR
    project_id IN (SELECT id FROM projects WHERE owner_id = auth.uid())
  );

DROP POLICY IF EXISTS "Users can insert own traces" ON traces;
CREATE POLICY "Users can insert own traces" ON traces
  FOR INSERT TO authenticated WITH CHECK (
    user_id = auth.uid() AND
    project_id IN (SELECT id FROM projects WHERE owner_id = auth.uid())
  );

DROP POLICY IF EXISTS "Users can update own traces" ON traces;
CREATE POLICY "Users can update own traces" ON traces
  FOR UPDATE TO authenticated USING (
    user_id = auth.uid() OR
    project_id IN (SELECT id FROM projects WHERE owner_id = auth.uid())
  );

DROP POLICY IF EXISTS "Users can delete own traces" ON traces;
CREATE POLICY "Users can delete own traces" ON traces
  FOR DELETE TO authenticated USING (
    user_id = auth.uid() OR
    project_id IN (SELECT id FROM projects WHERE owner_id = auth.uid())
  );

-- Blackbox reports follow trace ownership
DROP POLICY IF EXISTS "Users can read own reports" ON blackbox_reports;
CREATE POLICY "Users can read own reports" ON blackbox_reports
  FOR SELECT TO authenticated USING (
    user_id = auth.uid() OR
    project_id IN (SELECT id FROM projects WHERE owner_id = auth.uid())
  );

DROP POLICY IF EXISTS "Users can insert own reports" ON blackbox_reports;
CREATE POLICY "Users can insert own reports" ON blackbox_reports
  FOR INSERT TO authenticated WITH CHECK (
    user_id = auth.uid() AND
    project_id IN (SELECT id FROM projects WHERE owner_id = auth.uid())
  );

-- Rules are readable by project members; writable by project owner
DROP POLICY IF EXISTS "Users can read project rules" ON rules;
CREATE POLICY "Users can read project rules" ON rules
  FOR SELECT TO authenticated USING (
    project_id IN (SELECT id FROM projects WHERE owner_id = auth.uid())
  );

DROP POLICY IF EXISTS "Users can manage project rules" ON rules;
CREATE POLICY "Users can manage project rules" ON rules
  FOR ALL TO authenticated USING (
    project_id IN (SELECT id FROM projects WHERE owner_id = auth.uid())
  ) WITH CHECK (
    project_id IN (SELECT id FROM projects WHERE owner_id = auth.uid())
  );

-- Rule applications and signals follow trace/report visibility
DROP POLICY IF EXISTS "Users can read own rule applications" ON rule_applications;
CREATE POLICY "Users can read own rule applications" ON rule_applications
  FOR SELECT TO authenticated USING (
    trace_id IN (
      SELECT id FROM traces WHERE user_id = auth.uid()
        OR project_id IN (SELECT id FROM projects WHERE owner_id = auth.uid())
    )
  );

DROP POLICY IF EXISTS "Users can read own security signals" ON security_signals;
CREATE POLICY "Users can read own security signals" ON security_signals
  FOR SELECT TO authenticated USING (
    trace_id IN (
      SELECT id FROM traces WHERE user_id = auth.uid()
        OR project_id IN (SELECT id FROM projects WHERE owner_id = auth.uid())
    )
  );

-- ============================================================================
-- END OF SCHEMA
-- ============================================================================
-- Recommended follow-up:
--   • Add a migration / backfill job if importing legacy data
--   • Consider a storage bucket + pointer for very large raw_payload values
--   • Add a materialized view or summary table if you need fast "rules hit rate" dashboards
-- ============================================================================

-- ============================================================================
-- INTEGRATION NOTES (for existing RunLeak schema)
-- ============================================================================
-- The existing schema already defines:
--   - profiles (UUID, with deleted_at)
--   - runs, run_steps, leak_findings, reports, etc.
--
-- When integrating this OathLock Phase 1 schema:
--
-- Option A (recommended for new OathLock work):
--   Use the new `users`, `projects`, `traces`, etc. tables.
--   On user creation, you may copy or reference profiles:
--     INSERT INTO users (id, email, name, auth_user_id, ...)
--     VALUES (profile_id, ..., auth.uid(), ...);
--
-- Option B (minimal change):
--   Rename references from "users" to "profiles" in this file before applying,
--   or create a view:
--     CREATE VIEW oathlock_users AS SELECT * FROM profiles;
--   Then change foreign keys to point at profiles.
--
-- Option C (dual-write):
--   Keep both. On profile creation, also ensure a matching users row exists
--   (via trigger or application code).
--
-- The new tables are intentionally namespaced by their clear domain names
-- (traces, blackbox_reports, rules, etc.) to avoid clashing with legacy tables.
-- ============================================================================
