-- Item #30a Phase 1: Codex app-server multiplayer. This is the registry
-- table only -- no event log. Events are ephemeral relay fan-out
-- (codex.event frames); durable history already lives in
-- conversation_sessions + workspace_turn_timing_events, same as every other
-- provider. This table exists so a second client attaching to a live
-- thread (thread/resume) and the eventual multiplayer phases have a real
-- row to look up ownership/sharing state against, the same role
-- conversation_sessions plays for chat turns and file_locks plays for
-- writes.
create table if not exists codex_threads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references projects(id) on delete cascade,
  conversation_id uuid not null references agent_conversations(id) on delete cascade,
  connection_id uuid not null references agent_connections(id) on delete cascade,
  owner_user_id uuid references auth.users(id) on delete set null,
  -- The app-server's own thread id (its `thread/start` response) -- this,
  -- not this row's own id, is what a resident passes to `thread/resume`.
  codex_thread_id text not null,
  title text,
  status text not null default 'running' check (status in ('running', 'idle', 'closed')),
  -- Owner-controlled Sharing toggle, default on -- same semantics as the
  -- terminal's pty_sessions.shared (mission-relay-service.ts).
  shared boolean not null default true,
  cwd text not null,
  -- Captured from `initialize`'s response so a room with mixed CLI
  -- versions can degrade rendering per-thread rather than per-app (named
  -- risk #2 in the spec).
  codex_cli_version text,
  created_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now()
);

create unique index if not exists codex_threads_thread_unique on codex_threads (connection_id, codex_thread_id);
create index if not exists codex_threads_conversation_idx on codex_threads (conversation_id) where status <> 'closed';

alter table codex_threads enable row level security;
-- Service-role only, same posture as file_locks/pty state: every read/write
-- is mediated by bearer-authenticated bridge routes, never a direct client
-- query.
revoke all on codex_threads from anon, authenticated;
