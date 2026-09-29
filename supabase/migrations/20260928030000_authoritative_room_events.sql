-- Generic event appends must not be able to impersonate decisions made by
-- dedicated transactional membership, disclosure, and handoff workflows.
-- Keep the original implementation as a private helper and expose a guarded
-- authenticated entry point with the same PostgREST signature.

alter function public.append_m9r_room_event(uuid, text, uuid, uuid[], text, jsonb, uuid)
  rename to append_m9r_room_event_internal;

revoke all on function public.append_m9r_room_event_internal(uuid, text, uuid, uuid[], text, jsonb, uuid)
  from public, anon, authenticated;

create function public.append_m9r_room_event(
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
begin
  if p_kind is null or p_kind not in ('action', 'post', 'ask', 'reply', 'share', 'task', 'artifact') then
    raise exception 'room event kind requires a purpose-built authority workflow' using errcode = '22023';
  end if;

  if p_kind = 'action' and (
    p_payload->>'type' is distinct from 'shared_target.confirmed'
    or p_payload->'owner_confirmed' is distinct from 'true'::jsonb
    or jsonb_typeof(p_payload->'target') is distinct from 'object'
    or not (p_payload->'target' ?& array['pageGroupId', 'origin', 'path', 'tabRef'])
    or exists (
      select 1 from jsonb_object_keys(p_payload) as entries(key)
      where key not in ('type', 'owner_confirmed', 'target')
    )
  ) then
    raise exception 'shared target actions require an explicit human-owner confirmation' using errcode = '22023';
  end if;

  -- Agent-attributed room text is a disclosure boundary.  The receipt must
  -- match the exact proposed text, room audience, owning seat, room, and the
  -- authenticated owner.  Keep this in the public wrapper so callers cannot
  -- bypass it by invoking the private implementation directly.
  if p_actor_seat_id is not null and p_payload ? 'text' and not exists (
    select 1
      from public.m9r_disclosure_receipts receipt
      join public.m9r_disclosure_requests request on request.id = receipt.request_id
     where receipt.room_id = p_room_id
       and receipt.owner_id = auth.uid()
       and receipt.decision = 'approved'
       and receipt.audience in ('room', 'members')
       and receipt.payload_digest = encode(digest(convert_to(p_payload->>'text', 'UTF8'), 'sha256'), 'hex')
       and request.room_id = p_room_id
       and request.owner_id = auth.uid()
       and request.agent_seat_id = p_actor_seat_id::text
       and request.state = 'approved'
       and request.expires_at > now()
  ) then
    raise exception 'approved disclosure receipt required for agent room text' using errcode = '42501';
  end if;

  return query
    select * from public.append_m9r_room_event_internal(
      p_room_id, p_kind, p_actor_seat_id, p_causal_event_ids,
      p_payload_digest, p_payload, p_client_event_id
    );
end;
$$;

revoke all on function public.append_m9r_room_event(uuid, text, uuid, uuid[], text, jsonb, uuid)
  from public, anon;
grant execute on function public.append_m9r_room_event(uuid, text, uuid, uuid[], text, jsonb, uuid)
  to authenticated;

comment on function public.append_m9r_room_event_internal(uuid, text, uuid, uuid[], text, jsonb, uuid)
  is 'Private implementation; callers must use the public guarded append_m9r_room_event entry point.';

notify pgrst, 'reload schema';
