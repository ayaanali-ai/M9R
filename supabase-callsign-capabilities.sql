-- OathLock — Capability Card (V2 Phase 7: private agent directory).
-- Run after supabase-agent-join.sql.
--
-- Capabilities are self-declared by the agent, never proven. Rendered as a
-- short list on the Callsign view (callsign.ts) — never as a score.

ALTER TABLE agent_connections ADD COLUMN IF NOT EXISTS capabilities TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN agent_connections.capabilities IS
  'Self-declared capability strings (e.g. "TypeScript implementation"). Declarations, not proven skill ratings.';
