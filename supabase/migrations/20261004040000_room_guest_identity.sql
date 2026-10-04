-- Guest identity on room membership.
--
-- Guests join a room through a silent anonymous Supabase session (see
-- ensure-guest-session.ts), which has no name or email at all -- every guest
-- showed up to the host and to other members as "Room member" / "Someone".
-- This adds a name and email the guest types once, stored directly on their
-- membership row (anonymous auth.users rows have nothing in the profile
-- table person-names.ts reads from, so this cannot live there).
alter table public.m9r_room_members add column if not exists guest_display_name text
  check (guest_display_name is null or char_length(guest_display_name) between 1 and 80);
alter table public.m9r_room_members add column if not exists guest_email text
  check (guest_email is null or (char_length(guest_email) between 3 and 320 and guest_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'));

-- request_m9r_room_join gains two optional params so existing non-guest callers
-- (a signed-in member asking to join a room they're not yet in) keep working
-- unchanged. A guest's identity is attached on the *first* request only --
-- re-requesting (e.g. a page reload while still "requested") must not let a
-- later, different name/email silently overwrite what the host already saw.
-- PostgREST resolves an rpc call by matching the named params sent, and gets ambiguous
-- when two overloads of the same name both accept a superset/subset of those params with
-- defaults -- the old 1-arg signature must be gone, not just shadowed, before the 3-arg
-- version below can be called reliably.
drop function if exists public.request_m9r_room_join(uuid);
create or replace function public.request_m9r_room_join(
  p_room_id uuid,
  p_guest_display_name text default null,
  p_guest_email text default null
)
returns table (room_id uuid, member_id uuid, status text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  caller_id uuid := auth.uid();
  workspace_id uuid;
  clean_name text;
  clean_email text;
  member_row public.m9r_room_members%rowtype;
begin
  if caller_id is null then raise exception 'authentication required' using errcode = '42501'; end if;
  select r.workspace_id into workspace_id from public.m9r_rooms r where r.id = p_room_id and r.status not in ('closed', 'revoked');
  if workspace_id is null then raise exception 'room not found' using errcode = 'P0002'; end if;

  clean_name := nullif(btrim(coalesce(p_guest_display_name, '')), '');
  clean_email := nullif(lower(btrim(coalesce(p_guest_email, ''))), '');
  if clean_name is not null and char_length(clean_name) > 80 then raise exception 'guest name is too long' using errcode = '22023'; end if;
  if clean_email is not null and clean_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'guest email is invalid' using errcode = '22023'; end if;

  insert into public.m9r_room_members (room_id, user_id, role, status, guest_display_name, guest_email)
    values (p_room_id, caller_id, 'member', 'requested', clean_name, clean_email)
    on conflict (room_id, user_id) do update set
      status = case when public.m9r_room_members.status = 'active' then 'active' else 'requested' end,
      left_at = null,
      guest_display_name = coalesce(public.m9r_room_members.guest_display_name, excluded.guest_display_name),
      guest_email = coalesce(public.m9r_room_members.guest_email, excluded.guest_email)
    returning * into member_row;
  return query select member_row.room_id, member_row.id, member_row.status;
end; $$;
revoke all on function public.request_m9r_room_join(uuid, text, text) from public;
grant execute on function public.request_m9r_room_join(uuid, text, text) to authenticated;

-- Pending requests now also carry the guest's own typed name/email, so a host
-- reviewing "who is asking to join" sees a real name instead of nothing.
drop function if exists public.list_m9r_room_pending_members(uuid);
create or replace function public.list_m9r_room_pending_members(p_room_id uuid)
returns table (member_id uuid, user_id uuid, requested_at timestamptz, guest_display_name text, guest_email text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare caller_id uuid := auth.uid();
begin
  if caller_id is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if not exists (
    select 1 from public.m9r_rooms r left join public.workspace_members wm on wm.workspace_id = r.workspace_id and wm.user_id = caller_id
    where r.id = p_room_id and (r.created_by = caller_id or wm.role in ('owner', 'admin'))
  ) then raise exception 'room admission permission denied' using errcode = '42501'; end if;
  return query select m.id, m.user_id, m.joined_at, m.guest_display_name, m.guest_email from public.m9r_room_members m
    where m.room_id = p_room_id and m.status = 'requested' order by m.joined_at asc;
end; $$;
revoke all on function public.list_m9r_room_pending_members(uuid) from public;
grant execute on function public.list_m9r_room_pending_members(uuid) to authenticated;
