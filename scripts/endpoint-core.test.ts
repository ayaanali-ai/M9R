import assert from "node:assert/strict";
import test from "node:test";
import { buildEndpointView, endpointRef, fidelityFor, parseAddress, parseEndpointRef, resolveAddress, type EndpointRow } from "@/lib/endpoint-core";

const NOW = Date.parse("2026-09-19T12:00:00.000Z");
const iso = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString();

function row(over: Partial<EndpointRow> & { id: string; alias: string }): EndpointRow {
  return { workspace_id: "w1", owner_user_id: "u-me", provider: over.alias, current_connection_id: "c1", session_generation: 1, status: "active", ...over };
}

const A = "0a1b2c3d-0000-4000-8000-000000000001";
const B = "0a1b2c3d-0000-4000-8000-000000000002";
const C = "0a1b2c3d-0000-4000-8000-000000000003";

test("endpoint ids round-trip through their external ep_ form", () => {
  assert.equal(endpointRef(A), "ep_0a1b2c3d000040008000000000000001");
  assert.equal(parseEndpointRef(endpointRef(A)), A);
  assert.equal(parseEndpointRef("ep_short"), null);
  assert.equal(parseEndpointRef(`ep_${"g".repeat(32)}`), null);
});

test("addresses parse: alias, id, future handle form, and rejects", () => {
  assert.deepEqual(parseAddress("@Codex"), { kind: "alias", alias: "codex" });
  assert.deepEqual(parseAddress("claude-code"), { kind: "alias", alias: "claude-code" });
  assert.deepEqual(parseAddress(endpointRef(A)), { kind: "id", id: A });
  assert.deepEqual(parseAddress("@sarah/claude~3"), { kind: "handle", owner: "sarah", name: "claude", generation: 3 });
  assert.equal(parseAddress("@").kind, "invalid");
  assert.equal(parseAddress("@bad name").kind, "invalid");
  assert.equal(parseAddress("@-lead").kind, "invalid");
  assert.equal(parseAddress("@sarah/-x").kind, "invalid");
  assert.equal(parseAddress("ep_zz").kind, "invalid");
  assert.equal(parseAddress("@" + "a".repeat(40)).kind, "invalid");
});

test("a fresh bound endpoint is live and inferred idle; the confidence is never claimed as observed", () => {
  const view = buildEndpointView(row({ id: A, alias: "codex" }), iso(30), "u-me", NOW);
  assert.equal(view.reachability, "live");
  assert.deepEqual(view.presence, { state: "idle", confidence: "inferred", lastSeenAt: iso(30) });
  assert.equal(view.fidelity.level, "LIVE_NATIVE");
  assert.equal(view.mine, true);
  assert.equal(view.address, "@codex");
});

test("the 90 second lease is exact: 89 s is live, 91 s is queue and offline presence", () => {
  assert.equal(buildEndpointView(row({ id: A, alias: "codex" }), iso(89), null, NOW).reachability, "live");
  const stale = buildEndpointView(row({ id: A, alias: "codex" }), iso(91), null, NOW);
  assert.equal(stale.reachability, "queue");
  assert.deepEqual([stale.presence.state, stale.presence.confidence], ["offline", "unknown"]);
  assert.equal(stale.fidelity.level, "CONSULTATION");
});

test("an unbound endpoint keeps its address but has no live session; retired or suspended is offline", () => {
  const unbound = buildEndpointView(row({ id: A, alias: "opencode", current_connection_id: null }), null, null, NOW);
  assert.equal(unbound.reachability, "queue");
  assert.equal(unbound.fidelity.level, "CONSULTATION");
  assert.equal(buildEndpointView(row({ id: A, alias: "codex", status: "suspended" }), iso(1), null, NOW).reachability, "offline");
  assert.equal(buildEndpointView(row({ id: A, alias: "codex", status: "retired" }), iso(1), null, NOW).reachability, "offline");
});

test("fidelity is only claimed for providers M9R hosts", () => {
  assert.equal(fidelityFor("claude-code", true).level, "LIVE_NATIVE");
  assert.equal(fidelityFor("opencode", true).level, "LIVE_NATIVE");
  assert.equal(fidelityFor("grok-build", true).level, "CONSULTATION");
  assert.equal(fidelityFor("codex", false).level, "CONSULTATION");
});

test("resolving a bare alias: unique match, the caller's own when duplicated, ambiguity otherwise", () => {
  const mine = row({ id: A, alias: "codex", owner_user_id: "u-me" });
  const theirs = row({ id: B, alias: "codex", owner_user_id: "u-sarah", current_connection_id: "c2" });
  const other = row({ id: C, alias: "claude-code", owner_user_id: "u-sarah", current_connection_id: "c3" });

  assert.deepEqual(resolveAddress("@claude-code", [mine, other], "u-me"), { ok: true, endpoint: other });
  assert.deepEqual(resolveAddress("@codex", [mine, theirs, other], "u-me"), { ok: true, endpoint: mine });

  const ambiguous = resolveAddress("@codex", [mine, theirs], "u-nobody");
  assert.equal(ambiguous.ok, false);
  if (!ambiguous.ok) {
    assert.equal(ambiguous.code, "AMBIGUOUS_ENDPOINT");
    assert.deepEqual(ambiguous.candidates, [endpointRef(A), endpointRef(B)]);
  }
});

test("an exact endpoint id resolves even when the alias is ambiguous", () => {
  const mine = row({ id: A, alias: "codex" });
  const theirs = row({ id: B, alias: "codex", owner_user_id: "u-sarah", current_connection_id: "c2" });
  assert.deepEqual(resolveAddress(endpointRef(B), [mine, theirs], "u-me"), { ok: true, endpoint: theirs });
});

test("unknown and retired endpoints are ENDPOINT_NOT_FOUND and the message lists what is known", () => {
  const retired = row({ id: A, alias: "codex", status: "retired" });
  const live = row({ id: B, alias: "claude-code", current_connection_id: "c2" });
  const missing = resolveAddress("@codex", [retired, live], "u-me");
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.code, "ENDPOINT_NOT_FOUND");
    assert.match(missing.message, /@claude-code/);
    assert.doesNotMatch(missing.message, /@codex,/);
  }
});

test("owner handles are refused honestly until they exist, and bad input is INVALID_ADDRESS", () => {
  const handle = resolveAddress("@sarah/claude", [], null);
  assert.equal(handle.ok === false && handle.code, "HANDLES_NOT_AVAILABLE");
  const bad = resolveAddress("@not valid", [], null);
  assert.equal(bad.ok === false && bad.code, "INVALID_ADDRESS");
});
