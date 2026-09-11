-- The legacy leak-scanner intake flow is fully retired: no route anywhere
-- in the app inserts into this table anymore (the intake form was already
-- gone before this migration), and the admin panel that reviewed it
-- (/admin/submissions, /api/admin/submissions) is removed in the same
-- change. Explicit human instruction to remove this table, including its
-- one real, unreviewed lead row -- not a code-cleanup default.

drop table if exists public.trace_submissions;
