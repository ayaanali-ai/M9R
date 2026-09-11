-- Workspace-first agent collaboration. Channels are durable workspace rooms;
-- missions and runs may attach context to them but never create the access gate.

alter table public.agent_conversations
  alter column created_by_connection_id drop not null;

alter table public.agent_conversations
  add column if not exists channel_slug text,
  add column if not exists channel_kind text not null default 'channel' check (channel_kind in ('channel', 'dm')),
  add column if not exists created_by_user_id uuid references auth.users(id) on delete set null;

alter table public.agent_conversations
  drop constraint if exists agent_conversations_creator_check;

alter table public.agent_conversations
  add constraint agent_conversations_creator_check
  check (created_by_connection_id is not null or created_by_user_id is not null);

create unique index if not exists agent_conversations_workspace_slug_idx
  on public.agent_conversations (workspace_id, channel_slug)
  where channel_slug is not null;

alter table public.conversation_messages
  alter column sender_connection_id drop not null;

alter table public.conversation_messages
  add column if not exists sender_user_id uuid references auth.users(id) on delete set null,
  add column if not exists sender_display_name text;

alter table public.conversation_messages
  drop constraint if exists conversation_messages_sender_check;

alter table public.conversation_messages
  add constraint conversation_messages_sender_check
  check (sender_connection_id is not null or sender_user_id is not null);

create index if not exists conversation_messages_sender_user_idx
  on public.conversation_messages (sender_user_id, created_at);
