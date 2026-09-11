-- The live checklist an agent renders inside its own message bubble.
-- ACP already carries this natively as the `plan` session update
-- (PlanEntry[] -- see @agentclientprotocol/sdk's schema types, and
-- claude-agent-acp's planEntries(), which converts its own TodoWrite calls
-- into exactly that shape); the Bridge maps it to a `provider.plan` event
-- and lands it here.
--
-- A dedicated table rather than new columns on conversation_messages, for
-- the same reason conversation_message_attachments is its own table: this is
-- attached state with its own independent update cadence (an agent may
-- rewrite its checklist a dozen times inside one turn) and its own writer
-- (the owning Bridge, not the message author path). conversation_messages
-- rows are otherwise append-only apart from the human-only edit path.
--
-- One row per (message, connection), not one per entry, and not one per
-- message. Per entry: ACP's own contract is that a plan update carries the
-- COMPLETE list and the client replaces the whole plan each time, so the
-- entries array is the natural unit of replacement and an upsert is the
-- natural write. Per (message, connection) rather than per message: a live
-- checklist is reported during a turn, and during a turn the only message
-- that exists yet is the one that TRIGGERED it -- the agent's own reply is
-- posted at the end. So the anchor is the triggering message, exactly as
-- workspace.step/workspace.turn already group by it, and two agents can be
-- working the same human message at once (the turn indicator is already
-- per-connection for this reason). Scoping the row by connection_id is what
-- makes "an agent can never overwrite another agent's checklist" a
-- structural property rather than a check someone has to remember.

create table if not exists public.conversation_message_todos (
  message_id uuid not null references public.conversation_messages(id) on delete cascade,
  connection_id uuid not null,
  workspace_id uuid not null references public.projects(id) on delete cascade,
  conversation_id uuid not null references public.agent_conversations(id) on delete cascade,
  entries jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (message_id, connection_id)
);

create index if not exists conversation_message_todos_conversation_idx
  on public.conversation_message_todos (conversation_id, updated_at desc);

alter table public.conversation_message_todos enable row level security;
revoke all on public.conversation_message_todos from anon, authenticated;
grant select, insert, update, delete on public.conversation_message_todos to service_role;
