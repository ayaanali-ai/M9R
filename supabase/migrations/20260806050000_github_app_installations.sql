-- Per-workspace GitHub App installation -- the real fix for a structural gap
-- found while shipping PR-create: GITHUB_APP_INSTALLATION_ID was a single
-- global env var, meaning every workspace's git features could only ever
-- touch repos under ONE GitHub account (the operator's own). Nothing today
-- lets a user bind a channel to an arbitrary repository (no live route
-- writes agent_conversations.repository), so this wasn't yet exploitable --
-- but the moment a "bind repo" UI ships without this, any workspace could
-- name another workspace's repo and the token broker would mint a real
-- token for it. Per-workspace installation makes that structurally
-- impossible: a workspace's token can only ever come from ITS OWN
-- installation, which GitHub itself scopes to the repos that workspace
-- actually installed the App on -- enforced by GitHub, not by an
-- app-level check this codebase has to remember to write correctly.
--
-- One installation per workspace (a workspace re-installing replaces its
-- row, same as re-running the GitHub install flow always does client-side).
-- GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY stay global -- it's one App,
-- registered once, installed many times. GITHUB_APP_INSTALLATION_ID (the
-- pre-existing env var) becomes a fallback for workspaces with no row here
-- yet, not removed -- see mission-git-credential-broker.ts.

create table if not exists public.github_app_installations (
  workspace_id uuid primary key,
  installation_id bigint not null,
  account_login text not null check (octet_length(account_login) <= 200),
  account_type text not null check (account_type in ('User', 'Organization')),
  installed_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists github_app_installations_installation_idx
  on public.github_app_installations (installation_id);

alter table public.github_app_installations enable row level security;
revoke all on public.github_app_installations from anon, authenticated;
grant select, insert, update, delete on public.github_app_installations to service_role;
