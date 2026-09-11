-- Durable worker-attempt rows for the planning worker
-- (src/lib/mission/mission-planning-attempt-store.ts, in-memory today).
--
-- Written BEFORE the lease-table migration (20260727020000) so that
-- claim_mission_planning_lease can insert the initial attempt row in the
-- SAME transaction as the lease claim (see that migration's function body).
-- This migration does not implement lease claiming itself.
--
-- Design choice — append-only transition LOG, not just a current-row table:
-- `mission_planning_worker_attempts` holds the current/authoritative row per
-- attempt (mirroring InMemoryPlanningAttemptStore's shape exactly), and
-- `mission_planning_worker_attempt_transitions` is a separate, immutable,
-- insert-only log of every accepted transition. Rationale: the in-memory
-- store already keeps `transitions: PlanningAttemptTransitionRecord[]`
-- on the attempt object itself (see mission-planning-attempt-store.ts) as an
-- append-only array; a real transition-log TABLE is the direct durable
-- analogue of that array, and keeping it as a separate table (rather than a
-- jsonb array column mutated in place) means the log itself is genuinely
-- immutable at the database level (insert-only grant, no update/delete),
-- rather than "immutable by convention" inside a jsonb blob that an update
-- statement could still clobber.
create table if not exists public.mission_planning_worker_attempts (
  worker_attempt_id text primary key,
  workspace_id text not null,
  mission_id text not null references public.missions(id) on delete cascade,
  planning_request_id text not null,
  lease_id text not null,
  fencing_token integer not null check (fencing_token >= 0),
  worker_id text not null,
  model_configuration_id text not null,
  provider_request_id text,
  -- Self-referencing repair linkage (mission-planning-attempt-store.ts's
  -- `parentAttemptId`) — nullable, only set for attempt_kind = 'schema_repair'
  -- / 'validation_repair' rows that are bounded-retrying a specific prior
  -- attempt. Deferred FK (not validated until commit) so a repair row and
  -- its parent can be inserted in either order within one transaction if a
  -- future caller ever needs that.
  parent_attempt_id text references public.mission_planning_worker_attempts(worker_attempt_id) deferrable initially deferred,
  attempt_kind text not null check (attempt_kind in (
    'initial_invocation', 'transport_retry', 'throttling_retry',
    'schema_repair', 'validation_repair',
    'deterministic_pipeline_replay', 'persistence_replay'
  )),
  attempt_number integer not null check (attempt_number >= 1),
  -- Matches mission-planning-worker.ts's WorkerLifecycleState plus the
  -- recovery-specific states already modeled in
  -- mission-planning-attempt-store.ts's PlanningAttemptState union.
  state text not null check (state in (
    'claimed', 'invoking', 'response_received', 'parsing', 'validating',
    'simulating', 'repairing', 'recording_result',
    'completed', 'failed', 'cancelled', 'stale', 'superseded',
    'lease_lost', 'outcome_unknown'
  )),
  context_hash text not null,
  outcome_classification text check (outcome_classification in (
    'success', 'provider_rejected', 'transport_failure', 'throttled',
    'outcome_unknown', 'cancelled', 'stale', 'superseded', 'lease_lost'
  )),
  diagnostic_ref text,
  retry_class text,
  started_at timestamptz not null,
  response_received_at timestamptz,
  completed_at timestamptz,
  correlation_id text not null,
  causation_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists mission_planning_worker_attempts_request_idx
  on public.mission_planning_worker_attempts (workspace_id, mission_id, planning_request_id, started_at);

create index if not exists mission_planning_worker_attempts_nonterminal_idx
  on public.mission_planning_worker_attempts (workspace_id)
  where state not in ('completed', 'failed', 'cancelled', 'stale', 'superseded', 'lease_lost', 'outcome_unknown');

create index if not exists mission_planning_worker_attempts_parent_idx
  on public.mission_planning_worker_attempts (parent_attempt_id)
  where parent_attempt_id is not null;

-- Immutable, insert-only transition log — the durable analogue of the
-- in-memory `PlanningWorkerAttempt.transitions` array. One row per accepted
-- `transition_mission_planning_attempt` call (including the initial
-- `claimed` row inserted alongside attempt creation).
create table if not exists public.mission_planning_worker_attempt_transitions (
  id uuid primary key default gen_random_uuid(),
  worker_attempt_id text not null references public.mission_planning_worker_attempts(worker_attempt_id) on delete cascade,
  to_state text not null,
  detail text,
  occurred_at timestamptz not null default now()
);

create index if not exists mission_planning_worker_attempt_transitions_attempt_idx
  on public.mission_planning_worker_attempt_transitions (worker_attempt_id, occurred_at);

-- ---------------------------------------------------------------------------
-- create_mission_planning_attempt
-- ---------------------------------------------------------------------------
-- Standalone creation path for callers that are not going through
-- claim_mission_planning_lease's combined claim+create (see the lease
-- migration) — e.g. backfill/ops tooling. The normal worker path creates the
-- attempt as part of the lease-claim function in the same transaction.
create or replace function public.create_mission_planning_attempt(
  p_worker_attempt_id text,
  p_workspace_id text,
  p_mission_id text,
  p_planning_request_id text,
  p_lease_id text,
  p_fencing_token integer,
  p_worker_id text,
  p_model_configuration_id text,
  p_attempt_kind text,
  p_attempt_number integer,
  p_context_hash text,
  p_correlation_id text,
  p_causation_id text,
  p_parent_attempt_id text,
  p_now timestamptz
)
returns public.mission_planning_worker_attempts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.mission_planning_worker_attempts%rowtype;
begin
  insert into public.mission_planning_worker_attempts (
    worker_attempt_id, workspace_id, mission_id, planning_request_id, lease_id, fencing_token,
    worker_id, model_configuration_id, attempt_kind, attempt_number, state, context_hash,
    started_at, correlation_id, causation_id, parent_attempt_id
  ) values (
    p_worker_attempt_id, p_workspace_id, p_mission_id, p_planning_request_id, p_lease_id, p_fencing_token,
    p_worker_id, p_model_configuration_id, p_attempt_kind, p_attempt_number, 'claimed', p_context_hash,
    p_now, p_correlation_id, p_causation_id, p_parent_attempt_id
  )
  returning * into v_row;

  insert into public.mission_planning_worker_attempt_transitions (worker_attempt_id, to_state, occurred_at)
  values (p_worker_attempt_id, 'claimed', p_now);

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- transition_mission_planning_attempt
-- ---------------------------------------------------------------------------
-- Mirrors InMemoryPlanningAttemptStore.transition's exact semantics:
--   - fencing token must match the attempt's own captured token, or refused;
--   - duplicate identical terminal transition -> no-op, returns existing row
--     (no new transition-log row is written for a true duplicate);
--   - conflicting terminal transition (already terminal, different state
--     requested) -> refused with a typed reason, no mutation.
create or replace function public.transition_mission_planning_attempt(
  p_worker_attempt_id text,
  p_fencing_token integer,
  p_to_state text,
  p_now timestamptz,
  p_detail text,
  p_outcome_classification text
)
returns table (status text, reason text, attempt public.mission_planning_worker_attempts)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.mission_planning_worker_attempts%rowtype;
  v_terminal_states constant text[] := array['completed','failed','cancelled','stale','superseded','lease_lost','outcome_unknown'];
begin
  select * into v_row from public.mission_planning_worker_attempts where worker_attempt_id = p_worker_attempt_id for update;

  if not found then
    return query select 'refused'::text, 'not_found'::text, null::public.mission_planning_worker_attempts;
    return;
  end if;

  if v_row.fencing_token <> p_fencing_token then
    return query select 'refused'::text, 'stale_fencing_token'::text, null::public.mission_planning_worker_attempts;
    return;
  end if;

  if v_row.state = any(v_terminal_states) then
    if v_row.state = p_to_state then
      -- Idempotent duplicate terminal write: no mutation, no new log row.
      return query select 'ok'::text, 'noop_duplicate_terminal'::text, v_row;
      return;
    end if;
    return query select 'refused'::text, 'conflicting_terminal_write'::text, null::public.mission_planning_worker_attempts;
    return;
  end if;

  update public.mission_planning_worker_attempts
  set state = p_to_state,
      outcome_classification = coalesce(p_outcome_classification, outcome_classification),
      completed_at = case when p_to_state = any(v_terminal_states) then p_now else completed_at end,
      response_received_at = case when p_to_state = 'response_received' then p_now else response_received_at end,
      updated_at = now()
  where worker_attempt_id = p_worker_attempt_id
  returning * into v_row;

  insert into public.mission_planning_worker_attempt_transitions (worker_attempt_id, to_state, detail, occurred_at)
  values (p_worker_attempt_id, p_to_state, p_detail, p_now);

  return query select 'ok'::text, null::text, v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- attach_mission_planning_attempt_provider_request_id
-- ---------------------------------------------------------------------------
-- provider_request_id may be attached once it is known (after the model call
-- is actually in flight). Immutable once set to a non-null value: a later
-- call with a DIFFERENT value is rejected, matching
-- InMemoryPlanningAttemptStore.attachProviderRequestId.
create or replace function public.attach_mission_planning_attempt_provider_request_id(
  p_worker_attempt_id text,
  p_fencing_token integer,
  p_provider_request_id text
)
returns table (status text, reason text, attempt public.mission_planning_worker_attempts)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.mission_planning_worker_attempts%rowtype;
begin
  select * into v_row from public.mission_planning_worker_attempts where worker_attempt_id = p_worker_attempt_id for update;

  if not found then
    return query select 'refused'::text, 'not_found'::text, null::public.mission_planning_worker_attempts;
    return;
  end if;

  if v_row.fencing_token <> p_fencing_token then
    return query select 'refused'::text, 'stale_fencing_token'::text, null::public.mission_planning_worker_attempts;
    return;
  end if;

  if v_row.provider_request_id is not null and v_row.provider_request_id <> p_provider_request_id then
    return query select 'refused'::text, 'conflicting_terminal_write'::text, null::public.mission_planning_worker_attempts;
    return;
  end if;

  update public.mission_planning_worker_attempts
  set provider_request_id = p_provider_request_id, updated_at = now()
  where worker_attempt_id = p_worker_attempt_id
  returning * into v_row;

  return query select 'ok'::text, null::text, v_row;
end;
$$;

revoke all on public.mission_planning_worker_attempts from public, anon, authenticated;
revoke all on public.mission_planning_worker_attempt_transitions from public, anon, authenticated;
grant select, insert, update on public.mission_planning_worker_attempts to service_role;
-- Append-only: service_role may insert/select transitions, never update/delete.
grant select, insert on public.mission_planning_worker_attempt_transitions to service_role;

revoke all on function public.create_mission_planning_attempt(text, text, text, text, text, integer, text, text, text, integer, text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.create_mission_planning_attempt(text, text, text, text, text, integer, text, text, text, integer, text, text, text, text, timestamptz) to service_role;

revoke all on function public.transition_mission_planning_attempt(text, integer, text, timestamptz, text, text) from public, anon, authenticated;
grant execute on function public.transition_mission_planning_attempt(text, integer, text, timestamptz, text, text) to service_role;

revoke all on function public.attach_mission_planning_attempt_provider_request_id(text, integer, text) from public, anon, authenticated;
grant execute on function public.attach_mission_planning_attempt_provider_request_id(text, integer, text) to service_role;
