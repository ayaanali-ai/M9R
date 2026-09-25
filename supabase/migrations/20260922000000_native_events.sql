-- Agent-native event mirror. Payloads are metadata only; never prompts or outputs.
create table if not exists public.native_devices (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.projects(id) on delete cascade,
  connection_id uuid not null references public.agent_connections(id) on delete cascade,
  device_id uuid not null,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_seen_at timestamptz,
  unique (connection_id, device_id)
);
alter table public.native_devices enable row level security;

create table if not exists public.native_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.projects(id) on delete cascade,
  connection_id uuid not null references public.agent_connections(id) on delete cascade,
  device_id uuid not null,
  event_id uuid not null,
  seq bigint not null check (seq >= 0),
  kind text not null check (kind in ('agent_connected', 'task_created', 'task_delivered', 'task_approved', 'task_result')),
  task_id text check (length(task_id) <= 64),
  handle text check (length(handle) <= 80),
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  unique (device_id, event_id)
);
create index if not exists native_events_workspace_received_idx on public.native_events (workspace_id, received_at desc);
alter table public.native_events enable row level security;
-- No policies: only the service role reads/writes. Dashboard reads through a session-scoped route.
