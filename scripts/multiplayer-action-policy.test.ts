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
    authorization: "not-required",
    reason: "The selected target exposes a route that does not require global focus.",
  });
});

test("background refusal does not silently steal foreground focus", () => {
  const decision = selectActionDelivery({ target: { capabilities: ["input.shared-os"] }, requested: "background", targetBackgroundSafe: false });
  assert.equal(decision.ok, false);
  if (!decision.ok) assert.equal(decision.code, "background-unavailable");
});

test("foreground escalation identifies owner approval instead of pretending a lease exists", () => {
  const withoutLease = selectActionDelivery({ target: { capabilities: ["input.shared-os"] }, requested: "exclusive", allowForegroundEscalation: true });
  assert.equal(withoutLease.ok, true);
  if (withoutLease.ok) assert.equal(withoutLease.authorization, "owner-approval-required");
  const denied = selectActionDelivery({ target: { capabilities: ["input.shared-os"] }, requested: "exclusive" });
  assert.equal(denied.ok, false);
  const withLease = selectActionDelivery({ target: { capabilities: ["input.shared-os"] }, requested: "exclusive", ownerLeaseValid: true });
  assert.equal(withLease.ok, true);
  if (withLease.ok) {
    assert.equal(withLease.mode, "exclusive-input");
    assert.equal(withLease.authorization, "owner-lease-held");
  }
});

test("visible semantic work does not require a pointer move", () => {
  const decision = selectActionDelivery({ target: semanticTarget, requested: "visible", targetVisible: true });
  assert.equal(decision.ok, true);
  if (decision.ok) assert.equal(decision.mode, "visible-semantic");
});


test("advertising shared input does not make a semantic action physical", () => {
  const target = { capabilities: [...semanticTarget.capabilities, "input.shared-os"] };
  const semantic = selectActionDelivery({ target, targetBackgroundSafe: true });
  assert.equal(semantic.ok && semantic.mode, "background-semantic");
  const physical = selectActionDelivery({ target, targetBackgroundSafe: true, requiresPhysicalInput: true });
  assert.equal(physical.ok, false);
});

test("only exact known non-global routes are background candidates", () => {
  for (const capability of ["input.key", "input.shared-os", "window.state", "system.media", "system.unknown"]) {
    const decision = selectActionDelivery({ target: { capabilities: [capability] }, requested: "background", targetBackgroundSafe: true });
    assert.equal(decision.ok, false, `${capability} must not be inferred as background-safe`);
  }
  for (const capability of ["observe.screenshot", "browser.navigate", "menu.invoke", "window.frame", "system.output-audio"]) {
    const decision = selectActionDelivery({ target: { capabilities: [capability] }, requested: "background", targetBackgroundSafe: true });
    assert.equal(decision.ok, true, `${capability} is a known non-global-input route`);
    if (decision.ok) assert.equal(decision.authorization, "not-required");
  }
});
