-- The human-interrupt control: a durable request row a human creates from
-- the dashboard ("Stop" on a live agent turn), that the owning Bridge
-- process polls for and consumes -- mirrors bridge_permission_requests'
-- proven pending/consumed shape, but simpler: there is no approve/deny
-- decision here, only "cancel this" and "it was delivered."
-- Scoped by conversation_id + connection_id (not execution_id) because the
-- human only knows which agent/conversation they're looking at, never the
-- live ACP session id -- the Bridge itself resolves conversation+connection
-- to whichever of its own knownSessions currently owns that pairing.
create table if not exists bridge_cancel_turn_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references projects(id) on delete cascade,
  conversation_id uuid not null references agent_conversations(id) on delete cascade,
  connection_id uuid not null,
  status text not null default 'pending' check (status in ('pending', 'consumed')),
  requested_by_user_id uuid not null,
  created_at timestamptz not null default now(),
  consumed_at timestamptz
);

create index if not exists bridge_cancel_turn_requests_pending_idx
  on bridge_cancel_turn_requests (workspace_id, conversation_id, connection_id)
  where status = 'pending';

alter table bridge_cancel_turn_requests enable row level security;
