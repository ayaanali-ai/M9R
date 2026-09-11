-- Buzz-parity moderation primitives (closes GAP #4 from the OathLock-vs-
-- Buzz crate audit: crates/buzz-db has dedicated `moderation`/
-- `admin_moderation` modules; OathLock had zero report/mute/ban equivalent
-- anywhere in src/lib).
--
-- Scoped to what a WORKSPACE OWNER does inside their own workspace — not a
-- site-wide superadmin action (that's the separate ADMIN_PASSWORD-gated
-- /api/admin/* surface, a different concern). A target is either a human
-- (target_kind='user', target_id=auth.users.id) or an agent connection
-- (target_kind='connection', target_id=agent_connections.id), matching the
-- two sender identities conversation_messages already supports
-- (sender_user_id / sender_connection_id).

create table if not exists public.workspace_bans (
  workspace_id uuid not null references public.projects(id) on delete cascade,
  target_kind text not null check (target_kind in ('user', 'connection')),
  target_id text not null,
  reason text,
  banned_by uuid references auth.users(id) on delete set null,
  banned_at timestamptz not null default now(),
  primary key (workspace_id, target_kind, target_id)
);

create table if not exists public.workspace_mutes (
  workspace_id uuid not null references public.projects(id) on delete cascade,
  target_kind text not null check (target_kind in ('user', 'connection')),
  target_id text not null,
  -- null conversation_id = muted workspace-wide, not just in one channel.
  conversation_id uuid references public.agent_conversations(id) on delete cascade,
  reason text,
  muted_by uuid references auth.users(id) on delete set null,
  muted_at timestamptz not null default now(),
  primary key (workspace_id, target_kind, target_id, conversation_id)
);

create table if not exists public.workspace_message_reports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.projects(id) on delete cascade,
  conversation_id uuid not null references public.agent_conversations(id) on delete cascade,
  message_id uuid not null references public.conversation_messages(id) on delete cascade,
  reporter_user_id uuid not null references auth.users(id) on delete cascade,
  reason text not null check (char_length(reason) between 1 and 2000),
  status text not null default 'open' check (status in ('open', 'reviewed', 'dismissed')),
  created_at timestamptz not null default now()
);

create index if not exists workspace_message_reports_workspace_status_idx
  on public.workspace_message_reports (workspace_id, status, created_at desc);
