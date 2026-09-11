-- Real, observed bug: projects-service.ts's createDefaultWorkspace does a
-- check-then-insert with no lock between the two steps. Two concurrent
-- requests for the same brand-new user (normal on a dashboard page load
-- with parallel server components) can both see "no workspace yet" and
-- both insert a "Default workspace" row -- confirmed live: this exact
-- account has two such rows created 292ms apart on 2026-09-03. Harmless
-- for an existing user (oldest-owned-workspace resolution always picks
-- the same real workspace regardless of stray duplicates), but a real
-- risk for a first-time user: if their first agent connection and their
-- first dashboard load resolve to two different freshly-created
-- workspace ids, the agent's data lands in one while the UI settles on
-- the other -- looking exactly like the agent's work vanished.
--
-- Fix: a single atomic function using a session-scoped advisory lock
-- (pg_advisory_xact_lock, released automatically at transaction end) so
-- the check-and-insert can never race for the same owner.
create or replace function public.m9r_ensure_default_workspace(p_owner_id uuid)
returns public.projects
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.projects;
  v_created public.projects;
begin
  -- Serializes concurrent callers for this exact owner; a second
  -- transaction blocks here until the first commits or rolls back, then
  -- proceeds and finds the row the first one already created.
  perform pg_advisory_xact_lock(hashtext(p_owner_id::text));

  select * into v_existing
  from public.projects
  where owner_id = p_owner_id and deleted_at is null
  order by created_at asc
  limit 1;

  if found then
    return v_existing;
  end if;

  insert into public.projects (owner_id, name)
  values (p_owner_id, 'Default workspace')
  returning * into v_created;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_created.id, p_owner_id, 'owner')
  on conflict (workspace_id, user_id) do nothing;

  return v_created;
end;
$$;

revoke all on function public.m9r_ensure_default_workspace(uuid) from public, anon, authenticated;
grant execute on function public.m9r_ensure_default_workspace(uuid) to service_role;
