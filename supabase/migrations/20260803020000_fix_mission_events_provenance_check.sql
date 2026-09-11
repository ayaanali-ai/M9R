-- Fixes a latent, pre-existing schema/application drift bug: the original
-- provenance check constraint (20260725120000_mission_event_log.sql) allows
-- ('agent_report', 'human_input', 'system_inference', 'external_verification'),
-- but mission-domain.ts's real PROVENANCE_KINDS (the actual values every
-- MissionEvent has ever been constructed with) are
-- ('observed_fact', 'provider_claim', 'system_inference', 'agent_claim',
-- 'human_decision'). Only 'system_inference' ever overlapped, so any
-- human-actor collaboration command (AddParticipant, PostMessage, etc. —
-- mission-command-handler.ts's `provenance: context.actor.kind === "human"
-- ? "human_decision" : "system_inference"`) has always violated this
-- constraint against real Postgres. No application code anywhere emits the
-- constraint's original vocabulary; this migration fixes the constraint to
-- match the domain model that was always the real source of truth, the same
-- way this file's own schema_version column was fixed for the same class of
-- drift.

alter table public.mission_events
  drop constraint if exists mission_events_provenance_check;

alter table public.mission_events
  add constraint mission_events_provenance_check
  check (provenance in ('observed_fact', 'provider_claim', 'system_inference', 'agent_claim', 'human_decision'));
