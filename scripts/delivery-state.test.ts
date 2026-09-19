import assert from "node:assert/strict";
import test from "node:test";
import { ALLOWED_TRANSITIONS, DELIVERY_STATES, applyTransition, deriveDelivery, type DeliveryRecipient, type TimingEvidence } from "@/lib/delivery-state";

const T0 = Date.parse("2026-09-19T05:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
const CREATED = at(0);

const claude: DeliveryRecipient = { provider: "claude-code", address: "@claude-code", endpointId: "ep_1", live: true, fidelityLevel: "LIVE_NATIVE" };

function ev(stage: string, seconds: number, extra: Partial<TimingEvidence> = {}): TimingEvidence {
  return { stage, provider: "claude-code", occurred_at: at(seconds), at_ms: T0 + seconds * 1000, ...extra };
}

const derive = (timings: TimingEvidence[], over: Partial<{ recipient: DeliveryRecipient; nowSeconds: number }> = {}) =>
  deriveDelivery({ messageCreatedAt: CREATED, recipient: over.recipient ?? claude, timings, now: T0 + (over.nowSeconds ?? 60) * 1000 });

const states = (view: ReturnType<typeof derive>) => view.timeline.map((entry) => entry.state);

test("a live recipient with no Bridge evidence is only accepted: nothing is claimed from absence", () => {
  const view = derive([]);
  assert.equal(view.state, "accepted");
  assert.deepEqual(states(view), ["accepted"]);
  assert.equal(view.terminal, false);
});

test("an offline recipient is queued, and an old enough unreceived message is expired (terminal)", () => {
  const offline = { ...claude, live: false };
  assert.equal(derive([], { recipient: offline }).state, "queued");
  const expired = derive([], { recipient: offline, nowSeconds: 24 * 3600 + 5 });
  assert.equal(expired.state, "expired");
  assert.equal(expired.terminal, true);
  assert.deepEqual(states(expired), ["accepted", "expired"]);
});

test("the real happy path, with the Bridge re-offering the message, yields one clean ordered timeline", () => {
  const view = derive([
    ev("message.received", 1), ev("message.received", 5), ev("session.ready", 6), ev("message.enqueued", 6),
    ev("prompt.started", 7), ev("provider.first_event", 11), ev("turn.completed", 11, { metadata: { outcome: "ok" } }),
    ev("report.observed", 14), ev("message.received", 15), ev("fallback_report.posted", 15),
  ]);
  assert.deepEqual(states(view), ["accepted", "delivered_to_node", "delivered_to_session", "processing", "completed"]);
  assert.equal(view.state, "completed");
  assert.equal(view.terminal, true);
  assert.equal(view.attempt, 1);
  assert.ok(view.timeline.every((entry) => entry.attempt === 1));
  const node = view.timeline.find((entry) => entry.state === "delivered_to_node");
  assert.equal(node?.basis, "observed");
  assert.equal(node?.persisted, false, "no local ledger exists yet, so the receipt is never presented as persisted");
});

test("delivered_to_node is persisted only when the Bridge said it wrote its ledger first", () => {
  const withLedger = derive([ev("message.received", 1, { metadata: { ledger: true } })]);
  assert.equal(withLedger.timeline.find((entry) => entry.state === "delivered_to_node")?.persisted, true);
  const without = derive([ev("message.received", 1)]);
  assert.equal(without.timeline.find((entry) => entry.state === "delivered_to_node")?.persisted, false);
  const implied = derive([ev("prompt.started", 2, { metadata: { ledger: true } })]);
  assert.equal(implied.timeline.find((entry) => entry.state === "delivered_to_node")?.persisted, false, "an implied receipt is never called persisted");
});

test("a later stage implies the earlier ones, marked implied and never observed", () => {
  const view = derive([ev("turn.completed", 20, { metadata: { outcome: "ok" } })]);
  assert.deepEqual(states(view), ["accepted", "delivered_to_node", "delivered_to_session", "processing", "completed"]);
  assert.deepEqual(view.timeline.slice(1, 4).map((entry) => entry.basis), ["implied", "implied", "implied"]);
  assert.equal(view.timeline[4].basis, "observed");
});

test("a prompt that started without a stored receipt still shows the node hop as implied", () => {
  const view = derive([ev("prompt.started", 7)]);
  assert.deepEqual(states(view), ["accepted", "delivered_to_node", "delivered_to_session"]);
  assert.equal(view.state, "delivered_to_session");
  assert.equal(view.timeline[1].basis, "implied");
});

test("a failed turn is failed with its code, is not terminal, and a later receipt is attempt 2", () => {
  const first = derive([ev("message.received", 1), ev("prompt.started", 2), ev("turn.failed", 5)]);
  assert.equal(first.state, "failed");
  assert.equal(first.failureCode, "turn_failed");
  assert.equal(first.terminal, false);

  const retried = derive([
    ev("message.received", 1), ev("prompt.started", 2), ev("turn.failed", 5),
    ev("message.received", 30), ev("prompt.started", 31), ev("provider.first_event", 33), ev("turn.completed", 40, { metadata: { outcome: "ok" } }),
  ]);
  assert.equal(retried.state, "completed");
  assert.equal(retried.attempt, 2);
  assert.equal(retried.failureCode, null);
  assert.deepEqual(retried.timeline.filter((entry) => entry.attempt === 2).map((entry) => entry.state), ["delivered_to_node", "delivered_to_session", "processing", "completed"]);
});

test("turn.completed with a failed outcome is a failure", () => {
  assert.equal(derive([ev("message.received", 1), ev("turn.completed", 4, { metadata: { outcome: "failed" } })]).failureCode, "turn_failed");
});

test("turn.rejected is a Bridge decline, not a failure: state stays at the node, a note is added, and declined is set until something progresses", () => {
  const view = derive([ev("message.received", 1), ev("turn.rejected", 2)]);
  assert.equal(view.state, "delivered_to_node");
  assert.equal(view.failureCode, null);
  assert.equal(view.declined, true);
  assert.equal(view.notes.length, 1);
  assert.match(view.notes[0].meaning, /did not run it this time/);
  assert.equal(view.timeline.some((entry) => entry.state === "failed"), false);
});

test("the real deferred-then-succeeded shape: declines are kept as notes and the delivery still completes", () => {
  const view = derive([
    ev("message.received", 1), ev("turn.rejected", 1), ev("message.received", 2), ev("turn.rejected", 2),
    ev("provider.first_event", 20), ev("turn.completed", 20, { metadata: { outcome: "ok" } }),
  ]);
  assert.equal(view.state, "completed");
  assert.equal(view.declined, false);
  assert.equal(view.notes.length, 2);
  assert.equal(view.attempt, 1);
  assert.deepEqual(states(view), ["accepted", "delivered_to_node", "delivered_to_session", "processing", "completed"]);
});

test("another provider's evidence is ignored; evidence with no provider counts", () => {
  const view = derive([ev("message.received", 1, { provider: "codex" }), ev("prompt.started", 2, { provider: "codex" })]);
  assert.equal(view.state, "accepted");
  const unlabeled = derive([ev("message.received", 1, { provider: null })]);
  assert.equal(unlabeled.state, "delivered_to_node");
});

test("a receipt reported by another provider's local Bridge is not evidence that the recipient's node got the message", () => {
  const view = derive([
    ev("message.received", 1, { bridge_instance_id: "local-codex-1111" }),
    ev("message.received", 2, { bridge_instance_id: "local-claude-code-2222", metadata: { ledger: true } }),
    ev("prompt.started", 5, { bridge_instance_id: "local-claude-code-2222" }),
  ]);
  const node = view.timeline.filter((entry) => entry.state === "delivered_to_node");
  assert.equal(node.length, 1);
  assert.equal(node[0].at, at(2), "only the recipient's own Bridge counts");
  assert.equal(node[0].persisted, true);
  const onlyForeign = derive([ev("message.received", 1, { bridge_instance_id: "local-codex-1111" })]);
  assert.equal(onlyForeign.state, "accepted", "a foreign receipt alone proves nothing");
});

test("Bridges that do not use the local naming (cloud Bridges) are still accepted", () => {
  assert.equal(derive([ev("message.received", 1, { bridge_instance_id: "bridge-4f2a" })]).state, "delivered_to_node");
  assert.equal(derive([ev("message.received", 1, { bridge_instance_id: null })]).state, "delivered_to_node");
});

test("stages that are not delivery states never change the state", () => {
  const view = derive([ev("session.ready", 1), ev("message.enqueued", 1), ev("report.observed", 2), ev("fallback_report.posted", 3)]);
  assert.equal(view.state, "accepted");
});

test("consultation and resumable fidelity are flagged; a resumable receipt waits for the turn boundary", () => {
  const consult = derive([ev("message.received", 1)], { recipient: { ...claude, fidelityLevel: "CONSULTATION" } });
  assert.equal(consult.viaConsultation, true);
  const resumable = derive([ev("message.received", 1)], { recipient: { ...claude, fidelityLevel: "RESUMABLE_NATIVE" } });
  assert.equal(resumable.pendingUntilTurnBoundary, true);
  assert.equal(derive([ev("message.received", 1)]).pendingUntilTurnBoundary, false);
});

test("the transition table: forward steps, no-op repeats, retry from failed, and refused jumps", () => {
  assert.deepEqual(applyTransition("accepted", "delivered_to_node"), { ok: true, state: "delivered_to_node", noop: false });
  assert.deepEqual(applyTransition("processing", "processing"), { ok: true, state: "processing", noop: true });
  assert.deepEqual(applyTransition("failed", "delivered_to_node"), { ok: true, state: "delivered_to_node", noop: false });
  assert.deepEqual(applyTransition("accepted", "completed"), { ok: false, state: "accepted", error: "invalid_transition" });
  assert.deepEqual(applyTransition("delivered_to_node", "processing"), { ok: false, state: "delivered_to_node", error: "invalid_transition" });
  for (const terminal of ["completed", "expired", "rejected", "cancelled"] as const) {
    for (const next of DELIVERY_STATES) if (next !== terminal) assert.equal(applyTransition(terminal, next).ok, false, `${terminal} -> ${next}`);
  }
  assert.deepEqual(Object.keys(ALLOWED_TRANSITIONS).sort(), [...DELIVERY_STATES].sort());
});
