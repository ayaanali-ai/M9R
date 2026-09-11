-- Closes a real gap found in a security audit: audit_log_heads/entries,
-- workspace_bans/mutes/message_reports, persona_packs/persona_pack_assignments,
-- and channel_workflows/channel_workflow_runs were all created without the
-- `revoke all ... from public, anon, authenticated` step that
-- mission_events/missions/mission_command_outcomes (20260725120000) and
-- chat_evidence_requests/submissions (20260809230830) already got. Every
-- one of these tables is read/written exclusively through src/lib/supabase.ts's
-- service-role client (moderation-service.ts, persona-pack-store.ts,
-- mission-workflow-store.ts, audit-log.ts) -- no browser/anon/authenticated
-- caller ever needs direct table access -- so this is a pure lockdown with
-- no application-code change required.
--
-- audit_log_entries specifically backs append_audit_log_entry's tamper-evident
-- hash chain (20260804020000): that migration's own comment says "app code
-- never inserts directly, so the hash chain can't be bypassed by a buggy
-- caller" -- but without this revoke, Supabase's default PostgREST exposure
-- meant any anon/authenticated caller could insert/update/delete rows
-- directly, bypassing append_audit_log_entry (and the chain) entirely.

revoke all on public.audit_log_heads from public, anon, authenticated;
revoke all on public.audit_log_entries from public, anon, authenticated;
grant select, insert, update on public.audit_log_heads to service_role;
grant select, insert on public.audit_log_entries to service_role;

revoke all on function public.append_audit_log_entry(uuid, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.append_audit_log_entry(uuid, text, text, text, jsonb)
  to service_role;

revoke all on function public.verify_audit_log_chain(uuid)
  from public, anon, authenticated;
grant execute on function public.verify_audit_log_chain(uuid)
  to service_role;

revoke all on public.workspace_bans from public, anon, authenticated;
revoke all on public.workspace_mutes from public, anon, authenticated;
revoke all on public.workspace_message_reports from public, anon, authenticated;
grant select, insert, update, delete on public.workspace_bans to service_role;
grant select, insert, update, delete on public.workspace_mutes to service_role;
grant select, insert, update, delete on public.workspace_message_reports to service_role;

revoke all on public.persona_packs from public, anon, authenticated;
revoke all on public.persona_pack_assignments from public, anon, authenticated;
grant select, insert, update, delete on public.persona_packs to service_role;
grant select, insert, update, delete on public.persona_pack_assignments to service_role;

revoke all on public.channel_workflows from public, anon, authenticated;
revoke all on public.channel_workflow_runs from public, anon, authenticated;
grant select, insert, update, delete on public.channel_workflows to service_role;
grant select, insert, update, delete on public.channel_workflow_runs to service_role;
