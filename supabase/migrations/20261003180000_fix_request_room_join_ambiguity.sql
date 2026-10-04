-- Found in the first live cross-user test: every request_m9r_room_join call failed with
-- 'column reference "room_id" is ambiguous' (the RETURNS TABLE output names room_id/member_id/status clash with the
-- m9r_room_members columns used in ON CONFLICT). Same body; #variable_conflict makes the table columns win.
create or replace function public.request_m9r_room_join(p_room_id uuid)
returns table(room_id uuid, member_id uuid, status text)
language plpgsql
security definer
set search_path to 'public'
as $function$
#variable_conflict use_column
declare caller_id uuid := auth.uid(); workspace_id uuid; member_row public.m9r_room_members%rowtype;
begin
  if caller_id is null then raise exception 'authentication required' using errcode = '42501'; end if;
  select r.workspace_id into workspace_id from public.m9r_rooms r where r.id = p_room_id and r.status not in ('closed', 'revoked');
  if workspace_id is null then raise exception 'room not found' using errcode = 'P0002'; end if;
  insert into public.m9r_room_members (room_id, user_id, role, status)
    values (p_room_id, caller_id, 'member', 'requested')
    on conflict (room_id, user_id) do update set status = case when public.m9r_room_members.status = 'active' then 'active' else 'requested' end, left_at = null
    returning * into member_row;
  return query select member_row.room_id, member_row.id, member_row.status;
end; $function$;
