alter table public.agent_instructions
  add column if not exists assignment_id uuid
  references public.agent_assignments(id) on delete set null;

create index if not exists agent_instructions_assignment_idx
  on public.agent_instructions (assignment_id)
  where assignment_id is not null;

alter table public.agent_assignments
  add column if not exists run_id uuid,
  add column if not exists evidence_record_id uuid
  references public.evidence_records(id) on delete restrict;

create index if not exists agent_assignments_run_idx
  on public.agent_assignments (run_id)
  where run_id is not null;

create index if not exists agent_assignments_evidence_idx
  on public.agent_assignments (evidence_record_id)
  where evidence_record_id is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'agent_assignments_run_workspace_fkey'
  ) then
    alter table public.agent_assignments
      add constraint agent_assignments_run_workspace_fkey
      foreign key (run_id, workspace_id)
      references public.agent_runs(id, workspace_id)
      on delete set null;
  end if;
end $$;
