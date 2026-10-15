# Cloudflare startup credits and M9R Network Phase 0

Status: Phase 0 Worker and dedicated D1 database deployed on 2026-10-02; live pairing/message/inbox acceptance passed on 2026-10-03. Cloudflare Billing was inspected on 2026-10-02 before the acceptance run; the account-level snapshot below has not been refreshed after that run.

## How the $10,000 balance is used

There is no promo code or per-service redemption step. Once the startup benefit is active, eligible usage-based charges are automatically deducted from the credit balance. The credit balance and its remaining amount are shown in the Cloudflare dashboard and monthly invoices. Credits apply only to resources in the Cloudflare account that received the startup benefit. See [Cloudflare for Startups](https://www.cloudflare.com/startups/).

Cloudflare currently lists Workers, Durable Objects, and D1 among the eligible products. The Tier 3 Workers AI allowance has a $2,500 cap; R2 has a $10,000 cap; AI Gateway and domain registrar charges are excluded. Phase 0 needs no Workers AI, AI Gateway, or R2.

## What is already in this repository

- `wrangler.jsonc` deploys the M9R web app as the `m9r-web` Worker on `m9r.dev` and `www.m9r.dev`.
- `services/network-core` contains the separate Phase 0 Worker, SQLite-backed per-network Durable Object, D1 migration, and Wrangler config. The Worker is deployed to `https://m9r-network-core.m9r.workers.dev`.
- The earlier Next/Supabase Phase 0 prototype is not the credit-backed target. Cloudflare storage and compute in the new Worker are the intended host; Supabase Auth remains the source for validating human login tokens only.
- `services/relay-do` is the existing room/realtime relay Durable Object. It is not the provider-neutral Network core and should not be repurposed as one.
- The dedicated `m9r-network-core` D1 database is created, `0001_network_core.sql` is applied, the D1 ID is saved in `services/network-core/wrangler.jsonc`, and the `PAIRING_CODE_PEPPER` Worker secret is set. The existing empty `m9r-waitlist` database was left untouched.
- Wrangler authentication is active and the Worker health route returned `200`. Wrangler confirms deployment; its account command does not report startup-credit balance. The Cloudflare Billing dashboard showed the startup credit program active.
- On 2026-10-02, the Startup Credits view showed `$10,000` remaining of `$10,000` granted and an expiration date of 2027-09-16. The page also displayed a `$9,999.92` estimate, while the Billable Usage banner showed `$10,000` remaining; treat these as dashboard figures, not a reconciled invoice amount.
- The account-level Billable Usage view for 2026-09-19 through 2026-10-03 showed `$0.08` total and `$0.16` projected, attributed to Workers CPU time above quota. Workers standard requests, Durable Objects, and D1 showed zero billable usage in that view. These figures are account-wide and were not refreshed after the acceptance run, so they do not isolate the Network Core Worker.
- Before acceptance, the `m9r-network-core` Worker dashboard showed 2 invocations, 1 ms CPU, and 0 errors in the previous 24 hours. The acceptance flow used a small number of Worker requests and wrote test state; no post-test per-Worker usage breakdown was available.

## Recommended Phase 0 deployment shape

Keep the Network separate from room/session relay:

1. The dedicated `m9r-network-core` Worker serves the provider-neutral REST API.
2. One SQLite-backed Durable Object per `network_id` owns pairing, agent credentials, roster, permissions, event log, inbox cursors, approvals, and audit records.
3. D1 holds the network/pairing lookup index and receives event/audit history through a Durable Object outbox. Add R2 only when binary attachments are in scope.
4. The Worker verifies human sessions through Supabase Auth and stores no Network state in Supabase. It uses no Supabase service-role key.

This puts Phase 0 compute and state on the eligible Cloudflare services while preserving the rule that a network is distinct from a room. The local service TypeScript compilation and Wrangler deploy dry run passed. The D1 schema and Worker are deployed, `/health` returned `200`, and the live two-agent pairing/send/inbox acceptance flow passed on 2026-10-03.

## Deployment sequence

1. Completed: Wrangler login and account check.
2. Completed: inspected D1 inventory, left `m9r-waitlist` untouched, and created the dedicated `m9r-network-core` database.
3. Completed: applied the initial D1 migration and set `PAIRING_CODE_PEPPER` as a Worker secret.
4. Completed: deployed the Worker and Durable Object migration to `workers.dev`; `/health` returned `200`. Custom-domain routing remains off.
5. Completed: ran the authenticated two-agent pairing/send/inbox acceptance flow on 2026-10-03. Both test-agent credentials were revoked. One synthetic event and its test network remain because the API has no network-delete route.
6. Remaining: refresh the account-level Billing view after the acceptance run and confirm later that eligible charges continue to draw from the startup credit balance. The current pre-test snapshot is small and account-wide; it does not prove the exact credit applied to an individual request.

Cloudflare documents `wrangler d1 create` as creating a remote database and returning the binding/UUID, and `wrangler d1 migrations apply` as changing the selected database. See [D1 Wrangler commands](https://developers.cloudflare.com/d1/wrangler-commands/) and [Workers Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/).

## Remaining verification

The Phase 0 live acceptance is complete. Refresh Cloudflare Billing after the test to compare account-level usage and credit balance. No custom domain was added, and no second Workers Paid plan was created for the Network Core Worker.
