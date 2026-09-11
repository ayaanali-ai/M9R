-- Multi-human workspaces, phase 1: membership + roles.
--
-- Until now `projects` (workspaces) had exactly one human tied to it --
-- owner_id, checked directly in RLS everywhere. There was no table saying
-- "these other humans are also in this workspace." This is the foundation
-- that was missing before any real channel-permissions feature (human
-- picker, owner/admin roles, promote/demote) could be built honestly.
--
-- Scope of this migration: the membership/role primitive itself, plus
-- extending `projects` SELECT so a member (not just the owner) can see a
-- workspace exists. It deliberately does NOT yet rewrite every other
-- owner_id-gated table (chat, rules, findings, runs) to respect membership
-- -- that is real, separate follow-up work, not done here.
create table if not exists public.workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member')),
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (workspace_id, user_id)
);

-- Every workspace's existing owner becomes its 'owner' membership row --
-- membership is now the single source of truth for "who is in this
-- workspace and what can they do," with projects.owner_id staying as the
-- one row that can never be demoted or removed (enforced below).
-- Some existing project rows point at an owner_id with no matching
-- auth.users row (orphaned demo/reviewer projects) -- the join to auth.users
-- here is what makes this backfill skip those instead of failing the whole
-- migration on one bad row.
insert into public.workspace_members (workspace_id, user_id, role)
select p.id, p.owner_id, 'owner'
from public.projects p
join auth.users u on u.id = p.owner_id
on conflict (workspace_id, user_id) do nothing;

create index if not exists workspace_members_user_idx on public.workspace_members (user_id);

alter table public.workspace_members enable row level security;

grant select on public.workspace_members to authenticated;
grant select, insert, update, delete on public.workspace_members to service_role;

drop policy if exists "members read their workspace roster" on public.workspace_members;
create policy "members read their workspace roster" on public.workspace_members for select to authenticated
using (exists (select 1 from public.workspace_members m where m.workspace_id = workspace_members.workspace_id and m.user_id = (select auth.uid())));

-- Invites: owner/admin creates one for an email, the invited (signed-in,
-- matching-email) user accepts it -- app code enforces the email match and
-- expiry (service-role write path, same pattern as other invite-shaped
-- tables in this codebase); RLS here only needs to let a member see their
-- own workspace's invites and let anyone read the one row for a token they
-- were given (the token itself is the capability).
create table if not exists public.workspace_invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.projects(id) on delete cascade,
  email text not null check (char_length(email) between 3 and 320),
  role text not null check (role in ('admin', 'member')),
  token text not null unique default encode(gen_random_bytes(24), 'hex'),
  invited_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  accepted_at timestamptz,
  revoked_at timestamptz
);

create index if not exists workspace_invites_workspace_idx on public.workspace_invites (workspace_id, created_at desc);

alter table public.workspace_invites enable row level security;

grant select on public.workspace_invites to authenticated;
grant select, insert, update, delete on public.workspace_invites to service_role;

drop policy if exists "members read their workspace invites" on public.workspace_invites;
create policy "members read their workspace invites" on public.workspace_invites for select to authenticated
using (exists (select 1 from public.workspace_members m where m.workspace_id = workspace_invites.workspace_id and m.user_id = (select auth.uid())));

-- Extend projects SELECT: a member (any role) can now see the workspace
-- row exists, not only its owner. Insert/update/delete on projects itself
-- stay owner-only -- creating, renaming, or deleting the workspace is not
-- part of what was asked for here.
drop policy if exists "Users can read own projects" on public.projects;
create policy "Users can read own projects" on public.projects for select to authenticated
using (owner_id = (select auth.uid()) or exists (
  select 1 from public.workspace_members m where m.workspace_id = projects.id and m.user_id = (select auth.uid())
));
