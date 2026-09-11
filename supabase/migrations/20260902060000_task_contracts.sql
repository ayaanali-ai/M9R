-- Task negotiation / file-claiming (item 5). A human @-mentions 2+ agents in
-- one message; the first-mentioned agent proposes a decomposition; each
-- mentioned agent gets dispatched only its own assigned sub-task.
--
-- File claims here are informational only -- the real enforcement is the
-- already-built live file-lock check at actual write time (file_locks).
-- This is not a second locking system.
create table if not exists task_contracts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references projects(id) on delete cascade,
  conversation_id uuid not null references agent_conversations(id) on delete cascade,
  anchor_message_id uuid references conversation_messages(id) on delete set null,
  decomposed_by_connection_id uuid references agent_connections(id) on delete set null,
  status text not null default 'decomposing' check (status in ('decomposing', 'executing', 'completed', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists task_contract_items (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references task_contracts(id) on delete cascade,
  description text not null,
  expected_file_paths text[] not null default '{}',
  assigned_connection_id uuid references agent_connections(id) on delete set null,
  -- Every connection this item has ever been assigned to, oldest first.
  -- Loop-safety rule #1 (human-mandated, 2026-09-02): an item can never be
  -- reassigned to a connection already present here.
  assignment_history uuid[] not null default '{}',
  -- Loop-safety rule #2: hard cap on total reassignments. Both rules are
  -- deterministic, code-enforced circuit breakers -- they do not depend on
  -- the agents' judgment not to loop.
  reassignment_count int not null default 0,
  status text not null default 'pending' check (status in ('pending', 'in_progress', 'blocked', 'done', 'failed')),
  result_message_id uuid references conversation_messages(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists task_contracts_conversation_idx on task_contracts (conversation_id);
create index if not exists task_contracts_workspace_idx on task_contracts (workspace_id, status);
create index if not exists task_contract_items_contract_idx on task_contract_items (contract_id);
create index if not exists task_contract_items_assigned_idx on task_contract_items (assigned_connection_id) where status in ('pending', 'in_progress');

alter table task_contracts enable row level security;
alter table task_contract_items enable row level security;
-- Service-role only, matching conversation_sessions and file_locks: every
-- read/write is mediated by bearer-authenticated bridge routes or
-- cookie-scoped dashboard routes, never a direct client query.
revoke all on task_contracts from anon, authenticated;
revoke all on task_contract_items from anon, authenticated;
