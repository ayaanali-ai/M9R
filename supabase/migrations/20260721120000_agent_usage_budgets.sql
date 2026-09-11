-- Per-user, per-agent token budgets for the Live Sessions floor's usage bars.
-- OathLock cannot see provider rate limits, so the 5H/7D percentages are
-- measured against these human-set budgets instead. Owner-scoped via RLS.

create table if not exists public.agent_usage_budgets (
  user_id uuid not null references auth.users (id) on delete cascade,
  agent_kind text not null,
  window_5h_tokens bigint not null default 2000000 check (window_5h_tokens > 0),
  window_7d_tokens bigint not null default 20000000 check (window_7d_tokens > 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, agent_kind)
);

alter table public.agent_usage_budgets enable row level security;

drop policy if exists "agent_usage_budgets_select_own" on public.agent_usage_budgets;
create policy "agent_usage_budgets_select_own"
  on public.agent_usage_budgets for select
  using (auth.uid() = user_id);

drop policy if exists "agent_usage_budgets_insert_own" on public.agent_usage_budgets;
create policy "agent_usage_budgets_insert_own"
  on public.agent_usage_budgets for insert
  with check (auth.uid() = user_id);

drop policy if exists "agent_usage_budgets_update_own" on public.agent_usage_budgets;
create policy "agent_usage_budgets_update_own"
  on public.agent_usage_budgets for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
