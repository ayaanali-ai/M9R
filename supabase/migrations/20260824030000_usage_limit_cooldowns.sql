-- The bridge's usage-limit cooldown (bridge-runtime.ts, detectUsageLimitCooldownUntil
-- / recordUsageLimitCooldownIfApplicable) already correctly parses a provider's own
-- stated reset time ("...try again at Sep 14th, 2026 4:46 PM") into a real,
-- multi-week-future cooldown -- but it only ever lived in a plain in-memory Map inside
-- one resident process. Any restart (a manual one, a crash, a routine machine reboot)
-- wipes it, so the provider immediately retries, fails again, and generates a fresh
-- burst of chatter before re-establishing quiet. This table makes the cooldown a
-- durable record instead: written once when a cooldown is set, read once per
-- conversation the first time a resident process touches it after starting, then
-- cached in memory for the rest of that process's life -- the hot per-message check
-- stays a pure in-memory lookup, unchanged.
--
-- Keyed by (workspace_id, connection_id, conversation_id): connection_id is the
-- durable agent identity (survives restarts, unlike a resident's own bridge_instance_id),
-- so this applies to every agent connection in every workspace, not any one user.
create table if not exists public.agent_usage_limit_cooldowns (
  workspace_id uuid not null references public.projects(id) on delete cascade,
  connection_id uuid not null references public.agent_connections(id) on delete cascade,
  conversation_id uuid not null references public.agent_conversations(id) on delete cascade,
  cooldown_until timestamptz not null,
  reason text not null check (char_length(reason) between 1 and 500),
  updated_at timestamptz not null default now(),
  primary key (connection_id, conversation_id),
  constraint agent_usage_limit_cooldowns_connection_workspace_fk foreign key (connection_id, workspace_id)
    references public.agent_connections(id, workspace_id) on delete cascade,
  constraint agent_usage_limit_cooldowns_conversation_workspace_fk foreign key (conversation_id, workspace_id)
    references public.agent_conversations(id, workspace_id) on delete cascade
);

create index if not exists agent_usage_limit_cooldowns_workspace_idx
  on public.agent_usage_limit_cooldowns (workspace_id);

alter table public.agent_usage_limit_cooldowns enable row level security;
