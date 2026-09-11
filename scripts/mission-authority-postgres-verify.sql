\set ON_ERROR_STOP on
create extension if not exists pgcrypto;
truncate public.mission_execution_result_inbox, public.mission_dispatch_intents, public.mission_dispatch_leases, public.mission_assignment_index, public.mission_events, public.missions cascade;

insert into public.missions (id, workspace_id, repository_id, current_version) values ('verify-mission','verify-ws','verify-repo',2);
insert into public.mission_events (mission_id,aggregate_version,event_id,event_type,schema_version,actor,correlation_id,provenance,occurred_at,payload)
values ('verify-mission',1,'verify-assignment-created','mission.assignment_created','oathlock.mission-event.v1','{"kind":"system","id":"orchestrator"}','verify-corr','system_inference',now(),'{"assignment":{"id":"verify-assignment","dispatchKey":null,"status":"proposed","adapterRequirement":"codex"}}');
insert into public.mission_events (mission_id,aggregate_version,event_id,event_type,schema_version,actor,correlation_id,provenance,occurred_at,payload)
values ('verify-mission',2,'verify-assignment-claimed','mission.assignment_status_changed','oathlock.mission-event.v1','{"kind":"system","id":"orchestrator"}','verify-corr','system_inference',now(),'{"assignmentId":"verify-assignment","nextStatus":"claimed","dispatchKey":"verify-dispatch"}');
insert into public.mission_dispatch_leases (workspace_id,mission_id,dispatch_key,repository_id,lease_id,lease_owner,fencing_token,status,attempt,version,acquired_at,expires_at)
values ('verify-ws','verify-mission','verify-dispatch','verify-repo','verify-lease','{"worker":"verify"}',900719925, 'leased',1,1,now(),now()+interval '1 hour');
insert into public.mission_dispatch_intents (id,workspace_id,mission_id,assignment_id,dispatch_key,repository_id,adapter_requirement,lease_id,fencing_token,attempt,execution_constraints)
values ('00000000-0000-0000-0000-000000000111','verify-ws','verify-mission','verify-assignment','verify-dispatch','verify-repo','codex','verify-lease',900719925,1,'{}');

do $$
declare r record; started_id text; terminal_id text;
begin
  select * into r from public.accept_mission_execution_result_atomic('verify-ws','verify-mission','verify-assignment','00000000-0000-0000-0000-000000000111','00000000-0000-0000-0000-000000000111','codex','verify-lease','900719925',1,'started',1,'verify-digest-0001','verify-idem-start-0001','{"redactionState":"redacted"}','[]',true,'verify-corr',null,now());
  if r.status <> 'accepted' then raise exception 'started acceptance failed: %',r.reason; end if;
  select * into r from public.accept_mission_execution_result_atomic('verify-ws','verify-mission','verify-assignment','00000000-0000-0000-0000-000000000111','00000000-0000-0000-0000-000000000111','codex','verify-lease','900719925',1,'completed',1,'verify-digest-0002','verify-idem-term-00001','{"redactionState":"redacted"}','[]',false,'verify-corr',null,now());
  if r.status <> 'accepted' then raise exception 'terminal acceptance failed: %',r.reason; end if;
  select * into r from public.accept_mission_execution_result_atomic('verify-ws','verify-mission','verify-assignment','00000000-0000-0000-0000-000000000111','00000000-0000-0000-0000-000000000111','codex','verify-lease','900719925',1,'completed',1,'verify-digest-0002','verify-idem-term-00001','{"redactionState":"redacted"}','[]',false,'verify-corr',null,now());
  if r.status <> 'duplicate' then raise exception 'exact duplicate failed: %',r.reason; end if;
  select * into r from public.accept_mission_execution_result_atomic('verify-ws','verify-mission','verify-assignment','00000000-0000-0000-0000-000000000111','00000000-0000-0000-0000-000000000111','codex','verify-lease','1',1,'failed',1,'verify-digest-0003','verify-idem-stale0001','{"redactionState":"redacted"}','[]',true,'verify-corr',null,now());
  if r.reason <> 'stale_fencing_generation' then raise exception 'stale fence failed: %',r.reason; end if;
  select * into r from public.accept_mission_execution_result_atomic('verify-ws','verify-mission','verify-assignment','00000000-0000-0000-0000-000000000111','00000000-0000-0000-0000-000000000111','codex','wrong-lease','900719925',1,'failed',1,'verify-digest-0003','verify-idem-lease0001','{"redactionState":"redacted"}','[]',true,'verify-corr',null,now());
  if r.reason <> 'lease_mismatch' then raise exception 'lease mismatch failed: %',r.reason; end if;
  select * into r from public.accept_mission_execution_result_atomic('wrong-ws','verify-mission','verify-assignment','00000000-0000-0000-0000-000000000111','00000000-0000-0000-0000-000000000111','codex','verify-lease','900719925',1,'failed',1,'verify-digest-0003','verify-idem-ws000001','{"redactionState":"redacted"}','[]',true,'verify-corr',null,now());
  if r.reason <> 'workspace_mismatch' then raise exception 'workspace mismatch failed: %',r.reason; end if;
  select * into r from public.accept_mission_execution_result_atomic('verify-ws','verify-mission','wrong-assignment','00000000-0000-0000-0000-000000000111','00000000-0000-0000-0000-000000000111','codex','verify-lease','900719925',1,'failed',1,'verify-digest-0003','verify-idem-asn00001','{"redactionState":"redacted"}','[]',true,'verify-corr',null,now());
  if r.reason <> 'assignment_mismatch' then raise exception 'assignment mismatch failed: %',r.reason; end if;
  select * into r from public.accept_mission_execution_result_atomic('verify-ws','verify-mission','verify-assignment','00000000-0000-0000-0000-000000000111','bad-execution','codex','verify-lease','900719925',1,'failed',1,'verify-digest-0003','verify-idem-exec001','{"redactionState":"redacted"}','[]',true,'verify-corr',null,now());
  if r.reason <> 'execution_mismatch' then raise exception 'execution mismatch failed: %',r.reason; end if;
  select * into r from public.accept_mission_execution_result_atomic('verify-ws','verify-mission','verify-assignment','00000000-0000-0000-0000-000000000111','00000000-0000-0000-0000-000000000111','claude','verify-lease','900719925',1,'failed',1,'verify-digest-0003','verify-idem-prov001','{"redactionState":"redacted"}','[]',true,'verify-corr',null,now());
  if r.reason <> 'provider_mismatch' then raise exception 'provider mismatch failed: %',r.reason; end if;
  select * into r from public.accept_mission_execution_result_atomic('verify-ws','verify-mission','verify-assignment','00000000-0000-0000-0000-000000000111','00000000-0000-0000-0000-000000000111','codex','verify-lease','900719925',1,'invalid',1,'verify-digest-0003','verify-idem-kind001','{"redactionState":"redacted"}','[]',true,'verify-corr',null,now());
  if r.reason <> 'unsupported_result_kind' then raise exception 'kind refusal failed: %',r.reason; end if;
  if (select count(*) from public.mission_execution_result_inbox where execution_id='00000000-0000-0000-0000-000000000111') <> 2 then raise exception 'partial uniqueness failed'; end if;
end $$;

do $$ declare c integer; begin
  select count(*) into c from public.claim_mission_execution_results_for_application_atomic('verify-processor-a',now(),60000,10);
  if c <> 2 then raise exception 'claim expected 2 got %',c; end if;
  select count(*) into c from public.claim_mission_execution_results_for_application_atomic('verify-processor-b',now(),60000,10);
  if c <> 0 then raise exception 'exclusive claim failed'; end if;
end $$;

do $$ declare r public.mission_execution_result_inbox%rowtype; outcome jsonb; begin
  select * into r from public.mission_execution_result_inbox where result_kind='started' limit 1;
  outcome := public.update_mission_execution_result_application_atomic(r.accepted_result_id,'verify-processor-a','fully_applied',now());
  if outcome ->> 'reason' <> 'lifecycle_not_applied' then raise exception 'fully_applied should require lifecycle, got %',outcome; end if;
end $$;

do $$
declare r record; started public.mission_execution_result_inbox%rowtype; terminal public.mission_execution_result_inbox%rowtype; outcome jsonb; before_errors text;
begin
  -- The accepted response and stored row preserve trusted policy, not evidence count or result kind.
  select * into r from public.accept_mission_execution_result_atomic('verify-ws','verify-mission','verify-assignment','00000000-0000-0000-0000-000000000111','00000000-0000-0000-0000-000000000111','codex','verify-lease','900719925',1,'started',1,'verify-digest-0001','verify-idem-start-0001','{"redactionState":"redacted"}','[]',true,'verify-corr',null,now());
  if r.status <> 'duplicate' or (r.accepted_result ->> 'evidenceRequired') <> 'true' then raise exception 'true evidence policy was not preserved: %',r.accepted_result; end if;
  select * into r from public.accept_mission_execution_result_atomic('verify-ws','verify-mission','verify-assignment','00000000-0000-0000-0000-000000000111','00000000-0000-0000-0000-000000000111','codex','verify-lease','900719925',1,'completed',1,'verify-digest-0002','verify-idem-term-00001','{"redactionState":"redacted"}','[]',true,'verify-corr',null,now());
  if r.reason <> 'idempotency_conflict' then raise exception 'conflicting evidence policy converged: %',r.reason; end if;
  select * into r from public.accept_mission_execution_result_atomic('verify-ws','verify-mission','verify-assignment','00000000-0000-0000-0000-000000000111','00000000-0000-0000-0000-000000000111','codex','verify-lease','900719925',1,'failed',1,'verify-digest-null','verify-idem-null0001','{"redactionState":"redacted"}','[]',null,'verify-corr',null,now());
  if r.reason <> 'invalid_evidence_requirement' then raise exception 'missing evidence policy was not refused: %',r.reason; end if;
  if (select evidence_required from public.mission_execution_result_inbox where idempotency_key='verify-idem-start-0001') is distinct from true then raise exception 'true policy did not persist'; end if;
  if (select evidence_required from public.mission_execution_result_inbox where idempotency_key='verify-idem-term-00001') is distinct from false then raise exception 'false policy did not persist'; end if;

  select * into started from public.mission_execution_result_inbox where result_kind='started';
  select * into terminal from public.mission_execution_result_inbox where result_kind='completed';
  outcome := public.update_mission_execution_result_application_atomic(started.accepted_result_id,'verify-processor-a','lifecycle_applied',now());
  if outcome ->> 'ok' <> 'true' then raise exception 'lifecycle marker failed: %',outcome; end if;
  outcome := public.update_mission_execution_result_application_atomic(started.accepted_result_id,'verify-processor-a','fully_applied',now());
  if outcome ->> 'reason' <> 'evidence_not_applied' then raise exception 'required evidence gate missing: %',outcome; end if;
  before_errors := started.last_application_error;
  outcome := public.update_mission_execution_result_application_atomic(started.accepted_result_id,'wrong-owner','fully_applied',now());
  if outcome ->> 'reason' <> 'claim_not_owned' then raise exception 'wrong claim owner accepted: %',outcome; end if;
  if (select fully_applied_at from public.mission_execution_result_inbox where accepted_result_id=started.accepted_result_id) is not null then raise exception 'refused finalization mutated row'; end if;
  if (select last_application_error from public.mission_execution_result_inbox where accepted_result_id=started.accepted_result_id) is distinct from before_errors then raise exception 'refused finalization changed error state'; end if;
  perform public.update_mission_execution_result_application_atomic(started.accepted_result_id,'verify-processor-a','evidence_applied',now());
  outcome := public.update_mission_execution_result_application_atomic(started.accepted_result_id,'verify-processor-a','fully_applied',now());
  if outcome ->> 'ok' <> 'true' then raise exception 'required evidence finalization failed: %',outcome; end if;
  outcome := public.update_mission_execution_result_application_atomic(started.accepted_result_id,'verify-processor-a','fully_applied',now());
  if outcome ->> 'ok' <> 'true' then raise exception 'repeated finalization was not idempotent: %',outcome; end if;
  perform public.update_mission_execution_result_application_atomic(terminal.accepted_result_id,'verify-processor-a','lifecycle_applied',now());
  outcome := public.update_mission_execution_result_application_atomic(terminal.accepted_result_id,'verify-processor-a','fully_applied',now());
  if outcome ->> 'ok' <> 'true' then raise exception 'not-required evidence finalization failed: %',outcome; end if;
end $$;

do $$ begin
  if has_table_privilege('anon','public.mission_execution_result_inbox','insert') then raise exception 'anon insert granted'; end if;
  if has_table_privilege('authenticated','public.mission_execution_result_inbox','insert') then raise exception 'authenticated insert granted'; end if;
  if has_function_privilege('anon','public.accept_mission_execution_result_atomic(text,text,text,uuid,text,text,text,text,integer,text,integer,text,text,jsonb,jsonb,boolean,text,text,timestamptz)','execute') then raise exception 'anon RPC granted'; end if;
end $$;

select 'PASS mission authority PostgreSQL verifier' as result;
