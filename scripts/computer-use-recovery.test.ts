import assert from "node:assert/strict";
import test from "node:test";
import { preDispatchRetry } from "../src/lib/native/computer-use-recovery";
import { selectActionDelivery } from "../src/lib/native/multiplayer-action-policy";
import { recordComputerUseLatency, computerUseLatencySnapshot } from "../src/lib/native/computer-use-latency";

test("pre-dispatch refusals preserve a safe way to continue work", () => {
  for (const code of ["foreground-lease", "background-unavailable", "target-identity", "stale-observation", "overlay-not-visible", "unsupported-target-action", "unknown-gate"]) {
    assert.equal(preDispatchRetry(code), "refresh-target", code);
  }
  assert.equal(preDispatchRetry("operation-receipt-unavailable"), "same-operation-id");
  assert.equal(preDispatchRetry("mutation-lease"), "same-operation-id");
  assert.equal(preDispatchRetry("mutation-operation-conflict"), "new-operation-id");
  assert.equal(preDispatchRetry("task-canceled"), "never");
});

test("an explicit background boundary defeats a foreground grant", () => {
  const result = selectActionDelivery({ target: { capabilities: ["input.shared-os"] }, requested: "background",
    requiresPhysicalInput: true, targetVisible: true, allowForegroundEscalation: true, ownerLeaseValid: true });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "background-unavailable");
});

test("latency budgets retain bounded internal measurements independently of delivery", () => {
  for (let i = 0; i < 300; i++) recordComputerUseLatency({ timingsMs: { totalMs: 5_001, actionMs: 20 }, priorReceiptFound: false });
  const snapshot = computerUseLatencySnapshot();
  assert.equal(snapshot.length, 256);
  assert.deepEqual(snapshot[0]?.exceeded, ["totalMs"]);
  snapshot[0]!.timingsMs.totalMs = 0;
  assert.equal(computerUseLatencySnapshot()[0]?.timingsMs.totalMs, 5_001);
});
