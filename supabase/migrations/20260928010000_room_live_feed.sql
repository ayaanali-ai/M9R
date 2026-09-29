-- Durable room activity plus authenticated, ephemeral room presence.
-- Presence never enters m9r_room_events. The event table is the source of truth
-- for messages and coordination facts, ordered per room under an advisory lock.
-- A requested member stays quiet until admission because both Realtime policies
-- and the event table's SELECT policy require active membership.

alter table public.m9r_room_events
  add column if not exists client_event_id uuid;

create unique index if not exists m9r_room_events_client_event_idx
  on public.m9r_room_events (room_id, actor_user_id, client_event_id)
  where client_event_id is not null;

alter table public.m9r_room_events drop constraint if exists m9r_room_events_kind_check;
alter table public.m9r_room_events add constraint m9r_room_events_kind_check
  check (kind in ('action', 'post', 'ask', 'reply', 'share', 'approval', 'disclosure', 'membership', 'presence', 'claim', 'release', 'task', 'handoff', 'intent', 'artifact'));

drop function if exists public.append_m9r_room_event(uuid, text, uuid, uuid[], text, jsonb);

create or replace function public.append_m9r_room_event(
  p_room_id uuid,
  p_kind text,
  p_actor_seat_id uuid,
  p_causal_event_ids uuid[],
  p_payload_digest text,
  p_payload jsonb,
  p_client_event_id uuid
)
returns table (
  event_id uuid,
  sequence bigint,
  room_id uuid,
  actor_user_id uuid,
  actor_seat_id text,
  kind text,
  causal_event_ids uuid[],
  payload_digest text,
  payload jsonb,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_id uuid := auth.uid();
  member_row public.m9r_room_members%rowtype;
  event_row public.m9r_room_events%rowtype;
  computed_payload_digest text;
  release_payload jsonb;
  released_lease_count integer := 0;
  task_resource text;
  latest_artifact_event_id uuid;
  string_key text;
  allowed_keys text[] := array[
    'type', 'text', 'recipientActorId', 'replyTo', 'taskId', 'title', 'goal', 'doneCriteria',
    'status', 'assigneeActorId', 'handoffId', 'context', 'response', 'intentId', 'decision',
    'summary', 'action', 'pageGroupId', 'origin', 'path', 'tabRef', 'claimId', 'artifactRef',
    'label', 'owner_confirmed', 'target', 'scope', 'resourceKey', 'holderActorId', 'expiresAt',
    'artifactId', 'baseEventId', 'content'
  ];
begin
  if caller_id is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if p_room_id is null or p_client_event_id is null then raise exception 'room event identity is invalid' using errcode = '22023'; end if;
  if p_payload_digest is null or p_payload_digest !~ '^[a-f0-9]{64}$' then raise exception 'room event digest is invalid' using errcode = '22023'; end if;
  if p_payload is null or jsonb_typeof(p_payload) is distinct from 'object' or pg_column_size(p_payload) > 12288 then
    raise exception 'room event payload is invalid or too large' using errcode = '22023';
  end if;
  computed_payload_digest := encode(digest(p_payload::text, 'sha256'), 'hex');

  -- Serialize writes for this room so the server-assigned sequence is also the
  -- committed operation order. The lock is released with the transaction.
  perform pg_advisory_xact_lock(hashtextextended(p_room_id::text, 0));

  select m.* into member_row
    from public.m9r_room_members as m
    where m.room_id = p_room_id and m.user_id = caller_id and m.status = 'active';
  if not found then raise exception 'room membership required' using errcode = '42501'; end if;
  if not exists (select 1 from public.m9r_rooms r where r.id = p_room_id and r.status not in ('closed', 'revoked')) then
    raise exception 'room not found' using errcode = 'P0002';
  end if;

  -- Retries from the same member are idempotent. The unique index is the final
  -- guard if a future write path does not take the room lock.
  select e.* into event_row from public.m9r_room_events as e
    where e.room_id = p_room_id and e.actor_user_id = caller_id and e.client_event_id = p_client_event_id;
  if found then
    if event_row.kind is distinct from p_kind
      or event_row.actor_seat_id is distinct from p_actor_seat_id::text
      or event_row.payload_digest is distinct from computed_payload_digest
      or event_row.causal_event_ids is distinct from coalesce(p_causal_event_ids, '{}') then
      raise exception 'room event idempotency key was reused for a different event' using errcode = '22023';
    end if;
    return query select event_row.id, event_row.sequence, event_row.room_id, event_row.actor_user_id,
      event_row.actor_seat_id, event_row.kind, event_row.causal_event_ids, event_row.payload_digest,
      event_row.payload, event_row.created_at;
    return;
  end if;

  -- Claim/release facts are reserved for act_m9r_room_lease so an ordinary
  -- member cannot write a forged lease event without acquiring the lease.
  if p_kind is null or p_kind not in ('action', 'post', 'ask', 'reply', 'share', 'approval', 'disclosure', 'membership', 'task', 'intent', 'artifact') then
    raise exception 'invalid or non-persistent room event kind' using errcode = '22023';
  end if;
  if p_actor_seat_id is not null and not exists (
    select 1 from public.m9r_room_agent_seats as s
    where s.id = p_actor_seat_id and s.room_id = p_room_id and s.member_id = member_row.id and s.status = 'active'
  ) then raise exception 'agent seat is not owned by the active member' using errcode = '42501'; end if;
  if exists (select 1 from jsonb_object_keys(p_payload) as entries(key) where not (key = any(allowed_keys))) then
    raise exception 'room event payload contains a non-shareable field' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_payload) as entries(key)
    where key in ('type', 'text', 'recipientActorId', 'replyTo', 'taskId', 'title', 'goal', 'status', 'assigneeActorId', 'handoffId', 'context', 'response', 'intentId', 'decision', 'summary', 'action', 'pageGroupId', 'origin', 'path', 'tabRef', 'claimId', 'artifactRef', 'label', 'resourceKey', 'holderActorId', 'expiresAt', 'artifactId', 'baseEventId', 'content')
      and jsonb_typeof(p_payload->key) <> 'string'
  ) then raise exception 'room event fields must be strings' using errcode = '22023'; end if;
  foreach string_key in array array['type', 'text', 'recipientActorId', 'replyTo', 'taskId', 'title', 'goal', 'status', 'assigneeActorId', 'handoffId', 'context', 'response', 'intentId', 'decision', 'summary', 'action', 'pageGroupId', 'origin', 'path', 'tabRef', 'claimId', 'artifactRef', 'label', 'resourceKey', 'holderActorId', 'expiresAt', 'artifactId', 'baseEventId', 'content'] loop
    if p_payload ? string_key and char_length(p_payload->>string_key) > case string_key when 'text' then 4000 when 'goal' then 4000 when 'context' then 4000 when 'summary' then 1000 when 'title' then 160 when 'response' then 2000 when 'resourceKey' then 180 when 'content' then 8000 else 512 end then
      raise exception 'room event field is too long' using errcode = '22023';
    end if;
  end loop;
  if p_payload ? 'owner_confirmed' and (jsonb_typeof(p_payload->'owner_confirmed') <> 'boolean' or p_payload->>'owner_confirmed' <> 'true') then
    raise exception 'room owner confirmation must be explicit' using errcode = '22023';
  end if;
  if p_payload ? 'owner_confirmed' and not exists (
    select 1 from public.m9r_rooms r join public.m9r_room_members owner_member on owner_member.room_id = r.id
    where r.id = p_room_id and r.created_by = caller_id and owner_member.user_id = caller_id
      and owner_member.id = member_row.id and owner_member.role = 'owner' and owner_member.status = 'active'
  ) then raise exception 'only the room owner can confirm shared browser targets' using errcode = '42501'; end if;
  if p_payload ? 'target' then
    if jsonb_typeof(p_payload->'target') is distinct from 'object' then raise exception 'room event target is invalid' using errcode = '22023'; end if;
    if exists (select 1 from jsonb_object_keys(p_payload->'target') as entries(key) where key not in ('pageGroupId', 'origin', 'path', 'tabRef'))
      or exists (select 1 from jsonb_each(p_payload->'target') as entries(key, value) where jsonb_typeof(value) is distinct from 'string' or char_length(value #>> '{}') > 512) then
      raise exception 'room event target is invalid' using errcode = '22023';
    end if;
  end if;
  if p_payload ? 'scope' then
    if jsonb_typeof(p_payload->'scope') is distinct from 'object' then raise exception 'room event scope is invalid' using errcode = '22023'; end if;
    if exists (select 1 from jsonb_object_keys(p_payload->'scope') as entries(key) where key not in ('kind', 'key'))
      or exists (select 1 from jsonb_each(p_payload->'scope') as entries(key, value) where jsonb_typeof(value) is distinct from 'string' or char_length(value #>> '{}') > 256) then
      raise exception 'room event scope is invalid' using errcode = '22023';
    end if;
  end if;
  if exists (
    select 1 from unnest(coalesce(p_causal_event_ids, '{}')) as refs(causal_id)
    where not exists (select 1 from public.m9r_room_events e where e.id = causal_id and e.room_id = p_room_id)
  ) then raise exception 'causal event must belong to this room' using errcode = '22023'; end if;

  if p_kind in ('post', 'ask', 'reply') then
    if jsonb_typeof(p_payload->'text') is distinct from 'string'
      or char_length(btrim(p_payload->>'text')) not between 1 and 4000 then
      raise exception 'room message text is invalid' using errcode = '22023';
    end if;
  end if;
  if p_kind = 'task' then
    if coalesce(p_payload->>'taskId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', true)
      or coalesce(p_payload->>'type' not in ('created', 'updated', 'completed', 'cancelled', 'blocked'), true) then
      raise exception 'room task event is invalid' using errcode = '22023';
    end if;
    if p_payload ? 'title' and (jsonb_typeof(p_payload->'title') <> 'string' or char_length(btrim(p_payload->>'title')) not between 1 and 160) then
      raise exception 'room task title is invalid' using errcode = '22023';
    end if;
    if p_payload ? 'goal' and (jsonb_typeof(p_payload->'goal') <> 'string' or char_length(btrim(p_payload->>'goal')) not between 1 and 4000) then
      raise exception 'room task goal is invalid' using errcode = '22023';
    end if;
    if p_payload ? 'doneCriteria' then
      if jsonb_typeof(p_payload->'doneCriteria') <> 'array' then raise exception 'room task done criteria are invalid' using errcode = '22023'; end if;
      if jsonb_array_length(p_payload->'doneCriteria') not between 1 and 16
        or exists (select 1 from jsonb_array_elements(p_payload->'doneCriteria') as entries(item) where jsonb_typeof(item) <> 'string' or char_length(btrim(item #>> '{}')) not between 1 and 500) then
        raise exception 'room task done criteria are invalid' using errcode = '22023';
      end if;
    end if;
    if p_payload->>'type' = 'created' and not (p_payload ? 'title' and p_payload ? 'goal' and p_payload ? 'doneCriteria') then
      raise exception 'created room task requires a title, goal, and done criteria' using errcode = '22023';
    end if;
    if p_payload ? 'status' and p_payload->>'status' not in ('open', 'claimed', 'blocked', 'done', 'cancelled') then
      raise exception 'room task status is invalid' using errcode = '22023';
    end if;
    if (p_payload->>'type' = 'completed' and p_payload->>'status' is distinct from 'done')
      or (p_payload->>'type' = 'cancelled' and p_payload->>'status' is distinct from 'cancelled')
      or (p_payload->>'type' = 'blocked' and p_payload->>'status' is distinct from 'blocked')
      or (p_payload->>'type' = 'created' and p_payload->>'status' is distinct from 'open') then
      raise exception 'room task type and status disagree' using errcode = '22023';
    end if;
    if p_payload ? 'assigneeActorId' then raise exception 'task assignment must use an accepted handoff' using errcode = '22023'; end if;
  end if;
  if p_kind = 'artifact' then
    if coalesce(p_payload->>'type' not in ('created', 'updated'), true)
      or coalesce(p_payload->>'artifactId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', true)
      or jsonb_typeof(p_payload->'title') is distinct from 'string'
      or char_length(btrim(p_payload->>'title')) not between 1 and 160
      or p_payload->>'title' is distinct from btrim(p_payload->>'title')
      or jsonb_typeof(p_payload->'content') is distinct from 'string'
      or octet_length(p_payload->>'content') > 8000 then
      raise exception 'room artifact snapshot is invalid or too large' using errcode = '22023';
    end if;
    if p_payload->>'type' = 'created' then
      if p_payload ? 'baseEventId' or exists (
        select 1 from public.m9r_room_events e
        where e.room_id = p_room_id and e.kind = 'artifact' and e.payload->>'artifactId' = p_payload->>'artifactId'
      ) then raise exception 'room artifact identity already exists' using errcode = '22023'; end if;
    else
      if coalesce(p_payload->>'baseEventId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', true)
        or not ((p_payload->>'baseEventId')::uuid = any(coalesce(p_causal_event_ids, '{}'))) then
        raise exception 'room artifact edit must cite its base version' using errcode = '22023';
      end if;
      select e.id into latest_artifact_event_id from public.m9r_room_events e
        where e.room_id = p_room_id and e.kind = 'artifact' and e.payload->>'artifactId' = p_payload->>'artifactId'
        order by e.sequence desc limit 1;
      if latest_artifact_event_id is distinct from (p_payload->>'baseEventId')::uuid then
        raise exception 'artifact version changed since it was read' using errcode = '40001';
      end if;
    end if;
  end if;
  if p_kind = 'handoff' then
    if coalesce(p_payload->>'handoffId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', true)
      or coalesce(p_payload->>'taskId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', true)
      or coalesce(p_payload->>'recipientActorId' !~* '^(member|seat):[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', true)
      or coalesce(p_payload->>'type' not in ('proposed', 'accepted', 'declined', 'countered', 'cancelled', 'completed'), true) then
      raise exception 'room handoff event is invalid' using errcode = '22023';
    end if;
    if p_payload->>'type' = 'proposed' then
      if jsonb_typeof(p_payload->'context') is distinct from 'string'
        or char_length(btrim(p_payload->>'context')) not between 1 and 4000
        or jsonb_typeof(p_payload->'doneCriteria') is distinct from 'array' then
        raise exception 'room handoff requires bounded context and done criteria' using errcode = '22023';
      end if;
      if jsonb_array_length(p_payload->'doneCriteria') not between 1 and 16
        or exists (select 1 from jsonb_array_elements(p_payload->'doneCriteria') as entries(item) where jsonb_typeof(item) <> 'string' or char_length(btrim(item #>> '{}')) not between 1 and 500) then
        raise exception 'room handoff done criteria are invalid' using errcode = '22023';
      end if;
    end if;
  end if;

  if p_payload ? 'recipientActorId' and p_payload->>'recipientActorId' !~* '^(member|seat):[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'room recipient identity is invalid' using errcode = '22023';
  end if;
  if p_payload ? 'holderActorId' and p_payload->>'holderActorId' !~* '^(member|seat):[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'room lease holder identity is invalid' using errcode = '22023';
  end if;

  insert into public.m9r_room_events (room_id, actor_user_id, actor_seat_id, kind, causal_event_ids, payload_digest, payload, client_event_id)
    values (p_room_id, caller_id, p_actor_seat_id::text, p_kind, coalesce(p_causal_event_ids, '{}'), computed_payload_digest, p_payload, p_client_event_id)
    returning * into event_row;

  -- Completing/cancelling a task releases its own live lease in the same
  -- transaction and records the release; a conflicting active holder was
  -- already rejected by the before-insert lease trigger.
  if p_kind = 'task' and (p_payload->>'status' in ('done', 'cancelled') or p_payload->>'type' in ('completed', 'cancelled')) then
    task_resource := 'task:' || (p_payload->>'taskId');
    delete from public.m9r_room_leases l
      where l.room_id = p_room_id and l.resource_key = task_resource
        and (l.expires_at <= clock_timestamp()
          or (l.holder_member_id = member_row.id and l.holder_seat_id is not distinct from p_actor_seat_id));
    get diagnostics released_lease_count = row_count;
    if released_lease_count > 0 then
      release_payload := jsonb_build_object(
        'type', case when p_payload->>'status' = 'done' or p_payload->>'type' = 'completed' then 'room.lease.task_completed' else 'room.lease.task_cancelled' end,
        'resourceKey', task_resource,
        'scope', jsonb_build_object('kind', 'task', 'key', p_payload->>'taskId'),
        'status', 'released'
      );
      insert into public.m9r_room_events (room_id, actor_user_id, actor_seat_id, kind, causal_event_ids, payload_digest, payload, client_event_id)
        values (p_room_id, caller_id, p_actor_seat_id::text, 'release', array[event_row.id], encode(digest(release_payload::text, 'sha256'), 'hex'), release_payload, gen_random_uuid());
    end if;
  end if;

  return query select event_row.id, event_row.sequence, event_row.room_id, event_row.actor_user_id,
    event_row.actor_seat_id, event_row.kind, event_row.causal_event_ids, event_row.payload_digest,
    event_row.payload, event_row.created_at;
end;
$$;
revoke all on function public.append_m9r_room_event(uuid, text, uuid, uuid[], text, jsonb, uuid) from public;
grant execute on function public.append_m9r_room_event(uuid, text, uuid, uuid[], text, jsonb, uuid) to authenticated;

-- Supabase Postgres Changes only publishes tables explicitly in this publication.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
    and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'm9r_room_events') then
    execute 'alter publication supabase_realtime add table public.m9r_room_events';
  end if;
end;
$$;

-- The browser page shares only anonymous room presence metadata. It is never
-- written to application tables and membership is rechecked by both RLS rules.
drop policy if exists "active m9r room members can read room presence" on realtime.messages;
create policy "active m9r room members can read room presence"
on realtime.messages for select to authenticated
using (
  extension = 'presence'
  and realtime.topic() ~ '^m9r-room-presence:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  and exists (
    select 1 from public.m9r_room_members m
    where m.room_id = substring(realtime.topic() from 19)::uuid
      and m.user_id = (select auth.uid()) and m.status = 'active'
  )
);

drop policy if exists "active m9r room members can publish room presence" on realtime.messages;
create policy "active m9r room members can publish room presence"
on realtime.messages for insert to authenticated
with check (
  extension = 'presence'
  and realtime.topic() ~ '^m9r-room-presence:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  and exists (
    select 1 from public.m9r_room_members m
    where m.room_id = substring(realtime.topic() from 19)::uuid
      and m.user_id = (select auth.uid()) and m.status = 'active'
  )
);
