-- Real file locking (item 4): stop two agents silently overwriting each
-- other's edits to the same file.
--
-- One active lock per (workspace, path), enforced by a partial unique index
-- rather than application-level check-then-insert -- two residents racing on
-- the same file is exactly the case this feature exists for, so the DB has to
-- be the arbiter, not app code (same lesson as conversation_sessions_open_unique).
create table if not exists file_locks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references projects(id) on delete cascade,
  -- Workspace-relative path, matching workspace_file_activity's convention.
  path text not null,
  holder_connection_id uuid not null references agent_connections(id) on delete cascade,
  -- The conversation whose turn took this lock, so the conflict message can
  -- point a human at where the work is actually happening.
  conversation_id uuid references agent_conversations(id) on delete set null,
  held_since timestamptz not null default now(),
  -- Safety net for a resident that crashes without ever reporting a terminal
  -- turn stage. A lock is never permanent: worst case it expires.
  expires_at timestamptz not null,
  released_at timestamptz,
  released_reason text
);

create unique index if not exists file_locks_active_unique
  on file_locks (workspace_id, path)
  where released_at is null;

create index if not exists file_locks_holder_idx on file_locks (holder_connection_id) where released_at is null;

alter table file_locks enable row level security;
-- Service-role only, matching workspace_file_activity and agent_file_permissions:
-- every read/write is mediated by bearer-authenticated bridge routes or
-- cookie-scoped dashboard routes, never a direct client query.
revoke all on file_locks from anon, authenticated;
