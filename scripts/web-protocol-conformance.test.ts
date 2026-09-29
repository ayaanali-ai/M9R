import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  M9R_WEB_PROTOCOL_TYPES,
  createProtocolLedger,
  validateProtocolMessage,
  type ProtocolMessage,
} from "../packages/web-protocol-placeholder/src/index.ts";

const now = Date.parse("2026-09-26T12:00:00.000Z");
const future = new Date(now + 60_000).toISOString();
const base = (messageType: ProtocolMessage["message_type"], payload: Record<string, unknown>, seq = 1, id = "msg-1") => ({
  protocol: "m9r-web/0",
  message_id: id,
  session_id: "room-1",
  sender: { principal_id: "agent:codex", key_id: "key-1" },
  sequence: seq,
  created_at: new Date(now).toISOString(),
  causal: { lamport: seq, observed: [] },
  message_type: messageType,
  payload,
  signature: "dGVzdA",
});

// A frame the room-membership rule gates (post/reply/ask/share-artifact) needs its sender already admitted; this is
// the membership record that grants agent:codex the room, used by the tests below that exercise those types.
const admitCodex = { ...base("membership", { room_id: "room-1", member_id: "agent:codex", state: "active", requested_by: "owner:codex", invited_by: "owner:local", quiet_until_invited: false, expires_at: future }, 1, "admit-codex"), sender: { principal_id: "owner:local", key_id: "key-0" } };

const fixtures: Array<[ProtocolMessage["message_type"], Record<string, unknown>]> = [
  ["post", { text: "hello" }],
  ["get", { resource: "room-state" }],
  ["reply", { in_reply_to: "ask-1", text: "answer" }],
  ["subscribe", { room_id: "room-1" }],
  ["request-context", { site: "https://example.test", path: "/docs" }],
  ["share-artifact", { artifact_id: "artifact-1", media_type: "text/plain", digest: "a".repeat(64) }],
  ["ask", { question_id: "ask-1", to: "agent:claude", question: "Which field is the rate?", requested_by: "owner:codex" }],
  ["presence", { agent: "Codex", provider: "codex", url: "https://example.test/docs", action: "read", seq: 1 }],
  ["cursor", { tab_id: "tab-1", target: { selector: "#rate" } }],
  ["claim", { claim_id: "claim-1", tab_id: "tab-1", scope: { kind: "field", key: "#rate" }, expires_at: future }],
  ["release", { claim_id: "claim-1" }],
  ["approval-request", { operation_id: "op-1", action: "submit", target: { tab_id: "tab-1", path: "/checkout" }, expires_at: future }],
  ["approval-decision", { operation_id: "op-1", decision: "deny", approver: "owner:local" }],
  ["stop-all", { reason: "owner requested stop" }],
  ["audit-entry", { event_id: "event-1", event_type: "action.denied", previous_hash: null, hash: "b".repeat(64) }],
  ["grant", { site: "https://example.test", path: "/docs", actions: ["read"], expires_at: future, max_uses: 2, use_count: 0, spend_cap: { currency: "USD", max_minor: 0, used_minor: 0 } }],
  ["disclosure-request", { request_id: "disclosure-1", asked_by: "agent:codex", subject: "owner notes", data_class: "own_files_named", audience: ["agent:claude"], proposed_text_digest: "c".repeat(64), expires_at: future }],
  ["disclosure-decision", { request_id: "disclosure-1", decision: "deny", decided_by: "owner:codex", receipt_id: "receipt-1" }],
  ["membership", { room_id: "room-1", member_id: "member-1", state: "requested", requested_by: "owner:codex", quiet_until_invited: true, expires_at: future }],
];

const schema = JSON.parse(readFileSync(new URL("../packages/web-protocol-placeholder/schema/protocol.schema.json", import.meta.url), "utf8")) as {
  $schema: string;
  $defs: { payloads: Record<string, unknown> };
  allOf: Array<{ if?: { properties?: { message_type?: { const?: string } } }; then?: { properties?: { payload?: { $ref?: string } } } }>;
};

test("v0 JSON Schema vocabulary and validator cover every declared message type", () => {
  assert.equal(new Set(M9R_WEB_PROTOCOL_TYPES).size, M9R_WEB_PROTOCOL_TYPES.length);
  assert.deepEqual(fixtures.map(([type]) => type).sort(), [...M9R_WEB_PROTOCOL_TYPES].sort());
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.deepEqual(Object.keys(schema.$defs.payloads).sort(), [...M9R_WEB_PROTOCOL_TYPES].sort());
  const branches = schema.allOf.filter((branch) => branch.if?.properties?.message_type?.const);
  assert.equal(branches.length, M9R_WEB_PROTOCOL_TYPES.length);
  assert.ok(branches.every((branch) => branch.then?.properties?.payload?.$ref?.startsWith("#/$defs/payloads/")));
  for (const [type, payload] of fixtures) {
    assert.equal(validateProtocolMessage(base(type, payload), { nowMs: now }).ok, true, `${type} should validate`);
  }
});

test("the conformance gate rejects spoofed senders and replayed message IDs or sequences", () => {
  const ledger = createProtocolLedger({ now: () => now, ownerId: "owner:local" });
  assert.equal(ledger.accept(admitCodex, { principalId: "owner:local" }).ok, true);
  const first = base("post", { text: "one" });
  assert.equal(ledger.accept(first, { principalId: "agent:claude" }).ok, false, "authenticated transport identity must match envelope sender");
  assert.equal(ledger.accept(first, { principalId: "agent:codex" }).ok, true);
  assert.equal(ledger.accept(first, { principalId: "agent:codex" }).ok, false, "duplicate message ID must be rejected");
  assert.equal(ledger.accept(base("reply", { in_reply_to: "ask-1", text: "two" }, 1, "msg-2"), { principalId: "agent:codex" }).ok, false, "sequence rollback must be rejected");
});

test("the conformance gate rejects expired and exhausted grants", () => {
  const expired = base("grant", { site: "https://example.test", path: "/", actions: ["read"], expires_at: new Date(now).toISOString(), max_uses: 2, use_count: 0, spend_cap: { currency: "USD", max_minor: 0, used_minor: 0 } });
  const exhausted = base("grant", { site: "https://example.test", path: "/", actions: ["read"], expires_at: future, max_uses: 2, use_count: 2, spend_cap: { currency: "USD", max_minor: 0, used_minor: 0 } }, 2, "msg-2");
  const expiredResult = validateProtocolMessage(expired, { nowMs: now });
  const exhaustedResult = validateProtocolMessage(exhausted, { nowMs: now });
  assert.equal(expiredResult.ok, false);
  assert.equal(exhaustedResult.ok, false);
  if (!expiredResult.ok) assert.match(expiredResult.error, /expired/i);
  if (!exhaustedResult.ok) assert.match(exhaustedResult.error, /exhausted|use count/i);
});

test("disclosure, admission, attribution, and spend-cap fields fail closed", () => {
  const missingAttribution = base("ask", { question_id: "ask-2", to: "agent:claude", question: "Who asked?" });
  assert.equal(validateProtocolMessage(missingAttribution, { nowMs: now }).ok, false);
  const noisyJoin = base("membership", { room_id: "room-1", member_id: "member-2", state: "requested", requested_by: "owner:codex", quiet_until_invited: false });
  assert.equal(validateProtocolMessage(noisyJoin, { nowMs: now }).ok, false);
  const uncappedGrant = base("grant", { site: "https://example.test", path: "/", actions: ["click"], expires_at: future, max_uses: 1, use_count: 0 });
  assert.equal(validateProtocolMessage(uncappedGrant, { nowMs: now }).ok, false);
  const invalidDisclosure = base("disclosure-request", { request_id: "d-2", asked_by: "agent:codex", subject: "notes", data_class: "secrets", audience: "room", proposed_text_digest: "a".repeat(64), expires_at: future });
  assert.equal(validateProtocolMessage(invalidDisclosure, { nowMs: now }).ok, false);
});

test("the conformance gate refuses oversized payloads before accepting them", () => {
  const oversized = base("post", { text: "x".repeat(17_000) });
  const result = validateProtocolMessage(oversized, { nowMs: now });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /size|large/i);
});

test("the local reference ledger accepts and emits validated v0 frames without changing their payload", () => {
  const ledger = createProtocolLedger({ now: () => now, ownerId: "owner:local" });
  const admitClaude = { ...admitCodex, message_id: "admit-claude", sequence: 2, causal: { lamport: 2, observed: [] }, payload: { ...admitCodex.payload, member_id: "agent:claude" } };
  assert.equal(ledger.accept(admitCodex, { principalId: "owner:local" }).ok, true);
  assert.equal(ledger.accept(admitClaude, { principalId: "owner:local" }).ok, true);
  const incoming = base("ask", { question_id: "ask-1", to: "agent:claude", question: "Need the rate", requested_by: "owner:codex" });
  assert.equal(ledger.accept(incoming, { principalId: "agent:codex" }).ok, true);
  const outgoing = { ...base("reply", { in_reply_to: "ask-1", text: "12+" }, 1, "out-1"), sender: { principal_id: "agent:claude", key_id: "key-2" } };
  assert.equal(ledger.emit(outgoing, { principalId: "agent:claude" }).ok, true);
  assert.deepEqual(ledger.snapshot().map((message) => message.message_id), ["admit-codex", "admit-claude", "msg-1", "out-1"]);
});

test("AWARE actually enforces quiet-until-invited: a frame from an unadmitted or still-quiet member is refused, not just recorded", () => {
  const ledger = createProtocolLedger({ now: () => now, ownerId: "owner:local" });
  const neverAdmitted = base("post", { text: "hi" });
  const refused = ledger.accept(neverAdmitted, { principalId: "agent:codex" });
  assert.equal(refused.ok, false, "a post from a principal nobody admitted is refused, not just logged");
  if (!refused.ok) assert.match(refused.error, /not an active member/);

  const quietAdmit = { ...base("membership", { room_id: "room-1", member_id: "agent:codex", state: "active", requested_by: "owner:codex", invited_by: "owner:local", quiet_until_invited: true, expires_at: future }, 1, "admit-quiet"), sender: { principal_id: "owner:local", key_id: "key-0" } };
  assert.equal(ledger.accept(quietAdmit, { principalId: "owner:local" }).ok, true);
  const stillQuiet = ledger.accept(base("post", { text: "hi" }, 1, "msg-quiet"), { principalId: "agent:codex" });
  assert.equal(stillQuiet.ok, false, "an active-but-quiet member still cannot speak until invited");
  if (!stillQuiet.ok) assert.match(stillQuiet.error, /quiet until invited/);
});

test("AWARE refuses self-approval and a decision with no matching open request; only the owner may decide", () => {
  const ledger = createProtocolLedger({ now: () => now, ownerId: "owner:local" });
  const owner = (payload: Record<string, unknown>, seq: number, id: string) => ({ ...base("approval-decision", payload, seq, id), sender: { principal_id: "owner:local", key_id: "k" } });
  const orphanDecision = ledger.accept(owner({ operation_id: "never-requested", decision: "approve", approver: "owner:local" }, 1, "orphan"), { principalId: "owner:local" });
  assert.equal(orphanDecision.ok, false, "a decision with no matching open request is refused");

  const request = base("approval-request", { operation_id: "op-9", action: "submit", target: { tab_id: "tab-1" }, expires_at: future }, 1, "req-9");
  assert.equal(ledger.accept(request, { principalId: "agent:codex" }).ok, true);
  const selfApprove = ledger.accept({ ...base("approval-decision", { operation_id: "op-9", decision: "approve", approver: "agent:codex" }, 2, "self-approve"), sender: { principal_id: "agent:codex", key_id: "k" } }, { principalId: "agent:codex" });
  assert.equal(selfApprove.ok, false, "a principal cannot approve its own request");

  const notOwner = ledger.accept({ ...base("approval-decision", { operation_id: "op-9", decision: "approve", approver: "agent:claude" }, 1, "not-owner"), sender: { principal_id: "agent:claude", key_id: "k" } }, { principalId: "agent:claude" });
  assert.equal(notOwner.ok, false, "only the room owner may decide an approval request");

  const real = ledger.accept(owner({ operation_id: "op-9", decision: "approve", approver: "owner:local" }, 2, "real-decision"), { principalId: "owner:local" });
  assert.equal(real.ok, true, "the owner deciding a real open request succeeds");
  const twice = ledger.accept(owner({ operation_id: "op-9", decision: "deny", approver: "owner:local" }, 3, "twice"), { principalId: "owner:local" });
  assert.equal(twice.ok, false, "the same request cannot be decided a second time");
});

test("AWARE refuses a disclosure decision with no matching open request, and only the owner may decide one", () => {
  const ledger = createProtocolLedger({ now: () => now, ownerId: "owner:local" });
  const as = (principalId: string, type: ProtocolMessage["message_type"], payload: Record<string, unknown>, seq: number, id: string) => ({ ...base(type, payload, seq, id), sender: { principal_id: principalId, key_id: "k" } });
  const orphan = ledger.accept(as("owner:local", "disclosure-decision", { request_id: "never-asked", decision: "approve", decided_by: "owner:local", receipt_id: "r-1" }, 1, "orphan"), { principalId: "owner:local" });
  assert.equal(orphan.ok, false);

  const ask = as("agent:codex", "disclosure-request", { request_id: "d-9", asked_by: "agent:codex", subject: "notes", data_class: "own_files_named", audience: "room", proposed_text_digest: "a".repeat(64), expires_at: future }, 1, "ask-d9");
  assert.equal(ledger.accept(ask, { principalId: "agent:codex" }).ok, true);
  const wrongDecider = ledger.accept(as("agent:claude", "disclosure-decision", { request_id: "d-9", decision: "approve", decided_by: "agent:claude", receipt_id: "r-1" }, 1, "wrong"), { principalId: "agent:claude" });
  assert.equal(wrongDecider.ok, false);
  const real = ledger.accept(as("owner:local", "disclosure-decision", { request_id: "d-9", decision: "approve", decided_by: "owner:local", receipt_id: "r-1" }, 2, "real"), { principalId: "owner:local" });
  assert.equal(real.ok, true);
});

test("a stop-all frame is accepted even once the ledger is completely full, and the ledger remembers it happened", () => {
  const ledger = createProtocolLedger({ now: () => now, maxFrames: 3 });
  for (let i = 1; i <= 3; i += 1) assert.equal(ledger.accept(base("get", { resource: "x" }, i, `fill-${i}`), { principalId: "agent:codex" }).ok, true);
  const full = ledger.accept(base("get", { resource: "x" }, 4, "fill-4"), { principalId: "agent:codex" });
  assert.equal(full.ok, false, "the ledger is genuinely full for an ordinary frame");
  assert.equal(ledger.isStopped(), false);
  const stop = ledger.accept(base("stop-all", { reason: "owner hit stop" }, 5, "the-stop"), { principalId: "agent:codex" });
  assert.equal(stop.ok, true, "stop-all is accepted even when the ledger is full");
  assert.equal(ledger.isStopped(), true, "a caller can see that a real stop happened, not just a logged frame");
});

test("the emergency stop-all overflow stays singular and later stop-all frames are rejected durably", () => {
  const ledger = createProtocolLedger({ now: () => now, maxFrames: 3 });
  for (let i = 1; i <= 3; i += 1) assert.equal(ledger.accept(base("get", { resource: "x" }, i, `fill-${i}`), { principalId: "agent:codex" }).ok, true);

  const stop = base("stop-all", { reason: "owner hit stop" }, 4, "the-stop");
  assert.equal(ledger.accept(stop, { principalId: "agent:codex" }).ok, true);
  const repeated = ledger.accept(base("stop-all", { reason: "owner hit stop again" }, 5, "repeat-stop"), { principalId: "agent:codex" });
  assert.equal(repeated.ok, false, "a later stop cannot be accepted without a durable journal entry");
  assert.equal(ledger.isStopped(), true);
  assert.equal(ledger.snapshot().length, 4, "only one emergency frame may exceed the ordinary cap");
  assert.equal(ledger.snapshot().at(-1)?.message_id, "the-stop", "the overflow stop remains the durable terminal frame");

  assert.equal(ledger.accept(base("stop-all", { reason: "ID replay" }, 6, "the-stop"), { principalId: "agent:codex" }).ok, false, "a recorded stop ID cannot be replayed");
  assert.equal(ledger.accept(base("get", { resource: "after-stop" }, 5, "after-stop"), { principalId: "agent:codex" }).ok, false);

  const restarted = createProtocolLedger({ now: () => now, maxFrames: 3 });
  assert.doesNotThrow(() => restarted.restore(ledger.snapshot()));
  assert.equal(restarted.isStopped(), true, "reloading the bounded journal restores the stopped state");
  assert.equal(restarted.snapshot().length, 4);
  assert.equal(restarted.accept(base("stop-all", { reason: "same rejected later stop" }, 5, "repeat-stop"), { principalId: "agent:codex" }).ok, false, "the rejected operation remains rejected after restart");
});

test("only the owner may unilaterally admit a member as active; a member may still ask to join or leave on their own", () => {
  const ledger = createProtocolLedger({ now: () => now, ownerId: "owner:local" });
  const selfAdmit = ledger.accept({ ...base("membership", { room_id: "room-1", member_id: "agent:codex", state: "active", requested_by: "agent:codex", invited_by: "agent:codex", quiet_until_invited: false, expires_at: future }), sender: { principal_id: "agent:codex", key_id: "k" } }, { principalId: "agent:codex" });
  assert.equal(selfAdmit.ok, false, "a principal cannot declare itself active");
  const request = ledger.accept(base("membership", { room_id: "room-1", member_id: "agent:codex", state: "requested", requested_by: "agent:codex", quiet_until_invited: true, expires_at: future }, 1, "req-1"), { principalId: "agent:codex" });
  assert.equal(request.ok, true, "asking to join is always allowed");
});
