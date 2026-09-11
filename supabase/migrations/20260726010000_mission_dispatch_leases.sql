-- Durable dispatch leases for the Mission scheduler (src/lib/mission/mission-scheduler*.ts).
--
-- Phase 2D defined the lease state machine and candidate-selection policy as
-- pure TypeScript (mission-scheduler.ts) verified against nothing but
-- in-memory tests. This migration is Phase 2D.1: the persistence boundary
-- that lets MULTIPLE scheduler workers run that same policy against shared
-- state safely. It does NOT reimplement lease legality, candidate selection,
-- retry classification, or expiry semantics — those remain exactly the pure
-- functions the application calls. What lives here is the mechanical,
-- cross-cutting guarantee a database transaction is actually suited to
-- provide: atomic ownership per slot, monotonic fencing, and tenant-scope
-- verification under concurrent callers.
--
-- Uniqueness boundary: a lease protects `workspace_id + mission_id +
-- dispatch_key`, never `mission_id` alone. One Mission will eventually run
-- several concurrent assignments (an implementation assignment, a security-
-- review assignment, a verification assignment) that must be leased
-- independently. This vertical slice gives every Mission exactly one slot —
-- dispatch_key = 'primary' (see mission-scheduler.ts's DEFAULT_DISPATCH_KEY)
-- — but the schema does not assume that stays true: dispatch_key is part of
-- the primary key from day one so a later phase can mint per-assignment keys
-- without an ALTER TABLE.
--
-- This is a backend scheduling table, not end-user-facing: no RLS policy is
-- defined, matching agent_claims / launch_events / the mission_* tables
-- precedent. Access is gated by table grants (service_role only) and the
-- security definer functions below.

create table if not exists public.mission_dispatch_leases (
  workspace_id text not null,
  mission_id text not null references public.missions(id) on delete cascade,
  dispatch_key text not null,
  -- Denormalized from missions.repository_id at claim time, purely so a
  -- lease row is self-describing for observability; the AUTHORITATIVE
  -- repository check inside claim_mission_dispatch_candidates_atomic always
  -- reads missions.repository_id directly, never this column.
  repository_id text,
  lease_id text not null,
  lease_owner jsonb not null check (jsonb_typeof(lease_owner) = 'object'),
  -- Monotonic across the SLOT's entire lifetime, never reset to 1 on
  -- reacquire (mission-scheduler.ts's acquireLease documents why: two
  -- non-overlapping generations both starting at 1 would make a long-dead
  -- worker's write indistinguishable from the current generation's).
  fencing_token integer not null default 0 check (fencing_token >= 0),
  status text not null check (status in ('leased', 'released', 'expired', 'revoked')),
  attempt integer not null default 1 check (attempt >= 1),
  -- Optimistic-lock cache, incremented on every mutation of this row. Not
  -- read by application code today (every mutation already goes through a
  -- security-definer function that takes its own row lock), kept because it
  -- was explicitly requested and costs nothing to maintain.
  version integer not null default 1 check (version >= 1),
  acquired_at timestamptz not null,
  renewed_at timestamptz,
  expires_at timestamptz not null,
  released_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, mission_id, dispatch_key)
);

create index if not exists mission_dispatch_leases_expires_at_idx
  on public.mission_dispatch_leases (expires_at)
  where status = 'leased';

-- The scheduler's outbox: a durable row committed in the SAME transaction as
-- the lease that produced it, so a crash between "lease committed" and
-- "Runtime received the dispatch" cannot lose the instruction — a restarted
-- scheduler recovers it via the outstanding-intents query below instead of
-- replaying a message queue this phase deliberately does not introduce.
create table if not exists public.mission_dispatch_intents (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  mission_id text not null references public.missions(id) on delete cascade,
  dispatch_key text not null,
  repository_id text,
  adapter_requirement text,
  lease_id text not null,
  fencing_token integer not null,
  attempt integer not null,
  execution_constraints jsonb not null default '{}'::jsonb check (
    jsonb_typeof(execution_constraints) = 'object' and octet_length(execution_constraints::text) <= 131072
  ),
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  -- Set when a LATER claim on the same slot takes over — a crashed worker's
  -- instruction must read as dead, not merely "not yet delivered."
  superseded_at timestamptz,
  -- Phase 3A: set by attach_process_handle (plain update, not an RPC — see
  -- mission-scheduler-store-supabase.ts) once a real ProcessExecutionHost
  -- has actually launched something for this instruction. Null immediately
  -- after claim; a restarted Runtime with no persisted handle here has no
  -- way to ask "is my process still alive?" and Phase 3A's recovery model
  -- (mission-process-recovery.ts) treats that as process_status_unknown.
  process_handle jsonb check (process_handle is null or jsonb_typeof(process_handle) = 'object')
);

create index if not exists mission_dispatch_intents_outstanding_idx
  on public.mission_dispatch_intents (workspace_id)
  where delivered_at is null and superseded_at is null;

-- ---------------------------------------------------------------------------
-- claim_mission_dispatch_candidates_atomic
-- ---------------------------------------------------------------------------
--
-- Attempts to claim a batch of (workspace_id, mission_id, dispatch_key)
-- slots in ONE transaction. Candidates are locked in
-- (workspace_id, mission_id, dispatch_key) order regardless of the order the
-- caller supplied them in — required so two concurrent calls claiming
-- overlapping candidate sets can never deadlock against each other by
-- locking the same two rows in opposite orders.
--
-- For each candidate this function verifies, and does NOT trust the caller
-- on:
--   - the Mission exists;
--   - the Mission's OWN workspace_id (from `missions`, not the lease table)
--     matches the workspace_id the candidate was requested under;
--   - when a repository_id was supplied, it matches the Mission's own
--     repository_id;
--   - the caller-supplied p_mission_state is a member of the caller-supplied
--     p_dispatchable_states whitelist. This is a defense against a stale
--     read, NOT a redefinition of the whitelist — the whitelist itself is a
--     parameter every single call, sourced by the application from
--     mission-scheduler.ts's DISPATCHABLE_MISSION_STATES, never hardcoded
--     here.
--
-- A candidate is claimed when: it passes every check above, AND either no
-- lease row exists for its slot yet, or the existing row is not currently
-- live (status <> 'leased', or status = 'leased' but past its own
-- expires_at). Claiming REUSES the row (upsert), continuing its
-- fencing_token rather than resetting it, and supersedes any still-pending
-- dispatch intent for the same slot before inserting the new one.
create or replace function public.claim_mission_dispatch_candidates_atomic(
  p_candidates jsonb,
  p_holder jsonb,
  p_now timestamptz,
  p_lease_duration_ms bigint,
  p_dispatchable_states text[]
)
returns table (
  mission_id text,
  dispatch_key text,
  status text,
  reason text,
  lease jsonb,
  instruction jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_candidate jsonb;
  v_workspace_id text;
  v_mission_id text;
  v_repository_id text;
  v_dispatch_key text;
  v_mission_state text;
  v_adapter_requirement text;
  v_execution_constraints jsonb;
  v_mission public.missions%rowtype;
  v_existing public.mission_dispatch_leases%rowtype;
  v_still_live boolean;
  v_new_fencing_token integer;
  v_new_attempt integer;
  v_expires_at timestamptz;
  v_intent_id uuid;
begin
  for v_candidate in
    select value
    from jsonb_array_elements(p_candidates) as t(value)
    order by value ->> 'workspaceId', value ->> 'missionId', value ->> 'dispatchKey'
  loop
    v_workspace_id := v_candidate ->> 'workspaceId';
    v_mission_id := v_candidate ->> 'missionId';
    v_repository_id := v_candidate ->> 'repositoryId';
    v_dispatch_key := v_candidate ->> 'dispatchKey';
    v_mission_state := v_candidate ->> 'missionState';
    v_adapter_requirement := v_candidate ->> 'adapterRequirement';
    v_execution_constraints := coalesce(v_candidate -> 'executionConstraints', '{}'::jsonb);

    select * into v_mission from public.missions where id = v_mission_id for update;

    if not found then
      return query select v_mission_id, v_dispatch_key, 'refused'::text, 'mission_not_found'::text, null::jsonb, null::jsonb;
      continue;
    end if;

    if v_mission.workspace_id <> v_workspace_id then
      return query select v_mission_id, v_dispatch_key, 'refused'::text, 'workspace_mismatch'::text, null::jsonb, null::jsonb;
      continue;
    end if;

    if v_repository_id is not null and v_mission.repository_id is distinct from v_repository_id then
      return query select v_mission_id, v_dispatch_key, 'refused'::text, 'repository_mismatch'::text, null::jsonb, null::jsonb;
      continue;
    end if;

    if not (v_mission_state = any(p_dispatchable_states)) then
      return query select v_mission_id, v_dispatch_key, 'refused'::text, 'not_dispatchable_state'::text, null::jsonb, null::jsonb;
      continue;
    end if;

    select * into v_existing
    from public.mission_dispatch_leases
    where workspace_id = v_workspace_id and mission_id = v_mission_id and dispatch_key = v_dispatch_key
    for update;

    if found then
      v_still_live := v_existing.status = 'leased' and v_existing.expires_at > p_now;
      if v_still_live and v_existing.lease_owner <> p_holder then
        return query select v_mission_id, v_dispatch_key, 'refused'::text, 'already_leased'::text, null::jsonb, null::jsonb;
        continue;
      end if;
    end if;

    -- Fencing is monotonic across the slot's whole lifetime, not reset per
    -- generation — see the column comment above.
    v_new_fencing_token := coalesce(v_existing.fencing_token, 0) + 1;
    v_new_attempt := coalesce(v_existing.attempt, 0) + 1;
    v_expires_at := p_now + make_interval(secs => p_lease_duration_ms / 1000.0);

    insert into public.mission_dispatch_leases (
      workspace_id, mission_id, dispatch_key, repository_id, lease_id, lease_owner,
      fencing_token, status, attempt, version, acquired_at, expires_at
    ) values (
      v_workspace_id, v_mission_id, v_dispatch_key, v_mission.repository_id, gen_random_uuid()::text, p_holder,
      v_new_fencing_token, 'leased', v_new_attempt, 1, p_now, v_expires_at
    )
    on conflict (workspace_id, mission_id, dispatch_key) do update set
      repository_id = excluded.repository_id,
      lease_id = excluded.lease_id,
      lease_owner = excluded.lease_owner,
      fencing_token = excluded.fencing_token,
      status = 'leased',
      attempt = excluded.attempt,
      version = public.mission_dispatch_leases.version + 1,
      acquired_at = excluded.acquired_at,
      renewed_at = null,
      expires_at = excluded.expires_at,
      released_at = null,
      revoked_at = null,
      revoked_reason = null,
      updated_at = now()
    returning lease_id into v_existing.lease_id;

    -- Supersede any still-pending intent for this exact slot before writing
    -- the new one — a crashed worker's old instruction must not be actioned
    -- once its lease has been reclaimed.
    update public.mission_dispatch_intents
    set superseded_at = p_now
    where workspace_id = v_workspace_id
      and mission_id = v_mission_id
      and dispatch_key = v_dispatch_key
      and delivered_at is null
      and superseded_at is null;

    insert into public.mission_dispatch_intents (
      workspace_id, mission_id, dispatch_key, repository_id, adapter_requirement,
      lease_id, fencing_token, attempt, execution_constraints
    ) values (
      v_workspace_id, v_mission_id, v_dispatch_key, v_mission.repository_id, v_adapter_requirement,
      v_existing.lease_id, v_new_fencing_token, v_new_attempt, v_execution_constraints
    )
    returning id into v_intent_id;

    return query
    select
      v_mission_id,
      v_dispatch_key,
      'claimed'::text,
      null::text,
      jsonb_build_object(
        'leaseId', v_existing.lease_id,
        'workspaceId', v_workspace_id,
        'missionId', v_mission_id,
        'dispatchKey', v_dispatch_key,
        'holder', p_holder,
        'state', 'leased',
        'fencingToken', v_new_fencing_token,
        'acquiredAt', p_now,
        'expiresAt', v_expires_at,
        'renewedAt', null,
        'releasedAt', null,
        'revokedReason', null
      ),
      jsonb_build_object(
        'instructionId', v_intent_id,
        'missionId', v_mission_id,
        'workspaceId', v_workspace_id,
        'repositoryId', v_mission.repository_id,
        'dispatchKey', v_dispatch_key,
        'adapterRequirement', v_adapter_requirement,
        'leaseId', v_existing.lease_id,
        'fencingToken', v_new_fencing_token,
        'attempt', v_new_attempt,
        'executionConstraints', v_execution_constraints,
        'createdAt', p_now,
        'deliveredAt', null,
        'supersededAt', null,
        'processHandle', null
      );
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- renew / release / revoke — each takes its own row lock, so racing against
-- claim_mission_dispatch_candidates_atomic on the same slot serializes
-- correctly regardless of which function gets there first.
-- ---------------------------------------------------------------------------

create or replace function public.renew_mission_dispatch_lease_atomic(
  p_workspace_id text,
  p_mission_id text,
  p_dispatch_key text,
  p_lease_id text,
  p_fencing_token integer,
  p_holder jsonb,
  p_now timestamptz,
  p_lease_duration_ms bigint,
  p_renewal_window_ms bigint
)
returns table (status text, reason text, lease jsonb)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.mission_dispatch_leases%rowtype;
  v_new_fencing_token integer;
  v_new_expires_at timestamptz;
begin
  select * into v_row
  from public.mission_dispatch_leases
  where workspace_id = p_workspace_id and mission_id = p_mission_id and dispatch_key = p_dispatch_key
  for update;

  if not found then
    return query select 'refused'::text, 'lease_not_found'::text, null::jsonb;
    return;
  end if;

  if v_row.lease_id <> p_lease_id or v_row.fencing_token <> p_fencing_token then
    return query select 'refused'::text, 'stale_fencing_token'::text, null::jsonb;
    return;
  end if;

  if v_row.status <> 'leased' then
    return query select 'refused'::text, 'lease_already_terminal'::text, null::jsonb;
    return;
  end if;

  if v_row.lease_owner <> p_holder then
    return query select 'refused'::text, 'lease_not_held_by_caller'::text, null::jsonb;
    return;
  end if;

  if p_now > v_row.expires_at then
    return query select 'refused'::text, 'lease_expired'::text, null::jsonb;
    return;
  end if;

  if p_now < (v_row.expires_at - make_interval(secs => p_renewal_window_ms / 1000.0)) then
    return query select 'refused'::text, 'renewal_outside_window'::text, null::jsonb;
    return;
  end if;

  v_new_fencing_token := v_row.fencing_token + 1;
  v_new_expires_at := p_now + make_interval(secs => p_lease_duration_ms / 1000.0);

  update public.mission_dispatch_leases
  set fencing_token = v_new_fencing_token,
      expires_at = v_new_expires_at,
      renewed_at = p_now,
      version = version + 1,
      updated_at = now()
  where workspace_id = p_workspace_id and mission_id = p_mission_id and dispatch_key = p_dispatch_key;

  return query
  select
    'renewed'::text,
    null::text,
    jsonb_build_object(
      'leaseId', v_row.lease_id,
      'workspaceId', p_workspace_id,
      'missionId', p_mission_id,
      'dispatchKey', p_dispatch_key,
      'holder', v_row.lease_owner,
      'state', 'leased',
      'fencingToken', v_new_fencing_token,
      'acquiredAt', v_row.acquired_at,
      'expiresAt', v_new_expires_at,
      'renewedAt', p_now,
      'releasedAt', null,
      'revokedReason', null
    );
end;
$$;

create or replace function public.release_mission_dispatch_lease_atomic(
  p_workspace_id text,
  p_mission_id text,
  p_dispatch_key text,
  p_lease_id text,
  p_fencing_token integer,
  p_holder jsonb,
  p_now timestamptz
)
returns table (status text, reason text, lease jsonb)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.mission_dispatch_leases%rowtype;
begin
  select * into v_row
  from public.mission_dispatch_leases
  where workspace_id = p_workspace_id and mission_id = p_mission_id and dispatch_key = p_dispatch_key
  for update;

  if not found then
    return query select 'refused'::text, 'lease_not_found'::text, null::jsonb;
    return;
  end if;

  if v_row.lease_id <> p_lease_id or v_row.fencing_token <> p_fencing_token then
    return query select 'refused'::text, 'stale_fencing_token'::text, null::jsonb;
    return;
  end if;

  if v_row.status <> 'leased' then
    return query select 'refused'::text, 'lease_already_terminal'::text, null::jsonb;
    return;
  end if;

  if v_row.lease_owner <> p_holder then
    return query select 'refused'::text, 'lease_not_held_by_caller'::text, null::jsonb;
    return;
  end if;

  update public.mission_dispatch_leases
  set status = 'released',
      released_at = p_now,
      version = version + 1,
      updated_at = now()
  where workspace_id = p_workspace_id and mission_id = p_mission_id and dispatch_key = p_dispatch_key;

  return query
  select
    'released'::text,
    null::text,
    jsonb_build_object(
      'leaseId', v_row.lease_id,
      'workspaceId', p_workspace_id,
      'missionId', p_mission_id,
      'dispatchKey', p_dispatch_key,
      'holder', v_row.lease_owner,
      'state', 'released',
      'fencingToken', v_row.fencing_token,
      'acquiredAt', v_row.acquired_at,
      'expiresAt', v_row.expires_at,
      'renewedAt', v_row.renewed_at,
      'releasedAt', p_now,
      'revokedReason', null
    );
end;
$$;

-- Unlike renew/release, revocation is NOT fencing-checked and does not
-- verify lease_owner: it is the scheduler/reconciler's override for a
-- Mission that was cancelled or a holder that's known-dead, exercised
-- precisely when the current holder cannot be trusted to cooperate.
create or replace function public.revoke_mission_dispatch_lease_atomic(
  p_workspace_id text,
  p_mission_id text,
  p_dispatch_key text,
  p_now timestamptz,
  p_reason text
)
returns table (status text, reason text, lease jsonb)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.mission_dispatch_leases%rowtype;
begin
  select * into v_row
  from public.mission_dispatch_leases
  where workspace_id = p_workspace_id and mission_id = p_mission_id and dispatch_key = p_dispatch_key
  for update;

  if not found then
    return query select 'refused'::text, 'lease_not_found'::text, null::jsonb;
    return;
  end if;

  if v_row.status <> 'leased' then
    return query select 'refused'::text, 'lease_already_terminal'::text, null::jsonb;
    return;
  end if;

  update public.mission_dispatch_leases
  set status = 'revoked',
      revoked_at = p_now,
      revoked_reason = p_reason,
      version = version + 1,
      updated_at = now()
  where workspace_id = p_workspace_id and mission_id = p_mission_id and dispatch_key = p_dispatch_key;

  return query
  select
    'revoked'::text,
    null::text,
    jsonb_build_object(
      'leaseId', v_row.lease_id,
      'workspaceId', p_workspace_id,
      'missionId', p_mission_id,
      'dispatchKey', p_dispatch_key,
      'holder', v_row.lease_owner,
      'state', 'revoked',
      'fencingToken', v_row.fencing_token,
      'acquiredAt', v_row.acquired_at,
      'expiresAt', v_row.expires_at,
      'renewedAt', v_row.renewed_at,
      'releasedAt', null,
      'revokedReason', p_reason
    );
end;
$$;

-- Read-only authoritative fencing check. No row lock: a plain read is
-- sufficient because nothing here mutates state, and a future write path
-- (e.g. attaching execution results) that needs fencing enforced atomically
-- WITH its own write must take its own lock in its own function — this
-- exists as the check a caller performs before that work, not as a
-- substitute for enforcing fencing inside it.
create or replace function public.validate_mission_dispatch_fence_atomic(
  p_workspace_id text,
  p_mission_id text,
  p_dispatch_key text,
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
    from public.mission_dispatch_leases
    where workspace_id = p_workspace_id
      and mission_id = p_mission_id
      and dispatch_key = p_dispatch_key
      and lease_id = p_lease_id
      and fencing_token = p_fencing_token
      and status = 'leased'
  );
$$;

revoke all on public.mission_dispatch_leases from public, anon, authenticated;
revoke all on public.mission_dispatch_intents from public, anon, authenticated;
grant select, insert, update on public.mission_dispatch_leases to service_role;
grant select, insert, update on public.mission_dispatch_intents to service_role;

revoke all on function public.claim_mission_dispatch_candidates_atomic(jsonb, jsonb, timestamptz, bigint, text[])
  from public, anon, authenticated;
grant execute on function public.claim_mission_dispatch_candidates_atomic(jsonb, jsonb, timestamptz, bigint, text[])
  to service_role;

revoke all on function public.renew_mission_dispatch_lease_atomic(text, text, text, text, integer, jsonb, timestamptz, bigint, bigint)
  from public, anon, authenticated;
grant execute on function public.renew_mission_dispatch_lease_atomic(text, text, text, text, integer, jsonb, timestamptz, bigint, bigint)
  to service_role;

revoke all on function public.release_mission_dispatch_lease_atomic(text, text, text, text, integer, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.release_mission_dispatch_lease_atomic(text, text, text, text, integer, jsonb, timestamptz)
  to service_role;

revoke all on function public.revoke_mission_dispatch_lease_atomic(text, text, text, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.revoke_mission_dispatch_lease_atomic(text, text, text, timestamptz, text)
  to service_role;

revoke all on function public.validate_mission_dispatch_fence_atomic(text, text, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.validate_mission_dispatch_fence_atomic(text, text, text, text, integer)
  to service_role;
