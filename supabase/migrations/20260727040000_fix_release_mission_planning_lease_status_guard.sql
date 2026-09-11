-- Corrective migration — NOT executed against the live database.
--
-- Defect found by the Phase 5E live-Postgres harness
-- (scripts/phase5e-live-db-harness.ts, "stale release (already released)
-- refused" test): release_mission_planning_lease
-- (20260727020000_mission_planning_leases.sql) checks lease_id and
-- fencing_token but, unlike renew_mission_planning_lease, never checks that
-- the lease's current status is still 'leased'. A second release call with
-- the same (still-matching) lease_id/fencing_token succeeds and returns
-- 'ok' instead of being refused — so a stale/duplicate release (e.g. a
-- retried release request after the first one already succeeded) is
-- silently accepted rather than surfaced as a distinct, typed outcome.
--
-- This is not exploitable for double-claiming (a released lease is not
-- claimable by anyone until a fresh claim advances the fencing token
-- regardless), but it violates the intended contract: release, like renew,
-- should only succeed while status = 'leased'.
--
-- Fix: add the same status <> 'leased' guard renew_mission_planning_lease
-- already has, returning a distinct 'already_released' reason (kept
-- separate from renew's generic 'not_active' so callers can tell "this
-- lease is not live because it was already released" apart from "this
-- lease is not live because it expired/was revoked").
create or replace function public.release_mission_planning_lease(
  p_workspace_id text,
  p_mission_id text,
  p_planning_request_id text,
  p_lease_id text,
  p_fencing_token integer,
  p_now timestamptz
)
returns table (status text, reason text, lease public.mission_planning_leases)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.mission_planning_leases%rowtype;
begin
  select * into v_row
  from public.mission_planning_leases
  where workspace_id = p_workspace_id and mission_id = p_mission_id and planning_request_id = p_planning_request_id
  for update;

  if not found then
    return query select 'refused'::text, 'not_found'::text, null::public.mission_planning_leases;
    return;
  end if;

  if v_row.lease_id <> p_lease_id or v_row.fencing_token <> p_fencing_token then
    return query select 'refused'::text, 'stale_fencing_token'::text, null::public.mission_planning_leases;
    return;
  end if;

  if v_row.status <> 'leased' then
    return query select 'refused'::text, 'already_released'::text, null::public.mission_planning_leases;
    return;
  end if;

  update public.mission_planning_leases
  set status = 'released', released_at = p_now, version = version + 1, updated_at = now()
  where workspace_id = p_workspace_id and mission_id = p_mission_id and planning_request_id = p_planning_request_id
  returning * into v_row;

  return query select 'ok'::text, null::text, v_row;
end;
$$;

revoke all on function public.release_mission_planning_lease(text, text, text, text, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.release_mission_planning_lease(text, text, text, text, integer, timestamptz) to service_role;
