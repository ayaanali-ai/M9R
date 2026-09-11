-- Item #32: a genuine third-party secret -- a user's own model-provider API
-- key -- stored via Supabase Vault (pgsodium-backed, KMS-managed), never as
-- plaintext in an ordinary column. This table holds only the vault secret id
-- and metadata; the actual key value lives in vault.secrets, decryptable
-- only via vault.decrypted_secrets under the service role.
--
-- "m9r_native" names M9R's own first-party any-model harness (the "native"
-- adapter, provider slug "m9r") -- distinct from the existing ACP-driven
-- claude-code/codex/opencode connections, which keep working exactly as
-- they do today and don't touch this table.
create table public.m9r_native_provider_credentials (
  id uuid primary key default gen_random_uuid(),
  -- Bare uuid, no FK -- matching the existing workspace_id convention used
  -- across this schema (task_contracts, agent_connections, etc.); there is
  -- no canonical `workspaces` table to reference.
  workspace_id uuid not null,
  -- Allowlisted at the application layer (never a free-text env var name) --
  -- see m9r-native-credential-service.ts's PROVIDER_ENV_VAR allowlist.
  provider_env_var text not null,
  vault_secret_id uuid not null,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (workspace_id, provider_env_var)
);

comment on table public.m9r_native_provider_credentials is
  'Item #32: per-workspace model-provider API keys for M9R''s own first-party any-model harness (the "m9r-native" adapter). The actual key value is never stored here -- only a reference to its Supabase Vault secret. See M9R_MASTER_BUILD_PLAN.md item #32.';

alter table public.m9r_native_provider_credentials enable row level security;

-- Service-role only, matching every other secret-adjacent table in this
-- schema (agent_connections tokens, etc.) -- no client-side policy at all;
-- there is no legitimate client read path for this table.
