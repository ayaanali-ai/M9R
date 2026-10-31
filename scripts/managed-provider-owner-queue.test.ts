import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createManagedProviderOwner } from "@/lib/native/managed-provider-owner";
import { createLocalStore } from "@/lib/native/local-store";
import type {
  ManagedProviderConnection,
  ManagedProviderConnectionProfile,
  ManagedProviderConnectionSnapshot,
  ManagedProviderEvent,
  ManagedProviderModelApply,
} from "@/lib/native/managed-provider-contract";

/** A connection whose `send` blocks on a gate the test controls, so a turn can be held "active"
 * long enough to queue a follow-up message and then stop/pause before letting it finish. */
function gatedConnection(profile: ManagedProviderConnectionProfile) {
  let generation = 0;
  let status: ManagedProviderConnectionSnapshot["status"] = "stopped";
  let release = () => {};
  let gate: Promise<void> | undefined = new Promise<void>((resolve) => { release = resolve; });
  const modelApply: ManagedProviderModelApply = { ok: true, applies: "next-turn" };
  const connection: ManagedProviderConnection = {
    profile,
    start: async () => { generation += 1; status = "ready"; return { connectionId: profile.connectionId, generation }; },
    send: async function* (): AsyncIterable<ManagedProviderEvent> {
      yield { kind: "accepted" };
      if (gate) await gate;
      yield { kind: "result", text: "done", isError: false };
    },
    interrupt: async () => undefined,
    cancel: async () => undefined,
    pause: async () => undefined,
    resume: async () => undefined,
    status: () => ({ ...profile, status, generation }),
    readiness: () => ({ healthy: status === "ready" }),
    capabilities: () => ({ connectionId: profile.connectionId, provider: profile.provider, generation, models: [], currentModel: null, currentEffort: null }),
    applyModelSelection: async () => modelApply,
    continuation: () => undefined,
    drain: async () => undefined,
    stop: async () => { status = "stopped"; },
  };
  return {
    connection,
    /** Hold the next/current turn's `send` open until `release()` is called. */
    holdOpen() { gate = new Promise<void>((resolve) => { release = resolve; }); },
    release() { release(); },
  };
}

test("stopping an agent drops its queued follow-up, so the very next message runs instead of a stale one", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-owner-queue-"));
  const store = createLocalStore(root);
  let gated: ReturnType<typeof gatedConnection> | undefined;

  const owner = createManagedProviderOwner({
    agents: [{ handle: "codex", provider: "codex", folder: root }],
    storeRoot: root,
    repoRoot: root,
    brokerPort: 0,
    store,
    createConnection: (profile) => (gated = gatedConnection(profile)).connection,
    onEvent: (event) => { if (process.env.M9R_TEST_DEBUG) console.log("EVENT", JSON.stringify(event)); },
  });

  try {
    // Turn A starts; the fake connection is held ("working") until released.
    const first = owner.deliver("codex", "A: do the first thing");
    assert.equal((await first).ok, true);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // B arrives while A is still active -> queued behind A, and A's turn is interrupted.
    const second = await owner.deliver("codex", "B: do the second thing");
    assert.equal(second.ok, true);
    assert.equal((second as { mode: string }).mode, "interrupted");

    // The owner now says stop. This must drop B -- B is exactly the stale message the
    // owner is trying to get away from, not what they want to run next.
    owner.stop("codex");

    // Let A's turn actually finish draining now that it has been fenced/interrupted.
    gated!.release();
    await new Promise((resolve) => setTimeout(resolve, 20));

    // A fresh message C should run next, not the stale queued B.
    gated!.holdOpen();
    const third = await owner.deliver("codex", "C: do the real next thing");
    assert.equal(third.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Tasks are assigned sequential ids (T1=A, T2=B, T3=C) in a fresh store.
    const taskC = store.getTask?.("T3");
    assert.equal(taskC?.goal, "C: do the real next thing", "C must have been delivered as the third task");
    assert.ok(["queued", "done"].includes(taskC?.delivery?.state ?? ""), "sanity: C actually reached provider delivery");

    const taskB = store.getTask?.("T2");
    assert.equal(taskB?.goal, "B: do the second thing");
    assert.equal(taskB?.receipt?.state, "canceled", "B must be canceled by the stop, not silently started later");

    gated!.release();
  } finally {
    await owner.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});
