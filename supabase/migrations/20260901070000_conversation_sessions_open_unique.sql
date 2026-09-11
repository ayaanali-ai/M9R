-- Enforces "exactly one open session per (workspace, conversation,
-- connection)" at the database level. Two overlapping sync passes (e.g.
-- two poll ticks racing) can both read "no open session yet" and both
-- insert one -- confirmed live, from ordinary polling cadence, no exotic
-- trigger required. Application-level read-then-write cannot close this
-- race; only a real constraint can.
create unique index if not exists conversation_sessions_open_unique
  on conversation_sessions (workspace_id, conversation_id, connection_id)
  where status <> 'archived';
