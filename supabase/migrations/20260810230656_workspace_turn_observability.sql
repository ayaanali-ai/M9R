-- Phase 0: canonical workspace-turn correlation and bounded latency telemetry.
-- Timing events contain identifiers and stage metadata only. Message bodies,
-- provider output, commands, paths, tokens, and credentials are never stored.

alter table public.conversation_messages
  add column if not exists correlation_id text;

create index if not exists conversation_messages_correlation_idx
  on public.conversation_messages (workspace_id, correlation_id, created_at)
  where correlation_id is not null;

create table if not exists public.workspace_turn_timing_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.projects(id) on delete cascade,
  conversation_id uuid not null references public.agent_conversations(id) on delete cascade,
  message_id uuid not null references public.conversation_messages(id) on delete cascade,
  timing_id text not null,
  event_id text not null,
  correlation_id text not null,
  causation_id text,
  bridge_instance_id text,
  session_id text,
  provider text,
  stage text not null check (stage in (
    'message.received',
    'message.enqueued',
    'session.ready',
    'ack.completed',
    'prompt.started',
    'provider.first_event',
    'turn.completed',
    'turn.failed',
    'turn.rejected',
    'report.observed',
    'fallback_report.posted'
  )),
  source text not null check (source in ('relay', 'poll')),
  at_ms bigint not null check (at_ms >= 0),
  elapsed_ms bigint not null check (elapsed_ms >= 0),
  metadata jsonb not null default '{}'::jsonb check (
    jsonb_typeof(metadata) = 'object'
    and octet_length(metadata::text) <= 4096
  ),
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, event_id),
  constraint workspace_turn_timing_message_scope_fk
    foreign key (message_id, workspace_id)
    references public.conversation_messages(id, workspace_id) on delete cascade
);

create index if not exists workspace_turn_timing_channel_time_idx
  on public.workspace_turn_timing_events (workspace_id, conversation_id, occurred_at desc, id);

create index if not exists workspace_turn_timing_message_time_idx
  on public.workspace_turn_timing_events (workspace_id, message_id, at_ms, id);

alter table public.workspace_turn_timing_events enable row level security;
revoke all on public.workspace_turn_timing_events from anon, authenticated;
grant select, insert, update on public.workspace_turn_timing_events to service_role;
