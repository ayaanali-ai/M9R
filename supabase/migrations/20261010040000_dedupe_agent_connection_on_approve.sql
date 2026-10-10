-- Fix confirmed live (2026-10-10): approve_agent_claim_atomic always inserted a
-- brand-new agent_connections row on every approval, with no check for an
-- existing one. Every reconnect of the same person's same provider (a
-- restart, a new terminal session, a different machine) created another row,
-- all sharing the same generic agent_kind display label ("Codex", "OpenCode")
-- with nothing to distinguish them -- confirmed in production: two separate
-- "Codex" connections and two separate "OpenCode" connections, indistinguishable
-- in the UI, no way to tell which one a message actually came from or whether
-- it's even still alive.
--
-- Fix: before inserting the new connection, retire any existing ACTIVE
-- connection for the same (workspace_id, agent_kind, created_by) -- the same
-- person reconnecting the same provider in the same workspace. History
-- (sessions, runs, messages already sent) stays attached to the retired
-- connection's id, untouched; only its `status`/`revoked_at` change, so this
-- never loses data, it just stops leaving zombie "Connected" duplicates
-- behind every time someone reconnects.
create or replace function public.approve_agent_claim_atomic(
  p_claim_id uuid,
  p_user_id uuid,
  p_workspace_id uuid,
  p_token_hash text,
  p_one_time_token text,
  p_scopes text[],
  p_approved_at timestamptz
)
returns table (
  accepted boolean,
  reason text,
  claim_status text,
  approved_workspace_id uuid,
  approved_connection_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked_claim public.agent_claims%rowtype;
  new_connection_id uuid;
begin
  select * into locked_claim
  from public.agent_claims
  where id = p_claim_id
  for update;

  if not found then
    return query select false, 'not_found'::text, null::text, null::uuid, null::uuid;
    return;
  end if;

  if locked_claim.status <> 'pending' then
    return query select false, 'already_resolved'::text, locked_claim.status, null::uuid, null::uuid;
    return;
  end if;

  if locked_claim.expires_at <= p_approved_at then
    update public.agent_claims
    set status = 'expired'
    where id = locked_claim.id;
    return query select false, 'expired'::text, 'expired'::text, null::uuid, null::uuid;
    return;
  end if;

  if p_token_hash is null or p_token_hash = '' or p_one_time_token is null or p_one_time_token = '' then
    raise exception 'claim token material is required';
  end if;

  -- Retire this same person's prior active connection(s) for this same
  -- provider in this same workspace before creating the new one -- never
  -- more than one live connection per (workspace, agent_kind, owner) at a
  -- time. Revoke their tokens too, same as the existing manual disconnect
  -- path (disconnectAgentConnection / agent-join-service.ts), so a retired
  -- duplicate can't still authenticate after being superseded.
  with retired as (
    update public.agent_connections
    set status = 'revoked', revoked_at = p_approved_at
    where workspace_id = p_workspace_id
      and agent_kind = locked_claim.agent_kind
      and created_by = p_user_id
      and status = 'active'
    returning id
  )
  update public.agent_tokens
  set revoked_at = p_approved_at
  where connection_id in (select id from retired)
    and revoked_at is null;

  insert into public.agent_connections (
    workspace_id,
    claim_id,
    agent_kind,
    repo_hint,
    rule_targets,
    status,
    created_by
  ) values (
    p_workspace_id,
    locked_claim.id,
    locked_claim.agent_kind,
    locked_claim.repo_hint,
    coalesce(locked_claim.rule_targets, '{}'),
    'active',
    p_user_id
  )
  returning id into new_connection_id;

  insert into public.agent_tokens (
    connection_id,
    workspace_id,
    token_hash,
    scopes
  ) values (
    new_connection_id,
    p_workspace_id,
    p_token_hash,
    coalesce(p_scopes, '{}')
  );

  update public.agent_claims
  set status = 'approved',
      approved_by = p_user_id,
      workspace_id = p_workspace_id,
      connection_id = new_connection_id,
      one_time_token = p_one_time_token,
      approved_at = p_approved_at
  where id = locked_claim.id;

  return query
    select true, null::text, 'approved'::text, p_workspace_id, new_connection_id;
end;
$$;
