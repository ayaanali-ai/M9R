// Unit tests for the trace upload validation + metadata extraction. Run with:
//   npm run test
//
// These cover the PURE helper (validateAndExtractTraceMeta) which holds all the
// "what is a valid trace" rules. Persistence (uploadTrace) needs Supabase and is
// exercised separately.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateAndExtractTraceMeta,
  TraceValidationError,
  MAX_TRACE_BYTES,
} from "@/lib/trace-upload";

function validTrace() {
  return {
    schema: "oathlock.trace.v0",
    session_id: "ol_sess_123",
    task_summary: "do the thing",
    variant: "messy",
    actors_observed: ["human", "agent"],
    steps: [
      { step: 1, actor: "agent", errors: ["boom"], retries: 1 },
      {
        step: 2,
        actor: "model",
        token_usage: { input: 100, output: 50, total: 150 },
        estimated_cost_usd: 0.002,
      },
    ],
    totals: { steps: 2, failed_commands: 1, retries: 2 },
  };
}

test("accepts a well-formed trace and derives metadata", () => {
  const meta = validateAndExtractTraceMeta(validTrace());
  assert.equal(meta.sessionId, "ol_sess_123");
  assert.equal(meta.taskSummary, "do the thing");
  assert.equal(meta.schema, "oathlock.trace.v0");
  assert.equal(meta.variant, "messy");
  assert.equal(meta.stepCount, 2);
  assert.equal(meta.failedStepCount, 1);
  assert.equal(meta.retryCount, 2, "prefers totals.retries over per-step sum");
  assert.equal(meta.hasTokenUsage, true);
  assert.equal(meta.hasCostData, true);
  assert.equal(meta.totalInputTokens, 100);
  assert.equal(meta.totalOutputTokens, 50);
  assert.deepEqual(meta.distinctActors.sort(), ["agent", "human", "model"]);
  assert.ok(meta.byteSize > 0);
});

test("supports camelCase field names", () => {
  const meta = validateAndExtractTraceMeta({
    sessionId: "s1",
    taskSummary: "t",
    steps: [{ step: 1, tokenUsage: { input: 1, output: 2, total: 3 } }],
  });
  assert.equal(meta.sessionId, "s1");
  assert.equal(meta.hasTokenUsage, true);
});

test("falls back to summed per-step retries when totals absent", () => {
  const meta = validateAndExtractTraceMeta({
    session_id: "s",
    steps: [{ step: 1, retries: 2 }, { step: 2, retries: 3 }],
  });
  assert.equal(meta.retryCount, 5);
});

test("rejects non-object payloads", () => {
  assert.throws(() => validateAndExtractTraceMeta([] as unknown), TraceValidationError);
  assert.throws(() => validateAndExtractTraceMeta("nope" as unknown), TraceValidationError);
  assert.throws(() => validateAndExtractTraceMeta(null as unknown), TraceValidationError);
});

test("rejects a trace without a steps array", () => {
  assert.throws(
    () => validateAndExtractTraceMeta({ session_id: "s" }),
    /must contain a 'steps' array/,
  );
});

test("rejects an empty steps array", () => {
  assert.throws(
    () => validateAndExtractTraceMeta({ session_id: "s", steps: [] }),
    /must not be empty/,
  );
});

test("rejects a trace without a session id", () => {
  assert.throws(
    () => validateAndExtractTraceMeta({ steps: [{ step: 1 }] }),
    /must include a non-empty 'sessionId'/,
  );
});

test("rejects an oversized trace", () => {
  // Build a payload that serializes past the limit via a big string field.
  const big = "x".repeat(MAX_TRACE_BYTES + 100);
  assert.throws(
    () => validateAndExtractTraceMeta({ session_id: "s", note: big, steps: [{ step: 1 }] }),
    /too large/,
  );
});

test("clean trace reports no token usage / cost when absent", () => {
  const meta = validateAndExtractTraceMeta({
    session_id: "s",
    steps: [{ step: 1, actor: "agent" }],
  });
  assert.equal(meta.hasTokenUsage, false);
  assert.equal(meta.hasCostData, false);
  assert.equal(meta.totalInputTokens, null);
  assert.equal(meta.failedStepCount, 0);
});
