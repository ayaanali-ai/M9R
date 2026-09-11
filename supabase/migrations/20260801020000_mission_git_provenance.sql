-- Phase 5: bounded Git commit candidates, human authorization, and recorded results.

create table if not exists public.mission_git_provenance (
  operation_id text primary key,
  workspace_id text not null,
  mission_id text not null references public.missions(id) on delete cascade,
  assignment_id text not null,
  participant_id text not null,
  operation text not null check (operation in ('commit','push','pull_request')),
  branch text not null check (octet_length(branch) <= 200),
  commit_sha text not null check (commit_sha ~ '^[0-9a-fA-F]{40,64}$'),
  candidate_digest text not null check (octet_length(candidate_digest) <= 128),
  manifest_digest text not null check (octet_length(manifest_digest) <= 128),
  status text not null check (status in ('recorded','rejected','failed')),
  authorization_attestation jsonb check (authorization_attestation is null or (jsonb_typeof(authorization_attestation) = 'object' and octet_length(authorization_attestation::text) <= 4096)),
  recorded_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (mission_id, operation_id)
);

create index if not exists mission_git_provenance_mission_time_idx on public.mission_git_provenance (workspace_id, mission_id, recorded_at desc);
create index if not exists mission_git_provenance_commit_idx on public.mission_git_provenance (workspace_id, commit_sha);

alter table public.mission_git_provenance enable row level security;
revoke all on public.mission_git_provenance from anon, authenticated;
grant select, insert, update on public.mission_git_provenance to service_role;
