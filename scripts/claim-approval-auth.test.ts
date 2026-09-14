/**
 * Claim approval active-session wiring — tests
 * ----------------------------------------------------------------------------
 * Locks in the fix for the post-sign-in auth loop on /claim/[claimId]:
 *
 *  - Sign-in performs a FULL document navigation so the destination's server
 *    components/middleware see the freshly written Supabase auth cookies (a soft
 *    router navigation raced cookie propagation and rendered signed-out).
 *  - The claim page resolves auth server-side (same mechanism as the dashboard)
 *    and gates the approve/reject UI on it.
 *  - Approve/reject are explicit actions that POST /api/agent/claim/[claimId],
 *    and the approve handler still validates the authenticated user server-side.
 *
 * These are source-level assertions in the same style as auth-integration.test.ts.
 * Live token-once + approval behavior is covered by the manual smoke test in
 * docs/proof/agent-join-v0.md and by claim-approval-redirect.test.ts (pure logic).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// AuthForm: full navigation after sign-in (no soft-nav loop)
// ---------------------------------------------------------------------------

test("AuthForm redirects post-login with a full document navigation", async () => {
  const src = await readFile("src/components/product/AuthForm.tsx", "utf8");
  // Full navigation guarantees the server sees the new auth cookies.
  assert.match(src, /window\.location\.assign\(destination\)/);
  // The soft navigation that caused the loop must be gone.
  assert.doesNotMatch(src, /router\.replace\(/);
});

test("connect batch keeps per-provider secrets while sharing one human approval URL", async () => {
  const service = await readFile("src/lib/agent-join-service.ts", "utf8");
  const registerRoute = await readFile("src/app/api/agent/register-batch/route.ts", "utf8");
  const cli = await readFile("src/lib/oathlock-cli-core.ts", "utf8");
  assert.match(service, /registerClaimBatch/);
  assert.match(service, /setupCode: generateSetupCode\(\)/);
  assert.match(service, /buildClaimBatchUrl/);
  assert.match(registerRoute, /validateRegisterInput/);
  assert.match(registerRoute, /MAX_BATCH_CLAIMS/);
  assert.match(cli, /\/api\/agent\/register-batch/);
  assert.match(cli, /approve all new connections once/);
  assert.match(cli, /claimByKind/);
  assert.doesNotMatch(registerRoute, /one_time_token|token_hash/);
});

test("batch approval is one signed-in human action and never exposes token material", async () => {
  const service = await readFile("src/lib/agent-join-service.ts", "utf8");
  const route = await readFile("src/app/api/agent/claim/batch/route.ts", "utf8");
  const page = await readFile("src/app/claim/batch/[batchId]/page.tsx", "utf8");
  const actions = await readFile("src/components/ClaimBatchActions.tsx", "utf8");
  assert.match(service, /export async function approveClaimBatch/);
  assert.match(service, /humanApprovalContext\("approve"\)/);
  assert.match(service, /assertCanConnectAgent/);
  assert.match(route, /approveClaimBatch/);
  assert.match(route, /body\.decision === "approve"/);
  assert.match(page, /getClaimBatchPublic/);
  assert.match(actions, /Approve \$\{pendingCount\} connection/);
  assert.doesNotMatch(page + actions, /setup_code|one_time_token|token_hash|Bearer/);
});

test("batch claim schema is additive and indexed for public claim-page lookup", async () => {
  const migration = await readFile("supabase/migrations/20260913010000_agent_claim_batches.sql", "utf8");
  const baseline = await readFile("supabase-agent-join.sql", "utf8");
  assert.match(migration, /add column if not exists batch_id uuid/i);
  assert.match(migration, /idx_agent_claims_batch_id/i);
  assert.match(baseline, /batch_id UUID/i);
  assert.match(baseline, /idx_agent_claims_batch_id/i);
});

test("AuthForm sends sign-in to a safe, validated destination", async () => {
  const src = await readFile("src/components/product/AuthForm.tsx", "utf8");
  assert.match(src, /safeRelativePath\(next\)/);
  assert.match(src, /auth\/confirm\?next=\$\{encodeURIComponent\(destination\)\}/);
});

// ---------------------------------------------------------------------------
// Claim page: server-side auth, same mechanism as the dashboard
// ---------------------------------------------------------------------------

test("claim page resolves auth server-side via getUser (like the dashboard)", async () => {
  const src = await readFile("src/app/claim/[claimId]/page.tsx", "utf8");
  assert.match(src, /createClient\(\)/);
  assert.match(src, /auth\.getUser\(\)/);
  assert.match(src, /const signedIn = Boolean\(user\)/);
  // signedIn drives the approve/reject component.
  assert.match(src, /signedIn=\{signedIn\}/);
  assert.match(src, /returnTo=\{`\/claim\/\$\{claim\.claim_id\}`\}/);
});

test("claim page does not emit server diagnostics or secret-bearing logs", async () => {
  const src = await readFile("src/app/claim/[claimId]/page.tsx", "utf8");
  assert.doesNotMatch(src, /console\.(log|debug|info|warn|error)\(/);
  assert.doesNotMatch(src, /cookies\(\)/);
  assert.doesNotMatch(src, /hasAuthCookie/);
  assert.doesNotMatch(src, /server session missing|auth cookie missing/);
  assert.doesNotMatch(src, /one_time_token|setup_code|token_hash/);
});

// ---------------------------------------------------------------------------
// ClaimActions: explicit approve/reject, gated on signed-in state
// ---------------------------------------------------------------------------

test("ClaimActions shows sign-in link when signed out and posts approval when signed in", async () => {
  const src = await readFile("src/components/ClaimActions.tsx", "utf8");
  // Signed-out: sign-in link carries returnTo back to the claim.
  assert.match(src, /buildSignInHref\(returnTo\)/);
  assert.match(src, /Sign in to approve this claim/);
  // Explicit actions hit the approve/reject API route.
  assert.match(src, /fetch\(`\/api\/agent\/claim\/\$\{claimId\}`/);
  assert.match(src, /act\("approve"\)/);
  assert.match(src, /act\("reject"\)/);
  // No auto-approval: approval only runs from the button handler.
  assert.doesNotMatch(src, /useEffect\([^)]*act\(/);
});

// ---------------------------------------------------------------------------
// Approve handler: server-side authenticated-user validation (no bypass)
// ---------------------------------------------------------------------------

test("approveClaim validates the signed-in user server-side", async () => {
  const src = await readFile("src/lib/agent-join-service.ts", "utf8");
  // Approval reads the cookie session and refuses when unauthenticated.
  assert.match(src, /export async function approveClaim/);
  assert.match(src, /auth\.getUser\(\)/);
  assert.match(src, /UNAUTHENTICATED/);
});

test("claim-status requires setup_code and never returns token from claim_id alone", async () => {
  const src = await readFile("src/lib/agent-join-service.ts", "utf8");
  const migration = await readFile("supabase/migrations/20260721010000_atomic_agent_claim_lifecycle.sql", "utf8");
  assert.match(src, /p_setup_code_hash:\s*hashSecret\(setupCode\)/);
  assert.match(src, /BAD_SETUP_CODE/);
  assert.match(migration, /locked_claim\.setup_code_hash <> p_setup_code_hash/i);
  // Token consumption is serialized and the transient copy is destroyed in
  // the same database transaction that returns it.
  assert.match(migration, /for update/i);
  assert.match(migration, /one_time_token = null/i);
});
