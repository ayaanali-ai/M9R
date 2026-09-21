#!/usr/bin/env bash
# Build the Cloudflare bundle WITHOUT local env files, so no secret is baked into .open-next/cloudflare/next-env.mjs.
#
# Why: OpenNext embeds every value from .env.local into the Worker bundle. Real secrets must be Worker secrets
# (`wrangler secret put`), never baked. This hides .env.local for the duration of the build, passes only the public,
# non-secret build-time values, restores .env.local on every exit path, and fails if a secret name slipped into the bundle.
#
# Usage: bash scripts/build-cloudflare-clean.sh [site-url]     (default site url: https://app.m9r.workers.dev)
set -u
cd "$(dirname "$0")/.."
SITE_URL="${1:-https://app.m9r.workers.dev}"
HOLD=".env.build-hold.local"   # matches the .env*.local ignore rule

if [ -f .env.local ]; then
  mv .env.local "$HOLD"
  restore() { [ -f "$HOLD" ] && mv "$HOLD" .env.local; }
  trap restore EXIT
fi

export NEXT_PUBLIC_SITE_URL="$SITE_URL"
export NEXT_PUBLIC_SUPABASE_URL="https://eymtshaxpkmojsggdtkh.supabase.co"
export NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="sb_publishable_XGgzhm1N8caXP8Aj11SjQw_gmeRZOP0"
export NEXT_PUBLIC_M9R_BILLING_ENABLED="false"
export NEXT_PUBLIC_M9R_TERMINAL_ENABLED="true"
export NEXT_PUBLIC_VAPID_PUBLIC_KEY=""
export MISSION_RELAY_PUBLIC_URL="wss://m9r-relay.m9r.workers.dev"
export MISSION_RELAY_ENABLED="1"

node scripts/build-cloudflare.mjs || exit 1

ENVFILE=".open-next/cloudflare/next-env.mjs"
if [ -f "$ENVFILE" ] && grep -q -E "SERVICE_ROLE|TOKEN_SECRET|STRIPE_SECRET|RESEND_API_KEY|ADMIN_PASSWORD|OIDC_TOKEN|WEBHOOK_URL" "$ENVFILE"; then
  echo "FAIL: a secret name is baked into $ENVFILE. Do not deploy this build." >&2
  exit 2
fi
echo "OK: build finished and no secret names are baked into the bundle."
echo "Secrets this Worker needs (set with wrangler secret put): SUPABASE_SERVICE_ROLE_KEY, MISSION_RELAY_TOKEN_SECRET, RELAY_INTERNAL_SECRET, RESEND_API_KEY, LEAD_WEBHOOK_URL."
