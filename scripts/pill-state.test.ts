import assert from "node:assert/strict";
import test from "node:test";
import { State, type PillSnapshot } from "../pill/src/core/state";
import { mentionAt } from "../pill/src/views/composer";

const snap = (over: Partial<PillSnapshot> = {}): PillSnapshot => ({
  agents: [
    { handle: "claude", provider: "claude", state: "working", activity: ["a", "b"] },
    { handle: "codex", provider: "codex", state: "idle", activity: [] },
  ],
  approvals: [],
  thread: [],
  ...over,
});

test("the first snapshot hydrates chat without triggering arrival effects; later replies are new", () => {
  const earlier = { id: "t0", from: "m9r", text: "Earlier result" };
  const first = State.apply(snap({ thread: [earlier] }));
  assert.deepEqual(first.newReplies, []);
  assert.deepEqual(State.chatHistory.map((message) => message.content), ["m9r: Earlier result"]);
  const later = State.apply(snap({ thread: [earlier, { id: "t1", from: "claude", text: "done" }] }));
  assert.equal(later.newReplies.length, 1);
  const again = State.apply(snap({ thread: [earlier, { id: "t1", from: "claude", text: "done" }] }));
  assert.equal(again.newReplies.length, 0, "the same reply is not reported twice");
  const more = State.apply(snap({ thread: [earlier, { id: "t1", from: "claude", text: "done" }, { id: "t2", from: "codex", text: "ok" }] }));
  assert.deepEqual(more.newReplies.map((m) => m.id), ["t2"]);
});

test("a broker disconnect clears stale agent activity but preserves the conversation", () => {
  const before = State.chatHistory.map((message) => message.content);
  State.apply(snap({ connection: "connected" }));
  State.apply(snap({ agents: [], approvals: [], thread: [], connection: "disconnected" }));
  assert.equal(State.brokerConnection, "disconnected");
  assert.equal(State.tasks.length, 0, "disconnected agent states are not left looking active");
  assert.deepEqual(State.chatHistory.map((message) => message.content), before);
});

test("the broker echo acknowledges the existing outgoing message without duplicating it", () => {
  const outgoing = { id: 50, role: "user" as const, content: "@codex Check the note", delivery: "sending" as const };
  State.chatHistory.push(outgoing);
  const update = State.apply(snap({ thread: [{ id: "owner-echo", from: "you", text: outgoing.content }] }));
  assert.deepEqual(update.newReplies, []);
  assert.equal(State.chatHistory.filter(message => message.content === outgoing.content).length, 1);
  assert.equal(State.chatHistory.find(message => message.id === outgoing.id)?.delivery, "accepted");
});

test("approvals are reported once, queue in order, and mark the asking agent", () => {
  const now = Date.now();
  const a1 = { id: "a1", agent: "codex", title: "Post", detail: "Click Post" };
  const a2 = { id: "a2", agent: "claude", title: "Buy", detail: "Click Buy" };
  const first = State.apply(snap({ approvals: [a1] }), now);
  assert.deepEqual(first.newApprovals, ["a1"]);
  assert.equal(State.pendingApproval?.id, "a1");
  assert.equal(State.tasks.find((t) => t.id === "codex")?.state, "approval");
  const second = State.apply(snap({ approvals: [a1, a2] }), now + 1);
  assert.deepEqual(second.newApprovals, ["a2"], "only the new one is reported");
  assert.equal(State.approvals.length, 2);
  State.apply(snap({ approvals: [] }), now + 2);
  assert.equal(State.approvals.length, 2, "an empty or partial snapshot does not erase a recently visible approval");
  assert.equal(State.pendingApproval?.id, "a1");
  assert.equal(State.pendingApproval?.unconfirmed, true);
  assert.equal(State.tasks.find((t) => t.id === "codex")?.state, "approval");
  assert.equal(State.defaultView(), "approval");
  const recovered = State.apply(snap({ approvals: [a1, a2] }), now + 3);
  assert.deepEqual(recovered.newApprovals, [], "a returning approval is not alerted twice");
  assert.equal(State.pendingApproval?.unconfirmed, false);
  State.setDecisionError("a1", "broker unavailable");
  assert.deepEqual(State.decisionError, { approvalId: "a1", message: "broker unavailable" });
  State.resolveApproval("a1", now + 4);
  assert.equal(State.decisionError, null, "resolving the same approval clears its delivery error");
  State.resolveApproval("a2", now + 4);
  State.apply(snap({ approvals: [a1, a2] }), now + 5);
  assert.equal(State.approvals.length, 0, "accepted owner decisions suppress stale snapshots from restoring old cards");
  assert.equal(State.defaultView(), "overview");
});

test("agent run states map to display states; idle is availability, not a completion receipt", () => {
  State.apply(snap({ agents: [{ handle: "claude", provider: "claude", state: "working", activity: ["x"] }] }));
  State.apply(snap({ agents: [{ handle: "claude", provider: "claude", state: "idle", activity: ["x", "done"] }] }));
  assert.equal(State.tasks[0].pillBadge, null, "a provider snapshot's idle state is availability, not a task completion receipt");
  State.apply(snap({ agents: [{ handle: "claude", provider: "claude", state: "failed", activity: [] }] }));
  assert.equal(State.tasks[0].state, "error");
  assert.equal(State.tasks[0].pillBadge, "error");
});

test("mention detection finds the @handle being typed at the caret and nothing inside words or emails", () => {
  assert.deepEqual(mentionAt("@cl", 3), { start: 0, partial: "cl" });
  assert.deepEqual(mentionAt("ask @cod", 8), { start: 4, partial: "cod" });
  assert.equal(mentionAt("me@example.com", 14), null);
  assert.equal(mentionAt("hello", 5), null);
  assert.equal(mentionAt("@claude hi", 10), null, "a finished mention followed by text is not being typed");
});

test("conversation speaker and recipient survive hydration and streamed updates", () => {
  State.apply(snap({ thread: [{ id: "peer-participants", from: "claude", to: "codex", text: "Let's agree on a plan." }] }));
  let message = State.chatHistory.find(entry => entry.sourceId === "peer-participants")!;
  assert.equal(message.from, "claude");
  assert.equal(message.to, "codex");
  State.apply(snap({ thread: [{ id: "peer-participants", from: "claude", to: "codex", text: "Let's agree on a plan.\nI'll draft; you verify." }] }));
  message = State.chatHistory.find(entry => entry.sourceId === "peer-participants")!;
  assert.equal(State.chatHistory.filter(entry => entry.sourceId === "peer-participants").length, 1);
  assert.ok(message.content.includes("\n"));
  assert.equal(message.to, "codex");
});
