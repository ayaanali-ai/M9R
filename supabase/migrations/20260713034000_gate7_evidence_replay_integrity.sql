alter table public.evidence_records
  add column if not exists contract_digest text;

create unique index if not exists evidence_records_workspace_digest_unique
  on public.evidence_records (workspace_id, contract_digest)
  where contract_digest is not null;

alter table public.evidence_records
  add constraint evidence_records_contract_digest_format
  check (contract_digest is null or contract_digest ~ '^sha256:[a-f0-9]{64}$')
  not valid;

alter table public.evidence_records
  validate constraint evidence_records_contract_digest_format;
