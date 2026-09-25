import assert from "node:assert/strict";
import test from "node:test";
import { createWebAuthority, isBlockedOrigin, originOf, verifyAudit } from "@/lib/native/web-authority-core";

const bob = { owner: "bob", agent: "claude" };
const SITE = "https://shop.example";

function setup(options: { maxTtlMs?: number } = {}) {
  let clock = 1_000_000;
  let n = 0;
  const authority = createWebAuthority({ ownerId: "alice", now: () => clock, newId: () => `id${++n}`, maxTtlMs: options.maxTtlMs });
  return { authority, advance: (ms: number) => (clock += ms) };
}

function grantFor(
  authority: ReturnType<typeof setup>["authority"],
  actions: ReadonlyArray<"open" | "read" | "click" | "type"> = ["read", "click"],
  extra: { ttlMs?: number; maxUses?: number } = {},
) {
  const requested = authority.requestGrant({ grantee: bob, origin: SITE, actions: [...actions], ttlMs: extra.ttlMs });
  assert.ok(requested.ok);
  const approved = authority.approve(requested.request.id, { maxUses: extra.maxUses });
  assert.ok(approved.ok);
  return approved.grant;
}

test("a granted agent can do exactly what was granted on exactly that site, and each decision is logged", () => {
  const { authority } = setup();
  const grant = grantFor(authority);
  assert.deepEqual(authority.check({ grantee: bob, action: "read", origin: SITE, selector: "#price" }), { allowed: true, grantId: grant.id });
  assert.deepEqual(authority.check({ grantee: bob, action: "click", origin: SITE, selector: "#buy" }), { allowed: true, grantId: grant.id });

  const refused = authority.check({ grantee: bob, action: "type", origin: SITE });
  assert.deepEqual(refused, { allowed: false, reason: "the grant does not allow type" });
  assert.match(String((authority.check({ grantee: bob, action: "read", origin: "https://other.example" }) as { reason: string }).reason), /no grant covers/);
  assert.deepEqual(authority.check({ grantee: { owner: "bob", agent: "codex" }, action: "read", origin: SITE }), { allowed: false, reason: "no grant for bob/codex" });

  const kinds = authority.audit().map((e) => e.kind);
  assert.deepEqual(kinds, ["grant.requested", "grant.approved", "action.allowed", "action.allowed", "action.refused", "action.refused", "action.refused"]);
  assert.deepEqual(verifyAudit(authority.audit()), { ok: true });
});

test("nothing is allowed before the owner approves, and a denied request creates no grant", () => {
  const { authority } = setup();
  const requested = authority.requestGrant({ grantee: bob, origin: SITE, actions: ["read"] });
  assert.ok(requested.ok);
  assert.equal(authority.check({ grantee: bob, action: "read", origin: SITE }).allowed, false);
  assert.equal(authority.deny(requested.request.id), true);
  assert.equal(authority.approve(requested.request.id).ok, false);
  assert.equal(authority.grants().length, 0);
});

test("a grant ends at its expiry, on revocation, and when its uses run out", () => {
  const { authority, advance } = setup();
  const timed = grantFor(authority, ["read"], { ttlMs: 60_000 });
  assert.equal(authority.check({ grantee: bob, action: "read", origin: SITE }).allowed, true);
  advance(60_001);
  assert.deepEqual(authority.check({ grantee: bob, action: "read", origin: SITE }), { allowed: false, reason: "the grant has expired" });
  assert.ok(timed);

  const b = setup();
  const g = grantFor(b.authority, ["click"]);
  assert.equal(b.authority.revoke(g.id), true);
  assert.deepEqual(b.authority.check({ grantee: bob, action: "click", origin: SITE }), { allowed: false, reason: "the grant was revoked" });
  assert.equal(b.authority.revoke(g.id), false, "revoking twice is a no-op");

  const c = setup();
  grantFor(c.authority, ["click"], { maxUses: 2 });
  assert.equal(c.authority.check({ grantee: bob, action: "click", origin: SITE }).allowed, true);
  assert.equal(c.authority.check({ grantee: bob, action: "click", origin: SITE }).allowed, true);
  assert.deepEqual(c.authority.check({ grantee: bob, action: "click", origin: SITE }), { allowed: false, reason: "the grant has no uses left" });
});

test("revokeAll is an immediate stop for every grant", () => {
  const { authority } = setup();
  grantFor(authority, ["read"]);
  grantFor(authority, ["click"]);
  assert.equal(authority.revokeAll(), 2);
  assert.equal(authority.check({ grantee: bob, action: "read", origin: SITE }).allowed, false);
});

test("the owner can narrow a request but never widen it, and ttl is capped", () => {
  const { authority } = setup({ maxTtlMs: 3_600_000 });
  const requested = authority.requestGrant({ grantee: bob, origin: SITE, actions: ["read", "click"], ttlMs: 99 * 3_600_000 });
  assert.ok(requested.ok);
  assert.equal(requested.request.ttlMs, 3_600_000);
  const approved = authority.approve(requested.request.id, { actions: ["read", "type"], ttlMs: 9 * 3_600_000 });
  assert.ok(approved.ok);
  assert.deepEqual(approved.grant.actions, ["read"], "type was never requested, so it cannot appear");
  assert.equal(approved.grant.expiresAt - approved.grant.createdAt, 3_600_000);

  const b = setup();
  const r = b.authority.requestGrant({ grantee: bob, origin: SITE, actions: ["read"] });
  assert.ok(r.ok);
  assert.equal(b.authority.approve(r.request.id, { actions: ["click"] }).ok, false);
});

test("sensitive sites, non-web urls, empty requests and self-grants are refused up front", () => {
  const { authority } = setup();
  assert.match(String((authority.requestGrant({ grantee: bob, origin: "https://accounts.google.com", actions: ["read"] }) as { error: string }).error), /never-grant/);
  assert.match(String((authority.requestGrant({ grantee: bob, origin: "https://login.paypal.com", actions: ["read"] }) as { error: string }).error), /never-grant/);
  assert.equal(authority.requestGrant({ grantee: bob, origin: "file:///c:/x", actions: ["read"] }).ok, false);
  assert.equal(authority.requestGrant({ grantee: bob, origin: SITE, actions: [] }).ok, false);
  assert.equal(authority.requestGrant({ grantee: { owner: "alice", agent: "claude" }, origin: SITE, actions: ["read"] }).ok, false);
  assert.equal(isBlockedOrigin("https://notpaypal.com"), false);
  assert.equal(isBlockedOrigin("https://www.paypal.com"), true);
  assert.equal(isBlockedOrigin("https://bank.example", ["bank.example"]), true);
});

test("an unanswered request expires and can no longer be approved", () => {
  const { authority, advance } = setup();
  const r = authority.requestGrant({ grantee: bob, origin: SITE, actions: ["read"] });
  assert.ok(r.ok);
  advance(10 * 60_000 + 1);
  assert.equal(authority.pendingRequests().length, 0);
  assert.equal(authority.approve(r.request.id).ok, false);
});

test("editing, removing or reordering a log entry is detected", () => {
  const { authority } = setup();
  grantFor(authority);
  authority.check({ grantee: bob, action: "read", origin: SITE });
  authority.check({ grantee: bob, action: "type", origin: SITE });
  const entries = authority.audit();
  assert.deepEqual(verifyAudit(entries), { ok: true });

  const edited = entries.map((e) => ({ ...e }));
  edited[3].kind = "action.allowed";
  assert.deepEqual(verifyAudit(edited), { ok: false, brokenAt: 3 });

  const removed = entries.filter((_, i) => i !== 2);
  assert.deepEqual(verifyAudit(removed), { ok: false, brokenAt: 2 });

  const swapped = [entries[0], entries[2], entries[1], ...entries.slice(3)];
  assert.equal(verifyAudit(swapped).ok, false);
});

test("the log never contains typed text or page content, only metadata", () => {
  const { authority } = setup();
  grantFor(authority, ["type"]);
  authority.check({ grantee: bob, action: "type", origin: SITE, selector: "#card-number" });
  const serialized = JSON.stringify(authority.audit());
  assert.ok(serialized.includes("#card-number"));
  assert.ok(!("text" in authority.audit()[0]));
});

test("originOf accepts only http and https", () => {
  assert.equal(originOf("https://shop.example/a/b?c=1"), "https://shop.example");
  assert.equal(originOf("javascript:alert(1)"), null);
  assert.equal(originOf(undefined), null);
});

test("path-scoped grants cover only the exact path prefix and its descendants", () => {
  const { authority } = setup();
  const requested = authority.requestGrant({ grantee: bob, origin: "https://shop.example/cart/", actions: ["open", "read"] });
  assert.equal(requested.ok, true);
  if (!requested.ok) return;
  const approved = authority.approve(requested.request.id);
  assert.equal(approved.ok, true);
  if (!approved.ok) return;
  assert.equal(approved.grant.pathPrefix, "/cart");
  assert.equal(authority.check({ grantee: bob, action: "read", origin: SITE, path: "/cart" }).allowed, true);
  assert.equal(authority.check({ grantee: bob, action: "read", origin: SITE, path: "/cart/items/1" }).allowed, true);
  assert.match(String((authority.check({ grantee: bob, action: "read", origin: SITE, path: "/account" }) as { reason: string }).reason), /does not cover path/);
  assert.match(String((authority.check({ grantee: bob, action: "read", origin: SITE, path: "/cartoon" }) as { reason: string }).reason), /does not cover path/);
  assert.match(String((authority.check({ grantee: bob, action: "read", origin: SITE }) as { reason: string }).reason), /unknown/);
});
