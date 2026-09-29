-- Room URLs: lets a caller (including an anonymous guest session) check a room's
-- name/status plus their own membership state by room ID alone, and lets the room's
-- creator/workspace admin list pending join requests to admit. Both security definer,
-- both must fail with P0002 ("room not found") for anyone with no membership row and no
-- admin standing, so guessing a room UUID reveals neither existence nor content --
-- same requirement the rest of this schema already holds to.

create or replace function public.get_m9r_room_view(p_room_id uuid)
returns table (room_id uuid, name text, status text, my_status text)
language plpgsql security definer set search_path = public as $$
declare caller_id uuid := auth.uid(); room_row public.m9r_rooms%rowtype; my_member_status text;
begin
  if caller_id is null then raise exception 'authentication required' using errcode = '42501'; end if;
  select * into room_row from public.m9r_rooms r where r.id = p_room_id and r.status not in ('closed', 'revoked');
  if room_row.id is null then raise exception 'room not found' using errcode = 'P0002'; end if;
  select m.status into my_member_status from public.m9r_room_members m where m.room_id = p_room_id and m.user_id = caller_id;
  return query select room_row.id, room_row.name, room_row.status, coalesce(my_member_status, 'none');
end; $$;
revoke all on function public.get_m9r_room_view(uuid) from public;
grant execute on function public.get_m9r_room_view(uuid) to authenticated;

create or replace function public.list_m9r_room_pending_members(p_room_id uuid)
returns table (member_id uuid, user_id uuid, requested_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare caller_id uuid := auth.uid();
begin
  if caller_id is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if not exists (
    select 1 from public.m9r_rooms r left join public.workspace_members wm on wm.workspace_id = r.workspace_id and wm.user_id = caller_id
    where r.id = p_room_id and (r.created_by = caller_id or wm.role in ('owner', 'admin'))
  ) then raise exception 'room admission permission denied' using errcode = '42501'; end if;
  return query select m.id, m.user_id, m.joined_at from public.m9r_room_members m
    where m.room_id = p_room_id and m.status = 'requested' order by m.joined_at asc;
end; $$;
revoke all on function public.list_m9r_room_pending_members(uuid) from public;
grant execute on function public.list_m9r_room_pending_members(uuid) to authenticated;
