import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateResultAdoption } from "@/lib/result-adoption";

test("a primary agent records an explicit bounded adoption decision", () => {
  const result = validateResultAdoption({
    decision: "adopted",
    rationale: "The review identified a missing provider flag, so the plan now includes the correction.",
    planEffect: "Add the missing provider flag and regression test.",
  });
  assert.equal(result.ok, true);
  assert.equal(result.adoption?.decision, "adopted");
});

test("adoption rejects empty, overlong, or unknown decisions", () => {
  assert.equal(validateResultAdoption({ decision: "adopted", rationale: "", planEffect: "x" }).ok, false);
  assert.equal(validateResultAdoption({ decision: "invented", rationale: "x", planEffect: "x" }).ok, false);
  assert.equal(validateResultAdoption({ decision: "rejected", rationale: "x".repeat(1001), planEffect: "x" }).ok, false);
});

test("adoption is requester-bound, return-only, immutable, and graphable", async () => {
  const service = await readFile(new URL("../src/lib/result-adoption-service.ts", import.meta.url), "utf8");
  const route = await readFile(new URL("../src/app/api/agent/runs/[id]/adopt-result/route.ts", import.meta.url), "utf8");
  const migration = await readFile(new URL("../supabase/migrations/20260714000652_gate11f_result_adoptions.sql", import.meta.url), "utf8");
  assert.match(service, /requesting_connection_id", agent\.connectionId/);
  assert.match(service, /grant\.state !== "returning"/);
  assert.match(migration, /unique \(launch_grant_id\)/);
  assert.match(migration, /enable row level security/);
  assert.match(route, /recordResultAdoption/);
});

test("adoption carries the provider's reported usage onto the run's behavior snapshot, additively", async () => {
  const service = await readFile(new URL("../src/lib/result-adoption-service.ts", import.meta.url), "utf8");
  // The merge must be additive (spread existing behavior first) and must
  // never fabricate a value when the provider never reported one — every
  // field falls back to the pre-existing value, then to null.
  assert.match(service, /mergeAdoptedUsageIntoRunBehavior/);
  assert.match(service, /event_type", "return_result"/);
  assert.match(service, /\.\.\.existing,/);
  assert.match(service, /usage\.totalTokens \?\? existing\.totalTokens \?\? null/);
  // Usage carryover must be best-effort: a failure here cannot throw and
  // block the adoption decision that was already durably recorded.
  assert.match(service, /never let it block or fail an adoption decision/);
});
