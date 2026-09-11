-- Git-as-events (github-events-service.ts) posts messages with no real
-- connection or user behind them -- a GitHub webhook delivery, not an agent
-- or a signed-in human. conversation_messages_sender_check
-- (20260802020000_workspace_channels.sql) requires one of those two, which
-- is right for every actor-driven post; a system-authored event needs a
-- third, explicit lane rather than being smuggled through as a fake actor.
--
-- sender_kind stays 'user'/'connection' (unchanged meaning) for every
-- existing row; only a new 'system' value, paired with a required
-- sender_display_name, is added. The constraint below is additive: it
-- widens what's allowed, it never narrows what already passes.

alter table public.conversation_messages
  add column if not exists sender_kind text not null default 'connection'
  check (sender_kind in ('connection', 'user', 'system'));

update public.conversation_messages
  set sender_kind = case when sender_user_id is not null then 'user' else 'connection' end
  where sender_kind = 'connection';

alter table public.conversation_messages
  drop constraint if exists conversation_messages_sender_check;

alter table public.conversation_messages
  add constraint conversation_messages_sender_check
  check (
    (sender_kind = 'system' and sender_display_name is not null)
    or (sender_kind <> 'system' and (sender_connection_id is not null or sender_user_id is not null))
  );
