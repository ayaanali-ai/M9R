-- Workspace chat actions: threads, reactions, mentions, read state,
-- notifications, and durable channel metadata. These are workspace primitives;
-- Missions may link to a channel, but never gate its existence.

alter table public.agent_conversations
  add column if not exists description text,
  add column if not exists is_private boolean not null default false,
  add column if not exists archived_at timestamptz;

alter table public.conversation_messages
  add column if not exists parent_message_id uuid references public.conversation_messages(id) on delete cascade,
  add column if not exists edited_at timestamptz,
  add column if not exists deleted_at timestamptz;

alter table public.conversation_messages
  add constraint conversation_messages_id_workspace_unique unique (id, workspace_id);

create index if not exists conversation_messages_parent_idx
  on public.conversation_messages (conversation_id, parent_message_id, created_at);

create table if not exists public.conversation_message_reactions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.projects(id) on delete cascade,
  conversation_id uuid not null references public.agent_conversations(id) on delete cascade,
  message_id uuid not null references public.conversation_messages(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete cascade,
  actor_connection_id uuid references public.agent_connections(id) on delete cascade,
  emoji text not null check (char_length(emoji) between 1 and 16),
  created_at timestamptz not null default now(),
  constraint conversation_reaction_actor_check check (actor_user_id is not null or actor_connection_id is not null),
  constraint conversation_reaction_workspace_message_fk foreign key (message_id, workspace_id)
    references public.conversation_messages(id, workspace_id) on delete cascade
);

create unique index if not exists conversation_reactions_user_unique_idx
  on public.conversation_message_reactions (message_id, actor_user_id, emoji)
  where actor_user_id is not null;
create unique index if not exists conversation_reactions_connection_unique_idx
  on public.conversation_message_reactions (message_id, actor_connection_id, emoji)
  where actor_connection_id is not null;
create index if not exists conversation_reactions_message_idx
  on public.conversation_message_reactions (message_id, created_at);

create table if not exists public.conversation_message_mentions (
  message_id uuid not null references public.conversation_messages(id) on delete cascade,
  workspace_id uuid not null references public.projects(id) on delete cascade,
  mentioned_connection_id uuid references public.agent_connections(id) on delete cascade,
  mentioned_user_id uuid references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint conversation_mention_target_check check (mentioned_connection_id is not null or mentioned_user_id is not null),
  constraint conversation_mention_workspace_message_fk foreign key (message_id, workspace_id)
    references public.conversation_messages(id, workspace_id) on delete cascade
);

create index if not exists conversation_mentions_connection_idx
  on public.conversation_message_mentions (workspace_id, mentioned_connection_id, created_at desc);
create index if not exists conversation_mentions_user_idx
  on public.conversation_message_mentions (workspace_id, mentioned_user_id, created_at desc);

create table if not exists public.conversation_read_markers (
  workspace_id uuid not null references public.projects(id) on delete cascade,
  conversation_id uuid not null references public.agent_conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  last_read_message_id uuid references public.conversation_messages(id) on delete set null,
  read_at timestamptz not null default now(),
  primary key (conversation_id, user_id),
  constraint conversation_read_marker_workspace_fk foreign key (conversation_id, workspace_id)
    references public.agent_conversations(id, workspace_id) on delete cascade
);

create table if not exists public.workspace_notifications (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.projects(id) on delete cascade,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid references public.agent_conversations(id) on delete cascade,
  message_id uuid references public.conversation_messages(id) on delete cascade,
  kind text not null check (kind in ('mention', 'reply', 'reaction', 'agent_activity', 'channel_invite')),
  title text not null check (char_length(title) between 1 and 256),
  body text not null check (char_length(body) between 1 and 2048),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  read_at timestamptz,
  unique (recipient_user_id, message_id, kind)
);

create index if not exists workspace_notifications_inbox_idx
  on public.workspace_notifications (workspace_id, recipient_user_id, read_at, created_at desc);

create index if not exists agent_conversations_workspace_open_idx
  on public.agent_conversations (workspace_id, status, archived_at, updated_at desc);

alter table public.conversation_message_reactions enable row level security;
alter table public.conversation_message_mentions enable row level security;
alter table public.conversation_read_markers enable row level security;
alter table public.workspace_notifications enable row level security;

grant select on public.conversation_message_reactions, public.conversation_message_mentions,
  public.conversation_read_markers, public.workspace_notifications to authenticated;
grant select, insert, update, delete on public.conversation_message_reactions,
  public.conversation_message_mentions, public.conversation_read_markers,
  public.workspace_notifications to service_role;

drop policy if exists "owners read conversation reactions" on public.conversation_message_reactions;
create policy "owners read conversation reactions" on public.conversation_message_reactions for select to authenticated
using (exists (select 1 from public.projects p where p.id = workspace_id and p.owner_id = (select auth.uid())));

drop policy if exists "owners read conversation mentions" on public.conversation_message_mentions;
create policy "owners read conversation mentions" on public.conversation_message_mentions for select to authenticated
using (exists (select 1 from public.projects p where p.id = workspace_id and p.owner_id = (select auth.uid())));

drop policy if exists "owners manage conversation read markers" on public.conversation_read_markers;
create policy "owners manage conversation read markers" on public.conversation_read_markers for all to authenticated
using (user_id = (select auth.uid()) and exists (select 1 from public.projects p where p.id = workspace_id and p.owner_id = (select auth.uid())))
with check (user_id = (select auth.uid()) and exists (select 1 from public.projects p where p.id = workspace_id and p.owner_id = (select auth.uid())));

drop policy if exists "owners read workspace notifications" on public.workspace_notifications;
create policy "owners read workspace notifications" on public.workspace_notifications for select to authenticated
using (recipient_user_id = (select auth.uid()) and exists (select 1 from public.projects p where p.id = workspace_id and p.owner_id = (select auth.uid())));
