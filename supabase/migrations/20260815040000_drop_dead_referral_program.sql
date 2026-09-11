-- The referral program is fully dead: the code-issuance endpoint
-- (/api/referral) had zero UI callers anywhere in the app, its
-- "qualification" step depended on a trace-submission flow that no longer
-- exists, and both tables have 0 rows. Removing src/lib/referral.ts,
-- /api/referral, /api/admin/referrals, and the admin page's Referrals tab
-- in the same change that drops these tables.
--
-- trace_submissions itself is untouched -- it still holds one real,
-- unreviewed lead from the earlier product and stays for the founder to
-- action separately.

drop table if exists public.referrals;
drop table if exists public.referrers;
