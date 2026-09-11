-- Item 27a: the "Reconnect agents" button had no way to tell a human whether
-- anything actually happened. A local bridge could pick up the request,
-- retry zero or more failed residents, and the dashboard would never know --
-- the button just reverted to idle after 4 seconds regardless of outcome.
-- These columns let the local runtime report back what it actually did.
alter table public.bridge_reconnect_requests
  add column if not exists handled_at timestamptz,
  add column if not exists handled_summary text;
