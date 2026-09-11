-- The Watchfloor already has real per-kind visual treatment for
-- conversation_messages.kind ('handoff' gets a tinted background + labeled
-- chip, 'ack' renders dimmed) -- but four OathLock-authored templates
-- (evidence-submission requests, run-start approval requests, finding
-- announcements, permission requests) were posted with kind:'message', the
-- same kind as free-form human/agent chat text. Each is a system-generated
-- notice wrapping agent-supplied content (a task title, a finding title, a
-- risk summary), not the agent's own prose, and a human reading the
-- transcript has no way to tell the difference today.
--
-- 'notice' is a new, additive kind for exactly that case. sender_kind stays
-- 'connection' for these -- there is a real, authenticated agent connection
-- behind each post (its own CLI call triggered the request), so the sender
-- identity must still show; this is about the *content*, not who sent it.
alter table public.conversation_messages
  drop constraint if exists conversation_messages_kind_check;

alter table public.conversation_messages
  add constraint conversation_messages_kind_check
  check (kind in ('message', 'handoff', 'ack', 'result', 'notice'));
