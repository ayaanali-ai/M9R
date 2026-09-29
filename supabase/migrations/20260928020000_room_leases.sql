-- Explicit resource leases for shared task and browser-tab coordination.
-- These prevent competing room members from treating a concurrent edit as
-- an OT/CRDT merge. They coordinate only; local execution authority remains local.

create table if not exists public.m9r_room_leases (
  room_id uuid not null references public.m9r_rooms(id) on delete cascade,
  resource_key text not null check (char_length(resource_key) between 1 and 180),
  holder_member_id uuid not null references public.m9r_room_members(id) on delete cascade,
  -- A seat-owned lease must disappear with the seat. SET NULL would silently
  -- convert an agent lock into a human lock held by the same member.
  holder_seat_id uuid references public.m9r_room_agent_seats(id) on delete cascade,
  expires_at timestamptz not null,
  version bigint not null default 1 check (version > 0),
  -- These are restoration snapshots, not live foreign-key ownership. Hand-back
  -- revalidates both IDs against active membership/seat rows before restoring.
  preempted_member_id uuid,
  preempted_seat_id uuid,
  preempted_expires_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (room_id, resource_key),
  check ((preempted_member_id is null) = (preempted_expires_at is null))
);

create index if not exists m9r_room_leases_expiry_idx on public.m9r_room_leases (room_id, expires_at);
alter table public.m9r_room_leases enable row level security;
grant select on public.m9r_room_leases to authenticated;
grant select, insert, update, delete on public.m9r_room_leases to service_role;
drop policy if exists "active room members can read leases" on public.m9r_room_leases;
create policy "active room members can read leases" on public.m9r_room_leases
  for select to authenticated using (public.is_m9r_room_member(room_id, (select auth.uid())));

create or replace function public.enforce_m9r_room_task_lease()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member public.m9r_room_members%rowtype;
  lease_row public.m9r_room_leases%rowtype;
  task_resource text;
begin
  -- The only other bypassed type is the internally generated assignment fact
  -- emitted by act_m9r_room_handoff; the public append RPC never accepts it.
  if new.kind <> 'task' or new.payload->>'type' in ('created', 'assigned') then return new; end if;
  -- Also serialize privileged/direct table inserts with the lease RPC. The
  -- normal append RPC already holds this transaction-scoped lock; reacquiring
  -- it in the same transaction is safe and keeps this trigger self-contained.
  perform pg_advisory_xact_lock(hashtextextended(new.room_id::text, 0));
  task_resource := 'task:' || coalesce(new.payload->>'taskId', '');
  select * into actor_member from public.m9r_room_members
    where room_id = new.room_id and user_id = new.actor_user_id and status = 'active';
  if not found then raise exception 'active room membership is required' using errcode = '42501'; end if;
  select * into lease_row from public.m9r_room_leases
    where room_id = new.room_id and resource_key = task_resource for update;
  if found and lease_row.expires_at > clock_timestamp() and (
    lease_row.holder_member_id <> actor_member.id or lease_row.holder_seat_id is distinct from nullif(new.actor_seat_id, '')::uuid
  ) then
    raise exception 'task is leased to another room participant' using errcode = '55P03';
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_m9r_room_task_lease() from public;
drop trigger if exists m9r_room_task_lease_before_insert on public.m9r_room_events;
create trigger m9r_room_task_lease_before_insert
before insert on public.m9r_room_events
for each row execute function public.enforce_m9r_room_task_lease();

create or replace function public.act_m9r_room_lease(
  p_room_id uuid,
  p_resource_key text,
  p_action text,
  p_actor_seat_id uuid,
  p_ttl_ms integer,
  p_preempt boolean,
  p_client_event_id uuid
)
returns table (
  ok boolean,
  reason text,
  resource_key text,
  holder_member_id uuid,
  holder_seat_id uuid,
  expires_at timestamptz,
  version bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_id uuid := auth.uid();
  member_row public.m9r_room_members%rowtype;
  lease_row public.m9r_room_leases%rowtype;
  prior_member public.m9r_room_members%rowtype;
  prior_seat_is_active boolean := true;
  room_owner_id uuid;
  current_holder_id text;
  event_row public.m9r_room_events%rowtype;
  event_kind text;
  event_type text;
  event_status text;
  event_payload jsonb;
  event_expiry timestamptz;
  acquired boolean := false;
  result_reason text := 'lease_not_found';
  v_now timestamptz;
begin
  if caller_id is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if p_room_id is null or p_client_event_id is null or p_action is null or p_action not in ('acquire', 'release')
    or p_preempt is null
    or p_resource_key is null or char_length(p_resource_key) > 180
    or p_resource_key !~* '^(task:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|browser:[a-z0-9:_-]{1,160})$' then
    raise exception 'room lease request is invalid' using errcode = '22023';
  end if;
  if p_action = 'acquire' and (p_ttl_ms is null or p_ttl_ms not between 5000 and 120000) then
    raise exception 'room lease duration is outside the allowed range' using errcode = '22023';
  end if;
  if p_action = 'release' and (p_preempt or p_ttl_ms is not null) then
    raise exception 'lease release cannot request takeover or a duration' using errcode = '22023';
  end if;

  -- All changes to this room's event sequence and resource leases use the same
  -- room lock as append_m9r_room_event, preventing races between a claim and a task update.
  perform pg_advisory_xact_lock(hashtextextended(p_room_id::text, 0));
  v_now := clock_timestamp();
  select m.* into member_row from public.m9r_room_members as m
    where m.room_id = p_room_id and m.user_id = caller_id and m.status = 'active';
  if not found then raise exception 'room membership required' using errcode = '42501'; end if;
  select r.created_by into room_owner_id from public.m9r_rooms r where r.id = p_room_id and r.status not in ('closed', 'revoked');
  if room_owner_id is null then raise exception 'room not found' using errcode = 'P0002'; end if;
  if p_preempt and (p_action <> 'acquire' or caller_id <> room_owner_id or member_row.role <> 'owner' or p_actor_seat_id is not null) then
    raise exception 'only the room owner can preempt a lease' using errcode = '42501';
  end if;
  if p_actor_seat_id is not null and not exists (
    select 1 from public.m9r_room_agent_seats s
    where s.id = p_actor_seat_id and s.room_id = p_room_id and s.member_id = member_row.id and s.status = 'active'
  ) then raise exception 'agent seat is not owned by the active member' using errcode = '42501'; end if;

  select l.* into lease_row from public.m9r_room_leases as l
    where l.room_id = p_room_id and l.resource_key = p_resource_key for update;
  if found and lease_row.expires_at <= v_now then
    delete from public.m9r_room_leases as l where l.room_id = p_room_id and l.resource_key = p_resource_key;
    lease_row := null;
  end if;

  -- Retry of a successfully committed lease request is idempotent.
  select * into event_row from public.m9r_room_events e
    where e.room_id = p_room_id and e.actor_user_id = caller_id and e.client_event_id = p_client_event_id;
  if found then
    if event_row.kind not in ('claim', 'release')
      or event_row.payload->>'resourceKey' is distinct from p_resource_key
      or event_row.payload->>'requestAction' is distinct from p_action
      or event_row.payload->>'requestTtlMs' is distinct from p_ttl_ms::text
      or event_row.payload->>'requestPreempt' is distinct from p_preempt::text
      or event_row.actor_seat_id is distinct from p_actor_seat_id::text then
      raise exception 'room lease idempotency key was reused for a different request' using errcode = '22023';
    end if;
    select l.* into lease_row from public.m9r_room_leases as l where l.room_id = p_room_id and l.resource_key = p_resource_key;
    return query select true, 'duplicate', p_resource_key, lease_row.holder_member_id, lease_row.holder_seat_id, lease_row.expires_at, lease_row.version;
    return;
  end if;

  if p_action = 'acquire' then
    if lease_row.room_id is null then
      insert into public.m9r_room_leases (room_id, resource_key, holder_member_id, holder_seat_id, expires_at, version)
        values (p_room_id, p_resource_key, member_row.id, p_actor_seat_id, v_now + make_interval(secs => p_ttl_ms / 1000.0), 1)
        returning * into lease_row;
      acquired := true;
      result_reason := 'acquired';
      event_type := 'room.lease.acquired';
      event_status := 'held';
    elsif lease_row.holder_member_id = member_row.id and lease_row.holder_seat_id is not distinct from p_actor_seat_id then
      update public.m9r_room_leases as l set expires_at = v_now + make_interval(secs => p_ttl_ms / 1000.0), updated_at = v_now
        where l.room_id = p_room_id and l.resource_key = p_resource_key returning l.* into lease_row;
      acquired := true;
      result_reason := 'renewed';
      event_type := 'room.lease.renewed';
      event_status := 'held';
    elsif p_preempt then
      update public.m9r_room_leases as l set
        preempted_member_id = l.holder_member_id,
        preempted_seat_id = l.holder_seat_id,
        preempted_expires_at = l.expires_at,
        holder_member_id = member_row.id,
        holder_seat_id = p_actor_seat_id,
        expires_at = v_now + make_interval(secs => p_ttl_ms / 1000.0),
        version = l.version + 1,
        updated_at = v_now
      where l.room_id = p_room_id and l.resource_key = p_resource_key returning l.* into lease_row;
      acquired := true;
      result_reason := 'preempted';
      event_type := 'room.lease.preempted';
      event_status := 'preempted';
    else
      result_reason := 'lease_held';
    end if;
  else
    if lease_row.room_id is null then
      result_reason := 'lease_expired_or_missing';
    elsif lease_row.holder_member_id <> member_row.id
      or lease_row.holder_seat_id is distinct from p_actor_seat_id then
      result_reason := 'lease_held_by_another_participant';
    elsif p_actor_seat_id is null and caller_id = room_owner_id and lease_row.preempted_member_id is not null
      and lease_row.preempted_expires_at > v_now then
      select m.* into prior_member from public.m9r_room_members as m
        where m.id = lease_row.preempted_member_id and m.room_id = p_room_id and m.status = 'active';
      if found and lease_row.preempted_seat_id is not null then
        select exists (
          select 1 from public.m9r_room_agent_seats s
          where s.id = lease_row.preempted_seat_id and s.room_id = p_room_id
            and s.member_id = prior_member.id and s.status = 'active'
        ) into prior_seat_is_active;
      end if;
      if found and prior_seat_is_active then
        update public.m9r_room_leases as l set
          holder_member_id = prior_member.id,
          holder_seat_id = lease_row.preempted_seat_id,
          expires_at = lease_row.preempted_expires_at,
          preempted_member_id = null,
          preempted_seat_id = null,
          preempted_expires_at = null,
          version = l.version + 1,
          updated_at = v_now
        where l.room_id = p_room_id and l.resource_key = p_resource_key returning l.* into lease_row;
        acquired := true;
        result_reason := 'handed_back';
        event_type := 'room.lease.returned';
        event_status := 'held';
      else
        delete from public.m9r_room_leases as l where l.room_id = p_room_id and l.resource_key = p_resource_key;
        lease_row := null;
        acquired := true;
        result_reason := 'released';
        event_type := 'room.lease.released';
        event_status := 'released';
      end if;
    else
      delete from public.m9r_room_leases as l where l.room_id = p_room_id and l.resource_key = p_resource_key;
      lease_row := null;
      acquired := true;
      result_reason := 'released';
      event_type := 'room.lease.released';
      event_status := 'released';
    end if;
  end if;

  if acquired then
    event_kind := case when p_action = 'release' and result_reason <> 'handed_back' then 'release' else 'claim' end;
    event_expiry := lease_row.expires_at;
    current_holder_id := case when lease_row.room_id is null then null
      when lease_row.holder_seat_id is null then 'member:' || lease_row.holder_member_id::text
      else 'seat:' || lease_row.holder_seat_id::text end;
    event_payload := jsonb_build_object(
      'type', event_type,
      'resourceKey', p_resource_key,
      'scope', jsonb_build_object('kind', split_part(p_resource_key, ':', 1), 'key', split_part(p_resource_key, ':', 2)),
      'status', event_status,
      'expiresAt', event_expiry,
      'holderActorId', current_holder_id,
      'requestAction', p_action,
      'requestTtlMs', p_ttl_ms,
      'requestPreempt', p_preempt
    );
    if current_holder_id is null then event_payload := event_payload - 'holderActorId' - 'expiresAt'; end if;
    insert into public.m9r_room_events (
      room_id, actor_user_id, actor_seat_id, kind, causal_event_ids, payload_digest, payload, client_event_id
    ) values (
      p_room_id, caller_id, p_actor_seat_id::text, event_kind, '{}',
      encode(digest(event_payload::text, 'sha256'), 'hex'), event_payload, p_client_event_id
    );
  end if;

  return query select acquired, result_reason, p_resource_key, lease_row.holder_member_id,
    lease_row.holder_seat_id, lease_row.expires_at, lease_row.version;
end;
$$;
revoke all on function public.act_m9r_room_lease(uuid, text, text, uuid, integer, boolean, uuid) from public;
grant execute on function public.act_m9r_room_lease(uuid, text, text, uuid, integer, boolean, uuid) to authenticated;

-- Ensure a task update cannot race past an active holder lease, even for a
-- direct PostgREST RPC caller that bypasses the web UI.
-- (The trigger above tests the same room/resource lease row that acquisition locks.)

-- A handoff is a transactional state change, not a chat-shaped event. This RPC
-- validates each transition, records it, and transfers task ownership/lease in
-- the same transaction when the receiving participant accepts.
create or replace function public.act_m9r_room_handoff(
  p_room_id uuid,
  p_handoff_id uuid,
  p_task_id uuid,
  p_action text,
  p_actor_seat_id uuid,
  p_recipient_actor_id text,
  p_context text,
  p_done_criteria jsonb,
  p_response text,
  p_client_event_id uuid
)
returns table (
  ok boolean,
  reason text,
  handoff_event_id uuid,
  sequence bigint,
  handoff_status text,
  task_event_id uuid,
  lease_expires_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_id uuid := auth.uid();
  member_row public.m9r_room_members%rowtype;
  recipient_member public.m9r_room_members%rowtype;
  initiator_member public.m9r_room_members%rowtype;
  latest_row public.m9r_room_events%rowtype;
  proposal_row public.m9r_room_events%rowtype;
  existing_row public.m9r_room_events%rowtype;
  task_row public.m9r_room_events%rowtype;
  event_row public.m9r_room_events%rowtype;
  task_event_row public.m9r_room_events%rowtype;
  lease_row public.m9r_room_leases%rowtype;
  room_owner_id uuid;
  actor_id text;
  initiator_actor_id text;
  recipient_id text := p_recipient_actor_id;
  expected_actor_id text;
  latest_type text;
  result_status text;
  task_resource text := 'task:' || coalesce(p_task_id::text, '');
  event_payload jsonb;
  task_payload jsonb;
  lease_payload jsonb;
  lease_expiry timestamptz;
  recipient_seat_id uuid;
  criteria_invalid boolean;
  lease_active boolean := false;
begin
  if caller_id is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if p_room_id is null or p_handoff_id is null or p_task_id is null or p_client_event_id is null
    or p_action is null or p_action not in ('propose', 'accept', 'decline', 'counter', 'cancel', 'complete')
    or p_recipient_actor_id is null
    or p_recipient_actor_id !~* '^(member|seat):[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or (p_context is not null and char_length(btrim(p_context)) not between 1 and 4000)
    or (p_response is not null and char_length(btrim(p_response)) not between 1 and 2000) then
    raise exception 'room handoff request is invalid' using errcode = '22023';
  end if;
  recipient_id := lower(p_recipient_actor_id);
  if p_action = 'propose' then
    if p_context is null or p_done_criteria is null or jsonb_typeof(p_done_criteria) is distinct from 'array' then
      raise exception 'handoff proposal requires context and done criteria' using errcode = '22023';
    end if;
    if jsonb_array_length(p_done_criteria) not between 1 and 16 then raise exception 'handoff done criteria are invalid' using errcode = '22023'; end if;
    select exists (
      select 1 from jsonb_array_elements(p_done_criteria) as criteria(item)
      where jsonb_typeof(item) is distinct from 'string' or char_length(btrim(item #>> '{}')) not between 1 and 500
    ) into criteria_invalid;
    if criteria_invalid then raise exception 'handoff done criteria are invalid' using errcode = '22023'; end if;
  elsif p_action = 'counter' then
    if p_response is null then raise exception 'handoff counteroffer requires a response' using errcode = '22023'; end if;
    if p_done_criteria is not null then
      if jsonb_typeof(p_done_criteria) is distinct from 'array' then raise exception 'handoff done criteria are invalid' using errcode = '22023'; end if;
      if jsonb_array_length(p_done_criteria) not between 1 and 16 then raise exception 'handoff done criteria are invalid' using errcode = '22023'; end if;
      select exists (
        select 1 from jsonb_array_elements(p_done_criteria) as criteria(item)
        where jsonb_typeof(item) is distinct from 'string' or char_length(btrim(item #>> '{}')) not between 1 and 500
      ) into criteria_invalid;
      if criteria_invalid then raise exception 'handoff done criteria are invalid' using errcode = '22023'; end if;
    end if;
  elsif p_context is not null or p_done_criteria is not null then
    raise exception 'only a proposal or counteroffer can change handoff terms' using errcode = '22023';
  end if;

  if split_part(recipient_id, ':', 2) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'room handoff recipient is invalid' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_room_id::text, 0));
  select * into member_row from public.m9r_room_members
    where room_id = p_room_id and user_id = caller_id and status = 'active';
  if not found then raise exception 'room membership required' using errcode = '42501'; end if;
  select r.created_by into room_owner_id from public.m9r_rooms r
    where r.id = p_room_id and r.status not in ('closed', 'revoked');
  if room_owner_id is null then raise exception 'room not found' using errcode = 'P0002'; end if;
  if split_part(recipient_id, ':', 1) = 'member' then
    select * into recipient_member from public.m9r_room_members
      where id = split_part(recipient_id, ':', 2)::uuid and room_id = p_room_id and status = 'active';
    if not found then raise exception 'room handoff recipient is not active' using errcode = '22023'; end if;
  else
    recipient_seat_id := split_part(recipient_id, ':', 2)::uuid;
    select m.* into recipient_member from public.m9r_room_agent_seats s
      join public.m9r_room_members m on m.id = s.member_id
      where s.id = recipient_seat_id and s.room_id = p_room_id and s.status = 'active' and m.status = 'active';
    if not found then raise exception 'room handoff recipient agent is not active' using errcode = '22023'; end if;
  end if;
  if p_actor_seat_id is not null and not exists (
    select 1 from public.m9r_room_agent_seats s
    where s.id = p_actor_seat_id and s.room_id = p_room_id and s.member_id = member_row.id and s.status = 'active'
  ) then raise exception 'agent seat is not owned by the active member' using errcode = '42501'; end if;
  actor_id := case when p_actor_seat_id is null then 'member:' || member_row.id::text else 'seat:' || p_actor_seat_id::text end;

  select * into existing_row from public.m9r_room_events e
    where e.room_id = p_room_id and e.actor_user_id = caller_id and e.client_event_id = p_client_event_id;
  if found then
    if existing_row.kind <> 'handoff'
      or existing_row.payload->>'handoffId' is distinct from p_handoff_id::text
      or existing_row.payload->>'taskId' is distinct from p_task_id::text
      or existing_row.payload->>'recipientActorId' is distinct from recipient_id
      or existing_row.payload->>'type' is distinct from case p_action when 'propose' then 'proposed' when 'accept' then 'accepted' when 'decline' then 'declined' when 'counter' then 'countered' when 'cancel' then 'cancelled' else 'completed' end
      or existing_row.payload->>'context' is distinct from nullif(btrim(p_context), '')
      or existing_row.payload->>'response' is distinct from nullif(btrim(p_response), '')
      or existing_row.payload->'doneCriteria' is distinct from p_done_criteria
      or existing_row.actor_seat_id is distinct from p_actor_seat_id::text then
      raise exception 'room handoff idempotency key was reused for a different request' using errcode = '22023';
    end if;
    return query select true, 'duplicate', existing_row.id, existing_row.sequence,
      existing_row.payload->>'type', null::uuid, null::timestamptz;
    return;
  end if;

  select * into task_row from public.m9r_room_events e
    where e.room_id = p_room_id and e.kind = 'task' and e.payload->>'taskId' = p_task_id::text
    order by e.sequence desc limit 1;
  if not found or task_row.payload->>'status' in ('done', 'cancelled') then
    raise exception 'active room task not found' using errcode = 'P0002';
  end if;

  select * into latest_row from public.m9r_room_events e
    where e.room_id = p_room_id and e.kind = 'handoff' and e.payload->>'handoffId' = p_handoff_id::text
    order by e.sequence desc limit 1;
  if p_action = 'propose' then
    if latest_row.id is not null then raise exception 'handoff identity already exists' using errcode = '22023'; end if;
    if actor_id = recipient_id then raise exception 'a handoff must have a different recipient' using errcode = '22023'; end if;
    select * into lease_row from public.m9r_room_leases
      where room_id = p_room_id and resource_key = task_resource for update;
    if found and lease_row.expires_at > clock_timestamp() and (
      lease_row.holder_member_id <> member_row.id or lease_row.holder_seat_id is distinct from p_actor_seat_id
      or lease_row.preempted_member_id is not null
    ) then raise exception 'only the current task holder can propose a handoff' using errcode = '55P03'; end if;
    result_status := 'proposed';
  else
    if latest_row.id is null or latest_row.payload->>'taskId' is distinct from p_task_id::text
      or latest_row.payload->>'recipientActorId' is distinct from recipient_id then
      raise exception 'handoff state or recipient does not match' using errcode = '22023';
    end if;
    latest_type := latest_row.payload->>'type';
    select * into proposal_row from public.m9r_room_events e
      where e.room_id = p_room_id and e.kind = 'handoff' and e.payload->>'handoffId' = p_handoff_id::text and e.payload->>'type' = 'proposed'
      order by e.sequence asc limit 1;
    select * into initiator_member from public.m9r_room_members
      where room_id = p_room_id and user_id = proposal_row.actor_user_id and status = 'active';
    if not found then
      initiator_actor_id := null;
    else
      initiator_actor_id := case when proposal_row.actor_seat_id is null then 'member:' || initiator_member.id::text else 'seat:' || proposal_row.actor_seat_id::text end;
    end if;
    if latest_type in ('declined', 'cancelled', 'completed') then raise exception 'handoff is already terminal' using errcode = '22023'; end if;
    if latest_type = 'accepted' and p_action <> 'complete' then raise exception 'accepted handoff can only be completed' using errcode = '22023'; end if;
    if p_action = 'complete' then
      if latest_type <> 'accepted' or actor_id <> recipient_id then raise exception 'only the accepted recipient can complete the handoff' using errcode = '42501'; end if;
      result_status := 'completed';
    elsif p_action = 'cancel' then
      if latest_type not in ('proposed', 'countered') or (
        actor_id is distinct from initiator_actor_id
        and not (caller_id = room_owner_id and p_actor_seat_id is null)
      ) then
        raise exception 'only the sender or room owner can cancel a pending handoff' using errcode = '42501';
      end if;
      result_status := 'cancelled';
    else
      if latest_type not in ('proposed', 'countered') then raise exception 'handoff cannot transition from its current state' using errcode = '22023'; end if;
      if latest_type = 'proposed' then
        expected_actor_id := recipient_id;
      else
        select * into initiator_member from public.m9r_room_members
          where room_id = p_room_id and user_id = latest_row.actor_user_id and status = 'active';
        expected_actor_id := case when latest_row.actor_seat_id is null then 'member:' || initiator_member.id::text else 'seat:' || latest_row.actor_seat_id::text end;
        if expected_actor_id = recipient_id then expected_actor_id := initiator_actor_id; else expected_actor_id := recipient_id; end if;
      end if;
      if actor_id is distinct from expected_actor_id then raise exception 'handoff recipient must answer in turn' using errcode = '42501'; end if;
      result_status := case p_action when 'accept' then 'accepted' when 'decline' then 'declined' else 'countered' end;
    end if;
  end if;

  event_payload := jsonb_build_object(
    'type', result_status,
    'handoffId', p_handoff_id,
    'taskId', p_task_id,
    'recipientActorId', recipient_id,
    'actorId', actor_id,
    'senderActorId', case when p_action = 'propose' then actor_id else initiator_actor_id end
  );
  if p_context is not null then event_payload := event_payload || jsonb_build_object('context', btrim(p_context)); end if;
  if p_done_criteria is not null then event_payload := event_payload || jsonb_build_object('doneCriteria', p_done_criteria); end if;
  if p_response is not null then event_payload := event_payload || jsonb_build_object('response', btrim(p_response)); end if;
  insert into public.m9r_room_events (room_id, actor_user_id, actor_seat_id, kind, causal_event_ids, payload_digest, payload, client_event_id)
    values (p_room_id, caller_id, p_actor_seat_id::text, 'handoff', array[task_row.id], encode(digest(event_payload::text, 'sha256'), 'hex'), event_payload, p_client_event_id)
    returning * into event_row;

  if p_action = 'accept' then
    if initiator_member.id is null then raise exception 'handoff sender is no longer active' using errcode = '42501'; end if;
    if proposal_row.actor_seat_id is not null and not exists (
      select 1 from public.m9r_room_agent_seats s where s.id = proposal_row.actor_seat_id
        and s.room_id = p_room_id and s.member_id = initiator_member.id and s.status = 'active'
    ) then raise exception 'handoff sender agent is no longer active' using errcode = '42501'; end if;
    select * into lease_row from public.m9r_room_leases
      where room_id = p_room_id and resource_key = task_resource for update;
    if found and lease_row.expires_at <= clock_timestamp() then
      delete from public.m9r_room_leases where room_id = p_room_id and resource_key = task_resource;
      lease_row := null;
    end if;
    if lease_row.room_id is not null and (
      lease_row.preempted_member_id is not null
      or lease_row.holder_member_id <> initiator_member.id
      or lease_row.holder_seat_id is distinct from proposal_row.actor_seat_id
      ) then raise exception 'task lease changed while the handoff was pending' using errcode = '55P03'; end if;
    lease_expiry := case when lease_row.room_id is null then clock_timestamp() + interval '30 seconds' else lease_row.expires_at end;
    if lease_row.room_id is null then
      insert into public.m9r_room_leases (room_id, resource_key, holder_member_id, holder_seat_id, expires_at, version)
        values (p_room_id, task_resource, recipient_member.id, recipient_seat_id, lease_expiry, 1)
        returning * into lease_row;
    else
      update public.m9r_room_leases set holder_member_id = recipient_member.id, holder_seat_id = recipient_seat_id,
        expires_at = lease_expiry, version = version + 1, updated_at = clock_timestamp()
        where room_id = p_room_id and resource_key = task_resource returning * into lease_row;
    end if;
    lease_payload := jsonb_build_object(
      'type', 'room.lease.handoff', 'resourceKey', task_resource,
      'scope', jsonb_build_object('kind', 'task', 'key', p_task_id::text), 'status', 'held',
      'expiresAt', lease_row.expires_at, 'holderActorId', recipient_id,
      'handoffId', p_handoff_id
    );
    insert into public.m9r_room_events (room_id, actor_user_id, actor_seat_id, kind, causal_event_ids, payload_digest, payload, client_event_id)
      values (p_room_id, caller_id, p_actor_seat_id::text, 'claim', array[event_row.id], encode(digest(lease_payload::text, 'sha256'), 'hex'), lease_payload, gen_random_uuid());
    task_payload := jsonb_build_object('type', 'assigned', 'taskId', p_task_id, 'status', 'claimed', 'assigneeActorId', recipient_id);
    insert into public.m9r_room_events (room_id, actor_user_id, actor_seat_id, kind, causal_event_ids, payload_digest, payload, client_event_id)
      values (p_room_id, caller_id, p_actor_seat_id::text, 'task', array[event_row.id], encode(digest(task_payload::text, 'sha256'), 'hex'), task_payload, gen_random_uuid())
      returning * into task_event_row;
  elsif p_action = 'complete' then
    select * into lease_row from public.m9r_room_leases
      where room_id = p_room_id and resource_key = task_resource for update;
    if found and lease_row.expires_at <= clock_timestamp() then
      delete from public.m9r_room_leases where room_id = p_room_id and resource_key = task_resource;
      lease_row := null;
    end if;
    lease_active := lease_row.room_id is not null;
    if lease_active and (
      lease_row.holder_member_id <> member_row.id or lease_row.holder_seat_id is distinct from p_actor_seat_id
    ) then raise exception 'task lease is held by another participant' using errcode = '55P03'; end if;
    task_payload := jsonb_build_object('type', 'completed', 'taskId', p_task_id, 'status', 'done');
    insert into public.m9r_room_events (room_id, actor_user_id, actor_seat_id, kind, causal_event_ids, payload_digest, payload, client_event_id)
      values (p_room_id, caller_id, p_actor_seat_id::text, 'task', array[event_row.id, task_row.id], encode(digest(task_payload::text, 'sha256'), 'hex'), task_payload, gen_random_uuid())
      returning * into task_event_row;
    if lease_active then
      delete from public.m9r_room_leases where room_id = p_room_id and resource_key = task_resource;
      lease_payload := jsonb_build_object(
        'type', 'room.lease.completed', 'resourceKey', task_resource,
        'scope', jsonb_build_object('kind', 'task', 'key', p_task_id::text), 'status', 'released'
      );
      insert into public.m9r_room_events (room_id, actor_user_id, actor_seat_id, kind, causal_event_ids, payload_digest, payload, client_event_id)
        values (p_room_id, caller_id, p_actor_seat_id::text, 'release', array[task_event_row.id], encode(digest(lease_payload::text, 'sha256'), 'hex'), lease_payload, gen_random_uuid());
    end if;
  end if;

  return query select true, 'ok', event_row.id, event_row.sequence, result_status,
    task_event_row.id, lease_expiry;
end;
$$;
revoke all on function public.act_m9r_room_handoff(uuid, uuid, uuid, text, uuid, text, text, jsonb, text, uuid) from public;
grant execute on function public.act_m9r_room_handoff(uuid, uuid, uuid, text, uuid, text, text, jsonb, text, uuid) to authenticated;

-- Publish the current coordination lease rows for live holder changes. The
-- durable operation history remains m9r_room_events.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
    and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'm9r_room_leases') then
    execute 'alter publication supabase_realtime add table public.m9r_room_leases';
  end if;
end;
$$;
