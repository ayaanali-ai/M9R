-- Phase B8: per-participant commit-signing identity (plan §11.3). The
-- PRIVATE key never leaves the Agent Bridge (src/lib/bridge/git-signer.ts
-- generates and holds it locally) — this table stores only the public key
-- and its fingerprint, exactly the "commit identity" the plan describes:
-- display name, provider, participant ID, public signing key fingerprint.

create table if not exists public.mission_git_signing_identities (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  mission_id text not null references public.missions(id) on delete cascade,
  participant_id text not null,
  public_key text not null check (octet_length(public_key) <= 1024),
  fingerprint text not null check (octet_length(fingerprint) <= 256),
  registered_at timestamptz not null default now(),
  unique (mission_id, participant_id)
);

create index if not exists mission_git_signing_identities_mission_idx
  on public.mission_git_signing_identities (workspace_id, mission_id);

alter table public.mission_git_signing_identities enable row level security;
revoke all on public.mission_git_signing_identities from anon, authenticated;
grant select, insert on public.mission_git_signing_identities to service_role;
