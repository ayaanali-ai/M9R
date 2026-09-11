-- Phase 2: Mission Relay identity, persistent sessions, and recipient delivery.
-- Relay presence remains ephemeral; authoritative messages remain Mission events.

create table if not exists public.bridge_instances (
  id text primary key,
  workspace_id text not null,
  owner_id text not null,
  repository_id text,
  protocol_version text not null,
  software_version text,
  supported_providers jsonb not null default '[]'::jsonb check (jsonb_typeof(supported_providers) = 'array' and octet_length(supported_providers::text) <= 8192),
  last_heartbeat_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bridge_instances_workspace_idx on public.bridge_instances (workspace_id, last_heartbeat_at desc);

create table if not exists public.mission_agent_sessions (
  id text primary key,
  workspace_id text not null,
  mission_id text not null references public.missions(id) on delete cascade,
  participant_id text not null,
  bridge_instance_id text references public.bridge_instances(id) on delete set null,
  provider_adapter_id text not null,
  provider_session_ref text,
  state text not null check (state in ('registered','launching','initializing','ready','working','waiting','blocked','interrupted','resuming','closed')),
  capabilities jsonb not null default '{}'::jsonb check (jsonb_typeof(capabilities) = 'object' and octet_length(capabilities::text) <= 8192),
  last_event_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (mission_id, participant_id)
);

create index if not exists mission_agent_sessions_workspace_state_idx on public.mission_agent_sessions (workspace_id, state, updated_at desc);
create index if not exists mission_agent_sessions_mission_idx on public.mission_agent_sessions (workspace_id, mission_id, updated_at desc);

create table if not exists public.mission_message_deliveries (
  id text primary key,
  workspace_id text not null,
  mission_id text not null references public.missions(id) on delete cascade,
  message_id text not null,
  recipient_participant_id text not null,
  bridge_instance_id text references public.bridge_instances(id) on delete set null,
  agent_session_id text references public.mission_agent_sessions(id) on delete set null,
  status text not null check (status in ('queued','dispatched','delivered','acknowledged','failed','expired')),
  attempt_count integer not null default 0 check (attempt_count >= 0 and attempt_count <= 100),
  next_attempt_at timestamptz,
  last_attempt_at timestamptz,
  delivered_at timestamptz,
  acknowledged_at timestamptz,
  failure_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (message_id, recipient_participant_id)
);

create index if not exists mission_message_deliveries_queue_idx on public.mission_message_deliveries (workspace_id, status, next_attempt_at, created_at);
create index if not exists mission_message_deliveries_mission_idx on public.mission_message_deliveries (workspace_id, mission_id, created_at desc);

alter table public.bridge_instances enable row level security;
alter table public.mission_agent_sessions enable row level security;
alter table public.mission_message_deliveries enable row level security;
revoke all on public.bridge_instances from anon, authenticated;
revoke all on public.mission_agent_sessions from anon, authenticated;
revoke all on public.mission_message_deliveries from anon, authenticated;
grant select, insert, update on public.bridge_instances to service_role;
grant select, insert, update on public.mission_agent_sessions to service_role;
grant select, insert, update on public.mission_message_deliveries to service_role;
