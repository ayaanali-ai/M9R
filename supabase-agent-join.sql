-- OathLock — Agent Join v0.
-- Run after supabase-auth-foundation.sql and supabase-workspace-rules.sql.
--
-- Adds the agent-native layer: a human sends their coding agent to OathLock, the
-- agent requests a one-time claim, the human approves it (binding the connection
-- to a workspace they own), and the agent receives a scoped, hashed token.
--
-- Core principle, enforced here in the schema:
--   * No human approval, no persistent agent connection. A connection (and its
--     token) only exists AFTER a human approves a claim.
--   * The durable token store keeps ONLY a hash — never the raw token.
--
-- All four tables are workspace/owner-scoped via RLS. Token-authenticated agent
-- routes use the service role (RLS-bypassing) and authorize by token hash in app
-- code; the cookie-authenticated human approval path is constrained by RLS.

-- ---------------------------------------------------------------------------
-- agent_claims — a pending (or resolved) connection request from an agent.
--   Created by POST /api/agent/register. Public claim page reads a SAFE subset.
--   one_time_token is held transiently ONLY between approval and first retrieval
--   by the agent (with the correct setup_code); it is nulled on retrieval. The
--   DURABLE token lives hashed in agent_tokens — see note above.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Secret the agent uses to poll claim status / retrieve the one-time token.
  -- Stored hashed; the raw value is returned to the agent once at register time.
  setup_code_hash TEXT NOT NULL,

  agent_kind TEXT NOT NULL
    CHECK (agent_kind IN ('claude-code', 'codex', 'cursor', 'opencode', 'other')),
  repo_hint TEXT NOT NULL,
  rule_targets TEXT[] NOT NULL DEFAULT '{}',
  capabilities TEXT[] NOT NULL DEFAULT '{}',
  consent_mode TEXT NOT NULL CHECK (consent_mode = 'human_required'),

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),

  -- Set when a human approves: who approved and which workspace it binds to.
  approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  workspace_id UUID REFERENCES projects(id) ON DELETE CASCADE,

  -- The resulting connection (once approved + provisioned).
  connection_id UUID,

  -- Transient one-time token delivery (see note above). Nulled after retrieval.
  one_time_token TEXT,
  token_retrieved_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  approved_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ
);

COMMENT ON TABLE agent_claims IS
  'One-time agent→workspace connection requests, approved by a human (OathLock Agent Join v0).';

CREATE INDEX IF NOT EXISTS idx_agent_claims_status ON agent_claims(status);
CREATE INDEX IF NOT EXISTS idx_agent_claims_expires ON agent_claims(expires_at);

-- ---------------------------------------------------------------------------
-- agent_connections — a human-approved, persistent agent↔workspace link.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  claim_id UUID REFERENCES agent_claims(id) ON DELETE SET NULL,

  agent_kind TEXT NOT NULL
    CHECK (agent_kind IN ('claude-code', 'codex', 'cursor', 'opencode', 'other')),
  repo_hint TEXT NOT NULL,
  rule_targets TEXT[] NOT NULL DEFAULT '{}',

  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),

  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,

  UNIQUE (id, workspace_id)
);

COMMENT ON TABLE agent_connections IS
  'Human-approved persistent agent↔workspace connections (OathLock Agent Join v0).';

CREATE INDEX IF NOT EXISTS idx_agent_connections_workspace ON agent_connections(workspace_id);

-- ---------------------------------------------------------------------------
-- agent_tokens — scoped credentials for a connection. HASH ONLY, never raw.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL REFERENCES agent_connections(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- SHA-256 of the raw token. The raw token is never stored.
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT[] NOT NULL DEFAULT '{}',

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

COMMENT ON TABLE agent_tokens IS
  'Scoped agent tokens (hash only) bound to an approved connection (OathLock Agent Join v0).';

CREATE INDEX IF NOT EXISTS idx_agent_tokens_hash ON agent_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_agent_tokens_connection ON agent_tokens(connection_id);

-- ---------------------------------------------------------------------------
-- agent_sessions — metadata for sessions an agent submitted for analysis.
--   We never store raw session content here; only honest, non-sensitive
--   metadata, a short generated summary, and derived compare snapshots.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL REFERENCES agent_connections(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  agent_kind TEXT,
  session_format TEXT,
  source_quality TEXT,
  human_approved_submission BOOLEAN NOT NULL DEFAULT FALSE,

  findings_count INTEGER NOT NULL DEFAULT 0,
  rules_generated INTEGER NOT NULL DEFAULT 0,
  summary TEXT,

  -- Snapshot for later compare/proof. Mirrors the run-level Rule Health and
  -- behavioral summary so comparisons can recover if the run snapshot is behind.
  rule_health JSONB,
  behavior JSONB,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE agent_sessions IS
  'Metadata for agent-submitted sessions — no raw content (OathLock Agent Join v0).';

CREATE INDEX IF NOT EXISTS idx_agent_sessions_workspace ON agent_sessions(workspace_id);

-- ---------------------------------------------------------------------------
-- Row Level Security.
--   * Service role: full access (token-authenticated agent routes authorize in
--     app code by token hash, and never trust client-supplied workspace ids).
--   * authenticated users: may read/approve claims and read their own
--     connections/tokens/sessions only for workspaces they own.
-- ---------------------------------------------------------------------------
ALTER TABLE agent_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_sessions ENABLE ROW LEVEL SECURITY;

-- Service role full access on every table.
DROP POLICY IF EXISTS "Service role full access on agent_claims" ON agent_claims;
CREATE POLICY "Service role full access on agent_claims" ON agent_claims
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on agent_connections" ON agent_connections;
CREATE POLICY "Service role full access on agent_connections" ON agent_connections
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on agent_tokens" ON agent_tokens;
CREATE POLICY "Service role full access on agent_tokens" ON agent_tokens
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on agent_sessions" ON agent_sessions;
CREATE POLICY "Service role full access on agent_sessions" ON agent_sessions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- A signed-in human may read connections/tokens/sessions for workspaces they own.
DROP POLICY IF EXISTS "Users read own agent connections" ON agent_connections;
CREATE POLICY "Users read own agent connections" ON agent_connections
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT id FROM projects WHERE owner_id = auth.uid()));

DROP POLICY IF EXISTS "Users read own agent tokens" ON agent_tokens;
CREATE POLICY "Users read own agent tokens" ON agent_tokens
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT id FROM projects WHERE owner_id = auth.uid()));

DROP POLICY IF EXISTS "Users read own agent sessions" ON agent_sessions;
CREATE POLICY "Users read own agent sessions" ON agent_sessions
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT id FROM projects WHERE owner_id = auth.uid()));

GRANT SELECT ON public.agent_connections TO authenticated;
GRANT SELECT ON public.agent_tokens TO authenticated;
GRANT SELECT ON public.agent_sessions TO authenticated;

-- ---------------------------------------------------------------------------
-- Atomic claim lifecycle.
-- Approval locks the pending claim while it provisions the connection/token;
-- token polling locks the approved claim while it consumes the transient raw
-- token. This prevents duplicate provisioning and double token delivery.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS agent_connections_claim_id_unique
  ON agent_connections (claim_id)
  WHERE claim_id IS NOT NULL;

CREATE OR REPLACE FUNCTION approve_agent_claim_atomic(
  p_claim_id UUID,
  p_user_id UUID,
  p_workspace_id UUID,
  p_token_hash TEXT,
  p_one_time_token TEXT,
  p_scopes TEXT[],
  p_approved_at TIMESTAMPTZ
)
RETURNS TABLE (
  accepted BOOLEAN,
  reason TEXT,
  claim_status TEXT,
  approved_workspace_id UUID,
  approved_connection_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  locked_claim public.agent_claims%ROWTYPE;
  new_connection_id UUID;
BEGIN
  SELECT * INTO locked_claim
  FROM public.agent_claims
  WHERE id = p_claim_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'not_found'::TEXT, NULL::TEXT, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;
  IF locked_claim.status <> 'pending' THEN
    RETURN QUERY SELECT false, 'already_resolved'::TEXT, locked_claim.status, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;
  IF locked_claim.expires_at <= p_approved_at THEN
    UPDATE public.agent_claims SET status = 'expired' WHERE id = locked_claim.id;
    RETURN QUERY SELECT false, 'expired'::TEXT, 'expired'::TEXT, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;
  IF p_token_hash IS NULL OR p_token_hash = '' OR p_one_time_token IS NULL OR p_one_time_token = '' THEN
    RAISE EXCEPTION 'claim token material is required';
  END IF;

  INSERT INTO public.agent_connections (
    workspace_id, claim_id, agent_kind, repo_hint, rule_targets, status, created_by
  ) VALUES (
    p_workspace_id, locked_claim.id, locked_claim.agent_kind, locked_claim.repo_hint,
    COALESCE(locked_claim.rule_targets, '{}'), 'active', p_user_id
  ) RETURNING id INTO new_connection_id;

  INSERT INTO public.agent_tokens (connection_id, workspace_id, token_hash, scopes)
  VALUES (new_connection_id, p_workspace_id, p_token_hash, COALESCE(p_scopes, '{}'));

  UPDATE public.agent_claims
  SET status = 'approved',
      approved_by = p_user_id,
      workspace_id = p_workspace_id,
      connection_id = new_connection_id,
      one_time_token = p_one_time_token,
      approved_at = p_approved_at
  WHERE id = locked_claim.id;

  RETURN QUERY SELECT true, NULL::TEXT, 'approved'::TEXT, p_workspace_id, new_connection_id;
END;
$$;

CREATE OR REPLACE FUNCTION consume_agent_claim_token_atomic(
  p_claim_id UUID,
  p_setup_code_hash TEXT,
  p_retrieved_at TIMESTAMPTZ
)
RETURNS TABLE (
  accepted BOOLEAN,
  reason TEXT,
  claim_status TEXT,
  one_time_token TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  locked_claim public.agent_claims%ROWTYPE;
  token_to_deliver TEXT;
BEGIN
  SELECT * INTO locked_claim
  FROM public.agent_claims
  WHERE id = p_claim_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'not_found'::TEXT, NULL::TEXT, NULL::TEXT;
    RETURN;
  END IF;
  IF p_setup_code_hash IS NULL OR locked_claim.setup_code_hash <> p_setup_code_hash THEN
    RETURN QUERY SELECT false, 'bad_setup_code'::TEXT, NULL::TEXT, NULL::TEXT;
    RETURN;
  END IF;
  IF locked_claim.status = 'pending' AND locked_claim.expires_at <= p_retrieved_at THEN
    UPDATE public.agent_claims SET status = 'expired' WHERE id = locked_claim.id;
    RETURN QUERY SELECT true, NULL::TEXT, 'expired'::TEXT, NULL::TEXT;
    RETURN;
  END IF;
  IF locked_claim.status <> 'approved' THEN
    RETURN QUERY SELECT true, NULL::TEXT, locked_claim.status, NULL::TEXT;
    RETURN;
  END IF;
  IF locked_claim.one_time_token IS NULL OR locked_claim.token_retrieved_at IS NOT NULL THEN
    RETURN QUERY SELECT true, 'token_already_retrieved'::TEXT, 'approved'::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  token_to_deliver := locked_claim.one_time_token;
  UPDATE public.agent_claims
  SET one_time_token = NULL,
      token_retrieved_at = p_retrieved_at
  WHERE id = locked_claim.id;

  RETURN QUERY SELECT true, NULL::TEXT, 'approved'::TEXT, token_to_deliver;
END;
$$;

REVOKE ALL ON FUNCTION approve_agent_claim_atomic(UUID, UUID, UUID, TEXT, TEXT, TEXT[], TIMESTAMPTZ)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION approve_agent_claim_atomic(UUID, UUID, UUID, TEXT, TEXT, TEXT[], TIMESTAMPTZ)
  TO service_role;

REVOKE ALL ON FUNCTION consume_agent_claim_token_atomic(UUID, TEXT, TIMESTAMPTZ)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION consume_agent_claim_token_atomic(UUID, TEXT, TIMESTAMPTZ)
  TO service_role;
