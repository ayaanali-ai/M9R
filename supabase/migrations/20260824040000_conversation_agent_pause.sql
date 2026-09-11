-- Loop-prevention Layer 3: a human kill switch. The Aug 24 incident ran for
-- 8+ minutes with a human watching the feed live and no button to press --
-- every platform researched (Slack's !mute, Claude Tag's "Respond
-- automatically" toggle) ships one; OathLock didn't. Null means not paused
-- (the default, unchanged behavior for every existing conversation).
-- Deliberately allowed on core channels too (#general is exactly where the
-- incident happened) -- unlike archive/delete, this is reversible and
-- affects only automated agent delivery, never human messaging.
alter table public.agent_conversations
  add column if not exists agent_replies_paused_at timestamptz;
