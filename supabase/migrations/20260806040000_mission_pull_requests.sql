-- Real PR create/merge (gap: OathLock stayed GitHub-integrated rather than
-- building Buzz's Nostr patch model -- and Buzz's own git integration is
-- explicitly "least finished, more vision than reality" per their own docs,
-- so this is a place OathLock can be MORE real, not just parity).
--
-- Deliberately its own table, not an extra row shape in
-- mission_git_provenance: that table's commit_sha column has a hard CHECK
-- requiring a real 40-64 hex SHA (20260801020000_mission_git_provenance.sql)
-- -- correct for a commit/push candidate, but a PR-open candidate has no
-- commit yet. Bending that constraint to accept "not applicable" would
-- weaken a real security-relevant check for the case it exists to guard.
--
-- Same trust model as mission_git_provenance and channel_workflows:
-- service-role writes only, scoped in app code to the caller's own
-- workspace/mission, never RLS alone (RLS below only closes the door to
-- anon/authenticated touching this table directly).

create table if not exists public.mission_pull_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  mission_id text not null references public.missions(id) on delete cascade,
  assignment_id text not null,
  participant_id text not null,
  owner text not null check (octet_length(owner) <= 200),
  repo text not null check (octet_length(repo) <= 200),
  head_branch text not null check (octet_length(head_branch) <= 200),
  base_branch text not null check (octet_length(base_branch) <= 200),
  title text not null check (octet_length(title) <= 500),
  body text not null default '' check (octet_length(body) <= 8000),
  candidate_digest text not null check (octet_length(candidate_digest) <= 128),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'opened', 'failed')),
  pr_number integer,
  pr_url text,
  failure_reason text,
  decided_by_user_id uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  opened_at timestamptz,
  created_at timestamptz not null default now(),
  unique (mission_id, candidate_digest)
);

create index if not exists mission_pull_requests_mission_time_idx
  on public.mission_pull_requests (workspace_id, mission_id, created_at desc);

alter table public.mission_pull_requests enable row level security;
revoke all on public.mission_pull_requests from anon, authenticated;
grant select, insert, update on public.mission_pull_requests to service_role;
