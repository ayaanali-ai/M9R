# M9R cron scheduler

This is a small, separate Cloudflare Worker for the four application sweeps.
It does not change the generated `m9r-web` OpenNext Worker and does not share
the `network-core` cron.

The scheduler has no public control endpoint. Its `scheduled()` handler maps
Cloudflare's fixed cron expression to one fixed `GET` route on `TARGET_BASE_URL`
and sends the shared `CRON_SECRET` as a bearer token. Missing secrets, invalid
targets, unmapped cron expressions, network failures, and non-2xx responses fail
the invocation without logging the secret or response body.

The Wrangler config uses `SCHEDULER_ENABLED=true` in the Cloudflare-only
deployment. Set it to `false` as an emergency pause if a sweep must be stopped
without removing the triggers.

## Deploy checklist

Set the same secret on both Workers, then deploy the scheduler:

```text
npx wrangler secret put CRON_SECRET --config services/cron-scheduler/wrangler.jsonc
npx wrangler secret put CRON_SECRET --config wrangler.jsonc
npx wrangler deploy --config services/cron-scheduler/wrangler.jsonc
```

The scheduler is then active on Cloudflare. Keep the emergency gate in source so
pausing the trigger does not require a second scheduler design.

Before deployment, use Wrangler's dry run and identity/config checks:

```text
npx wrangler whoami
npx wrangler deploy --dry-run --config services/cron-scheduler/wrangler.jsonc
npx wrangler secret list --config services/cron-scheduler/wrangler.jsonc
npx wrangler deployments list --config services/cron-scheduler/wrangler.jsonc
```

Review the Cloudflare Workers Security/Logs surfaces and run the repository's
security checks before production rollout. The scheduler cannot prove that a
secret was configured remotely; the deployment checklist must be completed in
the authenticated Cloudflare account.
