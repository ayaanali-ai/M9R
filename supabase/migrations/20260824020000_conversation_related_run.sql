-- The "Open session in Claude" deep-link the Claude Tag demo video showed
-- (docs/research-claude-tag-ui-deep-dive.md) has a real OathLock analog: the
-- run a message is *about*. spawned_run_id already exists but means
-- something narrower and specific -- the run a handoff message caused to be
-- created, with its own atomic claim mechanism
-- (20260814010000_atomic_handoff_run_claim.sql, keyed on
-- kind='handoff' and spawned_run_id is null). Overloading that column for
-- "the run this message refers to" (a run-start request, an evidence
-- submission, a permission request -- none of which spawn anything) would
-- mix two different meanings into one field. related_run_id is a distinct,
-- purely descriptive column: nullable, additive, no claim semantics, set at
-- post time by whichever route already knows the run in scope.
alter table public.conversation_messages
  add column if not exists related_run_id uuid references public.agent_runs(id) on delete set null;
