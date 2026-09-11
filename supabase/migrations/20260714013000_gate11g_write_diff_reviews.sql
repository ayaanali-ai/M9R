create table if not exists public.launch_diff_reviews (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.projects(id) on delete cascade,
  launch_grant_id uuid not null references public.launch_grants(id) on delete cascade,
  manifest jsonb not null check (manifest->>'version' = 'oathlock.diff-manifest.v1' and octet_length(manifest::text) <= 262144),
  manifest_digest text not null check (manifest_digest ~ '^[a-f0-9]{64}$'),
  decision text not null default 'pending' check (decision in ('pending','approved','rejected')),
  decided_by uuid references auth.users(id) on delete restrict,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (launch_grant_id, manifest_digest),
  check ((decision = 'pending' and decided_by is null and decided_at is null) or (decision <> 'pending' and decided_by is not null and decided_at is not null))
);
alter table public.launch_diff_reviews enable row level security;
grant select, update on public.launch_diff_reviews to authenticated;
grant select, insert, update, delete on public.launch_diff_reviews to service_role;
drop policy if exists "owners read launch diff reviews" on public.launch_diff_reviews;
create policy "owners read launch diff reviews" on public.launch_diff_reviews for select to authenticated
using (exists (select 1 from public.projects p where p.id = workspace_id and p.owner_id = (select auth.uid())));
drop policy if exists "owners decide launch diff reviews" on public.launch_diff_reviews;
create policy "owners decide launch diff reviews" on public.launch_diff_reviews for update to authenticated
using (exists (select 1 from public.projects p where p.id = workspace_id and p.owner_id = (select auth.uid())))
with check (exists (select 1 from public.projects p where p.id = workspace_id and p.owner_id = (select auth.uid())));
