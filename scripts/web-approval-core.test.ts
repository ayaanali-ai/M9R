import assert from "node:assert/strict";
import test from "node:test";
import { canCreateHumanTypedPageTask } from "@/lib/native/approval-core";
import { classifyWebActionRisk } from "@/lib/native/risk-core";

test("web risk detection catches submit, buy, send, and delete controls", () => {
  for (const label of ["Submit order", "Buy now", "Send message", "Delete account"]) {
    assert.equal(classifyWebActionRisk({ action: "click", selector: "button", targetLabel: label }).risky, true, label);
  }
  assert.equal(classifyWebActionRisk({ action: "click", selector: "button[type=submit]" }).risky, true);
});

test("risk detection does not inspect the typed value and leaves ordinary reads/clicks alone", () => {
  assert.deepEqual(classifyWebActionRisk({ action: "type", selector: "#message", text: "please send the secret" }), { risky: false });
  assert.deepEqual(classifyWebActionRisk({ action: "read", selector: "#pricing" }), { risky: false });
  assert.deepEqual(classifyWebActionRisk({ action: "click", selector: "#expand-details" }), { risky: false });
});

test("page human_typed tasks require the authenticated extension-page channel", () => {
  assert.equal(canCreateHumanTypedPageTask({ origin: "human_typed", channel: "extension_page", ownerAuthenticated: true }), true);
  for (const channel of ["content_script", "page", "agent", "terminal", "unknown"] as const) {
    assert.equal(canCreateHumanTypedPageTask({ origin: "human_typed", channel, ownerAuthenticated: true }), false, channel);
  }
  assert.equal(canCreateHumanTypedPageTask({ origin: "human_typed", channel: "extension_page", ownerAuthenticated: false }), false);
  assert.equal(canCreateHumanTypedPageTask({ origin: "agent_initiated", channel: "extension_page", ownerAuthenticated: true }), false);
});
