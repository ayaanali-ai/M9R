-- Human-selected connection defaults and channel-specific settings. Runtime
-- resolves these for the authenticated connection before starting each turn.
alter table public.agent_connections add column if not exists effort text;
alter table public.agent_connections add column if not exists available_efforts jsonb;

create table if not exists public.channel_agent_settings (
  workspace_id uuid not null references public.projects(id) on delete cascade,
  conversation_id uuid not null references public.agent_conversations(id) on delete cascade,
  connection_id uuid not null references public.agent_connections(id) on delete cascade,
  model text,
  effort text,
  updated_by uuid not null references auth.users(id),
  updated_at timestamptz not null default now(),
  primary key (conversation_id, connection_id),
  check (model is null or length(model) between 1 and 80),
  check (effort is null or length(effort) between 1 and 80)
);
alter table public.channel_agent_settings enable row level security;
grant select on public.channel_agent_settings to authenticated;
grant all on public.channel_agent_settings to service_role;
-- API performs connection ownership + channel visibility checks before writing.
create policy "visible channel settings" on public.channel_agent_settings for select to authenticated
using (exists (select 1 from public.agent_conversations c where c.id = conversation_id and c.workspace_id = channel_agent_settings.workspace_id));
