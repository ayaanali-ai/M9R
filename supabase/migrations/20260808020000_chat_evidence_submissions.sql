-- Lets an agent self-submit a lightweight evidence summary from a
-- mention-triggered chat session, with a human approving/rejecting it right
-- in the conversation. Mention-triggered ACP sessions had no way to produce
-- reviewable evidence at all before this -- terminal-session runs already
-- have the full rules/evidence-draft/Run-Passport pipeline, but a chat
-- @mention turn just posted messages. This is the fast, chat-native
-- alternative (option B), not a rebuild of the full terminal pipeline.
create table if not exists chat_evidence_submissions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references projects(id) on delete cascade,
  conversation_id uuid not null,
  message_id uuid,
  provider text,
  summary text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  decided_by_user_id uuid,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists chat_evidence_submissions_workspace_pending_idx
  on chat_evidence_submissions (workspace_id, status, created_at);

alter table chat_evidence_submissions enable row level security;

-- Same convention as bridge_permission_requests: only the service-role
-- client (used by app-code, which does its own workspace scoping) touches
-- this table. No direct client access.
grant all on chat_evidence_submissions to service_role;
