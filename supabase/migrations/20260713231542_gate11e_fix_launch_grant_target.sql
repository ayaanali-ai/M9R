-- Gate 11E live-proof correction: routed assignments retain the target agent
-- in target_connection_id. The original RPC referenced the legacy dashboard
-- assignment column name and therefore rejected a valid routed assignment.

create or replace function public.create_resident_launch_grant_atomic(
  p_workspace_id uuid, p_assignment_id uuid, p_requesting_connection_id uuid,
  p_target_connection_id uuid, p_resident_instance_id uuid, p_authorization_id uuid,
  p_provider text, p_repository text, p_repository_binding_id text, p_task text,
  p_required_capabilities jsonb, p_allowed_paths jsonb, p_prohibited_paths jsonb,
  p_max_duration_ms bigint, p_max_estimated_tokens bigint, p_delegation_depth smallint,
  p_approval_policy text, p_idempotency_key text, p_claim_token_hash text,
  p_issued_at timestamptz, p_expires_at timestamptz
)
returns table (accepted boolean, reason text, launch_grant_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_id uuid;
  new_id uuid;
begin
  perform 1 from public.agent_assignments aa
  where aa.id = p_assignment_id and aa.workspace_id = p_workspace_id
    and aa.target_connection_id = p_target_connection_id
    and aa.requesting_connection_id = p_requesting_connection_id
    and aa.resident_instance_id = p_resident_instance_id
  for update;
  if not found then return query select false, 'assignment_mismatch'::text, null::uuid; return; end if;

  select lg.id into existing_id from public.launch_grants lg
  where lg.workspace_id = p_workspace_id and lg.idempotency_key = p_idempotency_key;
  if existing_id is not null then return query select true, 'existing'::text, existing_id; return; end if;

  if p_expires_at <= p_issued_at or p_expires_at > p_issued_at + interval '15 minutes' then
    return query select false, 'invalid_expiry'::text, null::uuid; return;
  end if;
  if not exists (
    select 1 from public.resident_provider_authorizations a
    join public.resident_instances r on r.id = a.resident_instance_id and r.workspace_id = a.workspace_id
    where a.id = p_authorization_id and a.workspace_id = p_workspace_id
      and a.resident_instance_id = p_resident_instance_id and a.target_connection_id = p_target_connection_id
      and a.provider = p_provider and a.repository = p_repository
      and a.repository_binding_id = p_repository_binding_id and a.revoked_at is null
      and a.max_duration_ms >= p_max_duration_ms
      and (p_max_estimated_tokens is null or (a.max_estimated_tokens is not null and a.max_estimated_tokens >= p_max_estimated_tokens))
      and a.max_delegation_depth >= p_delegation_depth
      and a.capabilities @> p_required_capabilities
      and r.connection_id = p_target_connection_id and r.provider = p_provider
      and r.revoked_at is null and r.lease_expires_at > p_issued_at
  ) then return query select false, 'authorization_mismatch'::text, null::uuid; return; end if;

  insert into public.launch_grants (
    workspace_id, assignment_id, requesting_connection_id, target_connection_id,
    resident_instance_id, authorization_id, provider, repository, repository_binding_id,
    task, required_capabilities, allowed_paths, prohibited_paths, max_duration_ms,
    max_estimated_tokens, delegation_depth, approval_policy, state, idempotency_key,
    claim_token_hash, issued_at, expires_at
  ) values (
    p_workspace_id, p_assignment_id, p_requesting_connection_id, p_target_connection_id,
    p_resident_instance_id, p_authorization_id, p_provider, p_repository, p_repository_binding_id,
    p_task, p_required_capabilities, p_allowed_paths, p_prohibited_paths, p_max_duration_ms,
    p_max_estimated_tokens, p_delegation_depth, p_approval_policy, 'queued', p_idempotency_key,
    p_claim_token_hash, p_issued_at, p_expires_at
  ) returning id into new_id;
  insert into public.launch_events (
    workspace_id, launch_grant_id, resident_instance_id, source, event_type,
    from_state, to_state, sequence, occurred_at
  ) values
    (p_workspace_id, new_id, p_resident_instance_id, 'oathlock_policy', 'authorize', 'requested', 'authorized', 1, p_issued_at),
    (p_workspace_id, new_id, p_resident_instance_id, 'oathlock_policy', 'queue', 'authorized', 'queued', 2, p_issued_at);
  update public.agent_assignments set launch_grant_id = new_id where id = p_assignment_id;
  return query select true, null::text, new_id;
end;
$$;

revoke all on function public.create_resident_launch_grant_atomic(uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, text, jsonb, jsonb, jsonb, bigint, bigint, smallint, text, text, text, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.create_resident_launch_grant_atomic(uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, text, jsonb, jsonb, jsonb, bigint, bigint, smallint, text, text, text, timestamptz, timestamptz) to service_role;
