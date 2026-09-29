import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyPowerRisk,
  describePower,
  extraTimeoutFor,
  grantActionFor,
  isDisclosureAction,
  isPowerAction,
  powerScopeFor,
  sanitizeLabel,
  validatePowerRequest,
} from "../src/lib/native/web-powers-core.ts";

const power = (action: string, extra: Record<string, unknown> = {}) => ({ action, ...extra });

test("page-bearing web actions are explicitly disclosure-gated at the broker boundary", () => {
  for (const action of ["read", "snapshot", "extract", "copy", "find", "screenshot", "link", "tabs"]) assert.equal(isDisclosureAction(action), true, action);
  for (const action of ["open", "click", "type", "scroll", "press", "submit", "buy"]) assert.equal(isDisclosureAction(action), false, action);
});

test("the supported power set is explicit and rejects malformed or extra arguments", () => {
  assert.equal(isPowerAction("scroll"), true);
  assert.equal(isPowerAction("upload"), true);
  assert.equal(isPowerAction("ask_owner"), false, "owner replies need a message-bar response contract before we expose this action");
  assert.equal(validatePowerRequest(power("scroll", { args: { by: 120 } })), null);
  assert.match(validatePowerRequest(power("scroll", { args: { by: 120, surprise: true } })) ?? "", /does not take surprise/);
  assert.match(validatePowerRequest(power("scroll", { args: { by: 100_001 } })) ?? "", /between -100000 and 100000/);
  assert.match(validatePowerRequest(power("wait", { args: { ms: 15_001 } })) ?? "", /0 to 15000/);
});

test("wait, find, select, press, and extract validate required inputs and bounds", () => {
  assert.match(validatePowerRequest(power("wait")) ?? "", /needs a selector, text or ms/);
  assert.match(validatePowerRequest(power("wait", { selector: "#ready", args: { text: "ready" } })) ?? "", /not both/);
  assert.equal(validatePowerRequest(power("find", { args: { query: "pricing", scrollToFirst: true } })), null);
  assert.match(validatePowerRequest(power("press", { args: { key: "Meta" } })) ?? "", /must be one of/);
  assert.equal(validatePowerRequest(power("select", { selector: "#region", args: { option: "North" } })), null);
  assert.match(validatePowerRequest(power("select", { selector: "#region", args: { value: "x", option: "X" } })) ?? "", /exactly one/);
  assert.match(validatePowerRequest(power("extract", { selector: "table", args: { maxRows: 501 } })) ?? "", /maxRows must be 1-500/);
});

test("risky powers reuse click classification for activation and selection targets", () => {
  assert.deepEqual(classifyPowerRisk(power("press", { selector: "button.submit-order", args: { key: "Enter" } })), { risky: true, category: "outside" });
  assert.deepEqual(classifyPowerRisk(power("select", { selector: "#plan", targetLabel: "Buy subscription" })), { risky: true, category: "money" });
  assert.deepEqual(classifyPowerRisk(power("press", { selector: "input.search", args: { key: "Enter" } })), { risky: false });
  assert.deepEqual(classifyPowerRisk(power("hover", { selector: "#menu" })), { risky: false });
  assert.deepEqual(classifyPowerRisk(power("screenshot")), { risky: true, category: "secrets" });
});

test("modified Enter chords on consequential forms are validated and owner-gated", () => {
  for (const key of ["Control+Enter", "Alt+Enter", "control+enter", "ALT+Return"]) {
    const request = power("press", {
      selector: "input.email",
      formSelector: "form#checkout",
      args: { key },
    });
    assert.equal(validatePowerRequest(request), null, `${key} should normalize as a supported shortcut`);
    assert.deepEqual(classifyPowerRisk(request), { risky: true, category: "money" }, `${key} can submit the checkout form`);
    assert.deepEqual(powerScopeFor(request), { kind: "form", key: "form#checkout" }, `${key} reserves the consequential form`);
    assert.equal(grantActionFor("press", request), "click", `${key} uses click authorization`);
  }
});

test("claim scopes reserve only the affected control except page navigation and activation", () => {
  assert.deepEqual(powerScopeFor(power("scroll", { args: { by: 200 } })), null);
  assert.deepEqual(powerScopeFor(power("select", { selector: "#country", formSelector: "form#profile" })), { kind: "field", key: "#country", formKey: "form#profile" });
  assert.deepEqual(powerScopeFor(power("press", { selector: "#name", formSelector: "form#profile", args: { key: "Tab" } })), { kind: "field", key: "#name", formKey: "form#profile" });
  assert.deepEqual(powerScopeFor(power("press", { selector: "button.submit", args: { key: "Enter" } })), { kind: "tab", key: "*" });
  assert.deepEqual(powerScopeFor(power("switch", { tab: "research" })), null);
  assert.deepEqual(powerScopeFor(power("back")), { kind: "tab", key: "*" });
});

test("power grants map to existing broker actions; waits and labels are bounded", () => {
  assert.equal(grantActionFor("scroll"), "read");
  assert.equal(grantActionFor("close"), "open");
  assert.equal(grantActionFor("select"), "click");
  assert.equal(grantActionFor("press", power("press", { args: { key: "Enter" } })), "click");
  assert.equal(grantActionFor("press", power("press", { args: { key: "Tab" } })), "type");
  assert.equal(extraTimeoutFor(power("wait", { args: { ms: 15_000 } })), 17_000);
  assert.equal(extraTimeoutFor(power("wait", { args: { ms: 0 } })), 2_000);
  assert.equal(describePower(power("find", { args: { query: "needle" } })), "finding text on the page");
  assert.equal(sanitizeLabel("  Save\nchanges  "), "Save changes");
  assert.equal(sanitizeLabel("x".repeat(100))?.length, 80);
});

test("snapshots, coordinates, refs, drag, and forms are bounded and explicitly validated", () => {
  assert.equal(isPowerAction("snapshot"), true);
  assert.equal(validatePowerRequest(power("snapshot", { args: { limit: 150, query: "search" } })), null);
  assert.match(validatePowerRequest(power("snapshot", { args: { limit: 151 } })) ?? "", /1-150/);
  assert.equal(validatePowerRequest(power("click_at", { args: { x: 640, y: 480 } })), null);
  assert.match(validatePowerRequest(power("click_at", { args: { x: -1, y: 1 } })) ?? "", /coordinates/);
  assert.equal(validatePowerRequest(power("drag", { selector: "@m9r-ref:e2", endSelector: "@m9r-ref:e8", args: { destination: "@m9r-ref:e8" } })), null);
  assert.equal(validatePowerRequest(power("fill_form", { formSelector: "form#profile", args: { fields: [{ selector: "#name", value: "Ada" }] } })), null);
});

test("externally consequential browser actions are always owner-gated and claim the tab", () => {
  for (const action of ["click_at", "drag", "drop", "upload", "download", "submit", "buy", "post", "follow", "like", "dm"]) {
    assert.equal(classifyPowerRisk(power(action, { selector: "#safe-looking" })).risky, true, `${action} must always require approval`);
    assert.deepEqual(powerScopeFor(power(action, { selector: "#target" })), { kind: "tab", key: "*" }, `${action} reserves the tab`);
  }
  assert.equal(classifyPowerRisk(power("point", { selector: "@m9r-ref:e4" })).risky, false);
  assert.equal(powerScopeFor(power("snapshot")), null);
  assert.deepEqual(powerScopeFor(power("fill_form", { formSelector: "form#profile", args: { fields: [{ selector: "#name", value: "x" }] } })), { kind: "form", key: "form#profile" });
});
