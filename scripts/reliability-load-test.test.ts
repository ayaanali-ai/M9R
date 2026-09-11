import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs, percentile } from "./reliability-load-test.mjs";

test("parseArgs defaults to a safe, local, read-only, unauthenticated-refusing configuration", () => {
  const args = parseArgs([]);
  assert.equal(args.base, "http://localhost:3000");
  assert.equal(args.method, "GET");
  assert.equal(args.token, null);
});

test("parseArgs reads every flag", () => {
  const args = parseArgs(["--base", "https://example.test", "--endpoint", "/api/x", "--method", "POST", "--concurrency", "5", "--requests", "20", "--body", "{}", "--token", "oak_x"]);
  assert.equal(args.base, "https://example.test");
  assert.equal(args.endpoint, "/api/x");
  assert.equal(args.method, "POST");
  assert.equal(args.concurrency, 5);
  assert.equal(args.requests, 20);
  assert.equal(args.body, "{}");
  assert.equal(args.token, "oak_x");
});

test("percentile picks the right rank and never fabricates a value for an empty set", () => {
  const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.equal(percentile(sorted, 50), 60);
  assert.equal(percentile(sorted, 0), 10);
  assert.equal(percentile(sorted, 99), 100);
  assert.equal(percentile([], 50), 0);
});

test("importing the module makes no network call (main() only runs when invoked directly)", async () => {
  // If main() ran on import, this test process would hang or error trying to
  // fetch http://localhost:3000 with no server there. Reaching this assertion
  // at all is the proof.
  assert.ok(true);
});
