-- IDE extension foundation: a personal API token a human can hand to their
-- editor (VS Code/Cursor today, JetBrains later), and a presence table that
-- token writes to. Distinct from agent_connections on purpose -- this is a
-- human's own editor reporting "I am looking at this file," not a connected
-- AI agent, and it must never be able to do anything an agent connection can
-- (no run start, no tool calls, no chat send). Scope is intentionally just
-- read/write of one's own presence row.

create table if not exists public.user_api_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null default 'IDE token',
  -- Only the SHA-256 hash is ever stored -- the raw token is shown once at
  -- creation and cannot be recovered, same posture as every other
  -- bearer-token system in this codebase (agent connection tokens).
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create index if not exists user_api_tokens_user_idx on public.user_api_tokens (user_id);

alter table public.user_api_tokens enable row level security;

grant select, insert, delete on public.user_api_tokens to authenticated;
grant select, insert, update, delete on public.user_api_tokens to service_role;

drop policy if exists "users manage own api tokens" on public.user_api_tokens;
create policy "users manage own api tokens" on public.user_api_tokens for all to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

-- One live row per human per workspace -- "current file + line," not a
-- history log (workspace_file_activity already owns agent history; this is
-- the human-editor counterpart, heartbeat-refreshed every few seconds and
-- read as stale/absent once the heartbeat stops, same posture as
-- agent_connections.last_seen_at).
create table if not exists public.workspace_presence (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  file_path text not null,
  line_number integer,
  editor_label text,
  updated_at timestamptz not null default now(),
  unique (workspace_id, user_id)
);

create index if not exists workspace_presence_workspace_idx on public.workspace_presence (workspace_id);

alter table public.workspace_presence enable row level security;

grant select on public.workspace_presence to authenticated;
grant select, insert, update, delete on public.workspace_presence to service_role;

drop policy if exists "members read workspace presence" on public.workspace_presence;
create policy "members read workspace presence" on public.workspace_presence for select to authenticated
using (exists (select 1 from public.projects p where p.id = workspace_presence.workspace_id and p.owner_id = (select auth.uid()))
  or public.is_workspace_member(workspace_presence.workspace_id, (select auth.uid())));
