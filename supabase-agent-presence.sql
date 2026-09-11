-- OathLock V2 Gate 1: authoritative resident/linked presence.
-- Run after supabase-agent-join.sql. Server/service-role writes only.

ALTER TABLE agent_connections
  ADD COLUMN IF NOT EXISTS execution_origin TEXT NOT NULL DEFAULT 'linked'
    CHECK (execution_origin IN ('linked', 'resident'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_connections_id_workspace
  ON agent_connections(id, workspace_id);

CREATE TABLE IF NOT EXISTS agent_presence_leases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL,
  workspace_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  protocol_version TEXT NOT NULL CHECK (protocol_version = 'oathlock.presence.v1'),
  adapter_instance_id TEXT NOT NULL CHECK (char_length(adapter_instance_id) BETWEEN 8 AND 128),
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  execution_origin TEXT NOT NULL CHECK (execution_origin IN ('linked', 'resident')),
  provider TEXT NOT NULL CHECK (char_length(provider) BETWEEN 2 AND 64),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 16 AND 128),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (connection_id, adapter_instance_id, sequence),
  UNIQUE (connection_id, idempotency_key),
  FOREIGN KEY (connection_id, workspace_id)
    REFERENCES agent_connections(id, workspace_id) ON DELETE CASCADE,
  CHECK (lease_expires_at > received_at)
);

CREATE INDEX IF NOT EXISTS idx_agent_presence_workspace_recent
  ON agent_presence_leases(workspace_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_presence_connection_recent
  ON agent_presence_leases(connection_id, received_at DESC);

ALTER TABLE agent_presence_leases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on agent_presence_leases" ON agent_presence_leases;
CREATE POLICY "Service role full access on agent_presence_leases" ON agent_presence_leases
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Users read own presence leases" ON agent_presence_leases;
CREATE POLICY "Users read own presence leases" ON agent_presence_leases
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT id FROM projects WHERE owner_id = (SELECT auth.uid())));

REVOKE ALL ON public.agent_presence_leases FROM anon;
REVOKE ALL ON public.agent_presence_leases FROM authenticated;
GRANT SELECT ON public.agent_presence_leases TO authenticated;
