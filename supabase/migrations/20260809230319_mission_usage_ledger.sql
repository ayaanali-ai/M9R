-- Phase 3: provider-reported usage ledger.
-- This is event-level telemetry, not a provider quota or billing authority.
-- One row is kept per normalized usage event so cumulative snapshots can be
-- deduplicated by turn in application code without double-counting retries.

alter table public.mission_runtime_events
  add column if not exists turn_id text;

create index if not exists mission_runtime_events_turn_idx
  on public.mission_runtime_events (workspace_id, turn_id, occurred_at, id)
  where turn_id is not null;

create table if not exists public.mission_usage_ledger (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  mission_id text not null references public.missions(id) on delete cascade,
  execution_id text not null,
  turn_id text,
  participant_id text,
  assignment_id text,
  provider text not null,
  provider_session_ref text,
  event_id text not null,
  occurred_at timestamptz not null,
  input_tokens bigint,
  output_tokens bigint,
  total_tokens bigint,
  cost_usd numeric(20, 8),
  context_used_tokens bigint,
  context_window_tokens bigint,
  usage_basis text,
  created_at timestamptz not null default now(),
  check (input_tokens is null or input_tokens >= 0),
  check (output_tokens is null or output_tokens >= 0),
  check (total_tokens is null or total_tokens >= 0),
  check (cost_usd is null or cost_usd >= 0),
  check (context_used_tokens is null or context_used_tokens >= 0),
  check (context_window_tokens is null or context_window_tokens >= 0),
  unique (workspace_id, event_id)
);

create index if not exists mission_usage_ledger_window_idx
  on public.mission_usage_ledger (workspace_id, occurred_at desc, id);

create index if not exists mission_usage_ledger_turn_idx
  on public.mission_usage_ledger (workspace_id, turn_id, occurred_at desc, id);

alter table public.mission_usage_ledger enable row level security;
revoke all on public.mission_usage_ledger from anon, authenticated;
grant select, insert, update on public.mission_usage_ledger to service_role;
