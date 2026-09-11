import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const sql = readFileSync(join(process.cwd(), "supabase/migrations/20260728040000_add_mission_result_evidence_requirement.sql"), "utf8");

test("evidence requirement replaces, rather than overloads, result acceptance", () => {
  assert.match(sql, /drop function public\.accept_mission_execution_result_atomic/i);
  assert.match(sql, /create function public\.accept_mission_execution_result_atomic/i);
  assert.match(sql, /p_evidence_required boolean/);
  assert.match(sql, /invalid_evidence_requirement/);
  assert.match(sql, /evidence_required is not distinct from p_evidence_required/i);
  assert.match(sql, /evidence_required,correlation_id/i);
  assert.doesNotMatch(sql, /accept_mission_execution_result_with_evidence_atomic/);
});

test("fully applied is gated by the trusted evidence policy", () => {
  assert.match(sql, /drop function public\.update_mission_execution_result_application_atomic/i);
  assert.match(sql, /returns jsonb language plpgsql security definer set search_path=''/i);
  for (const refusal of ["claim_not_owned", "claim_expired", "lifecycle_not_applied", "evidence_requirement_unknown", "evidence_not_applied"]) {
    assert.match(sql, new RegExp(refusal));
  }
  assert.ok(sql.indexOf("if v.lifecycle_applied_at is null") < sql.indexOf("application_status='fully_applied'"));
  assert.ok(sql.indexOf("if v.evidence_required is null") < sql.indexOf("application_status='fully_applied'"));
});
