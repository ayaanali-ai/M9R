import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const migration = readFileSync(join(process.cwd(), "supabase/migrations/20260728030000_fix_mission_result_validation_regex.sql"), "utf8");

test("PostgreSQL result validation keeps bounded canonical fields without bounded regex quantifiers", () => {
  assert.match(migration, /char_length\(p_result_digest\) not between 16 and 256/i);
  assert.match(migration, /char_length\(p_idempotency_key\) not between 16 and 256/i);
  assert.match(migration, /p_result_digest !~ '\^\[A-Za-z0-9\._:-\]\+\$'/);
  assert.match(migration, /p_idempotency_key !~ '\^\[A-Za-z0-9\._:-\]\+\$'/);
  assert.doesNotMatch(migration, /\{16,256\}/);
  assert.match(migration, /'invalid_digest'/);
  assert.match(migration, /'invalid_idempotency_key'/);
});
