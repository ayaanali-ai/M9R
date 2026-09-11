-- Shared Live Sessions v2: a Session is a bounded, lifecycled unit of work
-- (one task, possibly spanning several turns/queued follow-ups), replacing
-- the v1 approach of listing raw individual turns. See
-- M9R_MASTER_BUILD_PLAN.md item 1 for the full design.
--
-- Verified before this migration: the existing `agent_sessions` table is an
-- unrelated concept (evidence-submission metadata -- findings_count,
-- rules_generated, human_approved_submission). No collision, no reuse.
create table if not exists conversation_sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references projects(id) on delete cascade,
  conversation_id uuid not null references agent_conversations(id) on delete cascade,
  connection_id uuid references agent_connections(id) on delete set null,
  owner_user_id uuid references users(id) on delete set null,
  title text not null,
  status text not null default 'active' check (status in ('active', 'waiting', 'archived')),
  anchor_message_id uuid references conversation_messages(id) on delete set null,
  latest_message_id uuid references conversation_messages(id) on delete set null,
  -- Every message that belongs to this session, so the channel feed can
  -- filter out an archived session's messages by id without needing a
  -- separate join table.
  message_ids uuid[] not null default '{}',
  participant_user_ids uuid[] not null default '{}',
  archive_proposed_at timestamptz,
  archive_proposed_message_id uuid references conversation_messages(id) on delete set null,
  created_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  archived_at timestamptz,
  archived_by_user_id uuid references users(id) on delete set null
);

create index if not exists conversation_sessions_workspace_status_idx on conversation_sessions (workspace_id, status);
create index if not exists conversation_sessions_conversation_idx on conversation_sessions (conversation_id);
create index if not exists conversation_sessions_connection_idx on conversation_sessions (connection_id);

alter table conversation_sessions enable row level security;
-- Service-role only, matching workspace_file_activity / conversation_message_todos:
-- read/write is mediated entirely by server API routes, no client policies.
revoke all on conversation_sessions from anon, authenticated;
