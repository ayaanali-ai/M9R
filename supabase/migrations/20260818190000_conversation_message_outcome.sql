-- Adds a real outcome column to conversation_messages so a "result" message
-- can be styled by whether the turn actually succeeded, instead of by its
-- message kind alone. Before this, every data-kind="result" message rendered
-- green regardless of content -- measured 54 of 77 stored result messages
-- (70%) contain failure language ("did not complete", "error", "failed")
-- while all 77 rendered with the same success-green tint. The bridge already
-- computes this distinction (bridge-runtime.ts: providerFailureReason /
-- reportRecoveryFailureReason / the generic catch block / the success reply
-- branch) and discarded it one line before posting.
--
-- Nullable and additive: existing rows get NULL, which the UI must render
-- with no tint at all (unknown stays unknown, never guessed as success).
alter table public.conversation_messages
  add column if not exists outcome text;

alter table public.conversation_messages
  add constraint conversation_messages_outcome_check
    check (outcome is null or outcome in ('ok', 'failed', 'incomplete'));
