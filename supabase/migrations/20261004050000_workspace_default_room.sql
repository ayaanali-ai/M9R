-- Rooms→workspace pivot, step 2: the workspace itself is the room now, not a
-- separate thing a member has to remember to "create." Every workspace gets
-- exactly one room, made lazily the first time anyone asks for it (not via a
-- trigger on `projects` insert, so this never interferes with
-- m9r_ensure_default_workspace's own advisory-locked creation path).
--
-- Same locking shape as m9r_ensure_default_workspace: a check-then-insert
-- without a lock would let two concurrent "open my room" page loads each see
-- "no room yet" and both create one, splitting a workspace across two rooms.
create or replace function public.m9r_ensure_workspace_room(p_workspace_id uuid)
returns public.m9r_rooms
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  caller_id uuid := auth.uid();
  workspace_name text;
  is_owner boolean;
  v_existing public.m9r_rooms;
  v_created public.m9r_rooms;
begin
  if caller_id is null then raise exception 'authentication required' using errcode = '42501'; end if;
  -- Same access test as projects' own SELECT RLS: owner OR member. A plain
  -- is_workspace_member() check is too strict -- real workspaces exist whose
  -- owner has no workspace_members row at all (older rows, from before that
  -- table existed; see 20260830030000_workspace_members.sql's backfill, which
  -- skips any owner_id with no matching auth.users row rather than failing).
  select (owner_id = caller_id) into is_owner from public.projects where id = p_workspace_id and deleted_at is null;
  if is_owner is null then raise exception 'workspace not found' using errcode = 'P0002'; end if;
  if not is_owner and not public.is_workspace_member(p_workspace_id, caller_id) then
    raise exception 'workspace membership required' using errcode = '42501';
  end if;

  -- Serializes concurrent callers for this exact workspace; a second
  -- transaction blocks here until the first commits, then finds the room
  -- the first one already created.
  perform pg_advisory_xact_lock(hashtext(p_workspace_id::text));

  select * into v_existing
  from public.m9r_rooms
  where workspace_id = p_workspace_id and status not in ('closed', 'revoked')
  order by created_at asc
  limit 1;

  if found then
    return v_existing;
  end if;

  select name into workspace_name from public.projects where id = p_workspace_id;

  insert into public.m9r_rooms (workspace_id, created_by, name)
  values (p_workspace_id, caller_id, coalesce(workspace_name, 'Room'))
  returning * into v_created;
  -- m9r_room_owner_member_after_insert adds the creator as an active 'owner' member.

  return v_created;
end;
$$;

revoke all on function public.m9r_ensure_workspace_room(uuid) from public;
grant execute on function public.m9r_ensure_workspace_room(uuid) to authenticated;
