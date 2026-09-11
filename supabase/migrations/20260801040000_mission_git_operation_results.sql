-- A result receipt is not authorization. It can only complete an exact
-- candidate that already has a human approval attestation.
alter table public.mission_git_provenance
  add column if not exists operation_result jsonb;

alter table public.mission_git_provenance
  drop constraint if exists mission_git_provenance_status_check;

alter table public.mission_git_provenance
  add constraint mission_git_provenance_status_check
  check (status in ('recorded', 'rejected', 'failed', 'completed'));

alter table public.mission_git_provenance
  add constraint mission_git_provenance_result_check
  check (
    operation_result is null
    or (
      jsonb_typeof(operation_result) = 'object'
      and operation_result ? 'outcome'
      and operation_result ->> 'outcome' in ('succeeded', 'failed')
      and octet_length(operation_result::text) <= 4096
    )
  );
