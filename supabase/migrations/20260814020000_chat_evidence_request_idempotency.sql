-- Retries of an evidence-consent request must resolve to the same pending
-- request instead of creating duplicate consent prompts.

alter table public.chat_evidence_requests
  add column if not exists idempotency_key text;

alter table public.chat_evidence_requests
  drop constraint if exists chat_evidence_requests_idempotency_key_check;

alter table public.chat_evidence_requests
  add constraint chat_evidence_requests_idempotency_key_check
  check (idempotency_key is null or char_length(idempotency_key) between 1 and 256);

create unique index if not exists chat_evidence_requests_workspace_idempotency_idx
  on public.chat_evidence_requests (workspace_id, idempotency_key)
  where idempotency_key is not null;
