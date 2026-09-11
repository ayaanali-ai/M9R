-- A handoff message ("do part 2 of Task A") should be more than a chat line:
-- when the recipient agent's own inbox check surfaces it, OathLock starts a
-- real run on their connection so the same task is visible in their own CLI
-- session and on the Watchfloor. spawned_run_id records that run and doubles
-- as the "already handled" marker so re-polling the inbox never double-starts
-- the same handoff.

alter table public.conversation_messages
  add column if not exists spawned_run_id uuid references public.agent_runs(id) on delete set null;

create index if not exists conversation_messages_unconsumed_handoff_idx
  on public.conversation_messages (recipient_connection_id, kind)
  where kind = 'handoff' and spawned_run_id is null;
