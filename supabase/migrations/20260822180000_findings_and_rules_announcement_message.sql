-- Links a Finding/rule draft to the chat message that announces it, so the
-- Watchfloor message feed can show an inline Approve/Reject card under that
-- exact message -- same pattern as chat_evidence_requests.request_message_id
-- and approval_requests' request_summary.requestMessageId.
alter table public.findings add column if not exists announcement_message_id uuid;
alter table public.workspace_rules add column if not exists announcement_message_id uuid;
