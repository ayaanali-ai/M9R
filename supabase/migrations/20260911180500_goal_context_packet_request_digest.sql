-- create_goal_context_packet_atomic's idempotency check compared the
-- caller-supplied content digest (packet.digest, part of the packet's own
-- schema -- an integrity check on the referenced content) against itself on
-- replay. That means a resend with the same packet_id and same content but a
-- different sensitivity/redactionStatus/intendedRecipientPrincipalId was
-- silently accepted as an "idempotent replay" (200) instead of rejected as a
-- conflict (409), because the two fields that actually changed were never
-- part of the comparison. Fix: add a separate request_digest column -- a
-- hash of the FULL packet request, computed server-side the same way
-- receipts already do it -- and compare against that instead. The original
-- `digest` column is untouched and keeps its original meaning (content
-- integrity, not request idempotency).

alter table public.goal_context_packets
  add column if not exists request_digest text
    check (request_digest ~ '^[0-9a-f]{64}$');

-- Backfill is a no-op: this table had no rows at the time this migration was
-- written (Goal Gateway just shipped).
update public.goal_context_packets set request_digest = digest where request_digest is null;

alter table public.goal_context_packets
  alter column request_digest set not null;

drop function if exists public.create_goal_context_packet_atomic(
  uuid, uuid, text, text, text, text, text, text, text, text[], text, text,
  timestamptz, text, text, text
);

create or replace function public.create_goal_context_packet_atomic(
  p_workspace_id uuid,
  p_goal_id uuid,
  p_packet_id text,
  p_source_principal_id text,
  p_source_agent_id text,
  p_intended_recipient_principal_id text,
  p_purpose text,
  p_content_ref text,
  p_sensitivity text,
  p_allowed_transformations text[],
  p_redaction_status text,
  p_digest text,
  p_request_digest text,
  p_expires_at timestamptz,
  p_actor_kind text,
  p_actor_id text,
  p_correlation_id text
)
returns table (result text, packet_id text)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_packet_id text;
  v_existing_request_digest text;
  v_next_sequence integer;
begin
  perform 1 from public.goals g
   where g.id = p_goal_id and g.workspace_id = p_workspace_id
   for update;
  if not found then
    return query select 'not_found'::text, p_packet_id;
    return;
  end if;

  insert into public.goal_context_packets as t (
    workspace_id, goal_id, packet_id, source_principal_id, source_agent_id,
    intended_recipient_principal_id, purpose, content_ref, sensitivity,
    allowed_transformations, redaction_status, digest, request_digest, expires_at
  ) values (
    p_workspace_id, p_goal_id, p_packet_id, p_source_principal_id, p_source_agent_id,
    p_intended_recipient_principal_id, p_purpose, p_content_ref, p_sensitivity,
    p_allowed_transformations, p_redaction_status, p_digest, p_request_digest, p_expires_at
  )
  on conflict on constraint goal_context_packets_workspace_id_packet_id_key do nothing
  returning t.packet_id into v_packet_id;

  if v_packet_id is null then
    select p.request_digest into v_existing_request_digest
      from public.goal_context_packets p
     where p.workspace_id = p_workspace_id and p.packet_id = p_packet_id
     for update;
    if v_existing_request_digest <> p_request_digest then
      return query select 'idempotency_conflict'::text, p_packet_id;
      return;
    end if;
    return query select 'replayed'::text, p_packet_id;
    return;
  end if;

  select coalesce(max(e.sequence), 0) + 1 into v_next_sequence
    from public.goal_events e
   where e.workspace_id = p_workspace_id and e.goal_id = p_goal_id;
  insert into public.goal_events (
    workspace_id, goal_id, sequence, event_type, payload, actor_kind,
    actor_id, correlation_id, causation_id
  ) values (
    p_workspace_id, p_goal_id, v_next_sequence, 'goal.context_packet_created',
    jsonb_build_object('packetId', p_packet_id, 'sensitivity', p_sensitivity, 'contentRef', p_content_ref),
    p_actor_kind, p_actor_id, p_correlation_id, null
  );
  return query select 'created'::text, v_packet_id;
end;
$$;

revoke all on function public.create_goal_context_packet_atomic(
  uuid, uuid, text, text, text, text, text, text, text, text[], text, text,
  text, timestamptz, text, text, text
) from public, anon, authenticated;
grant execute on function public.create_goal_context_packet_atomic(
  uuid, uuid, text, text, text, text, text, text, text, text[], text, text,
  text, timestamptz, text, text, text
) to service_role;
