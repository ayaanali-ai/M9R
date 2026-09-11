-- The model-override control already exists (agent_connections.model) but
-- the dashboard has no real dropdown of a provider's actual available
-- models -- confirmed in code tonight: ACP's own newSession response
-- already returns the real, live list (session config option, category
-- "model") and the bridge already parses it to validate an override, then
-- discards it. Give the bridge somewhere real to persist what it just
-- discovered, so the dashboard can render a real dropdown instead of a
-- hardcoded, partially-empty catalog or free text.
alter table public.agent_connections
  add column if not exists available_models jsonb null;

comment on column public.agent_connections.available_models is
  'Best-effort snapshot of this connection''s real ACP model options ([{id,label}]), captured from the most recent session''s newSession response. Null until at least one session has started.';
