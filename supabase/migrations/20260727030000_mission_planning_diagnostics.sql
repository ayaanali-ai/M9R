-- Durable diagnostics for the planning worker
-- (src/lib/mission/mission-planning-diagnostics-store.ts, in-memory today).
--
-- This migration is the DB-level enforcement of the idempotency identity
-- closed in mission-planning-diagnostics-store.ts's InMemoryPlanningDiagnosticsStore:
-- idempotency_key is UNIQUE, and create_mission_planning_diagnostic below
-- implements the exact same "same key/same content -> return existing,
-- same key/different content -> typed conflict" contract as the in-memory
-- store, so the two are behaviorally interchangeable from a caller's POV.
--
-- Bounded payload size: 32 KiB (32768 bytes), checked via
-- octet_length(payload::text). This is larger than the in-memory store's
-- MAX_DIAGNOSTIC_RECORD_BYTES (8192) because `payload` here is a full jsonb
-- object (structured fields + text), not just a bounded text blob — the
-- bound exists to cap worst-case row size and defend against a caller
-- forgetting to redact/bound upstream, not to be the primary bounding
-- mechanism (redactForDiagnostics's MAX_DIAGNOSTIC_TEXT_CHARS truncation
-- upstream is still the primary bound in practice).
--
-- Append-only: no update/delete grants to any role, including service_role.
-- A "correction" is a new row under a new idempotency_key, never an edit.
create table if not exists public.mission_planning_diagnostics (
  diagnostic_ref text primary key,
  workspace_id text not null,
  mission_id text not null references public.missions(id) on delete cascade,
  planning_request_id text not null,
  worker_attempt_id text references public.mission_planning_worker_attempts(worker_attempt_id),
  diagnostic_kind text not null,
  stage text not null check (stage in ('invocation', 'parse', 'validation', 'simulation', 'repair', 'terminal')),
  model_configuration_id text not null,
  provider_request_id text,
  context_hash text not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 32768),
  payload_digest text not null,
  redaction_status text not null check (redaction_status in ('not_stored', 'redacted', 'fully_removed', 'unavailable', 'rejected_unsafe')),
  retention_class text not null default 'default',
  -- Idempotency identity — see mission-planning-diagnostics-store.ts's
  -- computeIdempotencyKey for the exact field composition this must match
  -- (workspaceId, missionId, planningRequestId, workerAttemptId-or-marker,
  -- diagnosticKind, stage, contextHash). Computed by the caller (the JS
  -- adapter layer), not derived inside this function, so the in-memory and
  -- Supabase-backed stores hash identically.
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  constraint mission_planning_diagnostics_idempotency_key_unique unique (idempotency_key)
);

create index if not exists mission_planning_diagnostics_request_idx
  on public.mission_planning_diagnostics (workspace_id, mission_id, planning_request_id, created_at);

create index if not exists mission_planning_diagnostics_attempt_idx
  on public.mission_planning_diagnostics (worker_attempt_id)
  where worker_attempt_id is not null;

-- "Bounded response material for deterministic replay" — a dedicated,
-- lightweight table rather than overloading `mission_planning_diagnostics`
-- with a `diagnostic_kind = 'replayable_response'` special case: the
-- replay executor's needs (digest-checked bounded raw structured output,
-- schema version, model_configuration_id, and a fast single-row lookup by
-- worker_attempt_id) are different enough from the diagnostics table's
-- append-many-per-attempt shape that a 1:1-per-attempt table is simpler to
-- reason about and query than filtering a diagnostic_kind out of a
-- many-rows-per-attempt table. Still append-only, still bounded, still
-- never authoritative on its own — replay always re-validates fresh (see
-- mission-planning-recovery-executor.ts).
create table if not exists public.mission_planning_replayable_responses (
  worker_attempt_id text primary key references public.mission_planning_worker_attempts(worker_attempt_id),
  workspace_id text not null,
  mission_id text not null references public.missions(id) on delete cascade,
  planning_request_id text not null,
  model_configuration_id text not null,
  schema_version integer not null,
  -- The redacted raw structured output text, bounded the same way
  -- redactForDiagnostics bounds diagnostic text (2000 chars pre-redaction
  -- truncation upstream); this column's own hard cap is a defense-in-depth
  -- bound, not the primary one.
  redacted_raw_output text not null check (octet_length(redacted_raw_output) <= 32768),
  output_digest text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- create_mission_planning_diagnostic
-- ---------------------------------------------------------------------------
-- Implements the 7-step atomic sequence:
--   1. validate relationships (Mission exists + workspace matches; planning
--      request/attempt existence is trusted from the caller the same way
--      claim_mission_planning_lease trusts p_request_exists — no dedicated
--      planning-request table exists to validate against directly);
--   2. validate fence if the attempt is still active (worker_attempt_id
--      supplied + p_fencing_token supplied -> re-checked against the
--      attempts table);
--   3. check idempotency (unique key lookup);
--   4. return existing on identical retry (same key, same payload_digest);
--   5. refuse conflicting content with a typed error (same key, different
--      payload_digest);
--   6. insert bounded, redacted payload (payload/redaction already applied
--      by the caller — the JS adapter layer — before this function is
--      called, matching the in-memory store's contract that callers pass
--      already-redacted content);
--   7. return the stable ref.
create or replace function public.create_mission_planning_diagnostic(
  p_diagnostic_ref text,
  p_workspace_id text,
  p_mission_id text,
  p_planning_request_id text,
  p_worker_attempt_id text,
  p_fencing_token integer,
  p_diagnostic_kind text,
  p_stage text,
  p_model_configuration_id text,
  p_provider_request_id text,
  p_context_hash text,
  p_payload jsonb,
  p_payload_digest text,
  p_redaction_status text,
  p_retention_class text,
  p_idempotency_key text
)
returns table (status text, reason text, diagnostic public.mission_planning_diagnostics)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mission public.missions%rowtype;
  v_attempt public.mission_planning_worker_attempts%rowtype;
  v_existing public.mission_planning_diagnostics%rowtype;
  v_row public.mission_planning_diagnostics%rowtype;
  v_terminal_states constant text[] := array['completed','failed','cancelled','stale','superseded','lease_lost','outcome_unknown'];
begin
  -- (1) validate relationships.
  select * into v_mission from public.missions where id = p_mission_id;
  if not found then
    return query select 'refused'::text, 'mission_not_found'::text, null::public.mission_planning_diagnostics;
    return;
  end if;
  if v_mission.workspace_id <> p_workspace_id then
    return query select 'refused'::text, 'workspace_mismatch'::text, null::public.mission_planning_diagnostics;
    return;
  end if;

  if p_worker_attempt_id is not null then
    select * into v_attempt from public.mission_planning_worker_attempts where worker_attempt_id = p_worker_attempt_id for update;
    if not found then
      return query select 'refused'::text, 'attempt_not_found'::text, null::public.mission_planning_diagnostics;
      return;
    end if;
    if v_attempt.workspace_id <> p_workspace_id or v_attempt.mission_id <> p_mission_id or v_attempt.planning_request_id <> p_planning_request_id then
      return query select 'refused'::text, 'attempt_relationship_mismatch'::text, null::public.mission_planning_diagnostics;
      return;
    end if;

    -- (2) validate fence if the attempt is still active. A terminal attempt
    -- may still record a final diagnostic without a live fence (e.g. the
    -- terminal "context hash mismatch" diagnostic recorded alongside the
    -- failure itself) — only refuse the fence when the attempt is NOT
    -- terminal and the token has moved on.
    if not (v_attempt.state = any(v_terminal_states)) and v_attempt.fencing_token <> p_fencing_token then
      return query select 'refused'::text, 'stale_fencing_token'::text, null::public.mission_planning_diagnostics;
      return;
    end if;
  end if;

  -- (3) check idempotency.
  select * into v_existing from public.mission_planning_diagnostics where idempotency_key = p_idempotency_key;

  if found then
    if v_existing.payload_digest = p_payload_digest then
      -- (4) identical retry -> return existing, no new row.
      return query select 'ok'::text, 'idempotent_replay'::text, v_existing;
      return;
    end if;
    -- (5) conflicting content -> typed refusal, no mutation.
    return query select 'refused'::text, 'idempotency_conflict'::text, v_existing;
    return;
  end if;

  -- (6) insert bounded, redacted payload.
  insert into public.mission_planning_diagnostics (
    diagnostic_ref, workspace_id, mission_id, planning_request_id, worker_attempt_id,
    diagnostic_kind, stage, model_configuration_id, provider_request_id, context_hash,
    payload, payload_digest, redaction_status, retention_class, idempotency_key
  ) values (
    p_diagnostic_ref, p_workspace_id, p_mission_id, p_planning_request_id, p_worker_attempt_id,
    p_diagnostic_kind, p_stage, p_model_configuration_id, p_provider_request_id, p_context_hash,
    p_payload, p_payload_digest, p_redaction_status, coalesce(p_retention_class, 'default'), p_idempotency_key
  )
  returning * into v_row;

  -- (7) return the stable ref (embedded in v_row).
  return query select 'ok'::text, 'created'::text, v_row;
end;
$$;

-- Read-only lookup — workspace-scoped, mirrors InMemoryPlanningDiagnosticsStore.get.
create or replace function public.get_mission_planning_diagnostic(
  p_workspace_id text,
  p_diagnostic_ref text
)
returns public.mission_planning_diagnostics
language sql
security definer
set search_path = ''
stable
as $$
  select * from public.mission_planning_diagnostics
  where diagnostic_ref = p_diagnostic_ref and workspace_id = p_workspace_id;
$$;

-- ---------------------------------------------------------------------------
-- create_mission_planning_replayable_response
-- ---------------------------------------------------------------------------
-- One row per attempt (primary key = worker_attempt_id): a later call for
-- the same attempt with a different output_digest is refused rather than
-- silently overwriting the stored material a replay might depend on.
create or replace function public.create_mission_planning_replayable_response(
  p_worker_attempt_id text,
  p_workspace_id text,
  p_mission_id text,
  p_planning_request_id text,
  p_model_configuration_id text,
  p_schema_version integer,
  p_redacted_raw_output text,
  p_output_digest text
)
returns table (status text, reason text, response public.mission_planning_replayable_responses)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.mission_planning_replayable_responses%rowtype;
  v_row public.mission_planning_replayable_responses%rowtype;
begin
  select * into v_existing from public.mission_planning_replayable_responses where worker_attempt_id = p_worker_attempt_id;

  if found then
    if v_existing.output_digest = p_output_digest then
      return query select 'ok'::text, 'idempotent_replay'::text, v_existing;
      return;
    end if;
    return query select 'refused'::text, 'digest_conflict'::text, v_existing;
    return;
  end if;

  insert into public.mission_planning_replayable_responses (
    worker_attempt_id, workspace_id, mission_id, planning_request_id,
    model_configuration_id, schema_version, redacted_raw_output, output_digest
  ) values (
    p_worker_attempt_id, p_workspace_id, p_mission_id, p_planning_request_id,
    p_model_configuration_id, p_schema_version, p_redacted_raw_output, p_output_digest
  )
  returning * into v_row;

  return query select 'ok'::text, 'created'::text, v_row;
end;
$$;

create or replace function public.get_mission_planning_replayable_response(
  p_workspace_id text,
  p_worker_attempt_id text
)
returns public.mission_planning_replayable_responses
language sql
security definer
set search_path = ''
stable
as $$
  select * from public.mission_planning_replayable_responses
  where worker_attempt_id = p_worker_attempt_id and workspace_id = p_workspace_id;
$$;

-- Append-only tables: no update/delete grants to ANY role, including
-- service_role — a "correction" is a new row under a new idempotency_key
-- (diagnostics) or is simply refused (replayable responses), never an edit.
revoke all on public.mission_planning_diagnostics from public, anon, authenticated;
revoke all on public.mission_planning_replayable_responses from public, anon, authenticated;
grant select, insert on public.mission_planning_diagnostics to service_role;
grant select, insert on public.mission_planning_replayable_responses to service_role;

revoke all on function public.create_mission_planning_diagnostic(text, text, text, text, text, integer, text, text, text, text, text, jsonb, text, text, text, text) from public, anon, authenticated;
grant execute on function public.create_mission_planning_diagnostic(text, text, text, text, text, integer, text, text, text, text, text, jsonb, text, text, text, text) to service_role;

revoke all on function public.get_mission_planning_diagnostic(text, text) from public, anon, authenticated;
grant execute on function public.get_mission_planning_diagnostic(text, text) to service_role;

revoke all on function public.create_mission_planning_replayable_response(text, text, text, text, text, integer, text, text) from public, anon, authenticated;
grant execute on function public.create_mission_planning_replayable_response(text, text, text, text, text, integer, text, text) to service_role;

revoke all on function public.get_mission_planning_replayable_response(text, text) from public, anon, authenticated;
grant execute on function public.get_mission_planning_replayable_response(text, text) to service_role;
