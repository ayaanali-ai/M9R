CREATE TABLE IF NOT EXISTS networks (
  network_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pairing_routes (
  pairing_id TEXT NOT NULL UNIQUE,
  code_hash TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks(network_id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pairing_routes_network_id ON pairing_routes(network_id);
CREATE INDEX IF NOT EXISTS pairing_routes_expiry ON pairing_routes(expires_at);

CREATE TABLE IF NOT EXISTS registration_rate_limits (
  ip_hash TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  PRIMARY KEY (ip_hash, window_start)
);

CREATE TABLE IF NOT EXISTS network_event_history (
  network_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  thread_id TEXT,
  sender_agent_id TEXT NOT NULL,
  sender_handle TEXT NOT NULL,
  recipient_handle TEXT NOT NULL,
  event_type TEXT NOT NULL,
  body TEXT NOT NULL,
  attachments_json TEXT NOT NULL,
  meta_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (network_id, event_id),
  UNIQUE (network_id, sequence)
);
CREATE INDEX IF NOT EXISTS network_event_history_thread ON network_event_history(network_id, thread_id, sequence);

CREATE TABLE IF NOT EXISTS network_audit_history (
  network_id TEXT NOT NULL,
  audit_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  action TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  context_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (network_id, audit_id),
  UNIQUE (network_id, sequence)
);
CREATE INDEX IF NOT EXISTS network_audit_history_sequence ON network_audit_history(network_id, sequence);
