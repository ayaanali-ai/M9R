-- The other real blocker found live tonight: an ACP session's requestPermission
-- call (acp-stdio-adapter.ts) genuinely waits for a human decision, but
-- nothing in the app ever surfaced that request to a human or fed a decision
-- back -- respondToPermission existed on the adapter with zero callers
-- anywhere. Any real task an agent does (running a command, reading a file
-- outside the bounded dev-mcp tools) hits this and silently stalls for its
-- full 15-minute timeout.
--
-- Deliberately its own table, not routed through mission_runtime_events:
-- that table is fed over the WebSocket relay (mission-relay-client.ts),
-- which had a real connectivity hiccup earlier tonight -- this needs to be
-- reliable over plain HTTP, the same polling discipline
-- scanWorkspaceMessages already uses for messages.

create table if not exists public.bridge_permission_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  mission_id text not null,
  execution_id text not null,
  request_id text not null,
  summary text not null check (octet_length(summary) <= 2048),
  command text,
  file_path text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied', 'consumed')),
  decided_by_user_id uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (execution_id, request_id)
);

create index if not exists bridge_permission_requests_pending_idx
  on public.bridge_permission_requests (workspace_id, status);

create index if not exists bridge_permission_requests_execution_idx
  on public.bridge_permission_requests (execution_id, status);

alter table public.bridge_permission_requests enable row level security;
revoke all on public.bridge_permission_requests from anon, authenticated;
grant select, insert, update on public.bridge_permission_requests to service_role;
