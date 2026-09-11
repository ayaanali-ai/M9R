-- Claim a handoff and create its child run in one database transaction.
--
-- The previous application path started a run and then marked the message.
-- Two concurrent inbox polls could therefore both start real runs before
-- either update won. This function locks the handoff row, verifies its
-- workspace/recipient/open-conversation scope, inserts exactly one run, and
-- records spawned_run_id before releasing the row lock.

create or replace function public.claim_handoff_and_start_run(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_message_id uuid,
  p_task_title text,
  p_agent_kind text,
  p_run_mode text default 'coordinated'
)
returns table(run_id uuid, started_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  handoff public.conversation_messages%rowtype;
  created_run public.agent_runs%rowtype;
begin
  select m.* into handoff
  from public.conversation_messages m
  join public.agent_conversations c on c.id = m.conversation_id and c.workspace_id = m.workspace_id
  where m.id = p_message_id
    and m.workspace_id = p_workspace_id
    and m.recipient_connection_id = p_connection_id
    and m.kind = 'handoff'
    and m.spawned_run_id is null
    and c.status = 'open'
  for update;

  if not found then
    return;
  end if;

  insert into public.agent_runs (
    connection_id,
    workspace_id,
    agent_kind,
    repo_hint,
    task_title,
    status,
    current_phase,
    run_mode
  )
  select
    c.id,
    p_workspace_id,
    p_agent_kind,
    c.repo_hint,
    left(coalesce(p_task_title, handoff.body), 200),
    'started',
    'started',
    p_run_mode
  from public.agent_connections c
  where c.id = p_connection_id
    and c.workspace_id = p_workspace_id
    and c.status = 'active'
    and c.revoked_at is null
  returning * into created_run;

  if not found then
    raise exception 'agent connection is not active in this workspace';
  end if;

  update public.conversation_messages
  set spawned_run_id = created_run.id
  where id = handoff.id
    and workspace_id = p_workspace_id
    and spawned_run_id is null;

  return query select created_run.id, created_run.started_at;
end;
$$;

revoke all on function public.claim_handoff_and_start_run(uuid, uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.claim_handoff_and_start_run(uuid, uuid, uuid, text, text, text) to service_role;
