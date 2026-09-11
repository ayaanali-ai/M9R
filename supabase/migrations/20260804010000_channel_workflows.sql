-- Buzz-parity channel workflow automation (closes the one confirmed gap from
-- the OathLock-vs-Buzz audit: Buzz's crates/buzz-workflow YAML trigger/action
-- engine, ported at a deliberately narrower scope — see
-- src/lib/mission/mission-workflow-schema.ts's module comment for exactly
-- what's included and why).
--
-- Same trust model as agent_conversations/conversation_messages: writes go
-- through the service-role client, scoped in app code to the caller's own
-- workspace, never RLS alone.

create table if not exists public.channel_workflows (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.projects(id) on delete cascade,
  conversation_id uuid not null references public.agent_conversations(id) on delete cascade,
  name text not null,
  definition_yaml text not null,
  definition_json jsonb not null,
  enabled boolean not null default true,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists channel_workflows_conversation_idx
  on public.channel_workflows (conversation_id, enabled);

create index if not exists channel_workflows_workspace_idx
  on public.channel_workflows (workspace_id);

create table if not exists public.channel_workflow_runs (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.channel_workflows(id) on delete cascade,
  workspace_id uuid not null references public.projects(id) on delete cascade,
  trigger_message_id uuid references public.conversation_messages(id) on delete set null,
  status text not null check (status in ('completed', 'failed')),
  step_results jsonb not null default '[]'::jsonb,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists channel_workflow_runs_workflow_idx
  on public.channel_workflow_runs (workflow_id, created_at desc);
