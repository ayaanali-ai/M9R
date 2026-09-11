create table if not exists public.agent_assignments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.projects(id) on delete cascade,
  target_connection_id uuid not null references public.agent_connections(id) on delete restrict,
  created_by uuid not null references auth.users(id) on delete restrict,
  repository text not null check (char_length(repository) between 1 and 300),
  task text not null check (char_length(task) between 1 and 500),
  scope jsonb not null default '[]'::jsonb check (jsonb_typeof(scope) = 'array'),
  prohibited_scope jsonb not null default '[]'::jsonb check (jsonb_typeof(prohibited_scope) = 'array'),
  max_duration_ms bigint not null check (max_duration_ms between 1 and 86400000),
  max_estimated_tokens bigint check (max_estimated_tokens between 1 and 1000000),
  approval_policy text not null check (approval_policy in ('human_before_material_action','human_before_start','preauthorized_bounded')),
  evidence_required boolean not null default true,
  state text not null default 'requested' check (state in ('requested','accepted','rejected','cancelled','expired','completed')),
  version text not null default 'oathlock.assignment.v1' check (version = 'oathlock.assignment.v1'),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_assignments_connection_workspace_fk foreign key (target_connection_id, workspace_id)
    references public.agent_connections(id, workspace_id) on delete restrict
);

create index if not exists agent_assignments_target_state_idx on public.agent_assignments(target_connection_id, state, created_at);
create index if not exists agent_assignments_workspace_created_idx on public.agent_assignments(workspace_id, created_at desc);

alter table public.agent_assignments enable row level security;
grant select, insert, update on public.agent_assignments to authenticated;
grant select, insert, update, delete on public.agent_assignments to service_role;

drop policy if exists "owners read assignments" on public.agent_assignments;
create policy "owners read assignments" on public.agent_assignments for select to authenticated
using (exists (select 1 from public.projects p where p.id = workspace_id and p.owner_id = (select auth.uid())));

drop policy if exists "owners create assignments" on public.agent_assignments;
create policy "owners create assignments" on public.agent_assignments for insert to authenticated
with check (created_by = (select auth.uid()) and exists (select 1 from public.projects p where p.id = workspace_id and p.owner_id = (select auth.uid())));

drop policy if exists "owners update assignments" on public.agent_assignments;
create policy "owners update assignments" on public.agent_assignments for update to authenticated
using (exists (select 1 from public.projects p where p.id = workspace_id and p.owner_id = (select auth.uid())))
with check (created_by = (select auth.uid()) and exists (select 1 from public.projects p where p.id = workspace_id and p.owner_id = (select auth.uid())));
