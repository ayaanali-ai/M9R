-- Fix two defects found by `supabase db lint --linked` after the Mission
-- runtime migrations were first exercised against live Postgres.

create or replace function public.apply_mission_command_atomic(
  p_mission_id text,
  p_workspace_id text,
  p_idempotency_key text,
  p_command_type text,
  p_payload_digest text,
  p_expected_version integer,
  p_events jsonb,
  p_result jsonb,
  p_repository_id text default null
)
returns table (
  status text,
  current_version integer,
  latest_event_id text,
  stored_result jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.mission_command_outcomes%rowtype;
  v_current_version integer;
  v_next_version integer;
  v_event jsonb;
  v_latest_event_id text;
  v_mission_workspace_id text;
begin
  select * into v_existing
  from public.mission_command_outcomes
  where workspace_id = p_workspace_id and idempotency_key = p_idempotency_key;

  if found then
    if v_existing.command_type <> p_command_type or (v_existing.result ->> 'payloadDigest') <> p_payload_digest then
      return query select 'idempotency_conflict'::text, v_existing.aggregate_version, null::text, v_existing.result;
      return;
    end if;
    return query select 'replayed'::text, v_existing.aggregate_version, null::text, v_existing.result;
    return;
  end if;

  insert into public.missions (id, workspace_id, repository_id, current_version)
  values (p_mission_id, p_workspace_id, p_repository_id, 0)
  on conflict (id) do nothing;

  -- Qualify both columns because current_version is also an OUT parameter.
  select m.current_version, m.workspace_id
  into v_current_version, v_mission_workspace_id
  from public.missions m
  where m.id = p_mission_id
  for update;

  if v_mission_workspace_id is distinct from p_workspace_id then
    return query select 'workspace_mismatch'::text, v_current_version, null::text, null::jsonb;
    return;
  end if;

  if v_current_version is distinct from p_expected_version then
    select * into v_existing
    from public.mission_command_outcomes
    where workspace_id = p_workspace_id and idempotency_key = p_idempotency_key;

    if found then
      if v_existing.command_type <> p_command_type or (v_existing.result ->> 'payloadDigest') <> p_payload_digest then
        return query select 'idempotency_conflict'::text, v_existing.aggregate_version, null::text, v_existing.result;
        return;
      end if;
      return query select 'replayed'::text, v_existing.aggregate_version, null::text, v_existing.result;
      return;
    end if;

    select me.event_id into v_latest_event_id
    from public.mission_events me
    where me.mission_id = p_mission_id
    order by me.aggregate_version desc
    limit 1;

    return query select 'version_conflict'::text, v_current_version, v_latest_event_id, null::jsonb;
    return;
  end if;

  v_next_version := v_current_version;

  for v_event in select * from jsonb_array_elements(p_events)
  loop
    v_next_version := v_next_version + 1;
    if (v_event ->> 'aggregateVersion')::integer is distinct from v_next_version then
      raise exception 'event aggregateVersion % does not match expected next version % for mission %',
        v_event ->> 'aggregateVersion', v_next_version, p_mission_id;
    end if;

    insert into public.mission_events (
      mission_id, aggregate_version, event_id, event_type, schema_version,
      actor, reason, correlation_id, causation_id, provenance, occurred_at, payload
    ) values (
      p_mission_id, v_next_version, v_event ->> 'eventId', v_event ->> 'type',
      v_event ->> 'schemaVersion', v_event -> 'actor', v_event -> 'reason',
      v_event ->> 'correlationId', v_event ->> 'causationId',
      v_event ->> 'provenance', (v_event ->> 'timestamp')::timestamptz,
      coalesce(v_event -> 'payload', '{}'::jsonb)
    );
    v_latest_event_id := v_event ->> 'eventId';
  end loop;

  update public.missions
  set current_version = v_next_version, updated_at = now()
  where id = p_mission_id;

  insert into public.mission_command_outcomes (
    workspace_id, idempotency_key, mission_id, command_type, result, aggregate_version
  ) values (
    p_workspace_id, p_idempotency_key, p_mission_id, p_command_type, p_result, v_next_version
  );

  return query select 'applied'::text, v_next_version, v_latest_event_id, p_result;
end;
$$;

revoke all on function public.apply_mission_command_atomic(text, text, text, text, text, integer, jsonb, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.apply_mission_command_atomic(text, text, text, text, text, integer, jsonb, jsonb, text)
  to service_role;

create or replace function public.claim_mission_dispatch_candidates_atomic(
  p_candidates jsonb, p_holder jsonb, p_now timestamptz, p_lease_duration_ms bigint, p_dispatchable_states text[]
)
returns table (mission_id text, dispatch_key text, status text, reason text, lease jsonb, instruction jsonb)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  c jsonb;
  a public.mission_assignment_index%rowtype;
  m public.missions%rowtype;
  l public.mission_dispatch_leases%rowtype;
  indexed_assignment public.mission_assignment_index%rowtype;
  wid text; mid text; aid text; dkey text; repository_id text; adapter text; state text;
  expected_version integer; token integer; attempt integer; expiry timestamptz; iid uuid;
begin
  if jsonb_typeof(p_candidates) <> 'array' then
    raise exception 'malformed_candidate' using errcode = '22023';
  end if;

  for c in
    select value
    from jsonb_array_elements(p_candidates) t(value)
    order by value ->> 'workspaceId', value ->> 'missionId', value ->> 'assignmentId', value ->> 'dispatchKey'
  loop
    wid := nullif(c ->> 'workspaceId', '');
    mid := nullif(c ->> 'missionId', '');
    aid := nullif(c ->> 'assignmentId', '');
    dkey := nullif(c ->> 'dispatchKey', '');
    repository_id := nullif(c ->> 'repositoryId', '');
    adapter := nullif(c ->> 'adapterRequirement', '');
    state := nullif(c ->> 'missionState', '');

    if wid is null or mid is null or dkey is null or state is null then
      return query select mid, dkey, 'refused'::text, 'invalid_candidate'::text, null::jsonb, null::jsonb; continue;
    end if;
    if aid is null then
      return query select mid, dkey, 'refused'::text, 'missing_assignment_id'::text, null::jsonb, null::jsonb; continue;
    end if;

    select * into m from public.missions where id = mid for update;
    if not found then
      return query select mid, dkey, 'refused'::text, 'mission_not_found'::text, null::jsonb, null::jsonb; continue;
    end if;
    if m.workspace_id <> wid then
      return query select mid, dkey, 'refused'::text, 'workspace_mismatch'::text, null::jsonb, null::jsonb; continue;
    end if;
    if repository_id is not null and m.repository_id is distinct from repository_id then
      return query select mid, dkey, 'refused'::text, 'repository_mismatch'::text, null::jsonb, null::jsonb; continue;
    end if;

    select * into a
    from public.mission_assignment_index
    where workspace_id = wid and mission_id = mid and assignment_id = aid
    for update;

    if not found then
      select * into indexed_assignment
      from public.mission_assignment_index
      where mission_id = mid and assignment_id = aid
      for update;
      if found then
        return query select mid, dkey, 'refused'::text, 'assignment_workspace_mismatch'::text, null::jsonb, null::jsonb; continue;
      end if;

      select * into indexed_assignment
      from public.mission_assignment_index
      where workspace_id = wid and assignment_id = aid
      for update;
      if found then
        return query select mid, dkey, 'refused'::text, 'assignment_mission_mismatch'::text, null::jsonb, null::jsonb; continue;
      end if;

      return query select mid, dkey, 'refused'::text, 'assignment_not_found'::text, null::jsonb, null::jsonb; continue;
    end if;

    if a.dispatch_key <> dkey then
      return query select mid, dkey, 'refused'::text, 'assignment_dispatch_key_mismatch'::text, null::jsonb, null::jsonb; continue;
    end if;
    if a.adapter_requirement is distinct from adapter then
      return query select mid, dkey, 'refused'::text, 'adapter_requirement_mismatch'::text, null::jsonb, null::jsonb; continue;
    end if;
    if a.assignment_status not in ('ready', 'claimed', 'running') then
      return query select mid, dkey, 'refused'::text, 'assignment_not_dispatchable'::text, null::jsonb, null::jsonb; continue;
    end if;
    if c ? 'expectedAssignmentSourceVersion' then
      expected_version := (c ->> 'expectedAssignmentSourceVersion')::integer;
      if a.source_aggregate_version <> expected_version then
        return query select mid, dkey, 'refused'::text, 'stale_assignment_projection'::text, null::jsonb, null::jsonb; continue;
      end if;
    end if;
    if not (state = any(p_dispatchable_states)) then
      return query select mid, dkey, 'refused'::text, 'not_dispatchable_state'::text, null::jsonb, null::jsonb; continue;
    end if;

    select * into l
    from public.mission_dispatch_leases
    where workspace_id = wid and mission_id = mid and dispatch_key = dkey
    for update;
    if found and l.status = 'leased' and l.expires_at > p_now and l.lease_owner <> p_holder then
      return query select mid, dkey, 'refused'::text, 'duplicate_or_already_claimed'::text, null::jsonb, null::jsonb; continue;
    end if;

    token := coalesce(l.fencing_token, 0) + 1;
    attempt := coalesce(l.attempt, 0) + 1;
    expiry := p_now + make_interval(secs => p_lease_duration_ms / 1000.0);

    insert into public.mission_dispatch_leases (
      workspace_id, mission_id, dispatch_key, repository_id, lease_id, lease_owner,
      fencing_token, status, attempt, version, acquired_at, expires_at
    ) values (
      wid, mid, dkey, m.repository_id, gen_random_uuid()::text, p_holder,
      token, 'leased', attempt, 1, p_now, expiry
    )
    on conflict (workspace_id, mission_id, dispatch_key) do update set
      repository_id = excluded.repository_id, lease_id = excluded.lease_id,
      lease_owner = excluded.lease_owner, fencing_token = excluded.fencing_token,
      status = 'leased', attempt = excluded.attempt,
      version = public.mission_dispatch_leases.version + 1,
      acquired_at = excluded.acquired_at, renewed_at = null,
      expires_at = excluded.expires_at, released_at = null, revoked_at = null,
      revoked_reason = null, updated_at = now()
    returning * into l;

    update public.mission_dispatch_intents
    set superseded_at = p_now
    where workspace_id = wid and mission_id = mid and dispatch_key = dkey
      and delivered_at is null and superseded_at is null;

    insert into public.mission_dispatch_intents (
      workspace_id, mission_id, assignment_id, dispatch_key, repository_id,
      adapter_requirement, lease_id, fencing_token, attempt, execution_constraints
    ) values (
      wid, mid, aid, dkey, m.repository_id, adapter, l.lease_id, token, attempt,
      coalesce(c -> 'executionConstraints', '{}'::jsonb)
    )
    returning id into iid;

    return query select
      mid,
      dkey,
      'claimed'::text,
      null::text,
      jsonb_build_object(
        'leaseId', l.lease_id, 'workspaceId', wid, 'missionId', mid,
        'dispatchKey', dkey, 'holder', p_holder, 'state', 'leased',
        'fencingToken', token, 'acquiredAt', p_now, 'expiresAt', expiry,
        'renewedAt', null, 'releasedAt', null, 'revokedReason', null
      ),
      jsonb_build_object(
        'instructionId', iid, 'missionId', mid, 'workspaceId', wid,
        'assignmentId', aid, 'repositoryId', m.repository_id,
        'dispatchKey', dkey, 'adapterRequirement', adapter,
        'leaseId', l.lease_id, 'fencingToken', token, 'attempt', attempt,
        'executionConstraints', coalesce(c -> 'executionConstraints', '{}'::jsonb),
        'createdAt', p_now, 'deliveredAt', null, 'supersededAt', null,
        'processHandle', null
      );
  end loop;
end;
$$;

revoke all on function public.claim_mission_dispatch_candidates_atomic(jsonb, jsonb, timestamptz, bigint, text[])
  from public, anon, authenticated;
grant execute on function public.claim_mission_dispatch_candidates_atomic(jsonb, jsonb, timestamptz, bigint, text[])
  to service_role;
