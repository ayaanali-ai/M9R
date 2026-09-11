-- Gate 13: one requester-owned decision atomically closes a returned resident
-- launch, its assignment, and its Dispatch while retaining the causal event.

create or replace function public.record_result_adoption_atomic(
  p_workspace_id uuid,
  p_run_id uuid,
  p_launch_grant_id uuid,
  p_requesting_connection_id uuid,
  p_decision text,
  p_rationale text,
  p_plan_effect text,
  p_occurred_at timestamptz
)
returns table (accepted boolean, reason text, adoption_id uuid, decision text, created_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  grant_row public.launch_grants%rowtype;
  new_adoption_id uuid;
  new_created_at timestamptz;
  next_sequence bigint;
  next_grant_state text;
  next_assignment_state text;
  custody_event text;
begin
  if p_decision not in ('adopted', 'rejected', 'challenged')
    or char_length(trim(p_rationale)) not between 1 and 1000
    or char_length(trim(p_plan_effect)) not between 1 and 1000 then
    return query select false, 'invalid_adoption'::text, null::uuid, null::text, null::timestamptz;
    return;
  end if;

  select * into grant_row from public.launch_grants
  where id = p_launch_grant_id and workspace_id = p_workspace_id
    and requesting_connection_id = p_requesting_connection_id
  for update;
  if grant_row.id is null then
    return query select false, 'grant_not_found'::text, null::uuid, null::text, null::timestamptz;
    return;
  end if;
  if grant_row.state <> 'returning' then
    return query select false, 'result_not_returned'::text, null::uuid, null::text, null::timestamptz;
    return;
  end if;
  if not exists (
    select 1 from public.agent_runs r
    join public.dispatches d on d.run_id = r.id and d.workspace_id = r.workspace_id
    where r.id = p_run_id and r.workspace_id = p_workspace_id
      and r.connection_id = p_requesting_connection_id
      and d.launch_grant_id = p_launch_grant_id
  ) then
    return query select false, 'run_not_authorized'::text, null::uuid, null::text, null::timestamptz;
    return;
  end if;

  begin
    insert into public.result_adoptions (
      workspace_id, run_id, launch_grant_id, assignment_id,
      requesting_connection_id, decision, rationale, plan_effect, created_at
    ) values (
      p_workspace_id, p_run_id, p_launch_grant_id, grant_row.assignment_id,
      p_requesting_connection_id, p_decision, trim(p_rationale), trim(p_plan_effect), p_occurred_at
    ) returning id, result_adoptions.created_at into new_adoption_id, new_created_at;
  exception when unique_violation then
    return query select false, 'already_recorded'::text, null::uuid, null::text, null::timestamptz;
    return;
  end;

  next_grant_state := case when p_decision = 'adopted' then 'completed' else 'evidence_rejected' end;
  next_assignment_state := case when p_decision = 'adopted' then 'completed' else 'rejected' end;
  custody_event := case when p_decision = 'adopted' then 'accept_evidence' else 'reject_evidence' end;
  select coalesce(max(sequence), 0) + 1 into next_sequence
    from public.launch_events where launch_grant_id = p_launch_grant_id;

  update public.launch_grants set state = next_grant_state, updated_at = p_occurred_at
    where id = p_launch_grant_id and state = 'returning';
  insert into public.launch_events (
    workspace_id, launch_grant_id, resident_instance_id, source, event_type,
    from_state, to_state, sequence, occurred_at, payload
  ) values (
    p_workspace_id, p_launch_grant_id, grant_row.resident_instance_id, 'requesting_agent', custody_event,
    'returning', next_grant_state, next_sequence, p_occurred_at,
    jsonb_build_object('adoption_id', new_adoption_id, 'decision', p_decision)
  );
  update public.agent_assignments set state = next_assignment_state, result_decision = p_decision,
    result_decided_at = p_occurred_at, updated_at = p_occurred_at
    where id = grant_row.assignment_id and workspace_id = p_workspace_id;
  update public.dispatches set resolution_state = 'resolved'
    where workspace_id = p_workspace_id and run_id = p_run_id and launch_grant_id = p_launch_grant_id;

  return query select true, null::text, new_adoption_id, p_decision, new_created_at;
end;
$$;

revoke all on function public.record_result_adoption_atomic(uuid, uuid, uuid, uuid, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.record_result_adoption_atomic(uuid, uuid, uuid, uuid, text, text, text, timestamptz) to service_role;
