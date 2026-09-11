-- Workspace identity: the ICM/Grok-Bot-style durable "who is this workspace,
-- why does it exist" record every connected agent should read before doing
-- anything, the same way agent_instructions/findings already get pulled into
-- an agent's context. One row per workspace, set once by a human owner and
-- editable from Settings -- not agent-writable, since it is meant to be the
-- one thing in Memory an agent's own output can never silently rewrite.
create table if not exists public.workspace_identity (
  workspace_id uuid primary key references public.projects(id) on delete cascade,
  mission text not null check (char_length(mission) between 1 and 2000),
  set_by_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.workspace_identity enable row level security;

grant select on public.workspace_identity to authenticated;
grant select, insert, update, delete on public.workspace_identity to service_role;

drop policy if exists "owners manage workspace identity" on public.workspace_identity;
create policy "owners manage workspace identity" on public.workspace_identity for all to authenticated
using (exists (select 1 from public.projects p where p.id = workspace_id and p.owner_id = (select auth.uid())))
with check (exists (select 1 from public.projects p where p.id = workspace_id and p.owner_id = (select auth.uid())));
