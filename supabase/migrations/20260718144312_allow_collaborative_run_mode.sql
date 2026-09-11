-- Expand the existing bounded run-mode contract without changing historical
-- rows or weakening the default. This constraint is idempotently replaced so
-- production databases created from the earlier Gate 8 migration can accept
-- the human-selected collaborative mode.
ALTER TABLE public.agent_runs
  DROP CONSTRAINT IF EXISTS agent_runs_run_mode_check;

ALTER TABLE public.agent_runs
  ADD CONSTRAINT agent_runs_run_mode_check
  CHECK (run_mode IN ('solo', 'coordinated', 'assurance', 'collaborative'));
