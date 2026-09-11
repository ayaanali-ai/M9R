-- Gate 11F: the requesting agent explicitly records how a returned provider
-- result affected its own plan. This is an immutable causal record, not an
-- inferred success metric.

create table if not exists public.result_adoptions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.projects(id) on delete cascade,
  run_id uuid not null references public.agent_runs(id) on delete cascade,
  launch_grant_id uuid not null references public.launch_grants(id) on delete restrict,
  assignment_id uuid not null references public.agent_assignments(id) on delete restrict,
  requesting_connection_id uuid not null references public.agent_connections(id) on delete restrict,
  decision text not null check (decision in ('adopted', 'rejected', 'challenged')),
  rationale text not null check (char_length(rationale) between 1 and 1000),
  plan_effect text not null check (char_length(plan_effect) between 1 and 1000),
  created_at timestamptz not null default now(),
  unique (launch_grant_id)
);

create index if not exists result_adoptions_run_idx on public.result_adoptions(run_id, created_at desc);

alter table public.result_adoptions enable row level security;
grant select on public.result_adoptions to authenticated;
grant select, insert on public.result_adoptions to service_role;

drop policy if exists "owners read result adoptions" on public.result_adoptions;
create policy "owners read result adoptions" on public.result_adoptions for select to authenticated
using (exists (select 1 from public.projects p where p.id = workspace_id and p.owner_id = (select auth.uid())));

revoke insert, update, delete on public.result_adoptions from authenticated, anon, public;
