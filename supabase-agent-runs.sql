-- OathLock — Agent Runs (Agent Dashboard + Two-Run Rule Proof loop).
-- Run after supabase-agent-join.sql.
--
-- Adds run-level telemetry so a human can SEE their connected agents working in
-- the dashboard, and so the two-run rule proof loop is visible:
--
--   Run A → evidence submitted → rule recommended/promoted →
--   Run B loads rule → Rule Health evaluates whether the rule held.
--
-- Provenance/telemetry ONLY. These tables never store source code, tokens,
-- local.json, claim URLs, setup codes, or any secret. Run rows are owner-scoped
-- through the agent_connections → projects(owner_id) chain via RLS.

-- ---------------------------------------------------------------------------
-- agent_runs — one row per agent run (a single task the agent performs).
--   Written by the token-authenticated CLI via the service role (scoped in app
--   code to the token's own connection/workspace). Read by the signed-in human
--   for connections in workspaces they own.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Ownership chain: connection → workspace(project) → owner. We denormalize
  -- workspace_id for fast owner-scoped reads; connection_id ties to the agent.
  connection_id UUID NOT NULL REFERENCES agent_connections(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  agent_kind TEXT,
  repo_hint TEXT,
  task_title TEXT,

  status TEXT NOT NULL DEFAULT 'started'
    CHECK (status IN ('started', 'working', 'waiting_for_human', 'submitted', 'completed', 'failed')),
  current_phase TEXT,

  rules_loaded_count INTEGER NOT NULL DEFAULT 0,

  -- Link to the submitted session metadata row, once a session is submitted.
  latest_session_id UUID REFERENCES agent_sessions(id) ON DELETE SET NULL,

  -- Conservative Rule Health outcome for this run, evaluated only when the run
  -- loaded active rules and submitted evidence. Summary counts + per-rule status
  -- ONLY (no session content). Shape: { evaluated, summary, items:[{status,...}] }.
  rule_health JSONB,

  -- Conservative behavioral snapshot for the two-run product-trial comparison.
  -- COUNTS ONLY (retries, repeated edits, failed commands, tool calls, changed
  -- files, verification present, total tokens, cost) — never session content.
  behavior JSONB,

  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  error_message TEXT,

  UNIQUE (id, workspace_id),
  FOREIGN KEY (connection_id, workspace_id)
    REFERENCES agent_connections(id, workspace_id) ON DELETE CASCADE
);

COMMENT ON TABLE agent_runs IS
  'Per-run agent telemetry for the dashboard command center. Provenance only — never source/secrets.';

-- Upgrade path: CREATE TABLE IF NOT EXISTS above is a no-op against an
-- agent_runs table that already existed before this composite unique
-- constraint was added — it's what every later V2 table (dispatches,
-- responses, findings, evidence_records) needs to bind a run to its
-- workspace with a real foreign key, not just app-code scoping. Safe to add
-- unconditionally: `id` is already globally unique via the primary key, so
-- (id, workspace_id) can never collide no matter how much existing data
-- there is. (A UNIQUE (connection_id, workspace_id) constraint was here
-- before and has been removed — it was wrong: one connection legitimately
-- has many runs over time, so it could never hold on real data.)
ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_id_workspace_id_key;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_id_workspace_id_key UNIQUE (id, workspace_id);

CREATE INDEX IF NOT EXISTS idx_agent_runs_workspace ON agent_runs(workspace_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_connection ON agent_runs(connection_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_last_seen ON agent_runs(workspace_id, last_seen_at DESC);

-- ---------------------------------------------------------------------------
-- agent_run_events — status/provenance timeline for a run. NEVER content.
--   message is a short, redacted status string (e.g. "phase: editing files").
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_run_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,

  event_type TEXT NOT NULL,
  message TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE agent_run_events IS
  'Status/provenance telemetry for an agent run. Never stores source code, tokens, or secrets.';

CREATE INDEX IF NOT EXISTS idx_agent_run_events_run ON agent_run_events(run_id, created_at);

-- ---------------------------------------------------------------------------
-- Row Level Security — mirrors the agent-join model.
--   * Service role: full access (token-authenticated CLI writes, scoped in app
--     code by the token's own connection/workspace).
--   * authenticated users: read runs/events only for workspaces they own.
-- ---------------------------------------------------------------------------
ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_run_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on agent_runs" ON agent_runs;
CREATE POLICY "Service role full access on agent_runs" ON agent_runs
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on agent_run_events" ON agent_run_events;
CREATE POLICY "Service role full access on agent_run_events" ON agent_run_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- A signed-in human may read runs for workspaces they own.
DROP POLICY IF EXISTS "Users read own agent runs" ON agent_runs;
CREATE POLICY "Users read own agent runs" ON agent_runs
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT id FROM projects WHERE owner_id = auth.uid()));

-- ...and the events that belong to those runs.
DROP POLICY IF EXISTS "Users read own agent run events" ON agent_run_events;
CREATE POLICY "Users read own agent run events" ON agent_run_events
  FOR SELECT TO authenticated
  USING (
    run_id IN (
      SELECT id FROM agent_runs
      WHERE workspace_id IN (SELECT id FROM projects WHERE owner_id = auth.uid())
    )
  );

GRANT SELECT ON public.agent_runs TO authenticated;
GRANT SELECT ON public.agent_run_events TO authenticated;
