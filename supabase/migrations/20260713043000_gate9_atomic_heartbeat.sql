create or replace function public.record_agent_heartbeat_atomic(
  p_connection_id uuid,
  p_workspace_id uuid,
  p_protocol_version text,
  p_adapter_instance_id text,
  p_sequence bigint,
  p_execution_origin text,
  p_provider text,
  p_idempotency_key text,
  p_received_at timestamptz,
  p_lease_expires_at timestamptz
)
returns table (accepted boolean, reason text)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_previous_sequence bigint;
begin
  perform 1
  from public.agent_connections c
  where c.id = p_connection_id
    and c.workspace_id = p_workspace_id
    and c.status = 'active'
  for update;

  if not found then
    return query select false, 'connection_not_active'::text;
    return;
  end if;

  select max(l.sequence)
  into v_previous_sequence
  from public.agent_presence_leases l
  where l.connection_id = p_connection_id
    and l.workspace_id = p_workspace_id
    and l.adapter_instance_id = p_adapter_instance_id;

  if v_previous_sequence is not null and p_sequence <= v_previous_sequence then
    return query select false, 'sequence_not_newer'::text;
    return;
  end if;

  insert into public.agent_presence_leases (
    connection_id, workspace_id, protocol_version, adapter_instance_id,
    sequence, execution_origin, provider, idempotency_key,
    received_at, lease_expires_at
  ) values (
    p_connection_id, p_workspace_id, p_protocol_version, p_adapter_instance_id,
    p_sequence, p_execution_origin, p_provider, p_idempotency_key,
    p_received_at, p_lease_expires_at
  );

  update public.agent_connections
  set last_seen_at = p_received_at,
      execution_origin = p_execution_origin
  where id = p_connection_id
    and workspace_id = p_workspace_id;

  return query select true, null::text;
exception
  when unique_violation then
    return query select false, 'duplicate'::text;
end;
$$;

revoke all on function public.record_agent_heartbeat_atomic(uuid, uuid, text, text, bigint, text, text, text, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.record_agent_heartbeat_atomic(uuid, uuid, text, text, bigint, text, text, text, timestamptz, timestamptz)
  to service_role;
