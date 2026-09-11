-- OathLock — Agent Instruction Channel v0.
-- Run after supabase-agent-join.sql.
--
-- Dashboard users can queue a short instruction for a connected coding agent.
-- Agents retrieve queued instructions by pulling their Agent inbox through the
-- CLI. Pulling marks rows as pulled; rows are never deleted by the channel, so
-- audit history remains intact.

CREATE TABLE IF NOT EXISTS agent_instructions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  connection_id UUID NOT NULL REFERENCES agent_connections(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,

  instruction TEXT NOT NULL CHECK (char_length(instruction) > 0 AND char_length(instruction) <= 1000),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'pulled')),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pulled_at TIMESTAMPTZ
);

COMMENT ON TABLE agent_instructions IS
  'Short dashboard instructions for connected coding agents. Pull-based Agent inbox; rows are preserved for audit history.';

CREATE INDEX IF NOT EXISTS idx_agent_instructions_workspace ON agent_instructions(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_instructions_connection_status ON agent_instructions(connection_id, status, created_at);

ALTER TABLE agent_instructions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on agent_instructions" ON agent_instructions;
CREATE POLICY "Service role full access on agent_instructions" ON agent_instructions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Users read own agent instructions" ON agent_instructions;
CREATE POLICY "Users read own agent instructions" ON agent_instructions
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT id FROM projects WHERE owner_id = auth.uid()));

DROP POLICY IF EXISTS "Users insert own agent instructions" ON agent_instructions;
CREATE POLICY "Users insert own agent instructions" ON agent_instructions
  FOR INSERT TO authenticated
  WITH CHECK (workspace_id IN (SELECT id FROM projects WHERE owner_id = auth.uid()));

GRANT SELECT, INSERT ON public.agent_instructions TO authenticated;
