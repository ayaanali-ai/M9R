-- Serialize claim approval and one-time token delivery inside PostgreSQL.
-- App-level read/insert/update sequences are not race-safe: concurrent approval
-- requests can provision multiple connections, and concurrent polls can both
-- observe the transient raw token before either clears it.

create unique index if not exists agent_connections_claim_id_unique
  on public.agent_connections (claim_id)
  where claim_id is not null;

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

create or replace function public.consume_agent_claim_token_atomic(
  p_claim_id uuid,
  p_setup_code_hash text,
  p_retrieved_at timestamptz
)
returns table (
  accepted boolean,
  reason text,
  claim_status text,
  one_time_token text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked_claim public.agent_claims%rowtype;
  token_to_deliver text;
begin
  select * into locked_claim
  from public.agent_claims
  where id = p_claim_id
  for update;

  if not found then
    return query select false, 'not_found'::text, null::text, null::text;
    return;
  end if;

  -- Verify the setup secret before returning even the claim state.
  if p_setup_code_hash is null or locked_claim.setup_code_hash <> p_setup_code_hash then
    return query select false, 'bad_setup_code'::text, null::text, null::text;
    return;
  end if;

  if locked_claim.status = 'pending' and locked_claim.expires_at <= p_retrieved_at then
    update public.agent_claims
    set status = 'expired'
    where id = locked_claim.id;
    return query select true, null::text, 'expired'::text, null::text;
    return;
  end if;

  if locked_claim.status <> 'approved' then
    return query select true, null::text, locked_claim.status, null::text;
    return;
  end if;

  if locked_claim.one_time_token is null or locked_claim.token_retrieved_at is not null then
    return query select true, 'token_already_retrieved'::text, 'approved'::text, null::text;
    return;
  end if;

  token_to_deliver := locked_claim.one_time_token;
  update public.agent_claims
  set one_time_token = null,
      token_retrieved_at = p_retrieved_at
  where id = locked_claim.id;

  return query select true, null::text, 'approved'::text, token_to_deliver;
end;
$$;

revoke all on function public.approve_agent_claim_atomic(uuid, uuid, uuid, text, text, text[], timestamptz)
  from public, anon, authenticated;
grant execute on function public.approve_agent_claim_atomic(uuid, uuid, uuid, text, text, text[], timestamptz)
  to service_role;

revoke all on function public.consume_agent_claim_token_atomic(uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.consume_agent_claim_token_atomic(uuid, text, timestamptz)
  to service_role;
