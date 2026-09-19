-- The provider's own session id for the most recent session M9R started for this connection,
-- so a person can resume it natively (`claude --resume`, `codex resume`, `opencode --session`).
alter table public.agent_connections
  add column if not exists last_provider_session_ref text
    check (last_provider_session_ref is null or char_length(last_provider_session_ref) <= 256),
  add column if not exists last_provider_session_at timestamptz;
