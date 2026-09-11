-- RunLeak Supabase Schema
-- Run this in the Supabase SQL Editor

-- Waitlist leads table
CREATE TABLE IF NOT EXISTS waitlist_leads (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email TEXT NOT NULL,
  source TEXT DEFAULT 'website',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_waitlist_leads_email ON waitlist_leads(email);

-- Trace submissions table
CREATE TABLE IF NOT EXISTS trace_submissions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  company TEXT,
  agent_type TEXT,
  spend_range TEXT,
  trace_text TEXT NOT NULL,
  status TEXT DEFAULT 'new' CHECK (status IN ('new', 'reviewing', 'report_sent', 'rejected')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trace_submissions_status ON trace_submissions(status);
CREATE INDEX IF NOT EXISTS idx_trace_submissions_email ON trace_submissions(email);

-- Demo reports table (optional tracking)
CREATE TABLE IF NOT EXISTS demo_reports (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email TEXT,
  report_json JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Users / profiles table
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  company TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

-- Runs table
CREATE TABLE IF NOT EXISTS runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  name TEXT,
  source_type TEXT,
  upload_status TEXT DEFAULT 'pending' CHECK (upload_status IN ('pending', 'processing', 'analyzed', 'failed')),
  detected_model_calls INTEGER DEFAULT 0,
  detected_tool_calls INTEGER DEFAULT 0,
  detected_retries INTEGER DEFAULT 0,
  total_input_tokens BIGINT DEFAULT 0,
  total_output_tokens BIGINT DEFAULT 0,
  estimated_cost_usd NUMERIC(10, 6),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_runs_user_id ON runs(user_id);
CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at);

-- Run steps table
CREATE TABLE IF NOT EXISTS run_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID REFERENCES runs(id) ON DELETE CASCADE,
  step_number INTEGER NOT NULL,
  step_type TEXT,
  model TEXT,
  tool_name TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cost_estimate NUMERIC(10, 6),
  latency_ms INTEGER,
  is_retry BOOLEAN DEFAULT FALSE,
  is_cache_miss BOOLEAN DEFAULT FALSE,
  raw_data TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_run_steps_run_id ON run_steps(run_id);

-- Leak findings table
CREATE TABLE IF NOT EXISTS leak_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID REFERENCES runs(id) ON DELETE CASCADE,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  leak_type TEXT NOT NULL,
  severity TEXT CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  confidence TEXT CHECK (confidence IN ('high', 'medium', 'low')),
  wasted_cost_usd NUMERIC(10, 6),
  affected_steps JSONB,
  evidence_json JSONB,
  fix_text TEXT,
  estimated_savings_low NUMERIC(10, 6),
  estimated_savings_high NUMERIC(10, 6),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_leak_findings_run_id ON leak_findings(run_id);
CREATE INDEX IF NOT EXISTS idx_leak_findings_user_id ON leak_findings(user_id);

-- Reports table
CREATE TABLE IF NOT EXISTS reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID REFERENCES runs(id) ON DELETE CASCADE,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  leak_score INTEGER,
  total_cost_usd NUMERIC(10, 6),
  estimated_waste_usd NUMERIC(10, 6),
  summary_text TEXT,
  report_data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reports_run_id ON reports(run_id);
CREATE INDEX IF NOT EXISTS idx_reports_user_id ON reports(user_id);

-- Audit log table
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID REFERENCES profiles(id),
  action TEXT NOT NULL,
  details JSONB,
  ip_address TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);

-- User settings table
CREATE TABLE IF NOT EXISTS user_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
  retention_days INTEGER DEFAULT 90,
  auto_redact BOOLEAN DEFAULT TRUE,
  walkthrough_completed BOOLEAN NOT NULL DEFAULT FALSE,
  walkthrough_completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS walkthrough_completed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS walkthrough_completed_at TIMESTAMPTZ;

-- Public workspace handles are optional for legacy accounts, unique ignoring case.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS username TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_unique
  ON public.users (lower(username)) WHERE username IS NOT NULL;

-- Enable Row Level Security
ALTER TABLE waitlist_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE trace_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE leak_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;

-- Policies: anon can insert into public-facing tables
DROP POLICY IF EXISTS "Allow anon insert on waitlist_leads" ON public.waitlist_leads;
CREATE POLICY "Allow anon insert on waitlist_leads" ON waitlist_leads
  FOR INSERT TO anon WITH CHECK (true);

DROP POLICY IF EXISTS "Allow anon insert on trace_submissions" ON public.trace_submissions;
CREATE POLICY "Allow anon insert on trace_submissions" ON trace_submissions
  FOR INSERT TO anon WITH CHECK (true);

DROP POLICY IF EXISTS "Allow anon insert on demo_reports" ON public.demo_reports;
CREATE POLICY "Allow anon insert on demo_reports" ON demo_reports
  FOR INSERT TO anon WITH CHECK (true);

-- Policies: authenticated users can select/update trace_submissions (admin)
DROP POLICY IF EXISTS "Allow authenticated select on trace_submissions" ON public.trace_submissions;
CREATE POLICY "Allow authenticated select on trace_submissions" ON trace_submissions
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Allow authenticated update on trace_submissions" ON public.trace_submissions;
CREATE POLICY "Allow authenticated update on trace_submissions" ON trace_submissions
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- Policies: owner-only access for user-owned tables
DROP POLICY IF EXISTS "Users can read own profile" ON public.profiles;
CREATE POLICY "Users can read own profile" ON profiles
  FOR SELECT TO authenticated USING (id = auth.uid());

DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
CREATE POLICY "Users can update own profile" ON profiles
  FOR UPDATE TO authenticated USING (id = auth.uid()) WITH CHECK (id = auth.uid());

DROP POLICY IF EXISTS "Users can read own runs" ON public.runs;
CREATE POLICY "Users can read own runs" ON runs
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can insert own runs" ON public.runs;
CREATE POLICY "Users can insert own runs" ON runs
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can update own runs" ON public.runs;
CREATE POLICY "Users can update own runs" ON runs
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can delete own runs" ON public.runs;
CREATE POLICY "Users can delete own runs" ON runs
  FOR DELETE TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can read own run steps" ON public.run_steps;
CREATE POLICY "Users can read own run steps" ON run_steps
  FOR SELECT TO authenticated USING (run_id IN (SELECT id FROM runs WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "Users can insert own run steps" ON public.run_steps;
CREATE POLICY "Users can insert own run steps" ON run_steps
  FOR INSERT TO authenticated WITH CHECK (run_id IN (SELECT id FROM runs WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "Users can read own findings" ON public.leak_findings;
CREATE POLICY "Users can read own findings" ON leak_findings
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can read own reports" ON public.reports;
CREATE POLICY "Users can read own reports" ON reports
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can read own settings" ON public.user_settings;
CREATE POLICY "Users can read own settings" ON user_settings
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can insert own settings" ON public.user_settings;
CREATE POLICY "Users can insert own settings" ON user_settings
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can update own settings" ON public.user_settings;
CREATE POLICY "Users can update own settings" ON user_settings
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- Service role policies (server-side operations)
DROP POLICY IF EXISTS "Service role full access on runs" ON public.runs;
CREATE POLICY "Service role full access on runs" ON runs
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on run_steps" ON public.run_steps;
CREATE POLICY "Service role full access on run_steps" ON run_steps
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on leak_findings" ON public.leak_findings;
CREATE POLICY "Service role full access on leak_findings" ON leak_findings
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on reports" ON public.reports;
CREATE POLICY "Service role full access on reports" ON reports
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ===========================================================================
-- Referral program — "refer 3, get a free Blackbox Report"
-- A referral only QUALIFIES when the referred person submits the audit-request
-- form via the referrer's link. All writes happen server-side via the service
-- role, so no anon policies are exposed.
-- ===========================================================================

-- A person who shares a referral link. One row per email; `code` is their link.
CREATE TABLE IF NOT EXISTS referrers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  code TEXT UNIQUE NOT NULL,
  -- locked: under goal · earned: hit goal, reward owed · fulfilled: delivered
  reward_status TEXT NOT NULL DEFAULT 'locked'
    CHECK (reward_status IN ('locked', 'earned', 'fulfilled')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_referrers_code ON referrers(code);

-- One qualified referral = one distinct referred email that submitted an audit
-- request via this referrer's link. The UNIQUE constraint prevents a single
-- referred email from being counted twice for the same referrer.
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

DROP POLICY IF EXISTS "Service role full access on referrers" ON referrers;
CREATE POLICY "Service role full access on referrers" ON referrers
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on referrals" ON referrals;
CREATE POLICY "Service role full access on referrals" ON referrals
  FOR ALL TO service_role USING (true) WITH CHECK (true);
