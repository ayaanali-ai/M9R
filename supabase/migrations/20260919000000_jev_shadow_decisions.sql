-- Shadow-mode Jev judgments: one row per human message, recorded next to what the existing
-- explicit-@mention routing decided, so agreement can be measured before Jev influences anything.
-- No message text is stored. Service-role only (RLS on, no policies).
create table if not exists public.jev_shadow_decisions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  message_id text not null,
  workspace_id text,
  conversation_id text,
  source text check (source in ('relay', 'http')),
  mode text not null,
  status text not null check (status in ('judged', 'unavailable')),
  is_task real,
  target text,
  target_confidence real,
  actual_mentioned text[] not null default '{}',
  agree boolean,
  latency_ms integer,
  model text,
  input_tokens integer
);
create index if not exists jev_shadow_decisions_created_at_idx on public.jev_shadow_decisions (created_at desc);
create index if not exists jev_shadow_decisions_workspace_idx on public.jev_shadow_decisions (workspace_id, created_at desc);
alter table public.jev_shadow_decisions enable row level security;
