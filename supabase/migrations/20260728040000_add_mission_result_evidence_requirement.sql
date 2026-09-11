-- Evidence requirement is trusted execution policy.  Legacy rows remain NULL:
-- NULL means unknown, never "not required".
alter table public.mission_execution_result_inbox add column evidence_required boolean;

-- Replace the old acceptance signature rather than adding an overload.  This
-- prevents callers from bypassing the policy input after this migration.
drop function public.accept_mission_execution_result_atomic(text,text,text,uuid,text,text,text,text,integer,text,integer,text,text,jsonb,jsonb,text,text,timestamptz);
create function public.accept_mission_execution_result_atomic(
  p_workspace_id text, p_mission_id text, p_assignment_id text, p_dispatch_intent_id uuid,
  p_execution_id text, p_provider_adapter_id text, p_lease_id text, p_fencing_generation text,
  p_execution_attempt integer, p_result_kind text, p_result_schema_version integer,
  p_result_digest text, p_idempotency_key text, p_metadata jsonb, p_evidence_descriptors jsonb,
  p_evidence_required boolean, p_correlation_id text, p_causation_id text, p_now timestamptz
)
returns table (status text, reason text, accepted_result jsonb)
language plpgsql security definer set search_path = '' as $$
declare
  v_intent public.mission_dispatch_intents%rowtype;
  v_lease public.mission_dispatch_leases%rowtype;
  v_existing public.mission_execution_result_inbox%rowtype;
  v_fence bigint;
  v_terminal boolean;
  v_id uuid;
begin
  if p_evidence_required is null then return query select 'refused','invalid_evidence_requirement',null::jsonb; return; end if;
  if p_result_kind not in ('started','completed','failed','cancelled','lease_lost') then return query select 'refused','unsupported_result_kind',null::jsonb; return; end if;
  if p_result_schema_version <> 1 then return query select 'refused','unsupported_schema_version',null::jsonb; return; end if;
  if p_result_digest is null or char_length(p_result_digest) not between 16 and 256 or p_result_digest !~ '^[A-Za-z0-9._:-]+$' then return query select 'refused','invalid_digest',null::jsonb; return; end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 16 and 256 or p_idempotency_key !~ '^[A-Za-z0-9._:-]+$' then return query select 'refused','invalid_idempotency_key',null::jsonb; return; end if;
  if p_metadata is null or jsonb_typeof(p_metadata) <> 'object' or p_metadata ->> 'redactionState' <> 'redacted' then return query select 'refused','metadata_not_redacted',null::jsonb; return; end if;
  if octet_length(p_metadata::text) > 16384 or p_evidence_descriptors is null or jsonb_typeof(p_evidence_descriptors) <> 'array' or octet_length(p_evidence_descriptors::text) > 32768 then return query select 'refused','metadata_too_large',null::jsonb; return; end if;
  if exists (select 1 from jsonb_array_elements(p_evidence_descriptors) d(value) where jsonb_typeof(d.value) <> 'object' or d.value ->> 'redactionState' <> 'redacted' or d.value ?| array['rawOutput','stdout','stderr','prompt','conversation','environment','token','secret']) then return query select 'refused','metadata_not_redacted',null::jsonb; return; end if;
  if p_fencing_generation !~ '^[1-9][0-9]*$' then return query select 'refused','stale_fencing_generation',null::jsonb; return; end if;
  v_fence := p_fencing_generation::bigint;

  select * into v_existing from public.mission_execution_result_inbox where workspace_id=p_workspace_id and idempotency_key=p_idempotency_key for update;
  if found then
    if v_existing.result_digest=p_result_digest and v_existing.result_kind=p_result_kind and v_existing.execution_id=p_execution_id and v_existing.evidence_required is not distinct from p_evidence_required then
      return query select 'duplicate',null,jsonb_build_object('acceptedResultId',v_existing.accepted_result_id,'status',v_existing.application_status,'evidenceRequired',v_existing.evidence_required); return;
    end if;
    return query select 'refused','idempotency_conflict',null::jsonb; return;
  end if;

  select * into v_intent from public.mission_dispatch_intents where id=p_dispatch_intent_id for update;
  if not found then return query select 'refused','dispatch_not_found',null::jsonb; return; end if;
  if v_intent.assignment_id is null then return query select 'refused','legacy_missing_assignment_linkage',null::jsonb; return; end if;
  if v_intent.workspace_id <> p_workspace_id then return query select 'refused','workspace_mismatch',null::jsonb; return; end if;
  if v_intent.mission_id <> p_mission_id then return query select 'refused','mission_mismatch',null::jsonb; return; end if;
  if v_intent.assignment_id <> p_assignment_id then return query select 'refused','assignment_mismatch',null::jsonb; return; end if;
  if p_execution_id <> p_dispatch_intent_id::text then return query select 'refused','execution_mismatch',null::jsonb; return; end if;
  if v_intent.adapter_requirement is distinct from p_provider_adapter_id then return query select 'refused','provider_mismatch',null::jsonb; return; end if;
  if v_intent.lease_id <> p_lease_id then return query select 'refused','lease_mismatch',null::jsonb; return; end if;
  if v_intent.attempt <> p_execution_attempt then return query select 'refused','execution_attempt_mismatch',null::jsonb; return; end if;
  if v_intent.superseded_at is not null then return query select 'refused','invalid_dispatch_state',null::jsonb; return; end if;
  select * into v_lease from public.mission_dispatch_leases where workspace_id=p_workspace_id and mission_id=p_mission_id and dispatch_key=v_intent.dispatch_key for update;
  if not found or v_lease.lease_id <> p_lease_id then return query select 'refused','lease_mismatch',null::jsonb; return; end if;
  if v_lease.fencing_token::bigint <> v_fence or v_lease.expires_at <= p_now then return query select 'refused','stale_fencing_generation',null::jsonb; return; end if;
  if v_lease.status <> 'leased' and p_result_kind <> 'lease_lost' then return query select 'refused','result_after_lease_loss',null::jsonb; return; end if;

  v_terminal := p_result_kind in ('completed','failed','cancelled','lease_lost');
  if p_result_kind <> 'started' and not exists (select 1 from public.mission_execution_result_inbox where workspace_id=p_workspace_id and execution_id=p_execution_id and result_kind='started') then return query select 'refused','execution_not_started',null::jsonb; return; end if;
  if v_terminal and exists (select 1 from public.mission_execution_result_inbox where workspace_id=p_workspace_id and execution_id=p_execution_id and result_kind in ('completed','failed','cancelled','lease_lost')) then return query select 'refused','terminal_result_conflict',null::jsonb; return; end if;
  if p_result_kind='started' and exists (select 1 from public.mission_execution_result_inbox where workspace_id=p_workspace_id and execution_id=p_execution_id and result_kind='started') then return query select 'refused','execution_already_terminal',null::jsonb; return; end if;

  insert into public.mission_execution_result_inbox (workspace_id,mission_id,assignment_id,dispatch_intent_id,dispatch_key,execution_id,provider_adapter_id,lease_id,fencing_generation,execution_attempt,result_kind,result_schema_version,result_digest,idempotency_key,metadata,evidence_descriptors,evidence_required,correlation_id,causation_id,accepted_at)
  values (p_workspace_id,p_mission_id,p_assignment_id,p_dispatch_intent_id,v_intent.dispatch_key,p_execution_id,p_provider_adapter_id,p_lease_id,v_fence,p_execution_attempt,p_result_kind,p_result_schema_version,p_result_digest,p_idempotency_key,p_metadata,p_evidence_descriptors,p_evidence_required,p_correlation_id,p_causation_id,p_now)
  returning accepted_result_id into v_id;
  return query select 'accepted',null,jsonb_build_object('acceptedResultId',v_id,'status','pending','evidenceRequired',p_evidence_required);
end;
$$;
revoke all on function public.accept_mission_execution_result_atomic(text,text,text,uuid,text,text,text,text,integer,text,integer,text,text,jsonb,jsonb,boolean,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.accept_mission_execution_result_atomic(text,text,text,uuid,text,text,text,text,integer,text,integer,text,text,jsonb,jsonb,boolean,text,text,timestamptz) to service_role;

-- The old boolean-returning updater could mark a row complete without both
-- required application markers.  Replace it, preserving all action semantics
-- while returning a stable typed outcome for the store.
drop function public.update_mission_execution_result_application_atomic(uuid,text,text,timestamptz,text,timestamptz);
create function public.update_mission_execution_result_application_atomic(
  p_accepted_result_id uuid,p_owner text,p_action text,p_now timestamptz,p_error_code text default null,p_next_attempt_at timestamptz default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v public.mission_execution_result_inbox%rowtype;
begin
  select * into v from public.mission_execution_result_inbox where accepted_result_id=p_accepted_result_id for update;
  if not found or v.application_claim_owner <> p_owner then return jsonb_build_object('ok',false,'reason','claim_not_owned'); end if;
  if v.application_claim_expires_at is not null and v.application_claim_expires_at <= p_now then return jsonb_build_object('ok',false,'reason','claim_expired'); end if;
  if p_action='lifecycle_applied' then
    update public.mission_execution_result_inbox set lifecycle_applied_at=coalesce(lifecycle_applied_at,p_now),updated_at=p_now where accepted_result_id=p_accepted_result_id;
  elsif p_action='evidence_applied' then
    update public.mission_execution_result_inbox set evidence_applied_at=coalesce(evidence_applied_at,p_now),updated_at=p_now where accepted_result_id=p_accepted_result_id;
  elsif p_action='fully_applied' then
    if v.fully_applied_at is not null then return jsonb_build_object('ok',true,'status','fully_applied'); end if;
    if v.lifecycle_applied_at is null then return jsonb_build_object('ok',false,'reason','lifecycle_not_applied'); end if;
    if v.evidence_required is null then return jsonb_build_object('ok',false,'reason','evidence_requirement_unknown'); end if;
    if v.evidence_required and v.evidence_applied_at is null then return jsonb_build_object('ok',false,'reason','evidence_not_applied'); end if;
    update public.mission_execution_result_inbox set application_status='fully_applied',fully_applied_at=p_now,application_claim_owner=null,application_claim_expires_at=null,updated_at=p_now where accepted_result_id=p_accepted_result_id;
  elsif p_action='failed' then
    update public.mission_execution_result_inbox set application_status='retry',retry_count=retry_count+1,last_application_error=p_error_code,next_attempt_at=coalesce(p_next_attempt_at,p_now+interval '30 seconds'),application_claim_owner=null,application_claim_expires_at=null,updated_at=p_now where accepted_result_id=p_accepted_result_id;
  elsif p_action='release' then
    update public.mission_execution_result_inbox set application_status='pending',application_claim_owner=null,application_claim_expires_at=null,updated_at=p_now where accepted_result_id=p_accepted_result_id;
  else
    raise exception 'invalid result application action' using errcode='22023';
  end if;
  return jsonb_build_object('ok',true,'status',case when p_action='fully_applied' then 'fully_applied' else p_action end);
end;
$$;
revoke all on function public.update_mission_execution_result_application_atomic(uuid,text,text,timestamptz,text,timestamptz) from public,anon,authenticated;
grant execute on function public.update_mission_execution_result_application_atomic(uuid,text,text,timestamptz,text,timestamptz) to service_role;
