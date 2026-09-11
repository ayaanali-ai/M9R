import assert from "node:assert/strict";
import test from "node:test";
import { ensureLocalTerminalRuntime, runtimeHealthUrl } from "../src/lib/local-terminal-runtime-launcher.ts";

test("runtime startup is idempotent when the local daemon is already healthy", async () => {
  let spawns = 0;
  const result = await ensureLocalTerminalRuntime({
    probe: async () => true,
    spawn: () => { spawns += 1; },
    wait: async () => {},
  });
  assert.equal(result, "already-running");
  assert.equal(spawns, 0);
  assert.equal(runtimeHealthUrl(), "http://127.0.0.1:43117/health");
});

test("runtime startup spawns once and waits until the daemon is healthy", async () => {
  let probes = 0;
  let spawns = 0;
  const result = await ensureLocalTerminalRuntime({
    probe: async () => ++probes >= 3,
    spawn: () => { spawns += 1; },
    wait: async () => {},
  }, { attempts: 3, intervalMs: 0 });
  assert.equal(result, "started");
  assert.equal(spawns, 1);
});

test("runtime startup reports failure without retrying the spawn", async () => {
  let spawns = 0;
  const result = await ensureLocalTerminalRuntime({
    probe: async () => false,
    spawn: () => { spawns += 1; throw new Error("blocked"); },
    wait: async () => {},
  });
  assert.equal(result, "failed");
  assert.equal(spawns, 1);
});
