import assert from "node:assert/strict";
import test from "node:test";
import { startParentLivenessWatchdog } from "@/lib/native/process-liveness";

test("parent watchdog fires once when the parent is no longer alive", async () => {
  let calls = 0;
  const stop = startParentLivenessWatchdog({
    parentPid: 999999,
    intervalMs: 1,
    isAlive: () => false,
    onParentGone: () => { calls++; },
  });
  await new Promise(resolve => setTimeout(resolve, 50));
  stop();
  assert.equal(calls, 1);
});

test("parent watchdog does not fire while the parent stays alive", () => {
  let calls = 0;
  const stop = startParentLivenessWatchdog({
    parentPid: process.pid,
    intervalMs: 50,
    isAlive: () => true,
    onParentGone: () => { calls++; },
  });
  stop();
  assert.equal(calls, 0);
});
