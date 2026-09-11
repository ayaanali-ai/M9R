-- PostgreSQL ERE does not reliably support the JavaScript-style bounded
-- quantifiers used by the initial result-authority migration. Keep bounds and
-- alphabet checks separate so both table constraints and the RPC agree.
alter table public.mission_execution_result_inbox drop constraint if exists mission_execution_result_inbox_result_digest_check;
alter table public.mission_execution_result_inbox drop constraint if exists mission_execution_result_inbox_idempotency_key_check;
alter table public.mission_execution_result_inbox add constraint mission_execution_result_inbox_result_digest_check check (char_length(result_digest) between 16 and 256 and result_digest ~ '^[A-Za-z0-9._:-]+$');
alter table public.mission_execution_result_inbox add constraint mission_execution_result_inbox_idempotency_key_check check (char_length(idempotency_key) between 16 and 256 and idempotency_key ~ '^[A-Za-z0-9._:-]+$');

create or replace function public.accept_mission_execution_result_atomic(
  p_workspace_id text,p_mission_id text,p_assignment_id text,p_dispatch_intent_id uuid,p_execution_id text,p_provider_adapter_id text,p_lease_id text,p_fencing_generation text,p_execution_attempt integer,p_result_kind text,p_result_schema_version integer,p_result_digest text,p_idempotency_key text,p_metadata jsonb,p_evidence_descriptors jsonb,p_correlation_id text,p_causation_id text,p_now timestamptz
) returns table (status text, reason text, accepted_result jsonb)
language plpgsql security definer set search_path = '' as $$
declare v_intent public.mission_dispatch_intents%rowtype; v_lease public.mission_dispatch_leases%rowtype; v_existing public.mission_execution_result_inbox%rowtype; v_fence bigint; v_id uuid;
begin
  if p_result_kind not in ('started','completed','failed','cancelled','lease_lost') then return query select 'refused','unsupported_result_kind',null::jsonb; return; end if;
  if p_result_schema_version <> 1 then return query select 'refused','unsupported_schema_version',null::jsonb; return; end if;
  if p_result_digest is null or char_length(p_result_digest) not between 16 and 256 or p_result_digest !~ '^[A-Za-z0-9._:-]+$' then return query select 'refused','invalid_digest',null::jsonb; return; end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 16 and 256 or p_idempotency_key !~ '^[A-Za-z0-9._:-]+$' then return query select 'refused','invalid_idempotency_key',null::jsonb; return; end if;
  if p_metadata is null or jsonb_typeof(p_metadata) <> 'object' or p_metadata ->> 'redactionState' <> 'redacted' then return query select 'refused','metadata_not_redacted',null::jsonb; return; end if;
  if octet_length(p_metadata::text)>16384 or p_evidence_descriptors is null or jsonb_typeof(p_evidence_descriptors)<>'array' or octet_length(p_evidence_descriptors::text)>32768 then return query select 'refused','metadata_too_large',null::jsonb; return; end if;
  if p_fencing_generation !~ '^[1-9][0-9]*$' then return query select 'refused','stale_fencing_generation',null::jsonb; return; end if; v_fence:=p_fencing_generation::bigint;
  select * into v_existing from public.mission_execution_result_inbox where workspace_id=p_workspace_id and idempotency_key=p_idempotency_key for update;
  if found then if v_existing.result_digest=p_result_digest and v_existing.result_kind=p_result_kind and v_existing.execution_id=p_execution_id then return query select 'duplicate',null,jsonb_build_object('acceptedResultId',v_existing.accepted_result_id,'status',v_existing.application_status); else return query select 'refused','idempotency_conflict',null::jsonb; end if; return; end if;
  select * into v_intent from public.mission_dispatch_intents where id=p_dispatch_intent_id for update;
  if not found then return query select 'refused','dispatch_not_found',null::jsonb; return; end if;
  if v_intent.assignment_id is null then return query select 'refused','legacy_missing_assignment_linkage',null::jsonb; return; end if;
  if v_intent.workspace_id<>p_workspace_id then return query select 'refused','workspace_mismatch',null::jsonb; return; end if;
  if v_intent.mission_id<>p_mission_id then return query select 'refused','mission_mismatch',null::jsonb; return; end if;
  if v_intent.assignment_id<>p_assignment_id then return query select 'refused','assignment_mismatch',null::jsonb; return; end if;
  if p_execution_id<>p_dispatch_intent_id::text then return query select 'refused','execution_mismatch',null::jsonb; return; end if;
  if v_intent.adapter_requirement is distinct from p_provider_adapter_id then return query select 'refused','provider_mismatch',null::jsonb; return; end if;
  if v_intent.lease_id<>p_lease_id then return query select 'refused','lease_mismatch',null::jsonb; return; end if;
  if v_intent.attempt<>p_execution_attempt then return query select 'refused','execution_attempt_mismatch',null::jsonb; return; end if;
  select * into v_lease from public.mission_dispatch_leases where workspace_id=p_workspace_id and mission_id=p_mission_id and dispatch_key=v_intent.dispatch_key for update;
  if not found or v_lease.lease_id<>p_lease_id then return query select 'refused','lease_mismatch',null::jsonb; return; end if;
  if v_lease.fencing_token::bigint<>v_fence or v_lease.expires_at<=p_now then return query select 'refused','stale_fencing_generation',null::jsonb; return; end if;
  if v_lease.status<>'leased' and p_result_kind<>'lease_lost' then return query select 'refused','result_after_lease_loss',null::jsonb; return; end if;
  if p_result_kind<>'started' and not exists(select 1 from public.mission_execution_result_inbox where workspace_id=p_workspace_id and execution_id=p_execution_id and result_kind='started') then return query select 'refused','execution_not_started',null::jsonb; return; end if;
  if p_result_kind in ('completed','failed','cancelled','lease_lost') and exists(select 1 from public.mission_execution_result_inbox where workspace_id=p_workspace_id and execution_id=p_execution_id and result_kind in ('completed','failed','cancelled','lease_lost')) then return query select 'refused','terminal_result_conflict',null::jsonb; return; end if;
  insert into public.mission_execution_result_inbox(workspace_id,mission_id,assignment_id,dispatch_intent_id,dispatch_key,execution_id,provider_adapter_id,lease_id,fencing_generation,execution_attempt,result_kind,result_schema_version,result_digest,idempotency_key,metadata,evidence_descriptors,correlation_id,causation_id,accepted_at) values(p_workspace_id,p_mission_id,p_assignment_id,p_dispatch_intent_id,v_intent.dispatch_key,p_execution_id,p_provider_adapter_id,p_lease_id,v_fence,p_execution_attempt,p_result_kind,p_result_schema_version,p_result_digest,p_idempotency_key,p_metadata,p_evidence_descriptors,p_correlation_id,p_causation_id,p_now) returning accepted_result_id into v_id;
  return query select 'accepted',null,jsonb_build_object('acceptedResultId',v_id,'status','pending');
end; $$;
revoke all on function public.accept_mission_execution_result_atomic(text,text,text,uuid,text,text,text,text,integer,text,integer,text,text,jsonb,jsonb,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.accept_mission_execution_result_atomic(text,text,text,uuid,text,text,text,text,integer,text,integer,text,text,jsonb,jsonb,text,text,timestamptz) to service_role;
