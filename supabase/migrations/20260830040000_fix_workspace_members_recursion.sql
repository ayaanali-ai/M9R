-- The roster SELECT policy on workspace_members queried workspace_members
-- from inside its own USING clause (the standard "team roster" RLS shape)
-- -- but unlike that shape's usual form (a join through a DIFFERENT table),
-- referencing the SAME table Postgres is currently evaluating RLS for
-- forces it to re-apply that same policy to the subquery's own rows,
-- which needs the policy result again, forever: confirmed live as
-- "infinite recursion detected in policy for relation workspace_members"
-- (42P17), breaking every workspace read the instant this migration
-- landed. A SECURITY DEFINER function breaks the cycle: it runs with the
-- function owner's privileges, so its internal query bypasses RLS instead
-- of re-triggering it.
create or replace function public.is_workspace_member(target_workspace_id uuid, target_user_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = target_workspace_id and m.user_id = target_user_id
  );
$$;

grant execute on function public.is_workspace_member(uuid, uuid) to authenticated;

drop policy if exists "members read their workspace roster" on public.workspace_members;
create policy "members read their workspace roster" on public.workspace_members for select to authenticated
using (public.is_workspace_member(workspace_id, (select auth.uid())));

drop policy if exists "members read their workspace invites" on public.workspace_invites;
create policy "members read their workspace invites" on public.workspace_invites for select to authenticated
using (public.is_workspace_member(workspace_id, (select auth.uid())));

drop policy if exists "Users can read own projects" on public.projects;
create policy "Users can read own projects" on public.projects for select to authenticated
using (owner_id = (select auth.uid()) or public.is_workspace_member(id, (select auth.uid())));
