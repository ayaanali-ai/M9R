import assert from "node:assert/strict";
import test from "node:test";
import { workspaceResultIdempotencyKey } from "@/lib/bridge/workspace-result-idempotency";

const result = { parentMessageId: "parent-1", identity: "codex-connection", body: "Done", outcome: "ok" as const };

test("result retries use one stable key across transports", () => {
  assert.equal(workspaceResultIdempotencyKey(result), workspaceResultIdempotencyKey({ ...result }));
});

test("distinct reports for one turn do not conflict forever", () => {
  const first = workspaceResultIdempotencyKey(result);
  assert.notEqual(first, workspaceResultIdempotencyKey({ ...result, body: "Turn failed" }));
  assert.notEqual(first, workspaceResultIdempotencyKey({ ...result, outcome: "failed" }));
});

test("result keys stay within the database limit", () => {
  const oversized = { ...result, identity: "x".repeat(400) };
  assert.ok(workspaceResultIdempotencyKey(oversized).length <= 256);
  assert.notEqual(workspaceResultIdempotencyKey(oversized), workspaceResultIdempotencyKey({ ...oversized, body: "Different" }));
});
