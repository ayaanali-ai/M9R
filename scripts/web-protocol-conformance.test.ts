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

const fixtures: Array<[ProtocolMessage["message_type"], Record<string, unknown>]> = [
  ["post", { text: "hello" }],
  ["get", { resource: "room-state" }],
  ["reply", { in_reply_to: "ask-1", text: "answer" }],
  ["subscribe", { room_id: "room-1" }],
  ["request-context", { site: "https://example.test", path: "/docs" }],
  ["share-artifact", { artifact_id: "artifact-1", media_type: "text/plain", digest: "a".repeat(64) }],
  ["ask", { question_id: "ask-1", to: "agent:claude", question: "Which field is the rate?" }],
  ["presence", { agent: "Codex", provider: "codex", url: "https://example.test/docs", action: "read", seq: 1 }],
  ["cursor", { tab_id: "tab-1", target: { selector: "#rate" } }],
  ["claim", { claim_id: "claim-1", tab_id: "tab-1", scope: { kind: "field", key: "#rate" }, expires_at: future }],
  ["release", { claim_id: "claim-1" }],
  ["approval-request", { operation_id: "op-1", action: "submit", target: { tab_id: "tab-1", path: "/checkout" }, expires_at: future }],
  ["approval-decision", { operation_id: "op-1", decision: "deny", approver: "owner:local" }],
  ["stop-all", { reason: "owner requested stop" }],
  ["audit-entry", { event_id: "event-1", event_type: "action.denied", previous_hash: null, hash: "b".repeat(64) }],
  ["grant", { site: "https://example.test", path: "/docs", actions: ["read"], expires_at: future, max_uses: 2, use_count: 0 }],
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
  const ledger = createProtocolLedger({ now: () => now });
  const first = base("post", { text: "one" });
  assert.equal(ledger.accept(first, { principalId: "agent:claude" }).ok, false, "authenticated transport identity must match envelope sender");
  assert.equal(ledger.accept(first, { principalId: "agent:codex" }).ok, true);
  assert.equal(ledger.accept(first, { principalId: "agent:codex" }).ok, false, "duplicate message ID must be rejected");
  assert.equal(ledger.accept(base("reply", { in_reply_to: "ask-1", text: "two" }, 1, "msg-2"), { principalId: "agent:codex" }).ok, false, "sequence rollback must be rejected");
});

test("the conformance gate rejects expired and exhausted grants", () => {
  const expired = base("grant", { site: "https://example.test", path: "/", actions: ["read"], expires_at: new Date(now).toISOString(), max_uses: 2, use_count: 0 });
  const exhausted = base("grant", { site: "https://example.test", path: "/", actions: ["read"], expires_at: future, max_uses: 2, use_count: 2 }, 2, "msg-2");
  const expiredResult = validateProtocolMessage(expired, { nowMs: now });
  const exhaustedResult = validateProtocolMessage(exhausted, { nowMs: now });
  assert.equal(expiredResult.ok, false);
  assert.equal(exhaustedResult.ok, false);
  if (!expiredResult.ok) assert.match(expiredResult.error, /expired/i);
  if (!exhaustedResult.ok) assert.match(exhaustedResult.error, /use count/i);
});

test("the conformance gate refuses oversized payloads before accepting them", () => {
  const oversized = base("post", { text: "x".repeat(17_000) });
  const result = validateProtocolMessage(oversized, { nowMs: now });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /size|large/i);
});

test("the local reference ledger accepts and emits validated v0 frames without changing their payload", () => {
  const ledger = createProtocolLedger({ now: () => now });
  const incoming = base("ask", { question_id: "ask-1", to: "agent:claude", question: "Need the rate" });
  assert.equal(ledger.accept(incoming, { principalId: "agent:codex" }).ok, true);
  const outgoing = { ...base("reply", { in_reply_to: "ask-1", text: "12+" }, 1, "out-1"), sender: { principal_id: "agent:claude", key_id: "key-2" } };
  assert.equal(ledger.emit(outgoing, { principalId: "agent:claude" }).ok, true);
  assert.deepEqual(ledger.snapshot().map((message) => message.message_id), ["msg-1", "out-1"]);
});
