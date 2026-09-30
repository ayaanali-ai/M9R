import assert from "node:assert/strict";
import test from "node:test";

import { createTurnScheduler } from "@/lib/native/turn-scheduler-core";

test("a lone pending agent gets the turn immediately", () => {
  const scheduler = createTurnScheduler();
  scheduler.register("claude");
  scheduler.setPending("claude", true);
  assert.equal(scheduler.requestTurn("claude").granted, true);
  assert.equal(scheduler.currentHolder(), "claude");
});

test("an agent with no pending work is never granted a turn", () => {
  const scheduler = createTurnScheduler();
  scheduler.register("claude");
  const result = scheduler.requestTurn("claude");
  assert.equal(result.granted, false);
  assert.equal(result.reason, "claude has no pending work");
});

test("default burst size is one action, then the turn moves to the next pending agent", () => {
  const scheduler = createTurnScheduler();
  scheduler.register("claude");
  scheduler.register("codex");
  scheduler.setPending("claude", true);
  scheduler.setPending("codex", true);
  assert.equal(scheduler.requestTurn("claude").granted, true);
  const after = scheduler.recordAction("claude");
  assert.deepEqual(after, { ok: true, yielded: true });
  assert.equal(scheduler.currentHolder(), "codex");
});

test("round robin is fair: it does not restart from the front after every yield", () => {
  const scheduler = createTurnScheduler();
  for (const id of ["a", "b", "c"]) {
    scheduler.register(id);
    scheduler.setPending(id, true);
  }
  const holders: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    const holder = scheduler.currentHolder();
    assert.ok(holder);
    holders.push(holder!);
    scheduler.recordAction(holder!);
  }
  assert.deepEqual(holders, ["a", "b", "c", "a", "b", "c"]);
});

test("an agent that goes idle mid-rotation is skipped, not stalled on", () => {
  const scheduler = createTurnScheduler();
  for (const id of ["a", "b", "c"]) {
    scheduler.register(id);
    scheduler.setPending(id, true);
  }
  assert.equal(scheduler.currentHolder(), "a");
  scheduler.recordAction("a");
  scheduler.setPending("b", false); // b finished its subtask between a's turn and now
  assert.equal(scheduler.currentHolder(), "c");
  scheduler.recordAction("c");
  assert.equal(scheduler.currentHolder(), "a", "b stays skipped until it has pending work again");
});

test("a process-per-message agent gets a larger burst so it is not restarted every single action", () => {
  const scheduler = createTurnScheduler();
  scheduler.register("codex", { burstSize: 4 });
  scheduler.register("claude", { burstSize: 1 });
  scheduler.setPending("codex", true);
  scheduler.setPending("claude", true);
  assert.equal(scheduler.currentHolder(), "codex");
  for (let i = 0; i < 3; i += 1) {
    const result = scheduler.recordAction("codex");
    assert.equal(result.yielded, false, `codex should keep its turn through action ${i + 1} of 4`);
  }
  assert.equal(scheduler.currentHolder(), "codex", "codex still holds the turn before its 4th action");
  const last = scheduler.recordAction("codex");
  assert.equal(last.yielded, true);
  assert.equal(scheduler.currentHolder(), "claude");
});

test("an agent can yield early without waiting out its full burst", () => {
  const scheduler = createTurnScheduler();
  scheduler.register("codex", { burstSize: 4 });
  scheduler.register("claude");
  scheduler.setPending("codex", true);
  scheduler.setPending("claude", true);
  scheduler.currentHolder();
  scheduler.recordAction("codex");
  scheduler.yieldTurn("codex");
  assert.equal(scheduler.currentHolder(), "claude");
});

test("recordAction and yieldTurn from a non-holder are no-ops", () => {
  const scheduler = createTurnScheduler();
  scheduler.register("a");
  scheduler.register("b");
  scheduler.setPending("a", true);
  scheduler.setPending("b", true);
  assert.equal(scheduler.currentHolder(), "a");
  const result = scheduler.recordAction("b");
  assert.deepEqual(result, { ok: false, yielded: false });
  assert.equal(scheduler.currentHolder(), "a");
  scheduler.yieldTurn("b");
  assert.equal(scheduler.currentHolder(), "a");
});

test("unregistering the current holder releases the turn to the next pending agent", () => {
  const scheduler = createTurnScheduler();
  scheduler.register("a");
  scheduler.register("b");
  scheduler.setPending("a", true);
  scheduler.setPending("b", true);
  assert.equal(scheduler.currentHolder(), "a");
  scheduler.unregister("a");
  assert.equal(scheduler.currentHolder(), "b");
});

test("a stale holder past its max hold time is released so it never stalls the fleet forever", () => {
  let clock = 1_000;
  const scheduler = createTurnScheduler({ now: () => clock });
  scheduler.register("a", { burstSize: 10 });
  scheduler.register("b");
  scheduler.setPending("a", true);
  scheduler.setPending("b", true);
  assert.equal(scheduler.currentHolder(), "a");
  assert.equal(scheduler.releaseIfStale(5_000), false, "not stale yet");
  clock += 6_000;
  assert.equal(scheduler.releaseIfStale(5_000), true);
  assert.equal(scheduler.currentHolder(), "b");
});

test("requesting a turn while another agent holds it names the current holder", () => {
  const scheduler = createTurnScheduler();
  scheduler.register("a");
  scheduler.register("b");
  scheduler.setPending("a", true);
  scheduler.setPending("b", true);
  scheduler.currentHolder();
  const result = scheduler.requestTurn("b");
  assert.equal(result.granted, false);
  assert.equal(result.holder, "a");
  assert.equal(result.reason, "waiting on @a");
});

test("snapshot reports each agent's pending state, holder status, and burst progress", () => {
  const scheduler = createTurnScheduler();
  scheduler.register("a", { burstSize: 2 });
  scheduler.register("b");
  scheduler.setPending("a", true);
  scheduler.currentHolder();
  scheduler.recordAction("a");
  const snap = scheduler.snapshot();
  assert.deepEqual(snap, [
    { id: "a", pending: true, isHolder: true, burstSize: 2, actionsTakenThisTurn: 1 },
    { id: "b", pending: false, isHolder: false, burstSize: 1, actionsTakenThisTurn: 0 },
  ]);
});

test("burst size is clamped to a sane minimum of one", () => {
  const scheduler = createTurnScheduler();
  scheduler.register("a", { burstSize: 0 });
  scheduler.setPending("a", true);
  scheduler.currentHolder();
  const result = scheduler.recordAction("a");
  assert.equal(result.yielded, true, "a burst of zero must still grant at least one action before yielding");
});

test("one tab scheduler can keep independent claim-scope lanes moving independently", () => {
  const scheduler = createTurnScheduler();
  const profile = scheduler.forLane("form:profile");
  const search = scheduler.forLane("field:search");
  profile.register("claude");
  profile.register("codex");
  search.register("gemini");
  search.register("opencode");
  profile.setPending("claude", true);
  profile.setPending("codex", true);
  search.setPending("gemini", true);
  search.setPending("opencode", true);

  assert.equal(profile.currentHolder(), "claude");
  assert.equal(search.currentHolder(), "gemini", "another contested scope in the same tab gets its own turn");
  assert.equal(profile.recordAction("claude").yielded, true);
  assert.equal(profile.currentHolder(), "codex");
  assert.equal(search.currentHolder(), "gemini", "progress in the profile lane does not rotate the search lane");
});
