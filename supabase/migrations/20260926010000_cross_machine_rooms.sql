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

create or replace function public.accept_m9r_room_invite(p_token_hash text)
returns table (room_id uuid, member_id uuid, room_status text)
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_id uuid := auth.uid();
  caller_email text;
  invite_row public.m9r_room_invites%rowtype;
  member_row public.m9r_room_members%rowtype;
begin
  if caller_id is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then raise exception 'invalid invite credential digest' using errcode = '22023'; end if;
  select lower(email) into caller_email from auth.users where id = caller_id;
  select * into invite_row from public.m9r_room_invites where token_hash = p_token_hash for update;
  if not found then raise exception 'invite not found' using errcode = 'P0002'; end if;
  if invite_row.status <> 'pending' then raise exception 'invite is no longer pending' using errcode = 'P0003'; end if;
  if invite_row.expires_at <= now() then
    update public.m9r_room_invites set status = 'expired' where id = invite_row.id;
    raise exception 'invite expired' using errcode = 'P0004';
  end if;
  if caller_email is null or caller_email <> lower(invite_row.invited_email) then raise exception 'invite email does not match signed-in user' using errcode = '42501'; end if;
  insert into public.m9r_room_members (room_id, user_id, role, status)
    values (invite_row.room_id, caller_id, 'member', 'active')
    on conflict (room_id, user_id) do update set status = 'active', left_at = null, joined_at = now()
    returning * into member_row;
  update public.m9r_room_invites set status = 'accepted', accepted_at = now() where id = invite_row.id;
  update public.m9r_rooms set status = 'active', updated_at = now() where id = invite_row.room_id and status not in ('closed', 'revoked');
  return query select member_row.room_id, member_row.id, (select r.status from public.m9r_rooms r where r.id = member_row.room_id);
end;
$$;
revoke all on function public.accept_m9r_room_invite(text) from public;
grant execute on function public.accept_m9r_room_invite(text) to authenticated;

-- Step 2: URL admission, minimized room events, and owner-gated disclosures.
-- Room messages never imply admission; a requested member remains quiet until an owner admits it.
alter table public.m9r_room_members drop constraint if exists m9r_room_members_status_check;
alter table public.m9r_room_members add constraint m9r_room_members_status_check check (status in ('requested', 'invited', 'active', 'left', 'removed', 'denied'));

create table if not exists public.m9r_room_agent_seats (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.m9r_rooms(id) on delete cascade,
  member_id uuid not null references public.m9r_room_members(id) on delete cascade,
  agent_kind text not null check (char_length(agent_kind) between 1 and 80),
  agent_label text not null check (char_length(agent_label) between 1 and 120),
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_at timestamptz not null default now(),
  unique (room_id, member_id, agent_kind, agent_label)
);
create index if not exists m9r_room_agent_seats_member_idx on public.m9r_room_agent_seats (room_id, member_id, status);

create table if not exists public.m9r_room_events (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.m9r_rooms(id) on delete cascade,
  sequence bigint generated always as identity,
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_seat_id text,
  kind text not null check (kind in ('action', 'post', 'ask', 'reply', 'share', 'approval', 'disclosure', 'membership', 'presence', 'claim', 'release')),
  causal_event_ids uuid[] not null default '{}',
  payload_digest text not null check (payload_digest ~ '^[a-f0-9]{64}$'),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (room_id, sequence)
);
create index if not exists m9r_room_events_room_sequence_idx on public.m9r_room_events (room_id, sequence);

create table if not exists public.m9r_disclosure_scopes (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.m9r_rooms(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  classes text[] not null default array['room_content']::text[],
  audience text not null default 'room' check (audience = 'room' or audience = 'members'),
  updated_at timestamptz not null default now(),
  unique (room_id, owner_id)
);

create table if not exists public.m9r_disclosure_requests (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.m9r_rooms(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  agent_seat_id text not null,
  asked_by text not null,
  subject text not null check (char_length(subject) between 1 and 200),
  data_class text not null check (data_class in ('room_content', 'own_messages', 'own_files_named', 'account_facts')),
  audience text not null,
  proposed_text_digest text not null check (proposed_text_digest ~ '^[a-f0-9]{64}$'),
  state text not null default 'pending' check (state in ('pending', 'approved', 'denied', 'expired')),
  decided_by uuid references auth.users(id) on delete set null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists m9r_disclosure_requests_owner_state_idx on public.m9r_disclosure_requests (owner_id, state, expires_at);

create table if not exists public.m9r_disclosure_receipts (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.m9r_disclosure_requests(id) on delete cascade,
  room_id uuid not null references public.m9r_rooms(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  data_class text not null,
  audience text not null,
  decision text not null check (decision in ('approved', 'denied', 'expired')),
  payload_digest text not null check (payload_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now()
);
create index if not exists m9r_disclosure_receipts_room_created_idx on public.m9r_disclosure_receipts (room_id, created_at desc);

alter table public.m9r_room_events enable row level security;
alter table public.m9r_room_agent_seats enable row level security;
alter table public.m9r_disclosure_scopes enable row level security;
alter table public.m9r_disclosure_requests enable row level security;
alter table public.m9r_disclosure_receipts enable row level security;
grant select on public.m9r_room_events, public.m9r_disclosure_scopes, public.m9r_disclosure_requests, public.m9r_disclosure_receipts to authenticated;
grant select on public.m9r_room_agent_seats to authenticated;
grant select, insert, update, delete on public.m9r_room_events, public.m9r_disclosure_scopes, public.m9r_disclosure_requests, public.m9r_disclosure_receipts to service_role;
grant select, insert, update, delete on public.m9r_room_agent_seats to service_role;

drop policy if exists "active room members can read minimized events" on public.m9r_room_events;
create policy "active room members can read minimized events" on public.m9r_room_events for select to authenticated using (public.is_m9r_room_member(room_id, (select auth.uid())));
drop policy if exists "room members can read their agent seats" on public.m9r_room_agent_seats;
create policy "room members can read their agent seats" on public.m9r_room_agent_seats for select to authenticated using (public.is_m9r_room_member(room_id, (select auth.uid())));
drop policy if exists "owners can read their disclosure scopes" on public.m9r_disclosure_scopes;
create policy "owners can read their disclosure scopes" on public.m9r_disclosure_scopes for select to authenticated using (owner_id = (select auth.uid()));
drop policy if exists "owners can read their disclosure requests" on public.m9r_disclosure_requests;
create policy "owners can read their disclosure requests" on public.m9r_disclosure_requests for select to authenticated using (owner_id = (select auth.uid()));
drop policy if exists "owners can read their disclosure receipts" on public.m9r_disclosure_receipts;
create policy "owners can read their disclosure receipts" on public.m9r_disclosure_receipts for select to authenticated using (owner_id = (select auth.uid()));

create or replace function public.register_m9r_room_agent_seat(
  p_room_id uuid, p_agent_kind text, p_agent_label text
)
returns table (seat_id uuid, room_id uuid, member_id uuid, agent_kind text, agent_label text, status text)
language plpgsql security definer set search_path = public as $$
declare caller_id uuid := auth.uid(); member_row public.m9r_room_members%rowtype; seat_row public.m9r_room_agent_seats%rowtype;
begin
  if caller_id is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if p_agent_kind is null or char_length(btrim(p_agent_kind)) not between 1 and 80 or p_agent_label is null or char_length(btrim(p_agent_label)) not between 1 and 120 then
    raise exception 'agent seat details are invalid' using errcode = '22023';
  end if;
  select * into member_row from public.m9r_room_members where room_id = p_room_id and user_id = caller_id and status = 'active';
  if not found then raise exception 'room membership required' using errcode = '42501'; end if;
  insert into public.m9r_room_agent_seats (room_id, member_id, agent_kind, agent_label, status)
    values (p_room_id, member_row.id, btrim(p_agent_kind), btrim(p_agent_label), 'active')
    on conflict (room_id, member_id, agent_kind, agent_label) do update set status = 'active'
    returning * into seat_row;
  return query select seat_row.id, seat_row.room_id, seat_row.member_id, seat_row.agent_kind, seat_row.agent_label, seat_row.status;
end; $$;
revoke all on function public.register_m9r_room_agent_seat(uuid, text, text) from public;
grant execute on function public.register_m9r_room_agent_seat(uuid, text, text) to authenticated;

create or replace function public.request_m9r_room_join(p_room_id uuid)
returns table (room_id uuid, member_id uuid, status text)
language plpgsql security definer set search_path = public as $$
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
end; $$;
revoke all on function public.request_m9r_room_join(uuid) from public;
grant execute on function public.request_m9r_room_join(uuid) to authenticated;

create or replace function public.admit_m9r_room_member(p_room_id uuid, p_member_id uuid)
returns table (room_id uuid, member_id uuid, status text)
language plpgsql security definer set search_path = public as $$
declare caller_id uuid := auth.uid(); updated public.m9r_room_members%rowtype;
begin
  if caller_id is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if not exists (select 1 from public.m9r_rooms r left join public.workspace_members wm on wm.workspace_id = r.workspace_id and wm.user_id = caller_id where r.id = p_room_id and (r.created_by = caller_id or wm.role in ('owner', 'admin'))) then raise exception 'room admission permission denied' using errcode = '42501'; end if;
  update public.m9r_room_members set status = 'active', joined_at = now(), left_at = null where id = p_member_id and room_id = p_room_id and status in ('requested', 'invited') returning * into updated;
  if not found then raise exception 'member request not found' using errcode = 'P0002'; end if;
  update public.m9r_rooms set status = 'active', updated_at = now() where id = p_room_id and status not in ('closed', 'revoked');
  return query select updated.room_id, updated.id, updated.status;
end; $$;
revoke all on function public.admit_m9r_room_member(uuid, uuid) from public;
grant execute on function public.admit_m9r_room_member(uuid, uuid) to authenticated;

create or replace function public.create_m9r_disclosure_request(
  p_room_id uuid, p_agent_seat_id text, p_asked_by text, p_subject text, p_data_class text,
  p_audience text, p_proposed_text_digest text, p_expires_at timestamptz
)
returns table (request_id uuid, state text, receipt_id uuid)
language plpgsql security definer set search_path = public as $$
declare caller_id uuid := auth.uid(); request_row public.m9r_disclosure_requests%rowtype; allowed boolean;
begin
  if caller_id is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if not public.is_m9r_room_member(p_room_id, caller_id) then raise exception 'room membership required' using errcode = '42501'; end if;
  if p_agent_seat_id is null or p_agent_seat_id !~ '^[0-9a-f-]{36}$' or not exists (
    select 1 from public.m9r_room_agent_seats s
    join public.m9r_room_members m on m.id = s.member_id
    where s.id = p_agent_seat_id::uuid and s.room_id = p_room_id and s.status = 'active' and m.user_id = caller_id and m.status = 'active'
  ) then raise exception 'active agent seat required' using errcode = '42501'; end if;
  if p_expires_at <= now() or p_expires_at > now() + interval '10 minutes' + interval '1 minute' then raise exception 'disclosure request expiry is invalid' using errcode = '22023'; end if;
  select p_data_class = any(s.classes) and (s.audience = 'room' or p_audience = 'members') into allowed from public.m9r_disclosure_scopes s where s.room_id = p_room_id and s.owner_id = caller_id;
  if coalesce(allowed, false) then return query select null::uuid, 'allowed'::text, null::uuid; return; end if;
  insert into public.m9r_disclosure_requests (room_id, owner_id, agent_seat_id, asked_by, subject, data_class, audience, proposed_text_digest, expires_at)
    values (p_room_id, caller_id, p_agent_seat_id, p_asked_by, p_subject, p_data_class, p_audience, p_proposed_text_digest, p_expires_at)
    returning * into request_row;
  return query select request_row.id, request_row.state, null::uuid;
end; $$;
revoke all on function public.create_m9r_disclosure_request(uuid, text, text, text, text, text, text, timestamptz) from public;
grant execute on function public.create_m9r_disclosure_request(uuid, text, text, text, text, text, text, timestamptz) to authenticated;

create or replace function public.decide_m9r_disclosure_request(p_request_id uuid, p_decision text)
returns table (request_id uuid, state text, receipt_id uuid)
language plpgsql security definer set search_path = public as $$
declare caller_id uuid := auth.uid(); request_row public.m9r_disclosure_requests%rowtype; receipt_id uuid;
begin
  if caller_id is null then raise exception 'authentication required' using errcode = '42501'; end if;
  select * into request_row from public.m9r_disclosure_requests where id = p_request_id and owner_id = caller_id for update;
  if not found then raise exception 'disclosure request not found' using errcode = 'P0002'; end if;
  if request_row.state <> 'pending' or request_row.expires_at <= now() then
    update public.m9r_disclosure_requests set state = 'expired' where id = request_row.id and state = 'pending';
    insert into public.m9r_disclosure_receipts (request_id, room_id, owner_id, data_class, audience, decision, payload_digest) values (request_row.id, request_row.room_id, caller_id, request_row.data_class, request_row.audience, 'expired', request_row.proposed_text_digest) returning id into receipt_id;
    return query select request_row.id, 'expired'::text, receipt_id; return;
  end if;
  if p_decision not in ('approve', 'deny') then raise exception 'invalid disclosure decision' using errcode = '22023'; end if;
  update public.m9r_disclosure_requests set state = case when p_decision = 'approve' then 'approved' else 'denied' end, decided_by = caller_id where id = request_row.id;
  insert into public.m9r_disclosure_receipts (request_id, room_id, owner_id, data_class, audience, decision, payload_digest) values (request_row.id, request_row.room_id, caller_id, request_row.data_class, request_row.audience, case when p_decision = 'approve' then 'approved' else 'denied' end, request_row.proposed_text_digest) returning id into receipt_id;
  return query select request_row.id, case when p_decision = 'approve' then 'approved' else 'denied' end, receipt_id;
end; $$;
revoke all on function public.decide_m9r_disclosure_request(uuid, text) from public;
grant execute on function public.decide_m9r_disclosure_request(uuid, text) to authenticated;

create or replace function public.append_m9r_room_event(
  p_room_id uuid, p_kind text, p_actor_seat_id uuid, p_causal_event_ids uuid[], p_payload_digest text, p_payload jsonb
)
returns table (event_id uuid, sequence bigint, room_id uuid, actor_user_id uuid, actor_seat_id text, kind text, causal_event_ids uuid[], payload_digest text, payload jsonb, created_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare caller_id uuid := auth.uid(); member_row public.m9r_room_members%rowtype; event_row public.m9r_room_events%rowtype;
begin
  if caller_id is null then raise exception 'authentication required' using errcode = '42501'; end if;
  select * into member_row from public.m9r_room_members where room_id = p_room_id and user_id = caller_id and status = 'active';
  if not found then raise exception 'room membership required' using errcode = '42501'; end if;
  if p_kind is null or p_kind not in ('action', 'post', 'ask', 'reply', 'share', 'approval', 'disclosure', 'membership', 'presence', 'claim', 'release') then raise exception 'invalid room event kind' using errcode = '22023'; end if;
  if p_actor_seat_id is not null and not exists (select 1 from public.m9r_room_agent_seats where id = p_actor_seat_id and room_id = p_room_id and member_id = member_row.id and status = 'active') then raise exception 'agent seat is not owned by the active member' using errcode = '42501'; end if;
  if p_payload_digest is null or p_payload_digest !~ '^[a-f0-9]{64}$' or p_payload is null or pg_column_size(p_payload) > 16384 then raise exception 'room event payload is invalid or too large' using errcode = '22023'; end if;
  insert into public.m9r_room_events (room_id, actor_user_id, actor_seat_id, kind, causal_event_ids, payload_digest, payload)
    values (p_room_id, caller_id, p_actor_seat_id::text, p_kind, coalesce(p_causal_event_ids, '{}'), p_payload_digest, p_payload)
    returning * into event_row;
  return query select event_row.id, event_row.sequence, event_row.room_id, event_row.actor_user_id, event_row.actor_seat_id, event_row.kind, event_row.causal_event_ids, event_row.payload_digest, event_row.payload, event_row.created_at;
end; $$;
revoke all on function public.append_m9r_room_event(uuid, text, uuid, uuid[], text, jsonb) from public;
grant execute on function public.append_m9r_room_event(uuid, text, uuid, uuid[], text, jsonb) to authenticated;
