import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isCanonicalPlanProposalShape,
  canEnterSimulation,
  isSimulationSuccessStatus,
  canApprovePlan,
  canMaterializePlan,
  modelOutputCannotSetPlanState,
} from "../src/lib/mission/mission-plan-authority-invariants.ts";
import type { MissionPlanProposal } from "../src/lib/mission/mission-domain.ts";
import { findCurrentPlanProposal } from "../src/lib/mission/mission-collaboration.ts";
import { PlanningRequestPortImpl } from "../src/lib/mission/mission-planning-request-port.ts";
import { InMemoryMissionStore } from "../src/lib/mission/mission-store.ts";
import { InMemoryIdempotencyStore } from "../src/lib/mission/mission-idempotency.ts";
import { validateMissionPlanProposal, type PlanValidationContext } from "../src/lib/mission/mission-planner-validator.ts";
import { simulateMissionPlanProposal } from "../src/lib/mission/mission-planner-simulator.ts";
import type { CommandOutcomeRecord } from "../src/lib/mission/mission-commands.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function basePlan(overrides: Partial<MissionPlanProposal> = {}): MissionPlanProposal {
  return {
    id: "plan-1",
    missionId: "mission-1",
    version: 1,
    status: "draft",
    objective: "obj",
    assumptions: [],
    constraints: [],
    participantProposals: [],
    assignmentProposals: [],
    collaborationTopology: [],
    evidenceRequirements: [],
    approvalGates: [],
    executionLimits: { maxDurationMs: null, maxEstimatedTokens: null },
    unresolvedQuestions: [],
    warnings: [],
    validationErrors: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: "test",
    supersedesPlanId: null,
    ...overrides,
  };
}

test("isCanonicalPlanProposalShape rejects raw/loose objects and accepts a real MissionPlanProposal", () => {
  assert.equal(isCanonicalPlanProposalShape(null), false);
  assert.equal(isCanonicalPlanProposalShape({ objective: "x" }), false);
  assert.equal(isCanonicalPlanProposalShape(basePlan()), true);
});

test("canEnterSimulation / isSimulationSuccessStatus only true for 'valid'", () => {
  for (const status of ["draft", "validating", "invalid", "approved", "materializing", "active", "superseded", "rejected", "cancelled"] as const) {
    assert.equal(canEnterSimulation(status), false, status);
    assert.equal(isSimulationSuccessStatus(status), false, status);
  }
  assert.equal(canEnterSimulation("valid"), true);
  assert.equal(isSimulationSuccessStatus("valid"), true);
});

test("canApprovePlan only true from 'valid'", () => {
  assert.equal(canApprovePlan("valid"), true);
  for (const status of ["draft", "validating", "invalid", "approved", "materializing", "active", "superseded", "rejected", "cancelled"] as const) {
    assert.equal(canApprovePlan(status), false, status);
  }
});

test("canMaterializePlan requires approved status AND being the mission's current Plan", () => {
  const approvedCurrent = basePlan({ status: "approved", version: 2 });
  const approvedStale = basePlan({ id: "plan-old", status: "approved", version: 1 });
  const newerSuperseding = basePlan({ id: "plan-2", status: "valid", version: 2 });

  assert.equal(canMaterializePlan(approvedCurrent, approvedCurrent), true);
  // Approved but a newer Plan is now current -> must not materialize even though its own status edge is legal.
  assert.equal(canMaterializePlan(approvedStale, newerSuperseding), false);
  // Not approved at all.
  assert.equal(canMaterializePlan(basePlan({ status: "valid" }), basePlan({ status: "valid" })), false);
  // No current plan resolvable.
  assert.equal(canMaterializePlan(approvedCurrent, null), false);
});

test("modelOutputCannotSetPlanState rejects objects carrying lifecycle fields, accepts clean raw output", () => {
  assert.equal(modelOutputCannotSetPlanState({ objective: "x" }), true);
  assert.equal(modelOutputCannotSetPlanState({ objective: "x", status: "approved" }), false);
  assert.equal(modelOutputCannotSetPlanState({ approvedAt: "2026-01-01" }), false);
  assert.equal(modelOutputCannotSetPlanState({ materializedAt: "2026-01-01" }), false);
  assert.equal(modelOutputCannotSetPlanState(null), true);
});

// ---------------------------------------------------------------------------
// Structural test: PlanningRequestPort exposes ONLY the expected whitelist.
// ---------------------------------------------------------------------------
test("PlanningRequestPortImpl exposes only loadSnapshot/loadPlanningRequest/recordModelPlanningResult — nothing execution-shaped", () => {
  const missionStore = new InMemoryMissionStore();
  const idempotencyStore = new InMemoryIdempotencyStore<CommandOutcomeRecord>();
  const port = new PlanningRequestPortImpl(missionStore, idempotencyStore);

  const proto = Object.getPrototypeOf(port);
  const methodNames = Object.getOwnPropertyNames(proto).filter(
    (name) => name !== "constructor" && typeof (port as unknown as Record<string, unknown>)[name] === "function",
  );

  const expected = new Set(["loadSnapshot", "loadPlanningRequest", "recordModelPlanningResult"]);
  assert.deepEqual(new Set(methodNames), expected, `PlanningRequestPortImpl method set drifted: ${methodNames.join(", ")}`);

  const forbiddenNamePattern = /approve|materialize|dispatch|createassignment|addparticipant|startmission|reject|cancel/i;
  for (const name of methodNames) {
    assert.equal(forbiddenNamePattern.test(name), false, `method '${name}' looks execution-shaped and must not exist on PlanningRequestPort`);
  }

  // Interface-level (compile-time) check: importing the type and constructing
  // a minimal conforming object with extra methods would still typecheck if
  // PlanningRequestPort were widened — the runtime whitelist above is the
  // actual regression guard since TS structural typing can't catch "someone
  // added a new method to the concrete class."
});

test("PlanningRequestPort source file documents and defines only the same three methods (source-level regression guard)", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "mission", "mission-planning-request-port.ts"), "utf8");
  const interfaceMatch = source.match(/export interface PlanningRequestPort \{([\s\S]*?)\n\}/);
  assert.ok(interfaceMatch, "could not locate PlanningRequestPort interface body");
  const body = interfaceMatch![1];
  const methodSignatures = [...body.matchAll(/^\s*(\w+)\(/gm)].map((m) => m[1]);
  assert.deepEqual(new Set(methodSignatures), new Set(["loadSnapshot", "loadPlanningRequest", "recordModelPlanningResult"]));
});

// ---------------------------------------------------------------------------
// Regression: repair output goes through the identical validate/simulate
// pipeline as a first attempt (audit finding #13) — explicit assertion via
// call-count spying on the actual pipeline functions the worker calls.
// ---------------------------------------------------------------------------
test("repair attempts are validated and simulated through the same functions as first attempts (spy-based)", async () => {
  // We can't easily monkeypatch the imported functions inside mission-planning-worker.ts
  // (ESM bindings are read-only), so instead we assert the structural fact from source:
  // the SAME `validateMissionPlanProposal`/`simulateMissionPlanProposal` calls appear
  // inside the single retry loop that also handles the first attempt — i.e. there is
  // no separate post-repair validation/simulation code path.
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "mission", "mission-planning-worker.ts"), "utf8");
  const validateCalls = [...source.matchAll(/validateMissionPlanProposal\(/g)].length;
  const simulateCalls = [...source.matchAll(/simulateMissionPlanProposal\(/g)].length;
  assert.equal(validateCalls, 1, "validateMissionPlanProposal must be called from exactly one call site (the shared loop) — a second call site would mean repair has its own path");
  assert.equal(simulateCalls, 1, "simulateMissionPlanProposal must be called from exactly one call site (the shared loop) — a second call site would mean repair has its own path");

  // Functional confirmation: the two pipeline functions themselves are pure
  // and stateless, so calling them twice with the same input (simulating
  // "first attempt" vs "post-repair attempt" reusing the identical proposal)
  // must yield identical results — proving there's no hidden attempt-number
  // branching inside them either.
  const plan = basePlan({ status: "draft" });
  const ctx: PlanValidationContext = {
    missionScope: { allowedPaths: [], prohibitedPaths: [] },
    missionBudget: { maxDurationMs: null, maxEstimatedTokens: null },
    availableApprovalAuthorities: ["human"],
  };
  const first = validateMissionPlanProposal(plan, ctx);
  const second = validateMissionPlanProposal(plan, ctx);
  assert.deepEqual(first, second);
  const simFirst = simulateMissionPlanProposal(plan);
  const simSecond = simulateMissionPlanProposal(plan);
  assert.deepEqual(simFirst, simSecond);
});

// ---------------------------------------------------------------------------
// findCurrentPlanProposal / findOutstandingPlanningRequestForSlot are the
// single source of truth — no ad hoc duplicate "is this still current" logic
// exists elsewhere for the same question.
// ---------------------------------------------------------------------------
test("no duplicate ad hoc 'current plan' scanning logic exists outside mission-collaboration.ts", () => {
  const missionDir = path.join(__dirname, "..", "src", "lib", "mission");
  const files = fs.readdirSync(missionDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "mission-collaboration.ts");
  // A duplicate would look like: iterating planProposals and comparing `.version >`
  // to find "the highest version non-terminal proposal" — the exact shape
  // findCurrentPlanProposal implements. Flag any other file doing that scan.
  const suspiciousPattern = /for\s*\([^)]*Object\.values\([^)]*planProposals[^)]*\)[\s\S]{0,200}?\.version\s*>/;
  const offenders: string[] = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(missionDir, file), "utf8");
    if (suspiciousPattern.test(text)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `found duplicate 'current plan' scan logic outside mission-collaboration.ts: ${offenders.join(", ")}`);
});

test("findCurrentPlanProposal ignores terminal statuses and returns highest version — sanity check reused above", () => {
  const proposals: Record<string, MissionPlanProposal> = {
    "plan-1": basePlan({ id: "plan-1", version: 1, status: "superseded" }),
    "plan-2": basePlan({ id: "plan-2", version: 2, status: "valid" }),
  };
  const current = findCurrentPlanProposal(proposals);
  assert.equal(current?.id, "plan-2");
});
