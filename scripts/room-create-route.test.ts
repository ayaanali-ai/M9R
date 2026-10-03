import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// The creator only becomes a room member in an AFTER INSERT trigger, and rooms are readable by members only. Asking for the
// inserted row back in the same statement is refused by row-level security (found live in the first cross-user test).
test("creating a room inserts first and reads the room in a separate query", () => {
  const source = readFileSync(join(process.cwd(), "src/app/api/rooms/route.ts"), "utf8");
  assert.doesNotMatch(source, /\.insert\([^)]*\)\s*\.select\(/s, "insert must not chain .select() on m9r_rooms");
  assert.match(source, /randomUUID\(\)/);
  assert.match(source, /\.from\("m9r_rooms"\)\s*\.select\([^)]*\)\s*\.eq\("id", roomId\)/s);
});
