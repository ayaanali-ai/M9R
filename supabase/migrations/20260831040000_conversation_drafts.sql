-- Shared co-drafting (#13): a structured document per conversation that
-- connected agents and the human jointly build, one named section at a
-- time -- deliberately not live character-by-character co-typing (agents
-- submit finished output, they don't "type" interactively) and deliberately
-- not raw code/diffs (those already live in workspace_file_activity against
-- real git). This is for the genuinely narrative artifacts a team produces
-- together: a PR description, a spec, a shared finding writeup. Scoped so
-- it can hand off cleanly to a real GitHub PR once the desktop build gives
-- agents git write access -- status flips to 'ready' as the explicit human
-- signal that a draft is finished and safe to turn into something durable.
--
-- Same access model as conversation_message_todos: no direct client access
-- at all, only ever touched by service-role backend code (the agent-facing
-- and dashboard-facing API routes), so there is nothing to get wrong in a
-- client-facing RLS policy.

create table if not exists public.conversation_drafts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.projects(id) on delete cascade,
  conversation_id uuid not null references public.agent_conversations(id) on delete cascade,
  title text not null,
  status text not null default 'draft' check (status in ('draft', 'ready')),
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_by_connection_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists conversation_drafts_conversation_idx
  on public.conversation_drafts (conversation_id, updated_at desc);

alter table public.conversation_drafts enable row level security;
revoke all on public.conversation_drafts from anon, authenticated;
grant select, insert, update, delete on public.conversation_drafts to service_role;

-- One row per named section (case-insensitive on heading within a draft --
-- enforced in the service layer, not here, since a citext-style unique index
-- would need an extension this repo doesn't otherwise use). Whoever last
-- wrote a section owns its attribution; earlier authorship of the same
-- section is not retained as history in v1 -- "who wrote this document"
-- reads as one clear author per section, not a diff log.
create table if not exists public.conversation_draft_sections (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references public.conversation_drafts(id) on delete cascade,
  heading text not null,
  body text not null,
  position integer not null default 0,
  author_kind text not null check (author_kind in ('agent', 'human')),
  author_connection_id uuid,
  author_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists conversation_draft_sections_draft_idx
  on public.conversation_draft_sections (draft_id, position);

alter table public.conversation_draft_sections enable row level security;
revoke all on public.conversation_draft_sections from anon, authenticated;
grant select, insert, update, delete on public.conversation_draft_sections to service_role;
