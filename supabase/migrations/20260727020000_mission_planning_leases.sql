-- Durable leases for the planning worker
-- (src/lib/mission/mission-planning-lease-store.ts, in-memory today).
--
-- Distinct from mission_dispatch_leases (20260726010000): different keying
-- (workspace_id + mission_id + planning_request_id, never a dispatch_key
-- slot), different owner (a planning worker, never an assignment executor).
-- Written AFTER mission_planning_worker_attempts (20260727010000) so
-- claim_mission_planning_lease can create the initial attempt row in the
-- SAME transaction as the lease claim — a crash immediately after claiming
-- never leaves an attempt-less lease (see
-- docs/PHASE_5D_TRANSACTION_BOUNDARIES.md's "claim + attempt-create"
-- candidate grouping).
create table if not exists public.mission_planning_leases (
  workspace_id text not null,
  mission_id text not null references public.missions(id) on delete cascade,
  planning_request_id text not null,
  lease_id text not null,
  owner_id text not null,
  -- Monotonic across the slot's entire lifetime, never reset after
  -- expiry/release/revoke — mirrors mission_dispatch_leases.fencing_token.
  fencing_token integer not null default 0 check (fencing_token >= 0),
  status text not null check (status in ('leased', 'released', 'expired', 'revoked')),
  attempt integer not null default 1 check (attempt >= 1),
  version integer not null default 1 check (version >= 1),
  acquired_at timestamptz not null,
  renewed_at timestamptz,
  expires_at timestamptz not null,
  released_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, mission_id, planning_request_id)
);

create index if not exists mission_planning_leases_expires_at_idx
  on public.mission_planning_leases (expires_at)
  where status = 'leased';

-- ---------------------------------------------------------------------------
-- claim_mission_planning_lease
-- ---------------------------------------------------------------------------
-- Verifies:
--   - the Mission exists and its OWN workspace_id matches p_workspace_id;
--   - the Mission is not terminal (p_mission_terminal supplied by the
--     caller, sourced the same way mission-planning-recovery.ts's
--     RequestSnapshotForRecovery.missionTerminal is — this function does not
--     redefine mission terminality, it trusts the caller's already-computed
--     projection, matching how claim_mission_dispatch_candidates_atomic
--     trusts p_dispatchable_states rather than re-deriving state itself);
--   - the planning request exists, belongs to this Mission
--     (p_request_exists / p_request_terminal, same trust boundary as
--     above — this table has no FK into a `planning_requests` table because
--     none exists yet; the PlanningRequestRecord lives in the Mission event
--     projection, not a dedicated row);
--   - the lease slot is not currently live (no row, or existing row's
--     status <> 'leased' or past its own expires_at).
--
-- On success, ALSO creates the initial worker-attempt row in the SAME
-- transaction (calling create_mission_planning_attempt), so a crash between
-- "lease claimed" and "attempt row created" cannot happen.
create or replace function public.claim_mission_planning_lease(
  p_workspace_id text,
  p_mission_id text,
  p_planning_request_id text,
  p_mission_terminal boolean,
  p_request_exists boolean,
  p_request_terminal boolean,
  p_owner_id text,
  p_now timestamptz,
  p_lease_duration_ms bigint,
  p_worker_attempt_id text,
  p_worker_id text,
  p_model_configuration_id text,
  p_attempt_kind text,
  p_attempt_number integer,
  p_context_hash text,
  p_correlation_id text,
  p_causation_id text
)
returns table (status text, reason text, lease public.mission_planning_leases, attempt public.mission_planning_worker_attempts)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mission public.missions%rowtype;
  v_existing public.mission_planning_leases%rowtype;
  v_still_live boolean;
  v_new_fencing_token integer;
  v_new_attempt integer;
  v_expires_at timestamptz;
  v_lease public.mission_planning_leases%rowtype;
  v_attempt_row public.mission_planning_worker_attempts%rowtype;
begin
  select * into v_mission from public.missions where id = p_mission_id for update;

  if not found then
    return query select 'refused'::text, 'mission_not_found'::text, null::public.mission_planning_leases, null::public.mission_planning_worker_attempts;
    return;
  end if;

  if v_mission.workspace_id <> p_workspace_id then
    return query select 'refused'::text, 'workspace_mismatch'::text, null::public.mission_planning_leases, null::public.mission_planning_worker_attempts;
    return;
  end if;

  if p_mission_terminal then
    return query select 'refused'::text, 'mission_terminal'::text, null::public.mission_planning_leases, null::public.mission_planning_worker_attempts;
    return;
  end if;

  if not p_request_exists then
    return query select 'refused'::text, 'planning_request_not_found'::text, null::public.mission_planning_leases, null::public.mission_planning_worker_attempts;
    return;
  end if;

  if p_request_terminal then
    return query select 'refused'::text, 'planning_request_terminal'::text, null::public.mission_planning_leases, null::public.mission_planning_worker_attempts;
    return;
  end if;

  select * into v_existing
  from public.mission_planning_leases
  where workspace_id = p_workspace_id and mission_id = p_mission_id and planning_request_id = p_planning_request_id
  for update;

  if found then
    v_still_live := v_existing.status = 'leased' and v_existing.expires_at > p_now;
    if v_still_live then
      return query select 'refused'::text, 'already_leased'::text, null::public.mission_planning_leases, null::public.mission_planning_worker_attempts;
      return;
    end if;
  end if;

  v_new_fencing_token := coalesce(v_existing.fencing_token, 0) + 1;
  v_new_attempt := coalesce(v_existing.attempt, 0) + 1;
  v_expires_at := p_now + make_interval(secs => p_lease_duration_ms / 1000.0);

  insert into public.mission_planning_leases (
    workspace_id, mission_id, planning_request_id, lease_id, owner_id,
    fencing_token, status, attempt, version, acquired_at, expires_at
  ) values (
    p_workspace_id, p_mission_id, p_planning_request_id, gen_random_uuid()::text, p_owner_id,
    v_new_fencing_token, 'leased', v_new_attempt, 1, p_now, v_expires_at
  )
  on conflict (workspace_id, mission_id, planning_request_id) do update set
    lease_id = excluded.lease_id,
    owner_id = excluded.owner_id,
    fencing_token = excluded.fencing_token,
    status = 'leased',
    attempt = excluded.attempt,
    version = public.mission_planning_leases.version + 1,
    acquired_at = excluded.acquired_at,
    renewed_at = null,
    expires_at = excluded.expires_at,
    released_at = null,
    revoked_at = null,
    revoked_reason = null,
    updated_at = now()
  returning * into v_lease;

  select * into v_attempt_row
  from public.create_mission_planning_attempt(
    p_worker_attempt_id, p_workspace_id, p_mission_id, p_planning_request_id,
    v_lease.lease_id, v_new_fencing_token, p_worker_id, p_model_configuration_id,
    p_attempt_kind, p_attempt_number, p_context_hash, p_correlation_id, p_causation_id,
    null, p_now
  );

  return query select 'claimed'::text, null::text, v_lease, v_attempt_row;
end;
$$;

create or replace function public.renew_mission_planning_lease(
  p_workspace_id text,
  p_mission_id text,
  p_planning_request_id text,
  p_lease_id text,
  p_fencing_token integer,
  p_now timestamptz,
  p_lease_duration_ms bigint
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

  if v_row.status <> 'leased' or v_row.expires_at <= p_now then
    return query select 'refused'::text, 'not_active'::text, null::public.mission_planning_leases;
    return;
  end if;

  update public.mission_planning_leases
  set expires_at = p_now + make_interval(secs => p_lease_duration_ms / 1000.0),
      renewed_at = p_now,
      version = version + 1,
      updated_at = now()
  where workspace_id = p_workspace_id and mission_id = p_mission_id and planning_request_id = p_planning_request_id
  returning * into v_row;

  return query select 'ok'::text, null::text, v_row;
end;
$$;

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

  update public.mission_planning_leases
  set status = 'released', released_at = p_now, version = version + 1, updated_at = now()
  where workspace_id = p_workspace_id and mission_id = p_mission_id and planning_request_id = p_planning_request_id
  returning * into v_row;

  return query select 'ok'::text, null::text, v_row;
end;
$$;

-- Not fencing-checked, not owner-verified — the reconciler's override for a
-- terminal Mission/dead worker, matching revoke_mission_dispatch_lease_atomic.
create or replace function public.revoke_mission_planning_lease(
  p_workspace_id text,
  p_mission_id text,
  p_planning_request_id text,
  p_now timestamptz,
  p_reason text
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

  if v_row.status <> 'leased' then
    return query select 'refused'::text, 'lease_already_terminal'::text, null::public.mission_planning_leases;
    return;
  end if;

  update public.mission_planning_leases
  set status = 'revoked', revoked_at = p_now, revoked_reason = p_reason, version = version + 1, updated_at = now()
  where workspace_id = p_workspace_id and mission_id = p_mission_id and planning_request_id = p_planning_request_id
  returning * into v_row;

  return query select 'ok'::text, null::text, v_row;
end;
$$;

create or replace function public.validate_mission_planning_fence(
  p_workspace_id text,
  p_mission_id text,
  p_planning_request_id text,
  p_lease_id text,
  p_fencing_token integer
)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1
    from public.mission_planning_leases
    where workspace_id = p_workspace_id
      and mission_id = p_mission_id
      and planning_request_id = p_planning_request_id
      and lease_id = p_lease_id
      and fencing_token = p_fencing_token
      and status = 'leased'
      and expires_at > now()
  );
$$;

revoke all on public.mission_planning_leases from public, anon, authenticated;
grant select, insert, update on public.mission_planning_leases to service_role;

revoke all on function public.claim_mission_planning_lease(text, text, text, boolean, boolean, boolean, text, timestamptz, bigint, text, text, text, text, integer, text, text, text) from public, anon, authenticated;
grant execute on function public.claim_mission_planning_lease(text, text, text, boolean, boolean, boolean, text, timestamptz, bigint, text, text, text, text, integer, text, text, text) to service_role;

revoke all on function public.renew_mission_planning_lease(text, text, text, text, integer, timestamptz, bigint) from public, anon, authenticated;
grant execute on function public.renew_mission_planning_lease(text, text, text, text, integer, timestamptz, bigint) to service_role;

revoke all on function public.release_mission_planning_lease(text, text, text, text, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.release_mission_planning_lease(text, text, text, text, integer, timestamptz) to service_role;

revoke all on function public.revoke_mission_planning_lease(text, text, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.revoke_mission_planning_lease(text, text, text, timestamptz, text) to service_role;

revoke all on function public.validate_mission_planning_fence(text, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.validate_mission_planning_fence(text, text, text, text, integer) to service_role;
