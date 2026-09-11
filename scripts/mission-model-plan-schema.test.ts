/**
 * Untrusted model plan output — schema tests (Phase 5B §4/§20).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { MODEL_PLAN_OUTPUT_SCHEMA_VERSION, validateRawModelPlanOutput, type RawModelPlanOutput } from "../src/lib/mission/mission-model-plan-schema.ts";

function validOutput(overrides: Partial<RawModelPlanOutput> = {}): RawModelPlanOutput {
  return {
    schemaVersion: MODEL_PLAN_OUTPUT_SCHEMA_VERSION,
    interpretedObjective: "Fix the flaky test",
    procedureTemplate: "solo_implementation",
    operatingMode: "solo",
    participants: [{ participantId: "impl", role: "implementer", requiredCapabilities: ["non_interactive_execution", "repository_editing"], allowedPaths: ["src"], prohibitedPaths: [], rationale: "does the work" }],
    assignments: [
      {
        assignmentId: "a1",
        assigneeId: "impl",
        objective: "fix it",
        allowedPaths: ["src"],
        prohibitedPaths: [],
        dependencies: [],
        requiredEvidence: ["evidence://tests"],
        approvalPolicy: "auto",
        maxDurationMs: 600_000,
        maxEstimatedTokens: 100_000,
        dispatchEligibilityConditions: ["assignee_active"],
        completionCriteria: ["completion_notice_submitted"],
      },
    ],
    collaborationTopology: [],
    evidenceRequirements: ["evidence://tests"],
    approvalGates: [],
    executionLimits: { maxDurationMs: 600_000, maxEstimatedTokens: 100_000 },
    assumptions: [],
    unresolvedQuestions: [],
    warnings: [],
    rationale: "solo fix",
    ...overrides,
  };
}

function toText(output: unknown): string {
  return JSON.stringify(output);
}

test("a well-formed model plan output is accepted", () => {
  const result = validateRawModelPlanOutput(toText(validOutput()));
  assert.equal(result.ok, true);
});

test("malformed JSON is rejected", () => {
  const result = validateRawModelPlanOutput("{ not json");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "malformed_json");
});

test("an unsupported schema version is rejected", () => {
  const result = validateRawModelPlanOutput(toText(validOutput({ schemaVersion: "oathlock.model-plan-output.v99" })));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "unsupported_schema_version");
});

test("an unknown, potentially authority-bearing top-level field is rejected", () => {
  const output = { ...validOutput(), preApproved: true };
  const result = validateRawModelPlanOutput(JSON.stringify(output));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "unknown_field");
});

test("a model attempting to assert a 'provider' field directly is rejected — no such field exists in the schema", () => {
  const output = validOutput();
  const withProvider = { ...output, participants: [{ ...output.participants[0], provider: "codex" }] };
  const result = validateRawModelPlanOutput(JSON.stringify(withProvider));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "unknown_field");
});

test("an invalid participant role enum is rejected", () => {
  const output = validOutput();
  output.participants[0].role = "super_admin";
  const result = validateRawModelPlanOutput(toText(output));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "invalid_enum_value");
});

test("an unsupported operating mode is rejected", () => {
  const result = validateRawModelPlanOutput(toText(validOutput({ operatingMode: "unbounded_swarm" })));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "invalid_enum_value");
});

test("an unsupported procedure template is rejected", () => {
  const result = validateRawModelPlanOutput(toText(validOutput({ procedureTemplate: "fully_autonomous_takeover" })));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "unsupported_template");
});

test("a malformed (empty-string) participant id is rejected", () => {
  const output = validOutput();
  output.participants[0].participantId = "";
  const result = validateRawModelPlanOutput(toText(output));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "malformed_id");
});

test("duplicate participant ids are rejected", () => {
  const output = validOutput();
  output.participants.push({ ...output.participants[0] });
  const result = validateRawModelPlanOutput(toText(output));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "duplicate_participant_id");
});

test("duplicate assignment ids are rejected", () => {
  const output = validOutput();
  output.assignments.push({ ...output.assignments[0] });
  const result = validateRawModelPlanOutput(toText(output));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "duplicate_assignment_id");
});

test("a missing assignee reference is rejected", () => {
  const output = validOutput();
  output.assignments[0].assigneeId = "nonexistent-participant";
  const result = validateRawModelPlanOutput(toText(output));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "missing_reference");
});

test("a missing dependency reference is rejected", () => {
  const output = validOutput();
  output.assignments[0].dependencies = ["nonexistent-assignment"];
  const result = validateRawModelPlanOutput(toText(output));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "missing_reference");
});

test("a dependency cycle is rejected", () => {
  const output = validOutput();
  output.assignments.push({ ...output.assignments[0], assignmentId: "a2", dependencies: ["a1"] });
  output.assignments[0].dependencies = ["a2"];
  const result = validateRawModelPlanOutput(toText(output));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "dependency_cycle");
});

test("a malformed (traversal-escaping) path is rejected", () => {
  const output = validOutput();
  output.assignments[0].allowedPaths = ["src/../../etc/passwd"];
  const result = validateRawModelPlanOutput(toText(output));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "malformed_path");
});

test("an invalid approvalPolicy enum value is rejected", () => {
  const output = validOutput();
  output.assignments[0].approvalPolicy = "self_approved_no_review_needed";
  const result = validateRawModelPlanOutput(toText(output));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "invalid_enum_value");
});

test("more participants than the array cap is rejected (unbounded-recursion / participant-count guard)", () => {
  const output = validOutput();
  output.participants = Array.from({ length: 50 }, (_, i) => ({ ...output.participants[0], participantId: `p${i}` }));
  const result = validateRawModelPlanOutput(toText(output));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "array_too_large");
});

test("an invalid collaboration edge kind is rejected", () => {
  const output = validOutput();
  output.collaborationTopology = [{ from: "a1", to: "a1", kind: "unrestricted_authority_grant" }];
  const result = validateRawModelPlanOutput(toText(output));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "invalid_enum_value");
});

test("a collaboration edge referencing an unknown assignment is rejected", () => {
  const output = validOutput();
  output.collaborationTopology = [{ from: "a1", to: "ghost", kind: "review" }];
  const result = validateRawModelPlanOutput(toText(output));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "missing_reference");
});
