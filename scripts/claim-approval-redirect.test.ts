/**
 * Claim approval return-path — unit tests
 * ----------------------------------------------------------------------------
 * Covers the open-redirect-safe `next`/returnTo handling that lets a signed-out
 * human open /claim/[claimId], sign in, and land back on the same claim page.
 *
 * The auth callback (src/app/auth/confirm/route.ts), the /auth page, and the
 * sign-in form all resolve their post-login destination through
 * safeRelativePath, and the claim page's "Sign in to approve" link is built by
 * buildSignInHref — so testing these two pure helpers exercises the full fix.
 *
 * DB-backed approval + token-once behavior (spec items 4–7) is verified by the
 * manual smoke test in docs/proof/agent-join-v0.md (no DB in unit tests).
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  safeRelativePath,
  buildSignInHref,
  DEFAULT_POST_LOGIN,
} from "../src/lib/safe-redirect.ts";

// ---------------------------------------------------------------------------
// safeRelativePath — the open-redirect guard
// ---------------------------------------------------------------------------

test("safeRelativePath: returns a same-origin claim path unchanged", () => {
  assert.equal(safeRelativePath("/claim/abc-123"), "/claim/abc-123");
  assert.equal(safeRelativePath("/claim/abc-123?x=1"), "/claim/abc-123?x=1");
});

test("safeRelativePath: falls back when missing or empty", () => {
  assert.equal(safeRelativePath(null), DEFAULT_POST_LOGIN);
  assert.equal(safeRelativePath(undefined), DEFAULT_POST_LOGIN);
  assert.equal(safeRelativePath(""), DEFAULT_POST_LOGIN);
});

test("safeRelativePath: rejects absolute/external URLs", () => {
  assert.equal(safeRelativePath("http://evil.com"), DEFAULT_POST_LOGIN);
  assert.equal(safeRelativePath("https://evil.com/claim/abc"), DEFAULT_POST_LOGIN);
});

test("safeRelativePath: rejects protocol-relative and backslash variants", () => {
  assert.equal(safeRelativePath("//evil.com"), DEFAULT_POST_LOGIN);
  assert.equal(safeRelativePath("/\\evil.com"), DEFAULT_POST_LOGIN);
});

test("safeRelativePath: rejects non-relative and whitespace-smuggled values", () => {
  assert.equal(safeRelativePath("dashboard"), DEFAULT_POST_LOGIN);
  assert.equal(safeRelativePath("javascript:alert(1)"), DEFAULT_POST_LOGIN);
  assert.equal(safeRelativePath(" /claim/abc"), DEFAULT_POST_LOGIN);
  assert.equal(safeRelativePath("/claim/\tabc"), DEFAULT_POST_LOGIN);
});

test("safeRelativePath: honors a custom fallback", () => {
  assert.equal(safeRelativePath("http://evil.com", "/agents"), "/agents");
});

// ---------------------------------------------------------------------------
// Spec item 2 & 3 — auth callback destination resolution (same helper)
// ---------------------------------------------------------------------------

test("auth callback respects a safe returnTo=/claim/[claimId]", () => {
  // The callback computes its destination via safeRelativePath(next).
  assert.equal(safeRelativePath("/claim/xyz"), "/claim/xyz");
});

test("auth callback rejects an unsafe external returnTo", () => {
  assert.equal(safeRelativePath("https://evil.com"), DEFAULT_POST_LOGIN);
  assert.equal(safeRelativePath("//evil.com"), DEFAULT_POST_LOGIN);
});

// ---------------------------------------------------------------------------
// Spec item 1 — claim page "Sign in to approve" link carries returnTo
// ---------------------------------------------------------------------------

test("buildSignInHref points back to the claim page after login", () => {
  assert.equal(buildSignInHref("/claim/abc-123"), "/auth?next=%2Fclaim%2Fabc-123");
});

test("buildSignInHref drops an unsafe returnTo to the default", () => {
  assert.equal(buildSignInHref("http://evil.com"), `/auth?next=${encodeURIComponent(DEFAULT_POST_LOGIN)}`);
  assert.equal(buildSignInHref(null), `/auth?next=${encodeURIComponent(DEFAULT_POST_LOGIN)}`);
});
