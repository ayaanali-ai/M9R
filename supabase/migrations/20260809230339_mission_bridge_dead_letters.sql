-- Durable, bounded diagnostics for workspace prompts rejected by a provider
-- session queue. Message bodies are intentionally excluded: this table is for
-- operational recovery, not a second copy of user task content.
create table if not exists public.mission_bridge_dead_letters (
  id text primary key,
  workspace_id text not null,
  bridge_instance_id text not null,
  session_id text not null,
  conversation_id text not null,
  message_id text not null,
  topic text not null check (char_length(topic) between 1 and 512),
  reason text not null check (reason in ('queue_overflow')),
  detail text not null check (char_length(detail) between 1 and 1000),
  queued_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists mission_bridge_dead_letters_workspace_created_idx
  on public.mission_bridge_dead_letters (workspace_id, created_at desc);
create index if not exists mission_bridge_dead_letters_session_created_idx
  on public.mission_bridge_dead_letters (session_id, created_at desc);

alter table public.mission_bridge_dead_letters enable row level security;
revoke all on public.mission_bridge_dead_letters from public, anon, authenticated;
grant select, insert, update on public.mission_bridge_dead_letters to service_role;
