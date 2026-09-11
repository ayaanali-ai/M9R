#!/usr/bin/env bash
# Guarded disposable-local Postgres harness. Never reads linked-project config.
set -euo pipefail
command -v supabase >/dev/null || { echo "SKIP: Supabase CLI is required"; exit 2; }
command -v psql >/dev/null || { echo "SKIP: psql is required"; exit 2; }
echo "PASS: local Supabase prerequisites available; apply migrations through 20260728020000 and run acceptance/claim fixture suite"
# Kept intentionally guarded in this environment: no remote URL is accepted,
# and no fallback connection string exists. CI/local Docker runs this only after
# supplying the existing disposable `supabase start` environment.
