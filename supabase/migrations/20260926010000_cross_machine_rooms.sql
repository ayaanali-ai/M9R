-- Step 1 of cross-machine rooms: durable room/member/invite records and the
-- authenticated create-room/invite primitives. No browser/UI/relay authority.

create table if not exists public.m9r_rooms (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.projects(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  status text not null default 'created' check (status in ('created', 'invite_pending', 'active', 'closing', 'closed', 'revoked')),
  policy_version integer not null default 1 check (policy_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);

create index if not exists m9r_rooms_workspace_created_idx on public.m9r_rooms (workspace_id, created_at desc);

create table if not exists public.m9r_room_members (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.m9r_rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'member')),
  status text not null default 'active' check (status in ('active', 'left', 'revoked')),
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  unique (room_id, user_id)
);

create index if not exists m9r_room_members_user_idx on public.m9r_room_members (user_id, room_id);

create table if not exists public.m9r_room_invites (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.m9r_rooms(id) on delete cascade,
  invited_by uuid not null references auth.users(id) on delete cascade,
  invited_email text not null check (char_length(invited_email) between 3 and 320),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'expired', 'revoked')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  check (expires_at > created_at)
);

create index if not exists m9r_room_invites_room_created_idx on public.m9r_room_invites (room_id, created_at desc);
create index if not exists m9r_room_invites_pending_expiry_idx on public.m9r_room_invites (expires_at) where status = 'pending';

create or replace function public.is_m9r_room_member(target_room_id uuid, target_user_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select target_user_id = (select auth.uid()) and exists (
    select 1 from public.m9r_room_members m
    where m.room_id = target_room_id and m.user_id = target_user_id and m.status = 'active'
  );
$$;
revoke all on function public.is_m9r_room_member(uuid, uuid) from public;
grant execute on function public.is_m9r_room_member(uuid, uuid) to authenticated;

create or replace function public.add_m9r_room_owner_member()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.m9r_room_members (room_id, user_id, role, status)
  values (new.id, new.created_by, 'owner', 'active');
  return new;
end;
$$;

drop trigger if exists m9r_room_owner_member_after_insert on public.m9r_rooms;
create trigger m9r_room_owner_member_after_insert
after insert on public.m9r_rooms
for each row execute function public.add_m9r_room_owner_member();

alter table public.m9r_rooms enable row level security;
alter table public.m9r_room_members enable row level security;
alter table public.m9r_room_invites enable row level security;

grant select, insert on public.m9r_rooms to authenticated;
grant update (status, updated_at, closed_at) on public.m9r_rooms to authenticated;
grant select on public.m9r_room_members, public.m9r_room_invites to authenticated;
grant select, insert, update, delete on public.m9r_rooms, public.m9r_room_members, public.m9r_room_invites to service_role;

drop policy if exists "room members can read their room" on public.m9r_rooms;
create policy "room members can read their room" on public.m9r_rooms for select to authenticated
using (public.is_m9r_room_member(id, (select auth.uid())));

drop policy if exists "workspace members can create rooms" on public.m9r_rooms;
create policy "workspace members can create rooms" on public.m9r_rooms for insert to authenticated
with check (created_by = (select auth.uid()) and public.is_workspace_member(workspace_id, (select auth.uid())));

drop policy if exists "room owners and workspace admins can update rooms" on public.m9r_rooms;
create policy "room owners and workspace admins can update rooms" on public.m9r_rooms for update to authenticated
using (
  created_by = (select auth.uid()) or exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = m9r_rooms.workspace_id and wm.user_id = (select auth.uid()) and wm.role in ('owner', 'admin')
  )
)
with check (
  status in ('created', 'invite_pending', 'active', 'closing', 'closed', 'revoked') and (
    created_by = (select auth.uid()) or exists (
      select 1 from public.workspace_members wm
      where wm.workspace_id = m9r_rooms.workspace_id and wm.user_id = (select auth.uid()) and wm.role in ('owner', 'admin')
    )
  )
);

drop policy if exists "room members can read room membership" on public.m9r_room_members;
create policy "room members can read room membership" on public.m9r_room_members for select to authenticated
using (public.is_m9r_room_member(room_id, (select auth.uid())));

drop policy if exists "room owners and workspace admins can read invites" on public.m9r_room_invites;
create policy "room owners and workspace admins can read invites" on public.m9r_room_invites for select to authenticated
using (exists (
  select 1 from public.m9r_rooms r
  left join public.workspace_members wm on wm.workspace_id = r.workspace_id and wm.user_id = (select auth.uid())
  where r.id = m9r_room_invites.room_id and (r.created_by = (select auth.uid()) or wm.role in ('owner', 'admin'))
));

create or replace function public.create_m9r_room_invite(
  p_room_id uuid,
  p_invited_email text,
  p_token_hash text,
  p_expires_at timestamptz
)
returns table (id uuid, room_id uuid, invited_email text, status text, created_at timestamptz, expires_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_id uuid := auth.uid();
  room_workspace_id uuid;
  room_owner_id uuid;
  can_invite boolean;
begin
  if caller_id is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if p_invited_email is null or lower(btrim(p_invited_email)) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or char_length(p_invited_email) > 320 then
    raise exception 'invalid invite email' using errcode = '22023';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then raise exception 'invalid invite credential digest' using errcode = '22023'; end if;
  if p_expires_at <= now() or p_expires_at > now() + interval '7 days' + interval '1 minute' then
    raise exception 'invite expiry is outside the allowed window' using errcode = '22023';
  end if;

  select r.workspace_id, r.created_by into room_workspace_id, room_owner_id
  from public.m9r_rooms r where r.id = p_room_id and r.status not in ('closed', 'revoked');
  if room_workspace_id is null then raise exception 'room not found' using errcode = 'P0002'; end if;

  select room_owner_id = caller_id or exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = room_workspace_id and wm.user_id = caller_id and wm.role in ('owner', 'admin')
  ) into can_invite;
  if not can_invite then raise exception 'room invite permission denied' using errcode = '42501'; end if;

  return query insert into public.m9r_room_invites as ri (room_id, invited_by, invited_email, token_hash, status, expires_at)
    values (p_room_id, caller_id, lower(btrim(p_invited_email)), p_token_hash, 'pending', p_expires_at)
    returning ri.id, ri.room_id, ri.invited_email, ri.status, ri.created_at, ri.expires_at;
  update public.m9r_rooms set status = 'invite_pending', updated_at = now() where m9r_rooms.id = p_room_id;
end;
$$;
revoke all on function public.create_m9r_room_invite(uuid, text, text, timestamptz) from public;
grant execute on function public.create_m9r_room_invite(uuid, text, text, timestamptz) to authenticated;
