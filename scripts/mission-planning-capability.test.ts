/**
 * Planning capability profile — Phase 5B §5/§20 tests.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { allPlanningCapabilitiesFalse, checkPlanningCapabilities, REQUIRED_PLANNING_CAPABILITIES, type PlanningModelConfiguration } from "../src/lib/mission/mission-planning-capability.ts";

function configuration(overrides: Partial<PlanningModelConfiguration> = {}): PlanningModelConfiguration {
  return {
    id: "planner-config-1",
    capabilities: allPlanningCapabilitiesFalse(),
    maximumContextTokens: 100_000,
    maximumOutputTokens: 8_000,
    maxRepairAttempts: 1,
    ...overrides,
  };
}

test("a configuration missing required capabilities fails with a typed error, never silently proceeds", () => {
  const result = checkPlanningCapabilities(configuration());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "planning_model_capability_unresolved");
    assert.deepEqual(result.error.missingCapabilities, [...REQUIRED_PLANNING_CAPABILITIES]);
  }
});

test("a configuration declaring all required capabilities passes", () => {
  const config = configuration({ capabilities: { ...allPlanningCapabilitiesFalse(), structured_output: true, strict_json_schema: true, tool_free_generation: true } });
  const result = checkPlanningCapabilities(config);
  assert.equal(result.ok, true);
});

test("capability truth comes from the configuration, never inferred from a model/provider name", () => {
  // Same "name" (id), opposite capability truth — proves nothing about the
  // check is keyed off the identifier string itself.
  const trusted = configuration({ id: "gpt-5-planner", capabilities: { ...allPlanningCapabilitiesFalse(), structured_output: true, strict_json_schema: true, tool_free_generation: true } });
  const untrusted = configuration({ id: "gpt-5-planner", capabilities: allPlanningCapabilitiesFalse() });
  assert.equal(checkPlanningCapabilities(trusted).ok, true);
  assert.equal(checkPlanningCapabilities(untrusted).ok, false);
});

test("the honest default (allPlanningCapabilitiesFalse) declares every capability false", () => {
  const defaults = allPlanningCapabilitiesFalse();
  assert.ok(Object.values(defaults).every((v) => v === false));
});
