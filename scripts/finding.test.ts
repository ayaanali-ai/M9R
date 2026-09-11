import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateFinding, summarizeAdoptions, FINDING_SCHEMA_VERSION, type FindingInput } from "../src/lib/finding.ts";
import { buildBrief } from "../src/lib/brief.ts";
import type { FindingView } from "../src/lib/finding-service.ts";

test("recordAdoption scopes the finding lookup to the adopting run's own workspace -- cross-workspace IDOR regression", () => {
  // recordAdoption uses requireService() (the service-role client, which
  // bypasses RLS entirely), so this workspace_id filter is the ONLY thing
  // standing between "adopt a finding in my own workspace" and "adopt any
  // finding in any workspace by guessing/obtaining its id" -- it was
  // previously missing while every sibling lookup in this file
  // (reviewFinding, listAvailableFindingsForWorkspace) already had it.
  const svc = readFileSync(resolve(process.cwd(), "src/lib/finding-service.ts"), "utf8");
  const start = svc.indexOf("export async function recordAdoption(");
  assert.ok(start > -1, "recordAdoption must exist");
  const next = svc.indexOf("\nexport ", start + 1);
  const body = svc.slice(start, next === -1 ? undefined : next);
  assert.match(body, /workspaceId:\s*string/, "recordAdoption must require a workspaceId parameter");
  assert.match(
    body,
    /\.eq\("id",\s*input\.findingId\)\s*\n\s*\.eq\("workspace_id",\s*input\.workspaceId\)/,
    "the findings lookup must filter by workspace_id, not just id",
  );

  const route = readFileSync(resolve(process.cwd(), "src/app/api/agent/findings/[id]/adopt/route.ts"), "utf8");
  assert.match(
    route,
    /recordAdoption\(\{\s*findingId,\s*workspaceId:\s*run\.workspace_id/,
    "the adopt route must pass the caller's own run's workspace_id through to recordAdoption",
  );
});

function baseInput(overrides: Partial<FindingInput> = {}): FindingInput {
  return {
    workspaceId: "ws-1",
    originatingRunId: "run-1",
    originatingSender: "codex",
    title: "waiting_for_human should enter the Evidence stage",
    applicableEnvironment: "Watchfloor display-state logic",
    observedBehavior: "Runs with a submitted session were shown as waiting_for_human.",
    evidenceLevel: "correlated",
    suggestedResponse: "Classify submitted-session runs as evidence_ready.",
    knownLimitations: ["Does not define whether evidence is complete."],
    ...overrides,
  };
}

test("a valid finding normalizes into the observed review state", () => {
  const result = validateFinding(baseInput());
  assert.equal(result.ok, true);
  assert.equal(result.normalized!.reviewState, "observed");
  assert.equal(result.normalized!.schemaVersion, FINDING_SCHEMA_VERSION);
});

test("rejects an invalid evidence level", () => {
  const result = validateFinding(baseInput({ evidenceLevel: "definitely_true" as never }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.field === "evidenceLevel"));
});

test("rejects missing required text fields", () => {
  const result = validateFinding(baseInput({ title: "  ", observedBehavior: "" }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.field === "title"));
  assert.ok(result.errors.some((e) => e.field === "observedBehavior"));
});

test("rejects secret-shaped content anywhere in the finding", () => {
  const result = validateFinding(baseInput({ suggestedResponse: "Use token=sk-live-abcdef1234567890abcd" }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /Rejected/.test(e.message)));
});

test("Adoption summary never implies causality", () => {
  assert.equal(summarizeAdoptions({ totalAdoptions: 0, confirmed: 0, contradicted: 0 }), "Not yet adopted by a later reviewed run.");
  const summary = summarizeAdoptions({ totalAdoptions: 3, confirmed: 2, contradicted: 1 });
  assert.match(summary, /Adopted in 3 later reviewed runs/);
  assert.match(summary, /confirmed in 2/);
  assert.match(summary, /contradicted in 1/);
  assert.ok(!/caused/i.test(summary));
  assert.ok(!/proved/i.test(summary));
});

function finding(overrides: Partial<FindingView> = {}): FindingView {
  return {
    id: "f1",
    originatingRunId: "run-1",
    originatingSender: "codex",
    title: "A finding",
    applicableEnvironment: "env",
    observedBehavior: "behavior",
    evidenceLevel: "correlated",
    suggestedResponse: "response",
    knownLimitations: [],
    reviewState: "available",
    createdAt: "2026-07-11T10:00:00Z",
    ...overrides,
  };
}

test("Brief caps at maxItems and reports truncation honestly", () => {
  const findings = Array.from({ length: 15 }, (_, i) => finding({ id: `f${i}`, title: `Finding ${i}` }));
  const brief = buildBrief(findings, null, { maxItems: 10 });
  assert.equal(brief.items.length, 10);
  assert.equal(brief.truncated, true);
});

test("Brief is not truncated when everything fits", () => {
  const findings = [finding()];
  const brief = buildBrief(findings, null);
  assert.equal(brief.items.length, 1);
  assert.equal(brief.truncated, false);
});

test("Brief carries the workspace's mission when a human has set one, and is honestly null otherwise", () => {
  const withMission = buildBrief([], {
    workspaceId: "workspace-1",
    mission: "Ship the billing migration without downtime.",
    setByUserId: "user-1",
    createdAt: "2026-07-11T10:00:00Z",
    updatedAt: "2026-07-11T10:00:00Z",
  });
  assert.equal(withMission.mission, "Ship the billing migration without downtime.");

  const withoutMission = buildBrief([], null);
  assert.equal(withoutMission.mission, null);
});
