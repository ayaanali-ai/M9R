-- Phase 1: replay-safe workspace delivery and post acknowledgement recovery.
-- Cursors are scoped to a bridge instance so two provider bridges can advance
-- independently while sharing one channel.

alter table public.conversation_messages
  add column if not exists idempotency_key text;

alter table public.conversation_messages
  drop constraint if exists conversation_messages_idempotency_key_check;

alter table public.conversation_messages
  add constraint conversation_messages_idempotency_key_check
  check (idempotency_key is null or char_length(idempotency_key) between 1 and 256);

create unique index if not exists conversation_messages_workspace_idempotency_idx
  on public.conversation_messages (workspace_id, idempotency_key)
  where idempotency_key is not null;

create table if not exists public.workspace_bridge_cursors (
  workspace_id uuid not null references public.projects(id) on delete cascade,
  bridge_instance_id text not null references public.bridge_instances(id) on delete cascade,
  conversation_id uuid not null references public.agent_conversations(id) on delete cascade,
  cursor_created_at timestamptz not null,
  cursor_message_id uuid not null,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, bridge_instance_id, conversation_id),
  constraint workspace_bridge_cursors_conversation_workspace_fk
    foreign key (conversation_id, workspace_id)
    references public.agent_conversations(id, workspace_id) on delete cascade,
  constraint workspace_bridge_cursors_message_workspace_fk
    foreign key (cursor_message_id, workspace_id)
    references public.conversation_messages(id, workspace_id) on delete cascade
);

create index if not exists workspace_bridge_cursors_updated_idx
  on public.workspace_bridge_cursors (workspace_id, bridge_instance_id, updated_at desc);

alter table public.workspace_bridge_cursors enable row level security;
revoke all on public.workspace_bridge_cursors from anon, authenticated;
grant select, insert, update on public.workspace_bridge_cursors to service_role;
