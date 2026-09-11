/**
 * Auth session persistence — tests
 * ----------------------------------------------------------------------------
 * Locks in the fix that makes a sign-in produce a real session every surface
 * agrees on (homepage/nav, dashboard, claim page, approval API):
 *
 *  - Browser + server both use @supabase/ssr (cookie-backed), so client and
 *    server can't disagree about who is signed in.
 *  - Sign-in verifies getSession() persisted, then does a FULL navigation.
 *  - The nav reflects the signed-in session instead of always showing "Sign in".
 *  - Dev-only diagnostics (/api/auth/debug + AuthDebugBadge) never leak secrets.
 *
 * Source-level assertions in the style of auth-integration.test.ts. Live
 * end-to-end behavior is covered by the manual smoke gate in
 * docs/proof/agent-join-v0.md.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Consistent @supabase/ssr usage (no localStorage-only split)
// ---------------------------------------------------------------------------

test("browser client uses @supabase/ssr createBrowserClient", async () => {
  const src = await readFile("src/lib/supabase/browser.ts", "utf8");
  assert.match(src, /createBrowserClient/);
  assert.match(src, /@supabase\/ssr/);
});

test("server + proxy clients use @supabase/ssr createServerClient with cookies", async () => {
  const server = await readFile("src/lib/supabase/server.ts", "utf8");
  const proxy = await readFile("src/lib/supabase/proxy.ts", "utf8");
  assert.match(server, /createServerClient/);
  assert.match(server, /cookies/);
  assert.match(proxy, /createServerClient/);
  assert.match(proxy, /cookies/);
});

// ---------------------------------------------------------------------------
// Sign-in persists the session, then full-navigates to a safe next
// ---------------------------------------------------------------------------

test("AuthForm verifies the session persisted before navigating", async () => {
  const src = await readFile("src/components/product/AuthForm.tsx", "utf8");
  assert.match(src, /auth\.getSession\(\)/);
  assert.match(src, /window\.location\.assign\(destination\)/);
  assert.doesNotMatch(src, /router\.replace\(/);
});

test("AuthForm resolves next through the open-redirect-safe helper", async () => {
  const src = await readFile("src/components/product/AuthForm.tsx", "utf8");
  assert.match(src, /safeRelativePath\(next\)/);
});

// ---------------------------------------------------------------------------
// Nav reflects the signed-in session
// ---------------------------------------------------------------------------

test("Nav reflects the signed-in session instead of always showing Sign in", async () => {
  const src = await readFile("src/components/Nav.tsx", "utf8");
  assert.match(src, /createClient/);
  assert.match(src, /onAuthStateChange/);
  assert.match(src, /signedIn \? "\/dashboard" : "\/auth"/);
  assert.match(src, /Enter workspace/);
});

// ---------------------------------------------------------------------------
// Dashboard + claim page agree on the SAME server auth mechanism
// ---------------------------------------------------------------------------

test("dashboard and claim page both resolve auth via server getUser", async () => {
  const dash = await readFile("src/app/dashboard/layout.tsx", "utf8");
  const claim = await readFile("src/app/claim/[claimId]/page.tsx", "utf8");
  assert.match(dash, /createClient\(\)/);
  assert.match(dash, /auth\.getUser\(\)/);
  assert.match(claim, /createClient\(\)/);
  assert.match(claim, /auth\.getUser\(\)/);
});

// ---------------------------------------------------------------------------
// Dev-only diagnostics are safe (no tokens/secrets, prod-gated)
// ---------------------------------------------------------------------------

test("/api/auth/debug is dev-gated and leaks no tokens", async () => {
  const src = await readFile("src/app/api/auth/debug/route.ts", "utf8");
  assert.match(src, /NODE_ENV === "production"/);
  assert.match(src, /authenticated/);
  assert.match(src, /authCookiePresent/);
  // Never returns token/secret material.
  assert.doesNotMatch(src, /access_token|refresh_token|setup_code|token_hash|getSession\(\)/);
});

test("AuthDebugBadge is dev-only and compares browser vs server session", async () => {
  const src = await readFile("src/components/AuthDebugBadge.tsx", "utf8");
  assert.match(src, /NODE_ENV === "production"/);
  assert.match(src, /browser session/);
  assert.match(src, /server session/);
  assert.match(src, /\/api\/auth\/debug/);
});

// ---------------------------------------------------------------------------
// Approval + token guarantees unchanged (no bypass / no double token)
// ---------------------------------------------------------------------------

test("approval requires server auth and token guarantees hold", async () => {
  const service = await readFile("src/lib/agent-join-service.ts", "utf8");
  const migration = await readFile("supabase/migrations/20260721010000_atomic_agent_claim_lifecycle.sql", "utf8");
  assert.match(service, /export async function approveClaim/);
  assert.match(service, /UNAUTHENTICATED/);
  assert.match(service, /approve_agent_claim_atomic/);
  assert.match(service, /p_setup_code_hash:\s*hashSecret\(setupCode\)/);
  assert.match(migration, /consume_agent_claim_token_atomic[\s\S]*for update/i);
  assert.match(migration, /one_time_token = null/i);

  const rules = await readFile("src/app/api/agent/rules/route.ts", "utf8");
  assert.match(rules, /authenticateAgent\(bearerFrom\(/);
});
