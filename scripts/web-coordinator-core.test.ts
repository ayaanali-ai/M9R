import assert from "node:assert/strict";
import test from "node:test";
import { createWebCoordinatorCore, type CoordinatorEnvelope } from "@/lib/native/web-coordinator-core";

const frame = (overrides: Partial<CoordinatorEnvelope> = {}): CoordinatorEnvelope => ({
  version: 1, sessionId: "session-1", fromOwner: "alice", toOwner: "bob", sequence: 1,
  nonce: "nonce-abcdefghijklmnop", createdAt: 10_000, kind: "web.command", sealedPayload: "aGVsbG8td2VpcmVkLWNpcGhlcnRleHQ",
  ...overrides,
});

test("coordinator only routes an authenticated session member's opaque frame to the recipient", () => {
  const core = createWebCoordinatorCore({ now: () => 10_000 });
  assert.equal(core.registerSession({ sessionId: "session-1", owners: ["alice", "bob"], expiresAt: 20_000 }), true);
  const delivered: CoordinatorEnvelope[] = [];
  core.attach("bob", (value) => delivered.push(value));
  assert.deepEqual(core.route("alice", frame()), { accepted: true, deliveredTo: 1 });
  assert.deepEqual(delivered, [frame()]);
  assert.equal(core.route("mallory", frame({ sequence: 2, nonce: "nonce-qrstuvwxyzabcdef" })).accepted, false);
  assert.equal(core.route("alice", frame({ toOwner: "mallory", sequence: 2, nonce: "nonce-qrstuvwxyzabcdef" })).accepted, false);
});

test("coordinator rejects sequence/nonce replays, stale frames, and expired sessions", () => {
  let clock = 10_000;
  const core = createWebCoordinatorCore({ now: () => clock });
  core.registerSession({ sessionId: "session-1", owners: ["alice", "bob"], expiresAt: 20_000 });
  core.attach("bob", () => {});
  assert.equal(core.route("alice", frame()).accepted, true);
  assert.match(core.route("alice", frame({ sequence: 1, nonce: "nonce-qrstuvwxyzabcdef" })).accepted ? "" : String((core.route("alice", frame({ sequence: 1, nonce: "nonce-qrstuvwxyzabcdef" })) as { reason: string }).reason), /sequence/);
  assert.equal(core.route("alice", frame({ sequence: 2 })).accepted, false);
  clock += 91_000;
  assert.equal(core.route("alice", frame({ sequence: 3, nonce: "nonce-qrstuvwxyzabcdef", createdAt: 10_000 })).accepted, false);
});

test("coordinator validates message kinds, bounded ciphertext, session membership, and offline delivery", () => {
  const core = createWebCoordinatorCore({ now: () => 10_000 });
  core.registerSession({ sessionId: "session-1", owners: ["alice", "bob"], expiresAt: 20_000 });
  assert.equal(core.route("alice", frame()).accepted, false);
  core.attach("bob", () => {});
  assert.equal(core.route("alice", frame({ sequence: 1, nonce: "nonce-abcdefghijklmnop", kind: "grant.create" as never })).accepted, false);
  assert.equal(core.route("alice", frame({ sequence: 1, nonce: "nonce-abcdefghijklmnop", sealedPayload: "../plaintext!" })).accepted, false);
  assert.equal(core.registerSession({ sessionId: "session-1", owners: ["alice", "mallory"], expiresAt: 20_000 }), false);
});
