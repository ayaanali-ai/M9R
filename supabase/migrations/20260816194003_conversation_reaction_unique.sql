-- toggleDashboardReaction (conversation-service.ts) does a select-then-insert
-- with no DB-level guard at all -- a genuine race (double-click, two open
-- tabs) silently inserted two duplicate reaction rows for the same
-- user+message+emoji instead of erroring, which the UI then rendered as a
-- doubled-up pill. Partial index (not actor_connection_id too) because only
-- the human dashboard path can hit this race today -- no agent-authored
-- reaction insert exists yet.
create unique index if not exists conversation_message_reactions_actor_user_unique
  on public.conversation_message_reactions (message_id, actor_user_id, emoji)
  where actor_user_id is not null;
