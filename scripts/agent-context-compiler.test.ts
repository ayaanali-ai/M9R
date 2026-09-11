import assert from "node:assert/strict";
import test from "node:test";
import { compileContextRequest } from "@/lib/agent-context-broker";

test("compiler deduplicates and keeps governance references before files", () => {
  const compiled = compileContextRequest({
    refs: ["file://src/a.ts", "rule://retry", "file://src/a.ts", "decision://d1", "finding://f1"],
    maxFetches: 3,
  });
  assert.deepEqual(compiled.refs, ["rule://retry", "decision://d1", "finding://f1"]);
  assert.deepEqual(compiled.omittedRefs, ["file://src/a.ts"]);
});

test("compiler preserves input order within the same priority", () => {
  const compiled = compileContextRequest({
    refs: ["file://b.ts", "file://a.ts", "diff://run/current"],
    maxFetches: 3,
  });
  assert.deepEqual(compiled.refs, ["diff://run/current", "file://b.ts", "file://a.ts"]);
});

test("compiler rejects invalid fetch budgets and malformed references", () => {
  assert.throws(() => compileContextRequest({ refs: [], maxFetches: -1 }));
  assert.throws(() => compileContextRequest({ refs: ["not-a-reference"], maxFetches: 1 }));
});
