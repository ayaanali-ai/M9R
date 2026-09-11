-- OathLock V2 Gate 2: ordered, replay-safe Work Signals and transactional outbox.
CREATE TABLE IF NOT EXISTS work_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  workspace_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL,
  run_id UUID REFERENCES agent_runs(id) ON DELETE CASCADE,
  protocol_version TEXT NOT NULL CHECK (protocol_version = 'oathlock.work-signal.v1'),
  adapter_instance_id TEXT NOT NULL,
  client_sequence BIGINT NOT NULL CHECK (client_sequence > 0),
  idempotency_key TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('RUN_STARTED','SCOPE_ANNOUNCED','WORKING','PHASE_CHANGED','BLOCKED','HUMAN_DECISION_REQUIRED','EVIDENCE_READY','RUN_COMPLETED','HELP_REQUESTED','CHECK_REQUESTED','CHECK_RESULT_RETURNED')),
  source TEXT NOT NULL CHECK (source IN ('observed','reported','derived')),
  summary TEXT NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 200),
  scope TEXT[] NOT NULL DEFAULT '{}',
  repo TEXT NOT NULL CHECK (char_length(repo) BETWEEN 1 AND 300),
  correlation_id TEXT CHECK (correlation_id IS NULL OR char_length(correlation_id) BETWEEN 1 AND 128),
  parent_event_id TEXT CHECK (parent_event_id IS NULL OR char_length(parent_event_id) BETWEEN 1 AND 128),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (connection_id, adapter_instance_id, client_sequence),
  UNIQUE (connection_id, idempotency_key),
  FOREIGN KEY (connection_id, workspace_id) REFERENCES agent_connections(id, workspace_id) ON DELETE CASCADE
);
-- Upgrade path: CREATE TABLE IF NOT EXISTS above is a no-op against a
-- work_signals table that already existed before repo/correlation/parent
-- columns were introduced, so add them explicitly and idempotently here.
ALTER TABLE work_signals ADD COLUMN IF NOT EXISTS repo TEXT;
UPDATE work_signals SET repo = 'unknown' WHERE repo IS NULL;
ALTER TABLE work_signals ALTER COLUMN repo SET NOT NULL;
ALTER TABLE work_signals DROP CONSTRAINT IF EXISTS work_signals_repo_check;
ALTER TABLE work_signals ADD CONSTRAINT work_signals_repo_check CHECK (char_length(repo) BETWEEN 1 AND 300);
ALTER TABLE work_signals ADD COLUMN IF NOT EXISTS correlation_id TEXT;
ALTER TABLE work_signals DROP CONSTRAINT IF EXISTS work_signals_correlation_id_check;
ALTER TABLE work_signals ADD CONSTRAINT work_signals_correlation_id_check CHECK (correlation_id IS NULL OR char_length(correlation_id) BETWEEN 1 AND 128);
ALTER TABLE work_signals ADD COLUMN IF NOT EXISTS parent_event_id TEXT;
ALTER TABLE work_signals DROP CONSTRAINT IF EXISTS work_signals_parent_event_id_check;
ALTER TABLE work_signals ADD CONSTRAINT work_signals_parent_event_id_check CHECK (parent_event_id IS NULL OR char_length(parent_event_id) BETWEEN 1 AND 128);

CREATE INDEX IF NOT EXISTS idx_work_signals_workspace_cursor ON work_signals(workspace_id, server_sequence);
CREATE INDEX IF NOT EXISTS idx_work_signals_run_cursor ON work_signals(run_id, server_sequence) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_work_signals_connection_recent ON work_signals(connection_id, received_at);
CREATE INDEX IF NOT EXISTS idx_work_signals_correlation ON work_signals(workspace_id, correlation_id) WHERE correlation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS work_signal_outbox (
  signal_id UUID PRIMARY KEY REFERENCES work_signals(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL,
  server_sequence BIGINT NOT NULL,
  delivery_state TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_state IN ('pending','delivered','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ
);
-- Upgrade path: backfill connection_id on an outbox table that pre-dates it.
ALTER TABLE work_signal_outbox ADD COLUMN IF NOT EXISTS connection_id UUID;
UPDATE work_signal_outbox o SET connection_id = w.connection_id
  FROM work_signals w WHERE o.signal_id = w.id AND o.connection_id IS NULL;
ALTER TABLE work_signal_outbox ALTER COLUMN connection_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_work_signal_outbox_pending ON work_signal_outbox(delivery_state, available_at) WHERE delivery_state = 'pending';
CREATE INDEX IF NOT EXISTS idx_work_signal_outbox_connection ON work_signal_outbox(connection_id, server_sequence);

-- Gate 2B: durable per-connection replay cursor. A connection's own
-- acknowledgement is the only thing that advances its cursor or marks its
-- own outbox rows delivered — one connection can never advance another's.
CREATE TABLE IF NOT EXISTS work_signal_cursors (
  connection_id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  last_acked_sequence BIGINT NOT NULL DEFAULT 0 CHECK (last_acked_sequence >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (connection_id, workspace_id) REFERENCES agent_connections(id, workspace_id) ON DELETE CASCADE
);

CREATE OR REPLACE FUNCTION public.enqueue_work_signal_outbox() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.work_signal_outbox(signal_id, workspace_id, connection_id, server_sequence)
  VALUES (NEW.id, NEW.workspace_id, NEW.connection_id, NEW.server_sequence);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.enqueue_work_signal_outbox() FROM PUBLIC;
DROP TRIGGER IF EXISTS enqueue_work_signal ON work_signals;
CREATE TRIGGER enqueue_work_signal AFTER INSERT ON work_signals FOR EACH ROW EXECUTE FUNCTION public.enqueue_work_signal_outbox();

ALTER TABLE work_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_signal_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_signal_cursors ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role work_signals" ON work_signals;
CREATE POLICY "Service role work_signals" ON work_signals FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Owners read work_signals" ON work_signals;
CREATE POLICY "Owners read work_signals" ON work_signals FOR SELECT TO authenticated USING (workspace_id IN (SELECT id FROM projects WHERE owner_id = (SELECT auth.uid())));
DROP POLICY IF EXISTS "Service role work_signal_outbox" ON work_signal_outbox;
CREATE POLICY "Service role work_signal_outbox" ON work_signal_outbox FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Service role work_signal_cursors" ON work_signal_cursors;
CREATE POLICY "Service role work_signal_cursors" ON work_signal_cursors FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Owners read work_signal_cursors" ON work_signal_cursors;
CREATE POLICY "Owners read work_signal_cursors" ON work_signal_cursors FOR SELECT TO authenticated USING (workspace_id IN (SELECT id FROM projects WHERE owner_id = (SELECT auth.uid())));
REVOKE ALL ON public.work_signals FROM anon;
REVOKE ALL ON public.work_signals FROM authenticated;
GRANT SELECT ON public.work_signals TO authenticated;
REVOKE ALL ON public.work_signal_outbox FROM anon, authenticated;
REVOKE ALL ON public.work_signal_cursors FROM anon;
REVOKE ALL ON public.work_signal_cursors FROM authenticated;
GRANT SELECT ON public.work_signal_cursors TO authenticated;
