-- Extend the existing room lease RPC for opaque, machine-local desktop/window labels.
-- These identifiers coordinate room ownership only; they never grant machine access.
-- Replaces the lease function without changing its transaction, authorization, or event behavior.

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
#variable_conflict use_column
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
    or p_resource_key !~* '^(task:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|browser:[a-z0-9:_-]{1,160}|desktop:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|window:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$' then
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
      encode(extensions.digest(event_payload::text, 'sha256'), 'hex'), event_payload, p_client_event_id
    );
  end if;

  return query select acquired, result_reason, p_resource_key, lease_row.holder_member_id,
    lease_row.holder_seat_id, lease_row.expires_at, lease_row.version;
end;
$$;
revoke all on function public.act_m9r_room_lease(uuid, text, text, uuid, integer, boolean, uuid) from public;
grant execute on function public.act_m9r_room_lease(uuid, text, text, uuid, integer, boolean, uuid) to authenticated;
