-- Buzz-parity persona packs (closes GAP #5: crates/buzz-persona had no
-- OathLock equivalent). Workspace-scoped; a pack is authored as one JSON
-- document (see src/lib/mission/persona-pack-schema.ts's module comment for
-- why this is inline-authored rather than a filesystem/git-distributed
-- bundle like Buzz's own packs).

create table if not exists public.persona_packs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  version text not null,
  manifest jsonb not null,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists persona_packs_workspace_idx
  on public.persona_packs (workspace_id);

-- Assigns a resolved persona (pack_id + persona name) to one of the
-- workspace's agent kinds -- the natural next wiring step (prepending the
-- resolved prompt to that agent's session) is not built in this pass; this
-- table just records the assignment so that step has something to read
-- from later.
create table if not exists public.persona_pack_assignments (
  workspace_id uuid not null references public.projects(id) on delete cascade,
  agent_kind text not null,
  pack_id uuid not null references public.persona_packs(id) on delete cascade,
  persona_name text not null,
  assigned_by_user_id uuid references auth.users(id) on delete set null,
  assigned_at timestamptz not null default now(),
  primary key (workspace_id, agent_kind)
);
