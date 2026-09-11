-- Live-caught (Aug 24): a Stop click filed while nothing was actually
-- running (channel paused) sat 'pending' for 15 minutes, then the Bridge's
-- poll reached forward in time and cancelled a completely unrelated later
-- turn the human never asked to stop. bridge_cancel_turn_requests is scoped
-- by conversation+connection, not a session id, so without an expiry a
-- stale request has no way to know it's stale -- a cancel only makes sense
-- against a turn that starts shortly after the click.
alter table bridge_cancel_turn_requests
  add column if not exists expires_at timestamptz not null default (now() + interval '2 minutes');
