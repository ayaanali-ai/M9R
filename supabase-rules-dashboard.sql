-- ============================================================================
-- OathLock — Rules Dashboard support
-- ============================================================================
-- Idempotent follow-up to supabase-oathlock-phase1.sql.
--
-- The application code (rule-engine.ts: createRuleFromFinding / applyRuleToTrace)
-- already reads and writes rules.times_applied, but the Phase 1 schema never
-- declared the column. This migration adds it so the Rules Dashboard can show
-- "times applied" and the apply path can increment it.
--
-- Safe to run multiple times. Run in the Supabase SQL editor.
-- ============================================================================

ALTER TABLE rules
  ADD COLUMN IF NOT EXISTS times_applied INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN rules.times_applied IS
  'How many times this rule has been applied to a trace. Maintained by applyRuleToTrace().';

-- Fast "active rules, most recently used first" listing for the dashboard.
CREATE INDEX IF NOT EXISTS idx_rules_active_created
  ON rules(is_active, created_at DESC)
  WHERE deleted_at IS NULL;
