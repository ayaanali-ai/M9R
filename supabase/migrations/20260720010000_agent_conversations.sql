-- OathLock V2 Gate 14: real multi-turn, multi-party agent conversations.
--
-- Existing coordination (dispatches/responses) is strictly one-shot:
-- one bounded request, one final result. This adds a genuine back-and-forth
-- channel between two or more connected agents in the same workspace --
-- handoffs, acknowledgments, and free-text messages, in order, visible live
-- on the Watchfloor and readable by each agent's own Inbox check (the same
-- checkpoint every connected agent already performs for human instructions).

create table if not exists public.agent_conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.projects(id) on delete cascade,
  topic text not null check (char_length(topic) between 1 and 200),
  created_by_connection_id uuid not null references public.agent_connections(id) on delete cascade,
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  constraint agent_conversations_creator_workspace_fk foreign key (created_by_connection_id, workspace_id)
    references public.agent_connections(id, workspace_id) on delete cascade
);

create table if not exists public.conversation_participants (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.projects(id) on delete cascade,
  conversation_id uuid not null references public.agent_conversations(id) on delete cascade,
  connection_id uuid not null references public.agent_connections(id) on delete cascade,
  joined_at timestamptz not null default now(),
  unique (conversation_id, connection_id),
  constraint conversation_participants_conversation_workspace_fk foreign key (conversation_id, workspace_id)
    references public.agent_conversations(id, workspace_id) on delete cascade,
  constraint conversation_participants_connection_workspace_fk foreign key (connection_id, workspace_id)
    references public.agent_connections(id, workspace_id) on delete cascade
);

create table if not exists public.conversation_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.projects(id) on delete cascade,
  conversation_id uuid not null references public.agent_conversations(id) on delete cascade,
  sender_connection_id uuid not null references public.agent_connections(id) on delete cascade,
  -- null recipient = broadcast to every current participant, not just one.
  recipient_connection_id uuid references public.agent_connections(id) on delete cascade,
  kind text not null check (kind in ('message', 'handoff', 'ack', 'result')),
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now(),
  constraint conversation_messages_conversation_workspace_fk foreign key (conversation_id, workspace_id)
    references public.agent_conversations(id, workspace_id) on delete cascade,
  constraint conversation_messages_sender_workspace_fk foreign key (sender_connection_id, workspace_id)
    references public.agent_connections(id, workspace_id) on delete cascade,
  constraint conversation_messages_recipient_workspace_fk foreign key (recipient_connection_id, workspace_id)
    references public.agent_connections(id, workspace_id) on delete cascade
);

create index if not exists conversation_messages_conversation_created_idx
  on public.conversation_messages (conversation_id, created_at);

alter table public.agent_conversations enable row level security;
alter table public.conversation_participants enable row level security;
alter table public.conversation_messages enable row level security;

grant select on public.agent_conversations, public.conversation_participants, public.conversation_messages to authenticated;
grant select, insert, update, delete on public.agent_conversations, public.conversation_participants, public.conversation_messages to service_role;

drop policy if exists "owners read conversations" on public.agent_conversations;
create policy "owners read conversations" on public.agent_conversations for select to authenticated
using (exists (select 1 from public.projects p where p.id = workspace_id and p.owner_id = (select auth.uid())));

drop policy if exists "owners read conversation participants" on public.conversation_participants;
create policy "owners read conversation participants" on public.conversation_participants for select to authenticated
using (exists (select 1 from public.projects p where p.id = workspace_id and p.owner_id = (select auth.uid())));

drop policy if exists "owners read conversation messages" on public.conversation_messages;
create policy "owners read conversation messages" on public.conversation_messages for select to authenticated
using (exists (select 1 from public.projects p where p.id = workspace_id and p.owner_id = (select auth.uid())));
