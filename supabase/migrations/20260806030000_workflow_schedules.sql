-- Workflow automation, schedule trigger: mission-workflow-schema.ts already
-- parses and validates a `schedule` trigger (cron or interval), but nothing
-- fires it yet -- EXECUTABLE_TRIGGERS deliberately excludes it, documented
-- as a known, honest gap. This adds the two columns a periodic sweep
-- (workflow-scheduler-service.ts, run by /api/internal/workflow-scheduler on
-- a Vercel Cron, same pattern as stale-run-sweep) needs to know which
-- schedule-triggered workflows are due: next_run_at is null until the first
-- sweep sees the workflow (lazy-initialized, not backfilled here with a
-- guess), then advances by the trigger's own interval after every run.

alter table public.channel_workflows
  add column if not exists next_run_at timestamptz,
  add column if not exists last_run_at timestamptz;

create index if not exists channel_workflows_due_schedule_idx
  on public.channel_workflows (next_run_at)
  where enabled = true;
