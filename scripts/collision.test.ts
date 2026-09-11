import { test } from "node:test";
import assert from "node:assert/strict";
import { detectCollisions, hasCollision, type RunScope } from "../src/lib/collision.ts";

test("no collision when scopes don't overlap", () => {
  const runs: RunScope[] = [
    { runId: "r1", sender: "codex", scope: ["a.ts"] },
    { runId: "r2", sender: "cursor", scope: ["b.ts"] },
  ];
  assert.deepEqual(detectCollisions(runs), []);
});

test("detects an overlap between two runs touching the same file", () => {
  const runs: RunScope[] = [
    { runId: "r1", sender: "codex", scope: ["a.ts", "b.ts"] },
    { runId: "r2", sender: "cursor", scope: ["b.ts", "c.ts"] },
  ];
  const collisions = detectCollisions(runs);
  assert.equal(collisions.length, 1);
  assert.deepEqual(collisions[0].runIds, ["r1", "r2"]);
  assert.deepEqual(collisions[0].overlappingPaths, ["b.ts"]);
});

test("runs with no declared scope are never flagged", () => {
  const runs: RunScope[] = [
    { runId: "r1", sender: "codex", scope: [] },
    { runId: "r2", sender: "cursor", scope: ["b.ts"] },
  ];
  assert.deepEqual(detectCollisions(runs), []);
});

test("three-way overlap produces a collision for each overlapping pair", () => {
  const runs: RunScope[] = [
    { runId: "r1", sender: "codex", scope: ["a.ts"] },
    { runId: "r2", sender: "cursor", scope: ["a.ts"] },
    { runId: "r3", sender: "claude", scope: ["a.ts"] },
  ];
  const collisions = detectCollisions(runs);
  assert.equal(collisions.length, 3);
});

test("a run never collides with itself", () => {
  const runs: RunScope[] = [{ runId: "r1", sender: "codex", scope: ["a.ts"] }];
  assert.deepEqual(detectCollisions(runs), []);
});

test("hasCollision reports true only for runs actually involved", () => {
  const runs: RunScope[] = [
    { runId: "r1", sender: "codex", scope: ["a.ts"] },
    { runId: "r2", sender: "cursor", scope: ["a.ts"] },
    { runId: "r3", sender: "claude", scope: ["z.ts"] },
  ];
  assert.equal(hasCollision("r1", runs), true);
  assert.equal(hasCollision("r3", runs), false);
});
