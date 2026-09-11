-- agent_kind used to be a fixed enum-style CHECK constraint
-- (claude-code/codex/cursor/other) that silently didn't even include
-- grok-build, despite the app already supporting it -- any real provider
-- name not in that exact list failed a claim/connection with a bare
-- "Could not create a claim" 500, no matter what the application layer
-- validated. Replaced with a format check matching the same slug pattern
-- (agent-join.ts's AGENT_KIND_SLUG_PATTERN, oathlock-cli-core.ts's
-- AGENT_KIND_SLUG_PATTERN) the app already enforces: any well-formed
-- provider name is a valid connection identity now, not just the ones with
-- real bootstrap/ACP integration today.
alter table agent_claims drop constraint agent_claims_agent_kind_check;
alter table agent_claims add constraint agent_claims_agent_kind_check
  check (agent_kind ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$');

alter table agent_connections drop constraint agent_connections_agent_kind_check;
alter table agent_connections add constraint agent_connections_agent_kind_check
  check (agent_kind ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$');
