import assert from "node:assert/strict";
import test from "node:test";
import { normalizeManagedProviderProfile } from "@/lib/native/managed-provider-contract";
import { createManagedProviderRuntime } from "@/lib/native/managed-provider-runtime";

function profile(handle: string, cwd = "C:/Work/Project") {
  return normalizeManagedProviderProfile({ handle, provider: handle, cwd });
}

test("owns one generation and fences stale provider callbacks", () => {
  const runtime = createManagedProviderRuntime([
    { profile: profile("claude"), status: "ready", doing: "Ready" },
  ]);

  const first = runtime.beginStart("m9r:claude:claude:c%3A%2Fwork%2Fproject");
  assert.equal(first, 1);
  assert.equal(runtime.transitionFor("m9r:claude:claude:c%3A%2Fwork%2Fproject", first, "working", "Working"), true);
  assert.equal(runtime.transitionFor("m9r:claude:claude:c%3A%2Fwork%2Fproject", first - 1, "ready", "Stale"), false);
  assert.equal(runtime.snapshot("m9r:claude:claude:c%3A%2Fwork%2Fproject")?.status, "working");
  assert.equal(runtime.snapshot("m9r:claude:claude:c%3A%2Fwork%2Fproject")?.doing, "Working");
});

test("stop invalidates the running generation before the provider exits", () => {
  const runtime = createManagedProviderRuntime([
    { profile: profile("codex"), status: "ready", doing: "Ready" },
  ]);
  const id = "m9r:codex:codex:c%3A%2Fwork%2Fproject";
  const generation = runtime.beginStart(id);
  const stoppingGeneration = runtime.beginStop(id);

  assert.equal(stoppingGeneration, generation + 1);
  assert.equal(runtime.isCurrent(id, generation), false);
  assert.equal(runtime.isStopping(id), true);
  assert.equal(runtime.snapshot(id)?.status, "draining");
  assert.equal(runtime.transitionFor(id, generation, "failed", "late failure"), false);

  runtime.finishStop(id, stoppingGeneration, "Stopped by you");
  assert.equal(runtime.isStopping(id), false);
  assert.equal(runtime.snapshot(id)?.status, "stopped");
  assert.equal(runtime.snapshot(id)?.doing, "Stopped by you");
});

test("tracks active task ownership without exposing private process state", () => {
  const runtime = createManagedProviderRuntime([
    { profile: profile("opencode"), status: "ready", doing: "Ready" },
  ]);
  const id = "m9r:opencode:opencode:c%3A%2Fwork%2Fproject";
  const generation = runtime.beginStart(id);

  assert.equal(runtime.claimTask(id, generation, "T-runtime-1"), true);
  assert.equal(runtime.claimTask(id, generation, "T-runtime-2"), false);
  assert.equal(runtime.snapshot(id)?.activeTaskId, "T-runtime-1");
  assert.equal(runtime.clearTask(id, generation, "T-runtime-2"), false);
  assert.equal(runtime.clearTask(id, generation, "T-runtime-1"), true);
  assert.equal(runtime.snapshot(id)?.activeTaskId, undefined);

  const snapshot = runtime.snapshot(id);
  assert(snapshot);
  assert.equal("token" in snapshot, false);
  assert.equal("processId" in snapshot, false);
  assert.equal("providerSessionRef" in snapshot, false);
});

test("rejects duplicate logical connections and profile drift", () => {
  const first = profile("claude");
  const runtime = createManagedProviderRuntime([{ profile: first }]);

  assert.throws(() => runtime.register({ profile: first }), /already registered/);
  assert.throws(() => runtime.register({ profile: { ...profile("claude", "C:/Other"), connectionId: first.connectionId } }), /already registered/);
  assert.deepEqual(runtime.snapshots().map((entry) => entry.connectionId), [first.connectionId]);
});
