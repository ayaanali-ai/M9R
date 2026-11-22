import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMultiplayerDispatchFence, desktopMutationTarget, desktopWindowMutationTarget } from "@/lib/native/multiplayer-dispatch-fence";
import { createLocalStore } from "@/lib/native/local-store";

test("a hung dispatch whose lease expires does not block refresh/observe forever -- only until a bounded staleness window passes", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-fence-"));
  let clock = 0;
  const store = createLocalStore(root, { now: () => new Date(clock) });
  const leaseTtlMs = 300;
  const fence = createMultiplayerDispatchFence({ store, now: () => clock, leaseTtlMs });
  const target = desktopMutationTarget();

  try {
    // Begin a mutating action and never commit or abort it -- this simulates a true hang in the
    // OS input driver, the exact case the heartbeat's lease-expiry path exists to detect.
    const begun = fence.begin({ agent: "codex", provider: "codex", sessionId: "s1", operationId: "op-1", target });
    assert.equal(begun.ok, true);

    // Let the real heartbeat (interval timers are real wall-clock, independent of the injected
    // `now`) fire at least once after the lease's injected clock has already expired, so it marks
    // the surface uncertain via the lease-expiry path (dispatchFinished = false).
    clock = leaseTtlMs + 50;
    await new Promise((resolve) => setTimeout(resolve, Math.ceil(leaseTtlMs / 3) + 100));

    // The surface is now unresolved and still "in flight" per the heartbeat's own bookkeeping:
    // a fresh begin() on the same surface must refuse, and an immediate observe must not clear it
    // -- the underlying dispatch could still land at any moment.
    const tooSoon = fence.begin({ agent: "codex", provider: "codex", sessionId: "s1", operationId: "op-2", target });
    assert.equal(tooSoon.ok, false);
    if (!tooSoon.ok) assert.equal(tooSoon.code, "surface-unresolved");
    const revisionBefore = fence.surfaceRevision(target.surfaceId);
    assert.equal(fence.observeSurface(target.surfaceId), revisionBefore, "too soon after lease expiry: observe must not clear it yet");

    // Once comfortably past the bounded staleness window (5x the lease TTL), a fresh observation
    // must be able to recover the surface -- otherwise a genuinely hung driver blocks every future
    // action on that surface forever, with no way out short of restarting the whole broker.
    clock += leaseTtlMs * 6;
    const revisionAfter = fence.observeSurface(target.surfaceId);
    assert.notEqual(revisionAfter, revisionBefore, "past the staleness window, observe must advance the surface and release it");

    const recovered = fence.begin({ agent: "codex", provider: "codex", sessionId: "s1", operationId: "op-3", target });
    assert.equal(recovered.ok, true, "a new action on the surface must be allowed once the stale hang has been recovered from");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("different semantic fields share one window concurrently while the same field and whole-window mutations conflict", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-region-fence-"));
  const fence = createMultiplayerDispatchFence({ store: createLocalStore(root) });
  const title = desktopWindowMutationTarget({ pid: 123, windowId: "456", processGeneration: "aabb", regionId: "title" });
  const caption = desktopWindowMutationTarget({ pid: 123, windowId: "456", processGeneration: "aabb", regionId: "caption" });
  const begin = (operationId: string, target = title, agent = "codex", expectedRegionRevision = 0) => fence.begin({ agent, provider: agent,
    sessionId: `${agent}-session`, operationId, target, expectedMutationRevision: 0, expectedRegionRevision });
  const a = begin("a"); const b = begin("b", caption, "claude");
  try {
    assert.equal(title.surfaceId, caption.surfaceId);
    assert.notEqual(title.targetId, caption.targetId);
    assert.equal(a.ok, true); assert.equal(b.ok, true);
    assert.equal(begin("same-field", title, "claude").ok, false);
    assert.equal(fence.begin({ agent: "third", provider: "third", sessionId: "third", operationId: "whole",
      target: desktopWindowMutationTarget({ pid: 123, windowId: "456", processGeneration: "aabb" }) }).ok, false);
    if (a.ok && !a.duplicate) a.transaction.commit({ status: "applied" });
    assert.equal(fence.regionRevision(title.surfaceId, "title"), 1);
    assert.equal(fence.regionRevision(title.surfaceId, "caption"), 0);
    if (b.ok && !b.duplicate) b.transaction.commit({ status: "applied" });
    assert.equal(fence.surfaceRevision(title.surfaceId), 0, "field edits do not stale unrelated fields");
    const stale = begin("stale"); assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.code, "stale-revision");
    const fresh = begin("fresh", title, "codex", 1); assert.equal(fresh.ok, true);
    if (fresh.ok && !fresh.duplicate) fresh.transaction.release("test finished before input");
  } finally {
    if (a.ok && !a.duplicate) a.transaction.abort("test cleanup");
    if (b.ok && !b.duplicate) b.transaction.abort("test cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});

test("an uncertain hung field does not reserve another independent field, and keeps its own recovery boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-region-hang-"));
  let clock = 0;
  const ttl = 300;
  const fence = createMultiplayerDispatchFence({ store: createLocalStore(root, { now: () => new Date(clock) }), now: () => clock, leaseTtlMs: ttl });
  const title = desktopWindowMutationTarget({ pid: 123, windowId: "456", regionId: "title" });
  const caption = desktopWindowMutationTarget({ pid: 123, windowId: "456", regionId: "caption" });
  const first = fence.begin({ agent: "codex", provider: "codex", sessionId: "one", operationId: "hung-title", target: title });
  try {
    assert.equal(first.ok, true);
    clock = ttl + 10;
    await new Promise((resolve) => setTimeout(resolve, 210));
    const other = fence.begin({ agent: "claude", provider: "claude", sessionId: "two", operationId: "caption", target: caption });
    assert.equal(other.ok, true, "an unrelated region continues after the title channel stalls");
    if (other.ok && !other.duplicate) other.transaction.commit({ status: "applied" });
    assert.equal(fence.begin({ agent: "claude", provider: "claude", sessionId: "two", operationId: "title-retry", target: title }).ok, false);
    assert.equal(fence.observeSurface(title.surfaceId), 0, "a live uncertain dispatch is not cleared by an early observation");
    clock += ttl * 6;
    assert.equal(fence.observeSurface(title.surfaceId), 1);
  } finally {
    if (first.ok && !first.duplicate) first.transaction.abort("test cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});
