-- OathLock referral program — standalone, idempotent migration.
-- Safe to run on a database that ALREADY has the base schema applied.
-- Run this in the Supabase SQL editor. Re-running it will not error.
--
-- Offer: refer 3 -> one free Blackbox Report. A referral QUALIFIES only when
-- the referred person submits the audit-request form via the referrer's link.

CREATE TABLE IF NOT EXISTS referrers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  code TEXT UNIQUE NOT NULL,
  reward_status TEXT NOT NULL DEFAULT 'locked'
    CHECK (reward_status IN ('locked', 'earned', 'fulfilled')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_referrers_code ON referrers(code);

CREATE TABLE IF NOT EXISTS referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id UUID NOT NULL REFERENCES referrers(id) ON DELETE CASCADE,
  referred_email TEXT NOT NULL,
  submission_id BIGINT REFERENCES trace_submissions(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'qualified'
    CHECK (status IN ('pending', 'qualified')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (referrer_id, referred_email)
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer_id ON referrals(referrer_id);

ALTER TABLE referrers ENABLE ROW LEVEL SECURITY;
ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;

-- Idempotent policies: drop-then-create so re-running never errors.
DROP POLICY IF EXISTS "Service role full access on referrers" ON referrers;
CREATE POLICY "Service role full access on referrers" ON referrers
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on referrals" ON referrals;
CREATE POLICY "Service role full access on referrals" ON referrals
  FOR ALL TO service_role USING (true) WITH CHECK (true);
