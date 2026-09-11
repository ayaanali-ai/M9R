-- Persist bounded resident failure reasons while keeping every non-result
-- payload closed to arbitrary data. This lets an over-budget provider result
-- fail visibly instead of being accepted or leaving the grant stuck running.

create or replace function public.record_resident_launch_event_atomic(
  p_launch_grant_id uuid,
  p_workspace_id uuid,
  p_connection_id uuid,
  p_instance_key text,
  p_event_type text,
  p_expected_from_state text,
  p_to_state text,
  p_sequence bigint,
  p_occurred_at timestamptz,
  p_payload jsonb
)
returns table (accepted boolean, reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare g public.launch_grants%rowtype;
begin
  select * into g from public.launch_grants
  where id = p_launch_grant_id and workspace_id = p_workspace_id
  for update;
  if not found then return query select false, 'not_found'::text; return; end if;
  if g.state <> p_expected_from_state then return query select false, 'state_conflict'::text; return; end if;
  if not exists (
    select 1 from public.resident_instances r where r.id = g.resident_instance_id
      and r.connection_id = p_connection_id and r.instance_key = p_instance_key
      and r.revoked_at is null and r.lease_expires_at > p_occurred_at
  ) then return query select false, 'resident_not_active'::text; return; end if;
  if exists (select 1 from public.launch_events e where e.launch_grant_id = g.id and e.sequence >= p_sequence) then
    return query select false, 'sequence_not_newer'::text; return;
  end if;
  if not ((g.state = 'claimed' and p_event_type = 'launch' and p_to_state = 'launching')
    or (g.state = 'launching' and p_event_type = 'acknowledge_process' and p_to_state = 'running')
    or (g.state = 'launching' and p_event_type = 'fail_launch' and p_to_state = 'launch_failed')
    or (g.state = 'running' and p_event_type = 'return_result' and p_to_state = 'returning')
    or (g.state in ('running','returning') and p_event_type = 'fail_provider' and p_to_state = 'provider_failed')
    or (g.state in ('claimed','launching','running','returning') and p_event_type = 'timeout' and p_to_state = 'timed_out')) then
    return query select false, 'invalid_transition'::text; return;
  end if;
  if jsonb_typeof(p_payload) <> 'object' or octet_length(p_payload::text) > 131072
    or (p_event_type = 'return_result' and nullif(p_payload->>'result_text', '') is null)
    or (p_event_type in ('fail_launch', 'fail_provider', 'timeout') and (
      not (p_payload ? 'failure_code')
      or p_payload <> jsonb_build_object('failure_code', p_payload->>'failure_code')
      or p_payload->>'failure_code' not in (
        'timeout', 'nonzero_exit', 'provider_reported_error',
        'missing_structured_result', 'provider_exception', 'token_budget_exceeded'
      )
    ))
    or (p_event_type not in ('return_result', 'fail_launch', 'fail_provider', 'timeout') and p_payload <> '{}'::jsonb) then
    return query select false, 'invalid_payload'::text; return;
  end if;
  update public.launch_grants
  set state = p_to_state,
      process_acknowledged_at = case when p_event_type = 'acknowledge_process' then p_occurred_at else process_acknowledged_at end,
      updated_at = p_occurred_at
  where id = g.id;
  insert into public.launch_events (
    workspace_id, launch_grant_id, resident_instance_id, source, event_type,
    from_state, to_state, sequence, occurred_at, payload
  ) values (g.workspace_id, g.id, g.resident_instance_id, 'resident', p_event_type, g.state, p_to_state, p_sequence, p_occurred_at, p_payload);
  return query select true, null::text;
end;
$$;

revoke all on function public.record_resident_launch_event_atomic(uuid, uuid, uuid, text, text, text, text, bigint, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.record_resident_launch_event_atomic(uuid, uuid, uuid, text, text, text, text, bigint, timestamptz, jsonb) to service_role;
