-- Capability Card (V2 Phase 7: private agent directory).
-- Capabilities are self-declared by the agent, never proven. Rendered as a
-- short list on the Callsign view -- never as a score.
--
-- This was originally shipped as a loose root-level supabase-callsign-capabilities.sql
-- file rather than a tracked migration, so it was never actually applied to
-- production -- agent_connections.capabilities did not exist, which made
-- proposeGoalWorkforce (goal-service.ts) 500 on every call since it selects
-- this column. Bringing it in as a real migration closes that gap.

alter table public.agent_connections add column if not exists capabilities text[] not null default '{}';

comment on column public.agent_connections.capabilities is
  'Self-declared capability strings (e.g. "TypeScript implementation"). Declarations, not proven skill ratings.';
