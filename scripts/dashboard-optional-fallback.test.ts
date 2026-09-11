import assert from "node:assert/strict";
import test from "node:test";
import { isMissingOptionalTableError } from "@/lib/dashboard-optional-fallback";

test("optional dashboard fallback recognizes Supabase missing-table responses", () => {
  assert.equal(isMissingOptionalTableError(new Error("Could not find the table 'public.mission_usage_ledger' in the schema cache")), true);
  assert.equal(isMissingOptionalTableError({ code: "42P01", message: "relation does not exist" }), true);
  assert.equal(isMissingOptionalTableError({ code: "PGRST205", message: "table not found" }), true);
});

test("optional dashboard fallback does not hide unrelated database failures", () => {
  assert.equal(isMissingOptionalTableError(new Error("permission denied for table")), false);
  assert.equal(isMissingOptionalTableError(null), false);
});
