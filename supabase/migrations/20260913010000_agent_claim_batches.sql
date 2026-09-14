-- Group the independently-authenticated claims created by one CLI `connect`
-- invocation so the human can approve them from one URL and one click.
-- Setup codes and one-time tokens remain per claim; batch_id is never an
-- authentication secret.

alter table public.agent_claims
  add column if not exists batch_id uuid;

create index if not exists idx_agent_claims_batch_id
  on public.agent_claims(batch_id, created_at);
