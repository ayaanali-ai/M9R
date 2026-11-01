import assert from "node:assert/strict";
import test from "node:test";
import { selectActionDelivery } from "../src/lib/native/multiplayer-action-policy";

const semanticTarget = { capabilities: ["observe.accessibility", "input.click.element", "input.text.insert"] as const };

test("auto mode keeps a semantic background agent independent of exclusive input", () => {
  const decision = selectActionDelivery({ target: semanticTarget, targetBackgroundSafe: true });
  assert.deepEqual(decision, {
    ok: true,
    mode: "background-semantic",
    escalated: false,
    reason: "The target exposes a semantic route that is safe without global focus.",
  });
});

test("background refusal does not silently steal foreground focus", () => {
  const decision = selectActionDelivery({ target: { capabilities: ["input.shared-os"] }, requested: "background", targetBackgroundSafe: false });
  assert.equal(decision.ok, false);
  if (!decision.ok) assert.equal(decision.code, "background-unavailable");
});

test("foreground escalation is explicit and lease-bound", () => {
  const withoutLease = selectActionDelivery({ target: { capabilities: ["input.shared-os"] }, requested: "exclusive", allowForegroundEscalation: true });
  assert.equal(withoutLease.ok, false);
  const withLease = selectActionDelivery({ target: { capabilities: ["input.shared-os"] }, requested: "exclusive", ownerLeaseValid: true });
  assert.equal(withLease.ok, true);
  if (withLease.ok) assert.equal(withLease.mode, "exclusive-input");
});

test("visible semantic work does not require a pointer move", () => {
  const decision = selectActionDelivery({ target: semanticTarget, requested: "visible", targetVisible: true });
  assert.equal(decision.ok, true);
  if (decision.ok) assert.equal(decision.mode, "visible-semantic");
});

