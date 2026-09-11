-- Real, code-enforced anti-loop guard for raw agent-to-agent messaging
-- (conversation_messages with both sender_connection_id and
-- recipient_connection_id set -- the same real mechanism WhispersPanel
-- already reads). Item #4's task-contract system has its own, bigger
-- loop-safety design (assignment_history + reassignment_count), but that's
-- scoped to task_contract_items and isn't built into the app yet. This is
-- the much smaller, immediately-effective guard for the raw messaging
-- primitive that IS live today and currently has no cap of any kind: two
-- agents replying to each other indefinitely is not prevented by anything
-- right now.
--
-- 0 = not a continuation of a directed exchange (a fresh directed message).
-- Incremented at write time only when this message directly answers the
-- immediately preceding message in the same back-and-forth (see
-- sendConversationMessage's depth check in conversation-service.ts).
alter table conversation_messages
  add column if not exists reply_depth int not null default 0;
