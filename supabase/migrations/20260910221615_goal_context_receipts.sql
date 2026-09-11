-- M9R Goal context and completion projections
--
-- These tables persist the provider-neutral contracts without becoming a
-- second event store or execution engine. Mission evidence remains the source
-- of truth for provider work; receipts reference that evidence by id/digest.

create table if not exists public.goal_context_packets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.projects(id) on delete cascade,
  goal_id uuid not null,
  packet_id text not null check (char_length(packet_id) between 1 and 160),
  source_principal_id text not null check (char_length(source_principal_id) between 1 and 160),
  source_agent_id text not null check (char_length(source_agent_id) between 1 and 160),
  intended_recipient_principal_id text,
  purpose text not null check (char_length(purpose) between 1 and 240),
  content_ref text not null check (char_length(content_ref) between 1 and 500),
  sensitivity text not null check (sensitivity in ('public', 'workspace', 'private', 'restricted')),
  allowed_transformations text[] not null default '{}',
  redaction_status text not null check (redaction_status in ('not_required', 'redacted', 'verified')),
  digest text not null check (digest ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, packet_id),
  constraint goal_context_packets_goal_workspace_fk foreign key (goal_id, workspace_id)
    references public.goals(id, workspace_id) on delete cascade,
  constraint goal_context_packets_restricted_redaction_ck check (
    sensitivity <> 'restricted' or redaction_status = 'verified'
  )
);

create index if not exists goal_context_packets_goal_created_idx
  on public.goal_context_packets (workspace_id, goal_id, created_at desc, id desc);
create index if not exists goal_context_packets_expiry_idx
  on public.goal_context_packets (workspace_id, expires_at)
  where expires_at is not null;

create table if not exists public.goal_completion_receipts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.projects(id) on delete cascade,
  goal_id uuid not null,
  receipt_id text not null check (char_length(receipt_id) between 1 and 160),
  mission_id text,
  receipt_digest text not null check (receipt_digest ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('achieved', 'failed', 'blocked', 'needs_decision')),
  conditions jsonb not null check (jsonb_typeof(conditions) = 'array'),
  evidence jsonb not null check (jsonb_typeof(evidence) = 'array'),
  agent_ids text[] not null default '{}',
  provider_ids text[] not null default '{}',
  approvals text[] not null default '{}',
  unresolved_risks text[] not null default '{}',
  decisions_required text[] not null default '{}',
  context_packet_ids text[] not null default '{}',
  started_at timestamptz,
  completed_at timestamptz,
  generated_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, receipt_id),
  constraint goal_completion_receipts_goal_workspace_fk foreign key (goal_id, workspace_id)
    references public.goals(id, workspace_id) on delete cascade,
  constraint goal_completion_receipts_decision_ck check (
    status <> 'needs_decision' or cardinality(decisions_required) > 0
  ),
  constraint goal_completion_receipts_achieved_ck check (
    status <> 'achieved' or (
      jsonb_array_length(evidence) > 0
      and jsonb_array_length(conditions) > 0
    )
  )
);

create index if not exists goal_completion_receipts_goal_created_idx
  on public.goal_completion_receipts (workspace_id, goal_id, created_at desc, id desc);
create index if not exists goal_completion_receipts_status_idx
  on public.goal_completion_receipts (workspace_id, status, created_at desc);

-- The original Goal migration predates Context Packet events. Keep the event
-- stream authoritative while extending its allowlist in a forward migration.
alter table public.goal_events drop constraint if exists goal_events_event_type_check;
alter table public.goal_events add constraint goal_events_event_type_check check (event_type in (
  'goal.proposed',
  'goal.authorized',
  'goal.mission_created',
  'goal.plan_ready',
  'goal.progress',
  'goal.context_requested',
  'goal.context_packet_created',
  'goal.approval_requested',
  'goal.provider_blocked',
  'goal.provider_failed',
  'goal.evidence_ready',
  'goal.receipt_ready',
  'goal.paused',
  'goal.cancelled',
  'goal.status_changed'
));

-- Persist a packet and its event under one Goal row lock. The application
-- validates the full contract; this function supplies idempotency and event
-- ordering without using SECURITY DEFINER or exposing a public RPC surface.
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
  v_existing_digest text;
  v_next_sequence integer;
begin
  perform 1 from public.goals g
   where g.id = p_goal_id and g.workspace_id = p_workspace_id
   for update;
  if not found then
    return query select 'not_found'::text, p_packet_id;
    return;
  end if;

  -- Table alias + qualified RETURNING is required: this function's RETURNS
  -- TABLE declares an OUT parameter also named packet_id, which otherwise
  -- shadows the goal_context_packets.packet_id column in RETURNING.
  insert into public.goal_context_packets as t (
    workspace_id, goal_id, packet_id, source_principal_id, source_agent_id,
    intended_recipient_principal_id, purpose, content_ref, sensitivity,
    allowed_transformations, redaction_status, digest, expires_at
  ) values (
    p_workspace_id, p_goal_id, p_packet_id, p_source_principal_id, p_source_agent_id,
    p_intended_recipient_principal_id, p_purpose, p_content_ref, p_sensitivity,
    p_allowed_transformations, p_redaction_status, p_digest, p_expires_at
  )
  -- ON CONFLICT's target column list cannot be table-qualified, so the alias
  -- above doesn't help here -- "packet_id" is still ambiguous against the
  -- OUT parameter. Naming the constraint instead sidesteps the column
  -- reference entirely.
  on conflict on constraint goal_context_packets_workspace_id_packet_id_key do nothing
  returning t.packet_id into v_packet_id;

  if v_packet_id is null then
    select p.digest into v_existing_digest
      from public.goal_context_packets p
     where p.workspace_id = p_workspace_id and p.packet_id = p_packet_id
     for update;
    if v_existing_digest <> p_digest then
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

-- Persist a normalized receipt and its receipt-ready event. This intentionally
-- does not mark a Goal completed: receipt adoption and Goal state transition
-- remain separate, approval-sensitive decisions.
create or replace function public.create_goal_receipt_atomic(
  p_workspace_id uuid,
  p_goal_id uuid,
  p_receipt_id text,
  p_receipt_digest text,
  p_mission_id text,
  p_status text,
  p_conditions jsonb,
  p_evidence jsonb,
  p_agent_ids text[],
  p_provider_ids text[],
  p_approvals text[],
  p_unresolved_risks text[],
  p_decisions_required text[],
  p_context_packet_ids text[],
  p_started_at timestamptz,
  p_completed_at timestamptz,
  p_generated_at timestamptz,
  p_actor_kind text,
  p_actor_id text,
  p_correlation_id text
)
returns table (result text, receipt_id text)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_receipt_id text;
  v_existing_digest text;
  v_next_sequence integer;
begin
  perform 1 from public.goals g
   where g.id = p_goal_id and g.workspace_id = p_workspace_id
   for update;
  if not found then
    return query select 'not_found'::text, p_receipt_id;
    return;
  end if;

  -- Same OUT-parameter shadowing as create_goal_context_packet_atomic above:
  -- the RETURNS TABLE's receipt_id OUT param shadows the column, so RETURNING
  -- needs a qualified reference.
  insert into public.goal_completion_receipts as t (
    workspace_id, goal_id, receipt_id, receipt_digest, mission_id, status,
    conditions, evidence, agent_ids, provider_ids, approvals, unresolved_risks,
    decisions_required, context_packet_ids, started_at, completed_at, generated_at
  ) values (
    p_workspace_id, p_goal_id, p_receipt_id, p_receipt_digest, p_mission_id, p_status,
    p_conditions, p_evidence, p_agent_ids, p_provider_ids, p_approvals, p_unresolved_risks,
    p_decisions_required, p_context_packet_ids, p_started_at, p_completed_at, p_generated_at
  )
  -- Same ON CONFLICT column-list ambiguity as create_goal_context_packet_atomic.
  on conflict on constraint goal_completion_receipts_workspace_id_receipt_id_key do nothing
  returning t.receipt_id into v_receipt_id;

  if v_receipt_id is null then
    select r.receipt_digest into v_existing_digest
      from public.goal_completion_receipts r
     where r.workspace_id = p_workspace_id and r.receipt_id = p_receipt_id
     for update;
    if v_existing_digest <> p_receipt_digest then
      return query select 'idempotency_conflict'::text, p_receipt_id;
      return;
    end if;
    return query select 'replayed'::text, p_receipt_id;
    return;
  end if;

  select coalesce(max(e.sequence), 0) + 1 into v_next_sequence
    from public.goal_events e
   where e.workspace_id = p_workspace_id and e.goal_id = p_goal_id;
  insert into public.goal_events (
    workspace_id, goal_id, sequence, event_type, payload, actor_kind,
    actor_id, correlation_id, causation_id
  ) values (
    p_workspace_id, p_goal_id, v_next_sequence, 'goal.receipt_ready',
    jsonb_build_object('receiptId', p_receipt_id, 'status', p_status, 'evidenceCount', jsonb_array_length(p_evidence)),
    p_actor_kind, p_actor_id, p_correlation_id, null
  );
  return query select 'created'::text, v_receipt_id;
end;
$$;

-- These projections are only reached through the server-side Goal/Mission
-- application services. They are deliberately not a public Data API surface.
alter table public.goal_context_packets enable row level security;
alter table public.goal_completion_receipts enable row level security;

revoke all on public.goal_context_packets, public.goal_completion_receipts from public, anon, authenticated;
grant select, insert on public.goal_context_packets to service_role;
grant select, insert, update on public.goal_completion_receipts to service_role;

revoke all on function public.create_goal_context_packet_atomic(
  uuid, uuid, text, text, text, text, text, text, text, text[], text, text,
  timestamptz, text, text, text
) from public, anon, authenticated;
grant execute on function public.create_goal_context_packet_atomic(
  uuid, uuid, text, text, text, text, text, text, text, text[], text, text,
  timestamptz, text, text, text
) to service_role;

revoke all on function public.create_goal_receipt_atomic(
  uuid, uuid, text, text, text, text, jsonb, jsonb, text[], text[], text[],
  text[], text[], text[], timestamptz, timestamptz, timestamptz, text, text, text
) from public, anon, authenticated;
grant execute on function public.create_goal_receipt_atomic(
  uuid, uuid, text, text, text, text, jsonb, jsonb, text[], text[], text[],
  text[], text[], text[], timestamptz, timestamptz, timestamptz, text, text, text
) to service_role;
