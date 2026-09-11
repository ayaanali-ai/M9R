-- Links a run to the Mission (task) it belongs to, so multiple agents
-- working the same task can be aggregated into one Mission Passport instead
-- of each agent producing its own disconnected Run Passport. Nullable: a
-- run started outside any Mission (the existing solo flow) stays valid.
alter table public.agent_runs
  add column if not exists mission_id text references public.missions (id) on delete set null;

create index if not exists agent_runs_mission_id_idx
  on public.agent_runs (mission_id)
  where mission_id is not null;
