-- The original color migration revoked EXECUTE from PUBLIC but did not revoke
-- the inherited anon grant on the SECURITY DEFINER RPC.  Keep allocation
-- available to signed-in clients and service maintenance only.
revoke all on function public.allocate_workspace_member_color(uuid, uuid) from public, anon;
grant execute on function public.allocate_workspace_member_color(uuid, uuid) to authenticated, service_role;
