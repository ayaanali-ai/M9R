-- Rules already carry a claim (body), a why (evidence_summary), and a loose
-- "what this helps with" (expected_prevention) -- but never a scope: under
-- what condition does this rule actually apply? That condition currently
-- lives nowhere structured; it gets folded into body's free text, so an
-- agent (and a human skimming Memory) can't tell "always do X" from "do X
-- only when Y" without re-reading the whole rule body carefully.
--
-- Findings already have this field (applicable_environment) and it is
-- silently dropped the moment a Finding is promoted into a rule (see
-- createRuleFromFinding in workspace-rules-service.ts) -- a real, structured
-- fact the human already reviewed and approved, thrown away at promotion.
-- This column carries it through instead of losing it.
alter table public.workspace_rules
  add column if not exists scope_condition text;
