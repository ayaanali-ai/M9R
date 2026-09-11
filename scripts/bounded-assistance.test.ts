import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBoundedRequest, canIssueRequest } from "../src/lib/bounded-assistance.ts";
import { SOLO_POLICY, COORDINATED_POLICY, ASSURANCE_POLICY } from "../src/lib/run-mode.ts";
import { readFileSync } from "node:fs";

test("a valid request renders a Dispatch-safe summary", () => {
  const result = validateBoundedRequest({
    type: "HELP_REQUESTED",
    need: "Windows-specific reproduction",
    allowed: "Focused fixture and error excerpt",
    notAllowed: "Private source or environment values",
  });
  assert.equal(result.ok, true);
  assert.match(result.summary!, /need: Windows-specific reproduction/);
  assert.match(result.summary!, /allowed: Focused fixture/);
  assert.match(result.summary!, /not allowed: Private source/);
});

test("rejects a request with no specific expected result", () => {
  const result = validateBoundedRequest({ type: "HELP_REQUESTED", need: "" });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /specific expected result/.test(e)));
});

test("rejects secret-shaped content in the request", () => {
  const result = validateBoundedRequest({ type: "CHECK_REQUESTED", need: "Bearer sk-live-abcdef1234567890" });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /Rejected/.test(e)));
});

test("solo runs can never issue a coordination request", () => {
  const result = canIssueRequest(SOLO_POLICY, { requestsUsed: 0, supportingAgentsUsed: 0, currentDelegationDepth: 0 });
  assert.equal(result.allowed, false);
});

test("a coordinated root run can issue its first request", () => {
  const result = canIssueRequest(COORDINATED_POLICY, { requestsUsed: 0, supportingAgentsUsed: 0, currentDelegationDepth: 0 });
  assert.equal(result.allowed, true);
});

test("a supporting run (depth 1) cannot issue a further request under assurance policy", () => {
  const result = canIssueRequest(ASSURANCE_POLICY, { requestsUsed: 0, supportingAgentsUsed: 0, currentDelegationDepth: 1 });
  assert.equal(result.allowed, false);
  assert.match(result.reason!, /Delegation depth/);
});

test("coordination usage reads stay scoped to the authenticated workspace", () => {
  const source = readFileSync(new URL("../src/lib/bounded-assistance-service.ts", import.meta.url), "utf8");
  const fn = source.slice(source.indexOf("export async function readRunCoordinationState"), source.indexOf("export function policyForRun"));
  assert.equal((fn.match(/\.eq\("workspace_id", workspaceId\)/g) ?? []).length, 3);
});
