-- Found during a whole-codebase security sweep: audit_logs (distinct from
-- audit_log_entries, the real tamper-evident chain fixed in
-- 20260814030000) is a legacy, empty, zero-consumer table -- no app code
-- anywhere reads or writes it -- that still had RLS enabled with zero
-- policies AND full anon/authenticated CRUD grants live in production.
-- Same exploitable class as the original 9-table finding: RLS-enabled-
-- no-policy only protects by accident (default deny) as long as nobody
-- ever adds a permissive policy to this specific table; the underlying
-- grants were still wide open the whole time.

revoke all on public.audit_logs from public, anon, authenticated;
