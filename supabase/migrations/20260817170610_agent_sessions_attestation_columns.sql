-- Additive columns carrying the real three-state evidence-submission model
-- (evidence-submission.ts's SubmissionOrigin/EvidenceAttachmentStatus/
-- HumanAttestation) alongside the legacy human_approved_submission boolean.
-- Nullable and additive: existing rows are left as-is, the legacy boolean
-- keeps being written and keeps gating exactly what it gates today.
alter table public.agent_sessions
  add column if not exists submission_origin text,
  add column if not exists attachment_status text,
  add column if not exists human_attestation text,
  add column if not exists submission_digest text;

alter table public.agent_sessions
  add constraint agent_sessions_submission_origin_check
    check (submission_origin is null or submission_origin in ('agent', 'human', 'system'));

alter table public.agent_sessions
  add constraint agent_sessions_attachment_status_check
    check (attachment_status is null or attachment_status in ('draft', 'validated', 'attached', 'rejected'));

alter table public.agent_sessions
  add constraint agent_sessions_human_attestation_check
    check (human_attestation is null or human_attestation in ('not_requested', 'pending', 'attested', 'declined'));
