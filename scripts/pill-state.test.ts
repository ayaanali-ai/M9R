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

test("the first snapshot is a baseline; a reply that arrives later on an empty thread is new", () => {
  const first = State.apply(snap());
  assert.deepEqual(first.newReplies, []);
  const later = State.apply(snap({ thread: [{ id: "t1", from: "claude", text: "done" }] }));
  assert.equal(later.newReplies.length, 1);
  const again = State.apply(snap({ thread: [{ id: "t1", from: "claude", text: "done" }] }));
  assert.equal(again.newReplies.length, 0, "the same reply is not reported twice");
  const more = State.apply(snap({ thread: [{ id: "t1", from: "claude", text: "done" }, { id: "t2", from: "codex", text: "ok" }] }));
  assert.deepEqual(more.newReplies.map((m) => m.id), ["t2"]);
});

test("approvals are reported once, queue in order, and mark the asking agent", () => {
  const a1 = { id: "a1", agent: "codex", title: "Post", detail: "Click Post" };
  const a2 = { id: "a2", agent: "claude", title: "Buy", detail: "Click Buy" };
  const first = State.apply(snap({ approvals: [a1] }));
  assert.deepEqual(first.newApprovals, ["a1"]);
  assert.equal(State.pendingApproval?.id, "a1");
  assert.equal(State.tasks.find((t) => t.id === "codex")?.state, "approval");
  const second = State.apply(snap({ approvals: [a1, a2] }));
  assert.deepEqual(second.newApprovals, ["a2"], "only the new one is reported");
  assert.equal(State.approvals.length, 2);
  State.apply(snap({ approvals: [] }));
  assert.equal(State.pendingApproval, null);
  assert.equal(State.defaultView(), "overview");
});

test("agent run states map to display states, and a finished run earns a finished badge", () => {
  State.apply(snap({ agents: [{ handle: "claude", provider: "claude", state: "working", activity: ["x"] }] }));
  State.apply(snap({ agents: [{ handle: "claude", provider: "claude", state: "idle", activity: ["x", "done"] }] }));
  assert.equal(State.tasks[0].pillBadge, "finished");
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
