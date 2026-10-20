-- A retried session submission must not create a second dashboard evidence row.
-- The key is scoped to both workspace and connection: two providers may submit
-- identical evidence in one workspace and still represent two real sessions.
--
-- Do not delete or merge historical evidence here. If old duplicate digests
-- exist, this migration fails before creating the index; reconcile those rows
-- with an owner-reviewed, evidence-preserving migration first.
do $$
begin
  if exists (
    select 1
    from public.agent_sessions
    where submission_digest is not null
    group by workspace_id, connection_id, submission_digest
    having count(*) > 1
  ) then
    raise exception 'agent_sessions contains duplicate submission_digest rows; reconcile them before enabling idempotency';
  end if;
end
$$;

create unique index if not exists agent_sessions_submission_idempotency_idx
  on public.agent_sessions (workspace_id, connection_id, submission_digest)
  where submission_digest is not null;
