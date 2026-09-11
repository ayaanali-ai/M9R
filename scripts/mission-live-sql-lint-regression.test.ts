import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260728050000_fix_mission_runtime_sql_lint.sql"),
  "utf8",
);
const variableConflictMigration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260728051000_fix_dispatch_claim_variable_conflict.sql"),
  "utf8",
);

test("command application qualifies output-parameter column names", () => {
  assert.match(migration, /select m\.current_version, m\.workspace_id/i);
  assert.match(migration, /from public\.missions m/i);
  assert.doesNotMatch(migration, /select current_version, workspace_id/i);
});

test("dispatch claim refusals return typed nullable jsonb columns", () => {
  assert.match(migration, /#variable_conflict use_column/i);
  const refusalQueries = migration.match(/return query select[^;]+;/gi) ?? [];
  assert.ok(refusalQueries.length >= 10);
  for (const query of refusalQueries.filter((value) => value.includes("'refused'"))) {
    assert.match(query, /null::jsonb,\s*null::jsonb/i);
  }
  assert.match(migration, /'claimed'::text,\s*null::text,\s*jsonb_build_object/i);
});

test("live correction scopes column conflict handling to the dispatch claim RPC", () => {
  assert.match(
    variableConflictMigration,
    /pg_get_functiondef\([\s\S]*claim_mission_dispatch_candidates_atomic\(jsonb,jsonb,timestamptz,bigint,text\[\]\)[\s\S]*#variable_conflict use_column/i,
  );
  assert.match(variableConflictMigration, /if v_corrected = v_definition then[\s\S]*raise exception/i);
  assert.match(variableConflictMigration, /execute v_corrected/i);
});

test("corrective functions preserve service-role-only execution", () => {
  assert.match(
    migration,
    /revoke all on function public\.apply_mission_command_atomic[\s\S]*from public, anon, authenticated/i,
  );
  assert.match(
    migration,
    /grant execute on function public\.claim_mission_dispatch_candidates_atomic[\s\S]*to service_role/i,
  );
});
