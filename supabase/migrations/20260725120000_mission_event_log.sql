-- Durable backing for the Mission domain (src/lib/mission/*).
--
-- One command's persistence — idempotency resolution, version check, event
-- append, and outcome recording — must commit as a single transaction.
-- Splitting it across two RPC calls (an earlier draft of this migration did
-- exactly that: append_mission_events_atomic then a separate
-- remember_mission_command_outcome_atomic) leaves a real window: a crash or
-- network failure between the two calls commits the Mission's events while
-- the idempotency record never lands, so a retried command can no longer
-- recognize itself as a duplicate. apply_mission_command_atomic is the fix —
-- one function, one implicit transaction, covering all three tables.
--
-- Domain transition legality (state machine rules, terminal immutability,
-- reason requirements) is NOT reimplemented here. The application
-- (applyMissionCommand, a pure function) computes the events and the result
-- to store; this function only enforces mechanical, cross-cutting
-- invariants that a database transaction is actually suited to guarantee:
-- idempotency-key resolution, optimistic version locking, contiguous
-- sequencing, and atomicity of the write.
--
-- This is a backend event log, not an end-user-facing table: no RLS policy
-- is defined, matching the existing agent_claims / launch_events precedent.
-- Access is gated entirely by table grants (service_role only) and the
-- security definer function below.

create table if not exists public.missions (
  id text primary key,
  -- Genesis identity: written once, at the first insert for this id
  -- (`on conflict (id) do nothing` in apply_mission_command_atomic below), and
  -- never updated afterward. No column-level revoke enforces this in SQL
  -- today — the immutability is a property of what the function chooses to
  -- write, not of a grant. Tracked as the same class of gap as the tenant-
  -- scope finding this phase closes, not re-opened here.
  workspace_id text not null,
  repository_id text,
  current_version integer not null default 0 check (current_version >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists missions_workspace_id_idx on public.missions (workspace_id);

create table if not exists public.mission_events (
  id uuid primary key default gen_random_uuid(),
  mission_id text not null references public.missions(id) on delete cascade,
  aggregate_version integer not null check (aggregate_version > 0),
  event_id text not null,
  event_type text not null check (event_type in (
    'mission.created',
    'mission.plan_proposed',
    'mission.plan_approved',
    'mission.state_changed',
    'mission.participant_added',
    'mission.evidence_attached',
    'mission.evidence_attested',
    'mission.decision_recorded',
    -- Phase 4A: participants, assignments, the Agent Message Protocol. No
    -- new table — these are new payload shapes riding the same jsonb
    -- `payload` column every prior event type already uses.
    'mission.participant_registered',
    'mission.participant_status_changed',
    'mission.participant_removed',
    'mission.assignment_created',
    'mission.assignment_status_changed',
    'mission.message_posted',
    -- Phase 4B: finding lifecycle. Same reasoning — no new table.
    'mission.finding_opened',
    'mission.finding_status_changed',
    -- Phase 5A: Mission Plan proposals. Named "plan_proposal_*" to avoid
    -- colliding with the existing 'mission.plan_proposed'/
    -- 'mission.plan_approved' above (Mission's own bare planVersion
    -- counter — a different, thinner concept). Same reasoning as every
    -- other Phase 4+ addition — no new table.
    'mission.plan_proposal_created',
    'mission.plan_proposal_status_changed',
    -- Phase 4D Part 4: evidence provenance. Not a mutation of
    -- 'mission.evidence_attached'/'mission.evidence_attested' above (Phase
    -- 1's bare {evidenceId, digest} pair) — same disambiguation precedent
    -- as the Phase 5A Plan-proposal events.
    'mission.evidence_recorded',
    'mission.evidence_superseded',
    -- Phase 5B: model-assisted planning request/result lifecycle. Two event
    -- types cover the full PlanningRequestStatus machine — same "one
    -- status-changed event reused across every transition" pattern as
    -- every prior phase's addition. A successful result still emits the
    -- EXISTING 'mission.plan_proposal_created'/'mission.plan_proposal_status_changed'
    -- above — no new Plan-creation path.
    'mission.model_plan_request_created',
    'mission.model_plan_request_status_changed'
  )),
  -- text, not integer: TypeScript's MissionEvent.schemaVersion is the
  -- literal string constant "oathlock.mission-event.v1"
  -- (mission-events.ts's MISSION_EVENT_SCHEMA_VERSION), never a bare
  -- integer. A prior draft of this column was `integer`, cast from the
  -- JSON value below — every real event produced by current TypeScript
  -- would have failed that cast at insert time. Fixed by matching the
  -- actual shape TypeScript emits rather than the shape this column
  -- assumed it would.
  schema_version text not null,
  actor jsonb not null check (jsonb_typeof(actor) = 'object'),
  reason jsonb,
  correlation_id text not null,
  causation_id text,
  provenance text not null check (provenance in ('agent_report', 'human_input', 'system_inference', 'external_verification')),
  occurred_at timestamptz not null,
  payload jsonb not null default '{}'::jsonb check (
    jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 131072
  ),
  recorded_at timestamptz not null default now(),
  unique (mission_id, aggregate_version),
  unique (mission_id, event_id)
);

create index if not exists mission_events_mission_id_version_idx
  on public.mission_events (mission_id, aggregate_version);

create table if not exists public.mission_command_outcomes (
  -- Idempotency keys are scoped to a workspace, not global: two different
  -- workspaces may reuse the same caller-supplied key without colliding.
  -- (Previously `idempotency_key text primary key` — that made the key a
  -- de facto cross-tenant namespace, the same class of gap the missing
  -- workspace_id column left on `missions`/`mission_events`.)
  workspace_id text not null,
  idempotency_key text not null,
  mission_id text not null references public.missions(id) on delete cascade,
  command_type text not null,
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  aggregate_version integer not null,
  recorded_at timestamptz not null default now(),
  primary key (workspace_id, idempotency_key)
);

create index if not exists mission_command_outcomes_mission_id_idx
  on public.mission_command_outcomes (mission_id);

-- Apply one already-computed command outcome atomically.
--
-- p_result is the full CommandOutcomeRecord the application already built
-- (idempotencyKey, payloadDigest, events, aggregateVersion) — stored
-- verbatim so a replay returns exactly what the original caller received.
--
-- Returns exactly one of:
--   'applied'              — this call performed the write; current_version
--                             reflects it.
--   'replayed'              — an identical command (same key, same payload
--                             digest) already committed; stored_result is
--                             the ORIGINAL outcome, not a new computation.
--   'idempotency_conflict'  — same key, different payload digest: a caller
--                             reused a key for different work. Refused.
--   'version_conflict'      — the Mission moved between the caller's read
--                             and this call; current_version is the real
--                             value so the caller can retry from fresh state.
--   'workspace_mismatch'    — the caller-supplied p_workspace_id does not
--                             match the Mission's own genesis workspace_id.
--                             `on conflict (id) do nothing` below means an
--                             existing Mission's workspace_id was NEVER
--                             re-checked against what a later caller
--                             supplies — a caller who simply knows a
--                             mission_id could append events and read the
--                             outcome under an unrelated workspace_id. This
--                             is the tenant-isolation boundary, enforced
--                             here rather than trusted to be satisfied by
--                             every future caller.
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
  -- Fast path: this exact command already ran. No lock needed to read an
  -- immutable, already-committed row. Scoped by workspace_id — idempotency
  -- keys are only unique within a workspace, not globally.
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

  -- Establish Mission genesis (no-op if it already exists) and lock the row
  -- for the remainder of this transaction — every later check in this
  -- function, including the idempotency recheck below, executes while
  -- holding this lock, so no concurrent caller can commit in between.
  -- workspace_id/repository_id are written ONLY on this first insert — a
  -- later command for the same mission_id hits `on conflict do nothing` and
  -- can pass whatever it wants for these two params without effect, which is
  -- the immutability the domain layer (Mission.workspaceId/repositoryId)
  -- requires.
  insert into public.missions (id, workspace_id, repository_id, current_version)
  values (p_mission_id, p_workspace_id, p_repository_id, 0)
  on conflict (id) do nothing;

  select current_version, workspace_id into v_current_version, v_mission_workspace_id
  from public.missions
  where id = p_mission_id
  for update;

  -- Tenant boundary: refused BEFORE the idempotency/version checks below,
  -- and before any event is appended. A caller cannot use a correct
  -- idempotency key or a correct expected_version to work around presenting
  -- the wrong workspace_id for an existing Mission.
  if v_mission_workspace_id is distinct from p_workspace_id then
    return query select 'workspace_mismatch'::text, v_current_version, null::text, null::jsonb;
    return;
  end if;

  if v_current_version is distinct from p_expected_version then
    -- Someone else moved the Mission since our caller read it. Before
    -- reporting a conflict, recheck idempotency: if that someone else was
    -- processing THIS EXACT command (a genuine concurrent duplicate that
    -- raced past our first, unlocked check above), their outcome is now
    -- visible and this call must replay it, not report a false conflict.
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

    -- Defensive: applyMissionCommand already assigns aggregateVersion when
    -- building each event. It must agree with what this lock-protected
    -- sequence computes, or the caller's view of the stream had already
    -- diverged before this transaction began.
    if (v_event ->> 'aggregateVersion')::integer is distinct from v_next_version then
      raise exception 'event aggregateVersion % does not match expected next version % for mission %',
        v_event ->> 'aggregateVersion', v_next_version, p_mission_id;
    end if;

    insert into public.mission_events (
      mission_id,
      aggregate_version,
      event_id,
      event_type,
      schema_version,
      actor,
      reason,
      correlation_id,
      causation_id,
      provenance,
      occurred_at,
      payload
    ) values (
      p_mission_id,
      v_next_version,
      v_event ->> 'eventId',
      v_event ->> 'type',
      v_event ->> 'schemaVersion',
      v_event -> 'actor',
      v_event -> 'reason',
      v_event ->> 'correlationId',
      v_event ->> 'causationId',
      v_event ->> 'provenance',
      (v_event ->> 'timestamp')::timestamptz,
      coalesce(v_event -> 'payload', '{}'::jsonb)
    );

    v_latest_event_id := v_event ->> 'eventId';
  end loop;

  update public.missions
  set current_version = v_next_version,
      updated_at = now()
  where id = p_mission_id;

  -- First write wins, matching InMemoryIdempotencyStore's documented
  -- contract. A unique_violation here means a concurrent caller committed
  -- the identical (workspace_id, idempotency_key) pair between our lookups
  -- above and this insert despite holding the same Mission-row lock we
  -- hold — only possible if it targeted a DIFFERENT mission_id, which is the
  -- caller's bug, not a race this function should paper over.
  insert into public.mission_command_outcomes (
    workspace_id, idempotency_key, mission_id, command_type, result, aggregate_version
  ) values (
    p_workspace_id, p_idempotency_key, p_mission_id, p_command_type, p_result, v_next_version
  );

  return query select 'applied'::text, v_next_version, v_latest_event_id, p_result;
end;
$$;

revoke all on public.missions from public, anon, authenticated;
revoke all on public.mission_events from public, anon, authenticated;
revoke all on public.mission_command_outcomes from public, anon, authenticated;
grant select, insert, update on public.missions to service_role;
grant select, insert on public.mission_events to service_role;
grant select, insert on public.mission_command_outcomes to service_role;

revoke all on function public.apply_mission_command_atomic(text, text, text, text, text, integer, jsonb, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.apply_mission_command_atomic(text, text, text, text, text, integer, jsonb, jsonb, text)
  to service_role;
