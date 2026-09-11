-- Git-as-events, v1: a real GitHub push/PR/review turns into a message in the
-- bound channel automatically, instead of only showing up when an agent
-- self-reports a commit SHA after the fact (github-link-service.ts's static
-- links). One repo binds to at most one channel per workspace; the owning
-- workspace is what scopes visibility/ownership, same as channel_workflows.
--
-- Written by the signed-in workspace owner (Settings -> Git events); read by
-- the webhook handler (service role, github-events-service.ts) to route an
-- incoming event to the right conversation, and by the same owner's session
-- to list/manage their own bindings.

create table if not exists public.github_repo_bindings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  repo_full_name text not null,
  conversation_id uuid not null references public.agent_conversations(id) on delete cascade,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (workspace_id, repo_full_name)
);

create index if not exists github_repo_bindings_conversation_idx
  on public.github_repo_bindings (conversation_id);

alter table public.github_repo_bindings enable row level security;

grant select, insert, delete on public.github_repo_bindings to authenticated;

drop policy if exists "owners manage their workspace repo bindings" on public.github_repo_bindings;
create policy "owners manage their workspace repo bindings" on public.github_repo_bindings for all to authenticated
using (created_by_user_id = (select auth.uid()))
with check (created_by_user_id = (select auth.uid()));

-- No policy grants the service role anything extra: it already bypasses RLS,
-- matching the existing convention (subscriptions, channel_workflows).
