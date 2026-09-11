import assert from "node:assert/strict";
import test from "node:test";
import { isMissingTurnIdColumnError } from "@/lib/mission/mission-runtime-event-store-supabase";

test("runtime event store recognizes databases that predate turn_id", () => {
  assert.equal(isMissingTurnIdColumnError({ code: "42703", message: "column turn_id does not exist" }), true);
  assert.equal(isMissingTurnIdColumnError({ code: "PGRST204", message: "Could not find the turn_id column" }), true);
  assert.equal(isMissingTurnIdColumnError({ code: "42P01", message: "relation does not exist" }), false);
  assert.equal(isMissingTurnIdColumnError(null), false);
});
