-- Gate 12: retain the abstract model tier that OathLock actually requested.
-- Legacy grants remain nullable; every v2 grant requires one bounded tier.

alter table public.launch_grants
  add column if not exists model_tier text;

alter table public.launch_grants
  drop constraint if exists launch_grants_model_tier_check;
alter table public.launch_grants
  add constraint launch_grants_model_tier_check
  check (model_tier in ('economy', 'balanced', 'frontier'));

create or replace function public.create_resident_launch_grant_v2_atomic(
  p_workspace_id uuid, p_assignment_id uuid, p_requesting_connection_id uuid,
  p_target_connection_id uuid, p_resident_instance_id uuid, p_authorization_id uuid,
  p_provider text, p_repository text, p_repository_binding_id text, p_task text,
  p_required_capabilities jsonb, p_allowed_paths jsonb, p_prohibited_paths jsonb,
  p_max_duration_ms bigint, p_max_estimated_tokens bigint, p_model_tier text,
  p_delegation_depth smallint, p_approval_policy text, p_idempotency_key text,
  p_claim_token_hash text, p_issued_at timestamptz, p_expires_at timestamptz
)
returns table (accepted boolean, reason text, launch_grant_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  result_accepted boolean;
  result_reason text;
  result_grant_id uuid;
begin
  if p_model_tier not in ('economy', 'balanced', 'frontier') then
    return query select false, 'invalid_model_tier'::text, null::uuid;
    return;
  end if;

  select r.accepted, r.reason, r.launch_grant_id
    into result_accepted, result_reason, result_grant_id
  from public.create_resident_launch_grant_atomic(
    p_workspace_id, p_assignment_id, p_requesting_connection_id,
    p_target_connection_id, p_resident_instance_id, p_authorization_id,
    p_provider, p_repository, p_repository_binding_id, p_task,
    p_required_capabilities, p_allowed_paths, p_prohibited_paths,
    p_max_duration_ms, p_max_estimated_tokens, p_delegation_depth,
    p_approval_policy, p_idempotency_key, p_claim_token_hash,
    p_issued_at, p_expires_at
  ) r;

  if result_accepted and result_grant_id is not null then
    update public.launch_grants
      set model_tier = p_model_tier,
          updated_at = greatest(updated_at, p_issued_at)
    where id = result_grant_id
      and workspace_id = p_workspace_id
      and (model_tier is null or model_tier = p_model_tier);
    if not found then
      return query select false, 'model_tier_conflict'::text, result_grant_id;
      return;
    end if;
  end if;

  return query select result_accepted, result_reason, result_grant_id;
end;
$$;

revoke all on function public.create_resident_launch_grant_v2_atomic(
  uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, text,
  jsonb, jsonb, jsonb, bigint, bigint, text, smallint, text, text, text,
  timestamptz, timestamptz
) from public, anon, authenticated;

grant execute on function public.create_resident_launch_grant_v2_atomic(
  uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, text,
  jsonb, jsonb, jsonb, bigint, bigint, text, smallint, text, text, text,
  timestamptz, timestamptz
) to service_role;
