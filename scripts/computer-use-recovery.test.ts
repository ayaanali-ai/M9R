import assert from "node:assert/strict";
import test from "node:test";
import { preDispatchRetry } from "../src/lib/native/computer-use-recovery";
import { selectActionDelivery } from "../src/lib/native/multiplayer-action-policy";
import { recordComputerUseLatency, computerUseLatencySnapshot } from "../src/lib/native/computer-use-latency";
import { createWebBroker } from "../src/lib/native/web-broker-core";

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

test("only trusted browser delivery receipts can certify a pre-dispatch refusal", async () => {
  for (const trusted of [false, true]) {
    let commandId = "";
    const broker = createWebBroker({ trustDeliveryReceipts: trusted, send: (raw) => {
      const message = raw as { type: string; id: string };
      if (message.type === "command") commandId = message.id;
      return true;
    } });
    const pending = broker.submit({ agent: "codex", provider: "codex", sessionId: "s1", tab: "one", action: "click", selector: "#button" });
    broker.onExtensionMessage({ type: "result", id: commandId, ok: false, error: "Stale exact tab", dispatchState: "not-dispatched" });
    const response = await pending;
    assert.equal(response.dispatchState, trusted ? "not-dispatched" : undefined);
  }
});
