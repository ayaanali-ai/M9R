-- Human channel membership: "which humans can join" a channel, the
-- counterpart to conversation_participants (agent membership) which already
-- exists. Without this, every workspace member could see every channel
-- including ones marked private, since privacy only ever gated agents.
--
-- Grandfather rule: a private channel with zero rows here (created before
-- this migration, or created without an explicit human list) is treated as
-- visible to every workspace member -- app code enforces this, not RLS,
-- since "no rows yet" and "deliberately empty" are indistinguishable at the
-- database level. Once a channel has at least one row, only those users see it.
create table if not exists public.conversation_human_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.projects(id) on delete cascade,
  conversation_id uuid not null references public.agent_conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  unique (conversation_id, user_id)
);

create index if not exists conversation_human_members_conversation_idx on public.conversation_human_members (conversation_id);
create index if not exists conversation_human_members_user_idx on public.conversation_human_members (user_id);

alter table public.conversation_human_members enable row level security;

grant select on public.conversation_human_members to authenticated;
grant select, insert, update, delete on public.conversation_human_members to service_role;

drop policy if exists "members read conversation human members" on public.conversation_human_members;
create policy "members read conversation human members" on public.conversation_human_members for select to authenticated
using (exists (select 1 from public.projects p where p.id = conversation_human_members.workspace_id and p.owner_id = (select auth.uid()))
  or public.is_workspace_member(conversation_human_members.workspace_id, (select auth.uid())));
