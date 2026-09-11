-- M9R Goal Gateway v1
--
-- A Goal is durable intent above a Mission. It is deliberately not a second
-- execution engine: Mission remains the execution aggregate and its existing
-- event store remains authoritative for provider work. This migration stores
-- the normalized contract, an append-only Goal event stream, and one atomic
-- create/idempotency boundary for the personal-agent ingress.

create table if not exists public.goals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.projects(id) on delete cascade,
  principal_id text not null check (char_length(principal_id) between 1 and 160),
  principal_kind text not null check (principal_kind in (
    'human', 'organization', 'personal_agent', 'workspace_agent', 'provider_agent'
  )),
  client_request_id text not null check (char_length(client_request_id) between 1 and 160),
  request_digest text not null check (request_digest ~ '^[0-9a-f]{64}$'),
  title text not null check (char_length(title) between 1 and 160),
  objective text not null check (char_length(objective) between 1 and 8000),
  success_conditions text[] not null default '{}',
  constraints text[] not null default '{}',
  allowed_capabilities text[] not null default '{}',
  provider_preferences text[] not null default '{}',
  autonomy_policy text not null check (autonomy_policy in (
    'observe', 'human_required', 'bounded_execute', 'delegated_action', 'auto_continue'
  )),
  budget jsonb not null default '{"maxDurationMs":null,"maxEstimatedTokens":null}'::jsonb
    check (jsonb_typeof(budget) = 'object'),
  deadline timestamptz,
  parent_goal_id uuid,
  context_refs text[] not null default '{}',
  contract jsonb not null check (jsonb_typeof(contract) = 'object'),
  status text not null default 'proposed' check (status in (
    'proposed', 'authorized', 'planning', 'executing', 'waiting', 'blocked',
    'review', 'completed', 'failed', 'cancelled', 'paused'
  )),
  current_mission_id text,
  created_by_user_id uuid references public.users(id) on delete set null,
  created_by_connection_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  unique (workspace_id, principal_id, client_request_id),
  constraint goals_parent_workspace_fk foreign key (parent_goal_id, workspace_id)
    references public.goals(id, workspace_id) on delete restrict,
  constraint goals_creator_connection_fk foreign key (created_by_connection_id)
    references public.agent_connections(id) on delete set null,
  constraint goals_success_condition_count check (cardinality(success_conditions) >= 1),
  constraint goals_budget_keys check (
    (budget ? 'maxDurationMs') and (budget ? 'maxEstimatedTokens')
  )
);

create index if not exists goals_workspace_status_created_idx
  on public.goals (workspace_id, status, created_at desc, id desc);
create index if not exists goals_parent_idx
  on public.goals (workspace_id, parent_goal_id);
create index if not exists goals_mission_idx
  on public.goals (workspace_id, current_mission_id)
  where current_mission_id is not null;

create table if not exists public.goal_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.projects(id) on delete cascade,
  goal_id uuid not null,
  sequence integer not null check (sequence > 0),
  event_type text not null check (event_type in (
    'goal.proposed',
    'goal.authorized',
    'goal.mission_created',
    'goal.plan_ready',
    'goal.progress',
    'goal.context_requested',
    'goal.approval_requested',
    'goal.provider_blocked',
    'goal.provider_failed',
    'goal.evidence_ready',
    'goal.receipt_ready',
    'goal.paused',
    'goal.cancelled',
    'goal.status_changed'
  )),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  actor_kind text not null check (actor_kind in ('human', 'agent', 'system')),
  actor_id text not null check (char_length(actor_id) between 1 and 160),
  correlation_id text not null check (char_length(correlation_id) between 1 and 160),
  causation_id text,
  occurred_at timestamptz not null default now(),
  unique (workspace_id, goal_id, sequence),
  constraint goal_events_goal_workspace_fk foreign key (goal_id, workspace_id)
    references public.goals(id, workspace_id) on delete cascade
);

create index if not exists goal_events_goal_sequence_idx
  on public.goal_events (workspace_id, goal_id, sequence);

-- Keep the first event and the idempotency decision in the same transaction.
-- The function is service-role-only because both bearer-agent and dashboard
-- paths already perform authorization in application code, and the public
-- Data API is intentionally not the ingress for these tables.
create or replace function public.create_goal_atomic(
  p_workspace_id uuid,
  p_goal_id uuid,
  p_principal_id text,
  p_principal_kind text,
  p_client_request_id text,
  p_request_digest text,
  p_title text,
  p_objective text,
  p_success_conditions text[],
  p_constraints text[],
  p_allowed_capabilities text[],
  p_provider_preferences text[],
  p_autonomy_policy text,
  p_budget jsonb,
  p_deadline timestamptz,
  p_parent_goal_id uuid,
  p_context_refs text[],
  p_contract jsonb,
  p_actor_kind text,
  p_actor_id text,
  p_correlation_id text,
  p_created_by_connection_id uuid default null,
  p_created_by_user_id uuid default null
)
returns table (result text, goal_id uuid)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_goal_id uuid;
  v_existing_digest text;
begin
  insert into public.goals (
    id, workspace_id, principal_id, principal_kind, client_request_id,
    request_digest, title, objective, success_conditions, constraints,
    allowed_capabilities, provider_preferences, autonomy_policy, budget,
    deadline, parent_goal_id, context_refs, contract, status,
    created_by_connection_id, created_by_user_id
  ) values (
    p_goal_id, p_workspace_id, p_principal_id, p_principal_kind, p_client_request_id,
    p_request_digest, p_title, p_objective, p_success_conditions, p_constraints,
    p_allowed_capabilities, p_provider_preferences, p_autonomy_policy, p_budget,
    p_deadline, p_parent_goal_id, p_context_refs, p_contract, 'proposed',
    p_created_by_connection_id, p_created_by_user_id
  )
  on conflict (workspace_id, principal_id, client_request_id) do nothing
  returning id into v_goal_id;

  if v_goal_id is null then
    select g.id, g.request_digest
      into v_goal_id, v_existing_digest
      from public.goals g
     where g.workspace_id = p_workspace_id
       and g.principal_id = p_principal_id
       and g.client_request_id = p_client_request_id
     for update;

    if v_existing_digest <> p_request_digest then
      return query select 'idempotency_conflict'::text, v_goal_id;
      return;
    end if;

    return query select 'replayed'::text, v_goal_id;
    return;
  end if;

  insert into public.goal_events (
    workspace_id, goal_id, sequence, event_type, payload, actor_kind,
    actor_id, correlation_id, causation_id
  ) values (
    p_workspace_id, v_goal_id, 1, 'goal.proposed', p_contract, p_actor_kind,
    p_actor_id, p_correlation_id, null
  );

  return query select 'created'::text, v_goal_id;
end;
$$;

alter table public.goals enable row level security;
alter table public.goal_events enable row level security;

revoke all on public.goals, public.goal_events from public, anon, authenticated;
grant select, insert, update on public.goals to service_role;
grant select, insert on public.goal_events to service_role;
revoke all on function public.create_goal_atomic(
  uuid, uuid, text, text, text, text, text, text, text[], text[], text[],
  text[], text, jsonb, timestamptz, uuid, text[], jsonb, text, text, text,
  uuid, uuid
) from public, anon, authenticated;
grant execute on function public.create_goal_atomic(
  uuid, uuid, text, text, text, text, text, text, text[], text[], text[],
  text[], text, jsonb, timestamptz, uuid, text[], jsonb, text, text, text,
  uuid, uuid
) to service_role;

-- Serialize Goal lifecycle changes and the corresponding event. The caller
-- must provide the state it read; a stale caller receives status_conflict and
-- cannot silently overwrite a newer authorization or dispatch decision.
create or replace function public.transition_goal_atomic(
  p_workspace_id uuid,
  p_goal_id uuid,
  p_expected_status text,
  p_next_status text,
  p_event_type text,
  p_payload jsonb,
  p_actor_kind text,
  p_actor_id text,
  p_correlation_id text,
  p_current_mission_id text default null
)
returns table (result text, goal_id uuid, status text, current_mission_id text)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_current_status text;
  v_current_mission_id text;
  v_next_sequence integer;
begin
  select g.status, g.current_mission_id
    into v_current_status, v_current_mission_id
    from public.goals g
   where g.id = p_goal_id
     and g.workspace_id = p_workspace_id
   for update;

  if not found then
    return query select 'not_found'::text, p_goal_id, null::text, null::text;
    return;
  end if;

  if v_current_status <> p_expected_status then
    return query select 'status_conflict'::text, p_goal_id, v_current_status, v_current_mission_id;
    return;
  end if;

  -- Table alias is required here: this function's RETURNS TABLE declares an
  -- OUT parameter also named current_mission_id, which otherwise shadows the
  -- goals.current_mission_id column and makes the bare reference ambiguous.
  update public.goals as g
     set status = p_next_status,
         current_mission_id = coalesce(p_current_mission_id, g.current_mission_id),
         updated_at = now()
   where g.id = p_goal_id
     and g.workspace_id = p_workspace_id;

  select coalesce(max(e.sequence), 0) + 1
    into v_next_sequence
    from public.goal_events e
   where e.goal_id = p_goal_id
     and e.workspace_id = p_workspace_id;

  insert into public.goal_events (
    workspace_id, goal_id, sequence, event_type, payload, actor_kind,
    actor_id, correlation_id, causation_id
  ) values (
    p_workspace_id, p_goal_id, v_next_sequence, p_event_type, p_payload,
    p_actor_kind, p_actor_id, p_correlation_id, null
  );

  return query select 'applied'::text, p_goal_id, p_next_status,
    coalesce(p_current_mission_id, v_current_mission_id);
end;
$$;

revoke all on function public.transition_goal_atomic(
  uuid, uuid, text, text, text, jsonb, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.transition_goal_atomic(
  uuid, uuid, text, text, text, jsonb, text, text, text, text
) to service_role;
