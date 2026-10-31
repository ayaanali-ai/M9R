import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMultiplayerDispatchFence, desktopMutationTarget } from "@/lib/native/multiplayer-dispatch-fence";
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
