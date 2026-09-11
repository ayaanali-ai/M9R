-- Links a live ACP permission request to the chat message that announces
-- it, so the Watchfloor message feed can show an inline Approve/Deny card
-- under that exact message instead of only the standalone top-of-page
-- banner -- same pattern as findings/rule drafts' announcement_message_id.
alter table public.bridge_permission_requests add column if not exists message_id uuid;
