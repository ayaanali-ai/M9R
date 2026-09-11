-- Bounded, trusted dispatch-read index for the long-running Mission runtime.
-- This is a projection of Mission events, never a second command authority.
-- New work is still claimed only through claim_mission_dispatch_candidates_atomic.

create table if not exists public.mission_runtime_dispatch_index (
  workspace_id text not null,
  mission_id text not null references public.missions(id) on delete cascade,
  mission_state text not null,
  source_aggregate_version integer not null check (source_aggregate_version > 0),
  source_event_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, mission_id),
  unique (mission_id)
);
create index if not exists mission_runtime_dispatch_index_scan_idx
  on public.mission_runtime_dispatch_index (workspace_id, mission_state, updated_at, mission_id);
revoke all on public.mission_runtime_dispatch_index from public, anon, authenticated;
grant select, insert, update on public.mission_runtime_dispatch_index to service_role;

create or replace function public.apply_mission_runtime_dispatch_index_event()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_workspace_id text;
  v_state text;
  v_existing public.mission_runtime_dispatch_index%rowtype;
begin
  if new.event_type not in ('mission.created', 'mission.state_changed') then return new; end if;
  select workspace_id into v_workspace_id from public.missions where id = new.mission_id;
  if v_workspace_id is null then raise exception 'runtime_dispatch_index_missing_workspace' using errcode = '23503'; end if;
  v_state := case when new.event_type = 'mission.created' then 'draft' else nullif(new.payload ->> 'nextState', '') end;
  if v_state is null then raise exception 'runtime_dispatch_index_malformed_event' using errcode = '22023'; end if;
  select * into v_existing from public.mission_runtime_dispatch_index where workspace_id = v_workspace_id and mission_id = new.mission_id for update;
  if not found then
    insert into public.mission_runtime_dispatch_index (workspace_id, mission_id, mission_state, source_aggregate_version, source_event_id)
    values (v_workspace_id, new.mission_id, v_state, new.aggregate_version, new.event_id);
  elsif new.aggregate_version < v_existing.source_aggregate_version then
    raise exception 'runtime_dispatch_index_stale_event' using errcode = 'P0001';
  elsif new.aggregate_version = v_existing.source_aggregate_version then
    if v_existing.workspace_id = v_workspace_id and v_existing.mission_state = v_state and v_existing.source_event_id = new.event_id then return new; end if;
    raise exception 'runtime_dispatch_index_same_version_conflict' using errcode = 'P0001';
  else
    update public.mission_runtime_dispatch_index
    set mission_state = v_state, source_aggregate_version = new.aggregate_version, source_event_id = new.event_id, updated_at = now()
    where workspace_id = v_workspace_id and mission_id = new.mission_id;
  end if;
  return new;
end;
$$;

drop trigger if exists mission_runtime_dispatch_index_from_event on public.mission_events;
create trigger mission_runtime_dispatch_index_from_event
after insert on public.mission_events
for each row execute function public.apply_mission_runtime_dispatch_index_event();
revoke all on function public.apply_mission_runtime_dispatch_index_event() from public, anon, authenticated;

-- Seed existing rows deterministically from the current immutable event log.
insert into public.mission_runtime_dispatch_index (workspace_id, mission_id, mission_state, source_aggregate_version, source_event_id)
select m.workspace_id, m.id, coalesce(s.next_state, 'draft'), coalesce(s.aggregate_version, c.aggregate_version), coalesce(s.event_id, c.event_id)
from public.missions m
join lateral (
  select event_id, aggregate_version from public.mission_events e where e.mission_id = m.id and e.event_type = 'mission.created' order by aggregate_version asc limit 1
) c on true
left join lateral (
  select event_id, aggregate_version, payload ->> 'nextState' as next_state from public.mission_events e where e.mission_id = m.id and e.event_type = 'mission.state_changed' order by aggregate_version desc limit 1
) s on true
on conflict (workspace_id, mission_id) do nothing;

create or replace function public.list_mission_runtime_dispatch_candidates(
  p_workspace_id text,
  p_limit integer
)
returns table (
  workspace_id text, mission_id text, repository_id text, mission_state text, mission_source_version integer,
  assignment_id text, dispatch_key text, adapter_requirement text, assignment_source_version integer,
  lease jsonb
)
language sql security definer set search_path = '' stable as $$
  select a.workspace_id, a.mission_id, m.repository_id, d.mission_state, d.source_aggregate_version,
         a.assignment_id, a.dispatch_key, a.adapter_requirement, a.source_aggregate_version,
         case when l.mission_id is null then null else jsonb_build_object(
           'leaseId', l.lease_id, 'missionId', l.mission_id, 'workspaceId', l.workspace_id, 'dispatchKey', l.dispatch_key,
           'holder', l.lease_owner, 'state', l.status, 'fencingToken', l.fencing_token, 'acquiredAt', l.acquired_at,
           'expiresAt', l.expires_at, 'renewedAt', l.renewed_at, 'releasedAt', l.released_at, 'revokedReason', l.revoked_reason
         ) end
  from public.mission_assignment_index a
  join public.mission_runtime_dispatch_index d on d.workspace_id = a.workspace_id and d.mission_id = a.mission_id
  join public.missions m on m.id = a.mission_id and m.workspace_id = a.workspace_id
  left join public.mission_dispatch_leases l on l.workspace_id = a.workspace_id and l.mission_id = a.mission_id and l.dispatch_key = a.dispatch_key
  where a.workspace_id = p_workspace_id
    and a.assignment_status in ('ready', 'claimed', 'running')
    and a.dispatch_key is not null
    and d.mission_state in ('ready', 'initializing', 'executing', 'reviewing', 'verifying')
  order by d.updated_at asc, a.updated_at asc, a.mission_id asc, a.assignment_id asc
  limit greatest(1, least(p_limit, 100));
$$;
revoke all on function public.list_mission_runtime_dispatch_candidates(text, integer) from public, anon, authenticated;
grant execute on function public.list_mission_runtime_dispatch_candidates(text, integer) to service_role;
