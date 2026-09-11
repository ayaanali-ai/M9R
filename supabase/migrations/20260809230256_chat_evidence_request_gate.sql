-- Phase 2: chat evidence must be explicitly requested, approved in-channel,
-- and then submitted as structured facts for final human review.
create table if not exists chat_evidence_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references projects(id) on delete cascade,
  conversation_id uuid not null,
  agent_connection_id uuid not null references agent_connections(id) on delete restrict,
  provider text,
  request_summary text not null,
  request_message_id uuid,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'expired')),
  decided_by_user_id uuid,
  decision_message_id uuid,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists chat_evidence_requests_pending_idx
  on chat_evidence_requests (workspace_id, conversation_id, status, created_at);

alter table chat_evidence_requests enable row level security;
grant all on chat_evidence_requests to service_role;

alter table chat_evidence_submissions
  add column if not exists request_id uuid references chat_evidence_requests(id) on delete restrict,
  add column if not exists evidence jsonb;

create unique index if not exists chat_evidence_submissions_request_unique
  on chat_evidence_submissions (request_id)
  where request_id is not null;
