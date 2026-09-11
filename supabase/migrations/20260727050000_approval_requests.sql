-- Durable human-approval requests for the bearer-CLI 403 dead-end.
--
-- Problem: when a bearer (CLI) run-start hits `needs_approval`, the API
-- returns a bare 403 with nothing persisted (see
-- PREFLIGHT_PERSISTENCE_SUPPORTED = false in
-- src/app/api/agent/run/start/route.ts). A bearer client structurally cannot
-- self-approve (no cookie session), so it has no path forward and no
-- durable record a human can act on. This table gives that 403 an id, an
-- expiry, and a decision a human can make from the dashboard.
--
-- Scope: narrowly `agent_run_start` only. Not a general approval system, not
-- a replacement for the Mission-planning approvalPolicy subsystem (separate,
-- untouched). Service-role-only, matching how this bearer-auth surface
-- (agent_connections / agent_runs, see agent-join-service.ts) is written
-- through app-code scoping rather than RLS + authenticated-role policies.
create table if not exists public.approval_requests (
  id text primary key,
  workspace_id text not null,
  connection_id text not null,
  operation_type text not null,
  operation_identity text not null,
  idempotency_key text not null unique,
  risk_classification text not null,
  status text not null check (status in ('pending', 'approved', 'rejected', 'expired', 'consumed')),
  -- Compact preflight snapshot only (status/risk_level/sensitive_areas/
  -- matched_rule_count/approval_required/checked_at) — never the raw task
  -- payload, prompt, or any secret-shaped content. Bounded to 8KB.
  request_summary jsonb not null check (octet_length(request_summary::text) <= 8192),
  created_at timestamptz not null default now(),
  -- 24h default TTL: long enough for a human to notice and act during a
  -- normal workday, short enough that a stale pending request does not
  -- silently authorize a run days later once finally approved.
  expires_at timestamptz not null,
  decided_at timestamptz,
  decided_by_user_id text,
  decision_note text check (decision_note is null or char_length(decision_note) <= 1000)
);

create index if not exists approval_requests_workspace_idx
  on public.approval_requests (workspace_id);

create index if not exists approval_requests_expires_at_idx
  on public.approval_requests (expires_at)
  where status = 'pending';

-- ---------------------------------------------------------------------------
-- create_or_get_pending_approval_request
-- ---------------------------------------------------------------------------
-- Atomic upsert-by-idempotency-key. A retried identical bearer request
-- resolves to the SAME row while it is still pending and unexpired. A prior
-- decided/expired row never gets resurrected — a genuinely new approval
-- cycle gets a new row (new id, new expiry).
create or replace function public.create_or_get_pending_approval_request(
  p_id text,
  p_workspace_id text,
  p_connection_id text,
  p_operation_type text,
  p_operation_identity text,
  p_idempotency_key text,
  p_risk_classification text,
  p_request_summary jsonb,
  p_now timestamptz,
  p_expires_at timestamptz
)
returns public.approval_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.approval_requests%rowtype;
  v_row public.approval_requests%rowtype;
begin
  select * into v_existing
  from public.approval_requests
  where idempotency_key = p_idempotency_key
  for update;

  if found and v_existing.status = 'pending' and v_existing.expires_at > p_now then
    return v_existing;
  end if;

  if found and v_existing.status = 'pending' and v_existing.expires_at <= p_now then
    update public.approval_requests
    set status = 'expired'
    where id = v_existing.id and status = 'pending';
  end if;

  insert into public.approval_requests (
    id, workspace_id, connection_id, operation_type, operation_identity,
    idempotency_key, risk_classification, status, request_summary,
    created_at, expires_at
  ) values (
    p_id, p_workspace_id, p_connection_id, p_operation_type, p_operation_identity,
    p_idempotency_key, p_risk_classification, 'pending', p_request_summary,
    p_now, p_expires_at
  )
  on conflict (idempotency_key) do update set
    id = excluded.id,
    workspace_id = excluded.workspace_id,
    connection_id = excluded.connection_id,
    operation_type = excluded.operation_type,
    operation_identity = excluded.operation_identity,
    risk_classification = excluded.risk_classification,
    status = 'pending',
    request_summary = excluded.request_summary,
    created_at = excluded.created_at,
    expires_at = excluded.expires_at,
    decided_at = null,
    decided_by_user_id = null,
    decision_note = null
  returning * into v_row;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- decide_approval_request
-- ---------------------------------------------------------------------------
-- p_decision is 'approved' or 'rejected'. Refuses (via `reason` on the
-- returned row-shape below) if the request does not exist in this workspace,
-- is already decided, or has expired (auto-transitioning it to 'expired'
-- first so the caller sees the real reason).
create or replace function public.decide_approval_request(
  p_id text,
  p_workspace_id text,
  p_decision text,
  p_decided_by_user_id text,
  p_decision_note text,
  p_now timestamptz
)
returns table (status text, reason text, request public.approval_requests)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.approval_requests%rowtype;
begin
  if p_decision not in ('approved', 'rejected') then
    return query select 'refused'::text, 'invalid_decision'::text, null::public.approval_requests;
    return;
  end if;

  select * into v_row
  from public.approval_requests
  where id = p_id and workspace_id = p_workspace_id
  for update;

  if not found then
    return query select 'refused'::text, 'not_found'::text, null::public.approval_requests;
    return;
  end if;

  if v_row.status = 'pending' and v_row.expires_at <= p_now then
    update public.approval_requests set status = 'expired' where id = v_row.id
    returning * into v_row;
    return query select 'refused'::text, 'expired'::text, v_row;
    return;
  end if;

  if v_row.status <> 'pending' then
    return query select 'refused'::text, 'already_decided'::text, v_row;
    return;
  end if;

  update public.approval_requests
  set status = p_decision,
      decided_at = p_now,
      decided_by_user_id = p_decided_by_user_id,
      decision_note = p_decision_note
  where id = v_row.id
  returning * into v_row;

  return query select 'ok'::text, null::text, v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- get_approval_request
-- ---------------------------------------------------------------------------
-- Workspace-scoped read. A cross-workspace lookup returns no row — behaves
-- identically to "not found", never a distinct/leaking error.
create or replace function public.get_approval_request(
  p_id text,
  p_workspace_id text
)
returns public.approval_requests
language sql
security definer
set search_path = ''
stable
as $$
  select *
  from public.approval_requests
  where id = p_id and workspace_id = p_workspace_id;
$$;

-- ---------------------------------------------------------------------------
-- get_approval_request_by_idempotency_key
-- ---------------------------------------------------------------------------
-- Used by the retry-after-approval check: before re-triggering a 403, the
-- caller looks up whether this exact operation already has an approved (or
-- rejected) request, without needing to know its id up front. Workspace-
-- scoped for the same non-leaking reason as get_approval_request.
create or replace function public.get_approval_request_by_idempotency_key(
  p_idempotency_key text,
  p_workspace_id text
)
returns public.approval_requests
language sql
security definer
set search_path = ''
stable
as $$
  select *
  from public.approval_requests
  where idempotency_key = p_idempotency_key and workspace_id = p_workspace_id;
$$;

-- ---------------------------------------------------------------------------
-- mark_approval_request_consumed
-- ---------------------------------------------------------------------------
-- Called after the originally-blocked operation successfully proceeds.
-- Idempotent: consuming an already-consumed request is a safe no-op.
create or replace function public.mark_approval_request_consumed(
  p_id text,
  p_workspace_id text,
  p_now timestamptz
)
returns public.approval_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.approval_requests%rowtype;
begin
  select * into v_row
  from public.approval_requests
  where id = p_id and workspace_id = p_workspace_id
  for update;

  if not found then
    return null;
  end if;

  if v_row.status = 'consumed' then
    return v_row;
  end if;

  update public.approval_requests
  set status = 'consumed'
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on public.approval_requests from public, anon, authenticated;
grant select, insert, update on public.approval_requests to service_role;

revoke all on function public.create_or_get_pending_approval_request(text, text, text, text, text, text, text, jsonb, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.create_or_get_pending_approval_request(text, text, text, text, text, text, text, jsonb, timestamptz, timestamptz) to service_role;

revoke all on function public.decide_approval_request(text, text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.decide_approval_request(text, text, text, text, text, timestamptz) to service_role;

revoke all on function public.get_approval_request(text, text) from public, anon, authenticated;
grant execute on function public.get_approval_request(text, text) to service_role;

revoke all on function public.get_approval_request_by_idempotency_key(text, text) from public, anon, authenticated;
grant execute on function public.get_approval_request_by_idempotency_key(text, text) to service_role;

revoke all on function public.mark_approval_request_consumed(text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.mark_approval_request_consumed(text, text, timestamptz) to service_role;
