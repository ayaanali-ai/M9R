-- Phase 1: bounded, redacted provider runtime-event journal.
-- Raw provider output is intentionally not retained here. The provider
-- adapters and runtime event normalizer are responsible for redaction and
-- bounded payload construction before this table is written.

create table if not exists public.mission_runtime_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  mission_id text not null references public.missions(id) on delete cascade,
  execution_id text not null,
  participant_id text,
  assignment_id text,
  event_id text not null,
  event_type text not null,
  adapter_id text not null,
  provider_session_ref text,
  correlation_id text not null,
  causation_id text,
  occurred_at timestamptz not null,
  raw_event_ref text,
  redaction_status text not null check (redaction_status = 'redacted'),
  summary text not null check (octet_length(summary) <= 2048),
  payload jsonb not null check (
    jsonb_typeof(payload) = 'object'
    and octet_length(payload::text) <= 8192
  ),
  activity jsonb check (
    activity is null
    or (jsonb_typeof(activity) = 'object' and octet_length(activity::text) <= 8192)
  ),
  created_at timestamptz not null default now(),
  unique (workspace_id, event_id)
);

create index if not exists mission_runtime_events_mission_time_idx
  on public.mission_runtime_events (workspace_id, mission_id, occurred_at, id);

create index if not exists mission_runtime_events_execution_time_idx
  on public.mission_runtime_events (workspace_id, execution_id, occurred_at, id);

create index if not exists mission_runtime_events_activity_time_idx
  on public.mission_runtime_events (workspace_id, mission_id, occurred_at desc, id)
  where activity is not null;

alter table public.mission_runtime_events enable row level security;
revoke all on public.mission_runtime_events from anon, authenticated;
grant select, insert, update on public.mission_runtime_events to service_role;
