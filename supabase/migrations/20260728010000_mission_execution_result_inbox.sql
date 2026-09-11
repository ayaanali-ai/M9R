-- Phase 3D.0 — authoritative Mission assignment dispatch boundary.
-- Legacy intents retain a NULL assignment_id; all new runtime writes must
-- supply it at the application/RPC boundary before a result can be accepted.

alter table public.mission_dispatch_intents
  add column if not exists assignment_id text null;

-- Trusted, synchronous projection of authoritative Mission assignment events.
-- It is not writable by providers/bearer clients and is never used to invent
-- historical linkage: absent rows are non-dispatchable by the new claim path.
create table if not exists public.mission_assignment_index (
  workspace_id text not null,
  mission_id text not null references public.missions(id) on delete cascade,
  assignment_id text not null,
  -- Root assignments are created before an authorized assignee binds their
  -- scheduler slot. A NULL linkage is never dispatchable; the first trusted
  -- `AssignAssignment` event may set it exactly once.
  dispatch_key text,
  assignment_status text not null check (assignment_status in ('proposed','ready','claimed','running','waiting_for_input','blocked','submitted','verified','accepted','rejected','cancelled','failed')),
  adapter_requirement text,
  source_aggregate_version integer not null check (source_aggregate_version > 0),
  source_event_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, mission_id, assignment_id),
  unique (mission_id, assignment_id)
);
create index if not exists mission_assignment_index_dispatch_idx
  on public.mission_assignment_index (workspace_id, mission_id, dispatch_key, assignment_status);
revoke all on public.mission_assignment_index from public, anon, authenticated;
grant select, insert, update on public.mission_assignment_index to service_role;

create or replace function public.apply_mission_assignment_index_event()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_workspace_id text; v_assignment jsonb; v_assignment_id text; v_dispatch_key text; v_status text; v_adapter text; v_existing public.mission_assignment_index%rowtype;
begin
  if new.event_type not in ('mission.assignment_created', 'mission.assignment_status_changed') then return new; end if;
  select workspace_id into v_workspace_id from public.missions where id = new.mission_id;
  if v_workspace_id is null then raise exception 'assignment index mission workspace missing' using errcode = '23503'; end if;
  if new.event_type = 'mission.assignment_created' then
    v_assignment := new.payload -> 'assignment';
    v_assignment_id := nullif(v_assignment ->> 'id', '');
    v_dispatch_key := nullif(v_assignment ->> 'dispatchKey', '');
    v_status := nullif(v_assignment ->> 'status', '');
    if v_assignment_id is null or v_status is null then raise exception 'assignment_index_malformed_event' using errcode = '22023'; end if;
    v_adapter := nullif(v_assignment ->> 'adapterRequirement', '');
    select * into v_existing from public.mission_assignment_index where workspace_id = v_workspace_id and mission_id = new.mission_id and assignment_id = v_assignment_id for update;
    if not found then
      insert into public.mission_assignment_index (workspace_id, mission_id, assignment_id, dispatch_key, assignment_status, adapter_requirement, source_aggregate_version, source_event_id)
      values (v_workspace_id, new.mission_id, v_assignment_id, v_dispatch_key, v_status, v_adapter, new.aggregate_version, new.event_id);
    elsif new.aggregate_version < v_existing.source_aggregate_version then
      raise exception 'assignment_index_stale_event' using errcode = 'P0001';
    elsif new.aggregate_version = v_existing.source_aggregate_version then
      if v_existing.dispatch_key = v_dispatch_key and v_existing.assignment_status = v_status and v_existing.adapter_requirement is not distinct from v_adapter and v_existing.source_event_id = new.event_id then return new; end if;
      raise exception 'assignment_index_same_version_conflict' using errcode = 'P0001';
    else
      if v_existing.dispatch_key <> v_dispatch_key or v_existing.adapter_requirement is distinct from v_adapter then
        raise exception 'assignment_index_invalid_transition' using errcode = 'P0001';
      end if;
      update public.mission_assignment_index set assignment_status = v_status, source_aggregate_version = new.aggregate_version, source_event_id = new.event_id, updated_at = now()
       where workspace_id = v_workspace_id and mission_id = new.mission_id and assignment_id = v_assignment_id;
    end if;
  else
    v_assignment_id := nullif(new.payload ->> 'assignmentId', '');
    v_status := nullif(new.payload ->> 'nextStatus', '');
    v_dispatch_key := nullif(new.payload ->> 'dispatchKey', '');
    if v_assignment_id is null or v_status is null then raise exception 'assignment_index_malformed_event' using errcode = '22023'; end if;
    select * into v_existing from public.mission_assignment_index where workspace_id = v_workspace_id and mission_id = new.mission_id and assignment_id = v_assignment_id for update;
    if not found then raise exception 'assignment_index_missing_assignment' using errcode = 'P0001'; end if;
    if new.aggregate_version < v_existing.source_aggregate_version then raise exception 'assignment_index_stale_event' using errcode = 'P0001'; end if;
    if new.aggregate_version = v_existing.source_aggregate_version then
      if v_existing.assignment_status = v_status and v_existing.dispatch_key is not distinct from v_dispatch_key and v_existing.source_event_id = new.event_id then return new; end if;
      raise exception 'assignment_index_same_version_conflict' using errcode = 'P0001';
    end if;
    -- The first assignment transition may bind the previously-null dispatch
    -- linkage. Once bound, every later status event must preserve it.
    if v_existing.dispatch_key is null then
      if v_dispatch_key is null or v_status <> 'claimed' then
        raise exception 'assignment_index_invalid_transition' using errcode = 'P0001';
      end if;
    elsif v_dispatch_key is not null and v_dispatch_key <> v_existing.dispatch_key then
      raise exception 'assignment_index_invalid_transition' using errcode = 'P0001';
    end if;
    update public.mission_assignment_index set dispatch_key = coalesce(v_existing.dispatch_key, v_dispatch_key), assignment_status = v_status, source_aggregate_version = new.aggregate_version, source_event_id = new.event_id, updated_at = now()
      where workspace_id = v_workspace_id and mission_id = new.mission_id and assignment_id = v_assignment_id;
  end if;
  return new;
end;
$$;
create trigger mission_assignment_index_from_event after insert on public.mission_events
  for each row execute function public.apply_mission_assignment_index_event();
revoke all on function public.apply_mission_assignment_index_event() from public, anon, authenticated;

create index if not exists mission_dispatch_intents_assignment_lookup_idx
  on public.mission_dispatch_intents (workspace_id, mission_id, assignment_id, id)
  where assignment_id is not null;

-- Fully replace the established claim RPC. The exact locked assignment-index
-- row is validated before any lease, dispatch-intent, or outbox write.
create or replace function public.claim_mission_dispatch_candidates_atomic(
  p_candidates jsonb, p_holder jsonb, p_now timestamptz, p_lease_duration_ms bigint, p_dispatchable_states text[]
)
returns table (mission_id text, dispatch_key text, status text, reason text, lease jsonb, instruction jsonb)
language plpgsql security definer set search_path = '' as $$
declare c jsonb; a public.mission_assignment_index%rowtype; m public.missions%rowtype; l public.mission_dispatch_leases%rowtype;
  indexed_assignment public.mission_assignment_index%rowtype;
  wid text; mid text; aid text; dkey text; repository_id text; adapter text; state text; expected_version integer; token integer; attempt integer; expiry timestamptz; iid uuid;
begin
  if jsonb_typeof(p_candidates) <> 'array' then raise exception 'malformed_candidate' using errcode = '22023'; end if;
  for c in select value from jsonb_array_elements(p_candidates) t(value) order by value ->> 'workspaceId', value ->> 'missionId', value ->> 'assignmentId', value ->> 'dispatchKey'
  loop
    wid := nullif(c ->> 'workspaceId',''); mid := nullif(c ->> 'missionId',''); aid := nullif(c ->> 'assignmentId',''); dkey := nullif(c ->> 'dispatchKey',''); repository_id := nullif(c ->> 'repositoryId',''); adapter := nullif(c ->> 'adapterRequirement',''); state := nullif(c ->> 'missionState','');
    if wid is null or mid is null or dkey is null or state is null then return query select mid,dkey,'refused','invalid_candidate',null,null; continue; end if;
    if aid is null then return query select mid,dkey,'refused','missing_assignment_id',null,null; continue; end if;
    select * into m from public.missions where id = mid for update;
    if not found then return query select mid,dkey,'refused','mission_not_found',null,null; continue; end if;
    if m.workspace_id <> wid then return query select mid,dkey,'refused','workspace_mismatch',null,null; continue; end if;
    if repository_id is not null and m.repository_id is distinct from repository_id then return query select mid,dkey,'refused','repository_mismatch',null,null; continue; end if;
    select * into a from public.mission_assignment_index where workspace_id=wid and mission_id=mid and assignment_id=aid for update;
    if not found then
      select * into indexed_assignment from public.mission_assignment_index where mission_id=mid and assignment_id=aid for update;
      if found then return query select mid,dkey,'refused','assignment_workspace_mismatch',null,null; continue; end if;
      select * into indexed_assignment from public.mission_assignment_index where workspace_id=wid and assignment_id=aid for update;
      if found then return query select mid,dkey,'refused','assignment_mission_mismatch',null,null; continue; end if;
      return query select mid,dkey,'refused','assignment_not_found',null,null; continue;
    end if;
    if a.dispatch_key <> dkey then return query select mid,dkey,'refused','assignment_dispatch_key_mismatch',null,null; continue; end if;
    if a.adapter_requirement is distinct from adapter then return query select mid,dkey,'refused','adapter_requirement_mismatch',null,null; continue; end if;
    if a.assignment_status not in ('ready','claimed','running') then return query select mid,dkey,'refused','assignment_not_dispatchable',null,null; continue; end if;
    if c ? 'expectedAssignmentSourceVersion' then
      expected_version := (c ->> 'expectedAssignmentSourceVersion')::integer;
      if a.source_aggregate_version <> expected_version then return query select mid,dkey,'refused','stale_assignment_projection',null,null; continue; end if;
    end if;
    if not (state = any(p_dispatchable_states)) then return query select mid,dkey,'refused','not_dispatchable_state',null,null; continue; end if;
    select * into l from public.mission_dispatch_leases where workspace_id=wid and mission_id=mid and dispatch_key=dkey for update;
    if found and l.status='leased' and l.expires_at > p_now and l.lease_owner <> p_holder then return query select mid,dkey,'refused','duplicate_or_already_claimed',null,null; continue; end if;
    token := coalesce(l.fencing_token,0)+1; attempt := coalesce(l.attempt,0)+1; expiry := p_now + make_interval(secs => p_lease_duration_ms / 1000.0);
    insert into public.mission_dispatch_leases (workspace_id,mission_id,dispatch_key,repository_id,lease_id,lease_owner,fencing_token,status,attempt,version,acquired_at,expires_at)
      values (wid,mid,dkey,m.repository_id,gen_random_uuid()::text,p_holder,token,'leased',attempt,1,p_now,expiry)
      on conflict (workspace_id,mission_id,dispatch_key) do update set repository_id=excluded.repository_id,lease_id=excluded.lease_id,lease_owner=excluded.lease_owner,fencing_token=excluded.fencing_token,status='leased',attempt=excluded.attempt,version=public.mission_dispatch_leases.version+1,acquired_at=excluded.acquired_at,renewed_at=null,expires_at=excluded.expires_at,released_at=null,revoked_at=null,revoked_reason=null,updated_at=now()
      returning * into l;
    update public.mission_dispatch_intents set superseded_at=p_now where workspace_id=wid and mission_id=mid and dispatch_key=dkey and delivered_at is null and superseded_at is null;
    insert into public.mission_dispatch_intents (workspace_id,mission_id,assignment_id,dispatch_key,repository_id,adapter_requirement,lease_id,fencing_token,attempt,execution_constraints)
      values (wid,mid,aid,dkey,m.repository_id,adapter,l.lease_id,token,attempt,coalesce(c->'executionConstraints','{}'::jsonb)) returning id into iid;
    return query select mid,dkey,'claimed',null,jsonb_build_object('leaseId',l.lease_id,'workspaceId',wid,'missionId',mid,'dispatchKey',dkey,'holder',p_holder,'state','leased','fencingToken',token,'acquiredAt',p_now,'expiresAt',expiry,'renewedAt',null,'releasedAt',null,'revokedReason',null),jsonb_build_object('instructionId',iid,'missionId',mid,'workspaceId',wid,'assignmentId',aid,'repositoryId',m.repository_id,'dispatchKey',dkey,'adapterRequirement',adapter,'leaseId',l.lease_id,'fencingToken',token,'attempt',attempt,'executionConstraints',coalesce(c->'executionConstraints','{}'::jsonb),'createdAt',p_now,'deliveredAt',null,'supersededAt',null,'processHandle',null);
  end loop;
end;
$$;

revoke all on function public.claim_mission_dispatch_candidates_atomic(jsonb, jsonb, timestamptz, bigint, text[]) from public, anon, authenticated;
grant execute on function public.claim_mission_dispatch_candidates_atomic(jsonb, jsonb, timestamptz, bigint, text[]) to service_role;
