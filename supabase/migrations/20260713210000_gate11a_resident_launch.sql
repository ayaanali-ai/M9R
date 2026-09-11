-- OathLock V2 Gate 11A: user-authorized resident launch custody.
-- Provider credentials and absolute local repository paths remain resident-local.

create table if not exists public.resident_instances (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.projects(id) on delete cascade,
  connection_id uuid not null references public.agent_connections(id) on delete cascade,
  instance_key text not null check (char_length(instance_key) between 8 and 100),
  protocol_version text not null default 'oathlock.resident-launch.v1'
    check (protocol_version = 'oathlock.resident-launch.v1'),
  provider text not null check (provider in ('codex','claude-code','cursor','opencode','other')),
  capabilities jsonb not null default '[]'::jsonb check (jsonb_typeof(capabilities) = 'array'),
  heartbeat_sequence bigint not null default 0 check (heartbeat_sequence >= 0),
  lease_expires_at timestamptz,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  unique (workspace_id, instance_key),
  constraint resident_instances_connection_workspace_fk foreign key (connection_id, workspace_id)
    references public.agent_connections(id, workspace_id) on delete cascade
);

create table if not exists public.resident_provider_authorizations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.projects(id) on delete cascade,
  resident_instance_id uuid not null references public.resident_instances(id) on delete cascade,
  target_connection_id uuid not null references public.agent_connections(id) on delete cascade,
  provider text not null check (provider in ('codex','claude-code','cursor','opencode','other')),
  repository_binding_id text not null check (char_length(repository_binding_id) between 8 and 100),
  repository text not null check (char_length(repository) between 1 and 300),
  capabilities jsonb not null default '[]'::jsonb check (jsonb_typeof(capabilities) = 'array'),
  approval_policy text not null default 'human_before_start'
    check (approval_policy in ('human_before_start','preauthorized_bounded')),
  max_duration_ms bigint not null check (max_duration_ms between 1 and 86400000),
  max_estimated_tokens bigint check (max_estimated_tokens between 1 and 1000000),
  max_delegation_depth smallint not null default 1 check (max_delegation_depth between 0 and 1),
  revoked_at timestamptz,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, resident_instance_id, target_connection_id, repository_binding_id),
  constraint resident_authorization_instance_workspace_fk foreign key (resident_instance_id, workspace_id)
    references public.resident_instances(id, workspace_id) on delete cascade,
  constraint resident_authorization_connection_workspace_fk foreign key (target_connection_id, workspace_id)
    references public.agent_connections(id, workspace_id) on delete cascade
);

create table if not exists public.launch_grants (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.projects(id) on delete cascade,
  assignment_id uuid not null references public.agent_assignments(id) on delete restrict,
  requesting_connection_id uuid not null references public.agent_connections(id) on delete restrict,
  target_connection_id uuid not null references public.agent_connections(id) on delete restrict,
  resident_instance_id uuid not null references public.resident_instances(id) on delete restrict,
  authorization_id uuid not null references public.resident_provider_authorizations(id) on delete restrict,
  protocol_version text not null default 'oathlock.resident-launch.v1'
    check (protocol_version = 'oathlock.resident-launch.v1'),
  provider text not null check (provider in ('codex','claude-code','cursor','opencode','other')),
  repository text not null check (char_length(repository) between 1 and 300),
  repository_binding_id text not null check (char_length(repository_binding_id) between 8 and 100),
  task text not null check (char_length(task) between 1 and 1000),
  required_capabilities jsonb not null default '[]'::jsonb check (jsonb_typeof(required_capabilities) = 'array'),
  allowed_paths jsonb not null check (jsonb_typeof(allowed_paths) = 'array' and jsonb_array_length(allowed_paths) > 0),
  prohibited_paths jsonb not null default '[]'::jsonb check (jsonb_typeof(prohibited_paths) = 'array'),
  max_duration_ms bigint not null check (max_duration_ms between 1 and 86400000),
  max_estimated_tokens bigint check (max_estimated_tokens between 1 and 1000000),
  delegation_depth smallint not null check (delegation_depth between 0 and 1),
  approval_policy text not null check (approval_policy in ('human_before_start','preauthorized_bounded')),
  state text not null default 'requested' check (state in (
    'requested','policy_pending','authorized','queued','claimed','launching','running','returning',
    'completed','rejected','expired','cancelled','launch_failed','timed_out','provider_failed','evidence_rejected'
  )),
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 200),
  claim_token_hash text not null check (claim_token_hash ~ '^[a-f0-9]{64}$'),
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  claimed_at timestamptz,
  process_acknowledged_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key),
  constraint launch_grants_time_order check (expires_at > issued_at and expires_at <= issued_at + interval '15 minutes'),
  constraint launch_grants_requesting_workspace_fk foreign key (requesting_connection_id, workspace_id)
    references public.agent_connections(id, workspace_id) on delete restrict,
  constraint launch_grants_target_workspace_fk foreign key (target_connection_id, workspace_id)
    references public.agent_connections(id, workspace_id) on delete restrict,
  constraint launch_grants_resident_workspace_fk foreign key (resident_instance_id, workspace_id)
    references public.resident_instances(id, workspace_id) on delete restrict
);

create table if not exists public.launch_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.projects(id) on delete cascade,
  launch_grant_id uuid not null references public.launch_grants(id) on delete cascade,
  resident_instance_id uuid references public.resident_instances(id) on delete restrict,
  source text not null check (source in ('requesting_agent','oathlock_policy','human_owner','resident','provider_process','evidence_service')),
  event_type text not null check (event_type in (
    'require_policy','authorize','reject','queue','claim','launch','acknowledge_process','return_result',
    'accept_evidence','reject_evidence','cancel','expire','fail_launch','fail_provider','timeout'
  )),
  from_state text not null,
  to_state text not null,
  sequence bigint not null check (sequence > 0),
  occurred_at timestamptz not null,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 131072),
  recorded_at timestamptz not null default now(),
  unique (launch_grant_id, sequence)
);

alter table public.agent_assignments
  add column if not exists requesting_connection_id uuid references public.agent_connections(id) on delete restrict,
  add column if not exists dispatch_id uuid references public.dispatches(id) on delete set null,
  add column if not exists required_capabilities jsonb not null default '[]'::jsonb,
  add column if not exists resident_instance_id uuid references public.resident_instances(id) on delete set null,
  add column if not exists launch_grant_id uuid references public.launch_grants(id) on delete set null,
  add column if not exists result_decision text check (result_decision in ('adopted','rejected','challenged','human_decision_required')),
  add column if not exists result_decided_at timestamptz;

alter table public.dispatches
  add column if not exists target_connection_id uuid references public.agent_connections(id) on delete set null,
  add column if not exists resident_instance_id uuid references public.resident_instances(id) on delete set null,
  add column if not exists assignment_id uuid references public.agent_assignments(id) on delete set null,
  add column if not exists launch_grant_id uuid references public.launch_grants(id) on delete set null,
  add column if not exists routing_reason text,
  add column if not exists routing_request jsonb check (routing_request is null or jsonb_typeof(routing_request) = 'object'),
  add column if not exists approval_state text not null default 'not_applicable'
    check (approval_state in ('not_applicable','pending','approved','rejected'));

create index if not exists agent_assignments_requesting_created_idx
  on public.agent_assignments(requesting_connection_id, created_at desc);
create index if not exists agent_assignments_dispatch_idx
  on public.agent_assignments(dispatch_id) where dispatch_id is not null;
create unique index if not exists agent_assignments_dispatch_unique
  on public.agent_assignments(dispatch_id) where dispatch_id is not null;

create unique index if not exists launch_grants_id_workspace_unique
  on public.launch_grants(id, workspace_id);
create index if not exists resident_instances_workspace_lease_idx
  on public.resident_instances(workspace_id, lease_expires_at desc) where revoked_at is null;
create index if not exists resident_authorizations_target_idx
  on public.resident_provider_authorizations(target_connection_id, repository, revoked_at);
create index if not exists launch_grants_resident_queue_idx
  on public.launch_grants(resident_instance_id, state, created_at) where state in ('authorized','queued');
create index if not exists launch_events_grant_sequence_idx
  on public.launch_events(launch_grant_id, sequence);

create or replace function public.prevent_launch_event_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'launch_events are append-only';
end;
$$;

drop trigger if exists launch_events_no_update on public.launch_events;
create trigger launch_events_no_update
before update or delete on public.launch_events
for each row execute function public.prevent_launch_event_mutation();

create or replace function public.record_resident_heartbeat_atomic(
  p_resident_instance_id uuid,
  p_workspace_id uuid,
  p_connection_id uuid,
  p_sequence bigint,
  p_seen_at timestamptz,
  p_lease_expires_at timestamptz
)
returns table (accepted boolean, reason text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_lease_expires_at <= p_seen_at or p_lease_expires_at > p_seen_at + interval '90 seconds' then
    return query select false, 'invalid_lease'::text;
    return;
  end if;
  update public.resident_instances
  set heartbeat_sequence = p_sequence,
      last_seen_at = p_seen_at,
      lease_expires_at = p_lease_expires_at,
      updated_at = p_seen_at
  where id = p_resident_instance_id
    and workspace_id = p_workspace_id
    and connection_id = p_connection_id
    and revoked_at is null
    and heartbeat_sequence < p_sequence;
  if found then return query select true, null::text;
  else return query select false, 'sequence_not_newer'::text;
  end if;
end;
$$;

create or replace function public.create_resident_launch_grant_atomic(
  p_workspace_id uuid, p_assignment_id uuid, p_requesting_connection_id uuid,
  p_target_connection_id uuid, p_resident_instance_id uuid, p_authorization_id uuid,
  p_provider text, p_repository text, p_repository_binding_id text, p_task text,
  p_required_capabilities jsonb, p_allowed_paths jsonb, p_prohibited_paths jsonb,
  p_max_duration_ms bigint, p_max_estimated_tokens bigint, p_delegation_depth smallint,
  p_approval_policy text, p_idempotency_key text, p_claim_token_hash text,
  p_issued_at timestamptz, p_expires_at timestamptz
)
returns table (accepted boolean, reason text, launch_grant_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_id uuid;
  new_id uuid;
begin
  perform 1 from public.agent_assignments aa
  where aa.id = p_assignment_id and aa.workspace_id = p_workspace_id
    and aa.connection_id = p_target_connection_id
    and aa.requesting_connection_id = p_requesting_connection_id
    and aa.resident_instance_id = p_resident_instance_id
  for update;
  if not found then return query select false, 'assignment_mismatch'::text, null::uuid; return; end if;

  select lg.id into existing_id from public.launch_grants lg
  where lg.workspace_id = p_workspace_id and lg.idempotency_key = p_idempotency_key;
  if existing_id is not null then return query select true, 'existing'::text, existing_id; return; end if;

  if p_expires_at <= p_issued_at or p_expires_at > p_issued_at + interval '15 minutes' then
    return query select false, 'invalid_expiry'::text, null::uuid; return;
  end if;
  if not exists (
    select 1 from public.resident_provider_authorizations a
    join public.resident_instances r on r.id = a.resident_instance_id and r.workspace_id = a.workspace_id
    where a.id = p_authorization_id and a.workspace_id = p_workspace_id
      and a.resident_instance_id = p_resident_instance_id and a.target_connection_id = p_target_connection_id
      and a.provider = p_provider and a.repository = p_repository
      and a.repository_binding_id = p_repository_binding_id and a.revoked_at is null
      and a.max_duration_ms >= p_max_duration_ms
      and (p_max_estimated_tokens is null or (a.max_estimated_tokens is not null and a.max_estimated_tokens >= p_max_estimated_tokens))
      and a.max_delegation_depth >= p_delegation_depth
      and a.capabilities @> p_required_capabilities
      and r.connection_id = p_target_connection_id and r.provider = p_provider
      and r.revoked_at is null and r.lease_expires_at > p_issued_at
  ) then return query select false, 'authorization_mismatch'::text, null::uuid; return; end if;

  insert into public.launch_grants (
    workspace_id, assignment_id, requesting_connection_id, target_connection_id,
    resident_instance_id, authorization_id, provider, repository, repository_binding_id,
    task, required_capabilities, allowed_paths, prohibited_paths, max_duration_ms,
    max_estimated_tokens, delegation_depth, approval_policy, state, idempotency_key,
    claim_token_hash, issued_at, expires_at
  ) values (
    p_workspace_id, p_assignment_id, p_requesting_connection_id, p_target_connection_id,
    p_resident_instance_id, p_authorization_id, p_provider, p_repository, p_repository_binding_id,
    p_task, p_required_capabilities, p_allowed_paths, p_prohibited_paths, p_max_duration_ms,
    p_max_estimated_tokens, p_delegation_depth, p_approval_policy, 'queued', p_idempotency_key,
    p_claim_token_hash, p_issued_at, p_expires_at
  ) returning id into new_id;
  insert into public.launch_events (
    workspace_id, launch_grant_id, resident_instance_id, source, event_type,
    from_state, to_state, sequence, occurred_at
  ) values
    (p_workspace_id, new_id, p_resident_instance_id, 'oathlock_policy', 'authorize', 'requested', 'authorized', 1, p_issued_at),
    (p_workspace_id, new_id, p_resident_instance_id, 'oathlock_policy', 'queue', 'authorized', 'queued', 2, p_issued_at);
  update public.agent_assignments set launch_grant_id = new_id where id = p_assignment_id;
  return query select true, null::text, new_id;
end;
$$;

create or replace function public.claim_resident_launch_grant_atomic(
  p_launch_grant_id uuid,
  p_workspace_id uuid,
  p_connection_id uuid,
  p_instance_key text,
  p_claimed_at timestamptz
)
returns table (accepted boolean, reason text, sequence bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  g public.launch_grants%rowtype;
  next_sequence bigint;
begin
  select * into g from public.launch_grants
  where id = p_launch_grant_id and workspace_id = p_workspace_id
  for update;
  if not found then return query select false, 'not_found'::text, null::bigint; return; end if;
  if g.claimed_at is not null or g.state = 'claimed' then return query select false, 'already_claimed'::text, null::bigint; return; end if;
  if g.state not in ('authorized', 'queued') then return query select false, 'invalid_state'::text, null::bigint; return; end if;
  if p_claimed_at >= g.expires_at then return query select false, 'expired'::text, null::bigint; return; end if;
  if not exists (
    select 1 from public.resident_instances r
    join public.resident_provider_authorizations a
      on a.id = g.authorization_id and a.resident_instance_id = r.id
    where r.id = g.resident_instance_id and r.workspace_id = p_workspace_id
      and r.connection_id = p_connection_id and r.instance_key = p_instance_key
      and r.provider = g.provider and r.revoked_at is null and r.lease_expires_at > p_claimed_at
      and a.target_connection_id = p_connection_id and a.provider = g.provider
      and a.repository_binding_id = g.repository_binding_id and a.revoked_at is null
  ) then return query select false, 'resident_not_authorized'::text, null::bigint; return; end if;

  select coalesce(max(e.sequence), 0) + 1 into next_sequence
  from public.launch_events e where e.launch_grant_id = g.id;
  update public.launch_grants set state = 'claimed', claimed_at = p_claimed_at, updated_at = p_claimed_at where id = g.id;
  insert into public.launch_events (
    workspace_id, launch_grant_id, resident_instance_id, source, event_type,
    from_state, to_state, sequence, occurred_at
  ) values (
    g.workspace_id, g.id, g.resident_instance_id, 'resident', 'claim',
    g.state, 'claimed', next_sequence, p_claimed_at
  );
  return query select true, null::text, next_sequence;
end;
$$;

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
    or (p_event_type <> 'return_result' and p_payload <> '{}'::jsonb) then
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

revoke all on function public.record_resident_heartbeat_atomic(uuid, uuid, uuid, bigint, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.create_resident_launch_grant_atomic(uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, text, jsonb, jsonb, jsonb, bigint, bigint, smallint, text, text, text, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.claim_resident_launch_grant_atomic(uuid, uuid, uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.record_resident_launch_event_atomic(uuid, uuid, uuid, text, text, text, text, bigint, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.record_resident_heartbeat_atomic(uuid, uuid, uuid, bigint, timestamptz, timestamptz) to service_role;
grant execute on function public.create_resident_launch_grant_atomic(uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, text, jsonb, jsonb, jsonb, bigint, bigint, smallint, text, text, text, timestamptz, timestamptz) to service_role;
grant execute on function public.claim_resident_launch_grant_atomic(uuid, uuid, uuid, text, timestamptz) to service_role;
grant execute on function public.record_resident_launch_event_atomic(uuid, uuid, uuid, text, text, text, text, bigint, timestamptz, jsonb) to service_role;

alter table public.resident_instances enable row level security;
alter table public.resident_provider_authorizations enable row level security;
alter table public.launch_grants enable row level security;
alter table public.launch_events enable row level security;

grant select on public.resident_instances, public.launch_grants, public.launch_events to authenticated;
grant select, insert, update on public.resident_provider_authorizations to authenticated;
grant select, insert, update, delete on public.resident_instances, public.resident_provider_authorizations, public.launch_grants, public.launch_events to service_role;

drop policy if exists "owners read resident instances" on public.resident_instances;
create policy "owners read resident instances" on public.resident_instances for select to authenticated
using (exists (select 1 from public.projects p where p.id = workspace_id and p.owner_id = (select auth.uid())));

drop policy if exists "owners read resident authorizations" on public.resident_provider_authorizations;
create policy "owners read resident authorizations" on public.resident_provider_authorizations for select to authenticated
using (exists (select 1 from public.projects p where p.id = workspace_id and p.owner_id = (select auth.uid())));

drop policy if exists "owners create resident authorizations" on public.resident_provider_authorizations;
create policy "owners create resident authorizations" on public.resident_provider_authorizations for insert to authenticated
with check (created_by = (select auth.uid()) and exists (
  select 1 from public.projects p where p.id = workspace_id and p.owner_id = (select auth.uid())
));

drop policy if exists "owners update resident authorizations" on public.resident_provider_authorizations;
create policy "owners update resident authorizations" on public.resident_provider_authorizations for update to authenticated
using (exists (select 1 from public.projects p where p.id = workspace_id and p.owner_id = (select auth.uid())))
with check (created_by = (select auth.uid()) and exists (
  select 1 from public.projects p where p.id = workspace_id and p.owner_id = (select auth.uid())
));

drop policy if exists "owners read launch grants" on public.launch_grants;
create policy "owners read launch grants" on public.launch_grants for select to authenticated
using (exists (select 1 from public.projects p where p.id = workspace_id and p.owner_id = (select auth.uid())));

drop policy if exists "owners read launch events" on public.launch_events;
create policy "owners read launch events" on public.launch_events for select to authenticated
using (exists (select 1 from public.projects p where p.id = workspace_id and p.owner_id = (select auth.uid())));
