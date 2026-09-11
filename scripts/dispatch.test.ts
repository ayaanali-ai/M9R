import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateDispatch,
  buildIdempotencyKey,
  isDispatchType,
  DISPATCH_TYPES,
  DISPATCH_SCHEMA_VERSION,
  type DispatchInput,
} from "../src/lib/dispatch.ts";

function baseInput(overrides: Partial<DispatchInput> = {}): DispatchInput {
  return {
    workspaceId: "ws-1",
    runId: "run-1",
    type: "RUN_STARTED",
    sender: "codex",
    summary: "task: fix live sync",
    ...overrides,
  };
}

test("all eleven dispatch types are recognized (8 canonical + 3 Bounded Assistance)", () => {
  assert.deepEqual(
    [...DISPATCH_TYPES],
    [
      "RUN_STARTED", "SCOPE_ANNOUNCED", "WORKING", "PHASE_CHANGED", "BLOCKED", "HUMAN_DECISION_REQUIRED", "EVIDENCE_READY", "RUN_COMPLETED",
      "HELP_REQUESTED", "CHECK_REQUESTED", "CHECK_RESULT_RETURNED",
    ],
  );
  assert.ok(isDispatchType("BLOCKED"));
  assert.ok(!isDispatchType("NONSENSE"));
});

test("a valid dispatch normalizes with an open resolution state", () => {
  const result = validateDispatch(baseInput());
  assert.equal(result.ok, true);
  assert.ok(result.normalized);
  assert.equal(result.normalized!.schemaVersion, DISPATCH_SCHEMA_VERSION);
  assert.equal(result.normalized!.resolutionState, "open");
  assert.equal(result.normalized!.visibility, "workspace");
});

test("same content produces the same idempotency key", () => {
  const a = validateDispatch(baseInput()).normalized!;
  const b = validateDispatch(baseInput()).normalized!;
  assert.equal(a.idempotencyKey, b.idempotencyKey);
});

test("scope order does not change the idempotency key", () => {
  const a = validateDispatch(baseInput({ scope: ["a.ts", "b.ts"] })).normalized!;
  const b = validateDispatch(baseInput({ scope: ["b.ts", "a.ts"] })).normalized!;
  assert.equal(a.idempotencyKey, b.idempotencyKey);
});

test("a different summary produces a different idempotency key", () => {
  const a = validateDispatch(baseInput({ summary: "task: fix live sync" })).normalized!;
  const b = validateDispatch(baseInput({ summary: "task: fix wire panel" })).normalized!;
  assert.notEqual(a.idempotencyKey, b.idempotencyKey);
});

test("buildIdempotencyKey is stable across repeated calls with the same input", () => {
  const key1 = buildIdempotencyKey({ workspaceId: "ws-1", runId: "run-1", type: "WORKING", sender: "codex", summary: "phase: editing" });
  const key2 = buildIdempotencyKey({ workspaceId: "ws-1", runId: "run-1", type: "WORKING", sender: "codex", summary: "phase: editing" });
  assert.equal(key1, key2);
});

test("rejects an unknown dispatch type", () => {
  const result = validateDispatch(baseInput({ type: "NOT_A_TYPE" as never }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.field === "type"));
});

test("rejects a missing summary", () => {
  const result = validateDispatch(baseInput({ summary: "  " }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.field === "summary"));
});

test("rejects an oversized summary", () => {
  const result = validateDispatch(baseInput({ summary: "x".repeat(300) }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /exceeds/.test(e.message)));
});

test("rejects secret-shaped content in the summary", () => {
  const result = validateDispatch(baseInput({ summary: "Bearer sk-live-abcdef1234567890" }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /Rejected/.test(e.message)));
});

test("rejects active script content in scope entries", () => {
  const result = validateDispatch(baseInput({ scope: ["<script>alert(1)</script>"] }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /active script/.test(e.message)));
});

test("rejects a missing workspaceId or runId", () => {
  const noWorkspace = validateDispatch(baseInput({ workspaceId: "" }));
  assert.equal(noWorkspace.ok, false);
  const noRun = validateDispatch(baseInput({ runId: "" }));
  assert.equal(noRun.ok, false);
});
