import assert from "node:assert/strict";
import test from "node:test";
import { stateLabel } from "@/lib/native/approval-commands";
import type { Task, TaskReceiptState } from "@/lib/native/inbox-core";

const at = "2026-11-07T00:58:07.245Z";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "T208", seq: 208, from: "you", to: "codex", goal: "Complete the requested work",
    goalTruncated: false, pointers: [], origin: "human_typed", approval: "approved", replyDepth: 0,
    idempotencyKey: "status-regression", createdAt: at,
    delivery: { state: "queued", attempts: 1 }, ...overrides,
  };
}

function receipt(state: TaskReceiptState): Task["receipt"] {
  return { state, attempt: 1, updatedAt: at, source: "provider-session", history: [] };
}

test("execution outcomes override stale queued and sending transport labels", () => {
  for (const state of ["queued", "sending", "done"] as const) {
    const delivery = { state, attempts: 1 };
    assert.equal(stateLabel(task({ delivery, receipt: receipt("paused") })), "paused");
    assert.equal(stateLabel(task({ delivery, receipt: receipt("failed") })), "failed");
    assert.equal(stateLabel(task({ delivery, receipt: receipt("canceled") })), "canceled");
    assert.equal(stateLabel(task({ delivery, receipt: receipt("completed") })), "answered");
  }
});

test("T208's incomplete completion stays visible with its paused receipt", () => {
  const completion: Task["completion"] = { status: "incomplete", remainingWork: ["Calculate and save the note"], summary: "Stopped before completion", updatedAt: at };
  assert.equal(stateLabel(task({ receipt: receipt("paused"), completion })), "paused; incomplete");
  assert.equal(stateLabel(task({ completion })), "paused; incomplete", "older records may lack a canonical receipt");
  assert.equal(stateLabel(task({ receipt: receipt("failed"), completion })), "failed", "a later failure remains authoritative");
  assert.equal(stateLabel(task({ receipt: receipt("canceled"), completion })), "canceled", "a later cancellation remains authoritative");
});

test("completion evidence and legacy lifecycle outcomes override transport acceptance", () => {
  assert.equal(stateLabel(task({ completion: { status: "completed", remainingWork: [], summary: "Verified", updatedAt: at } })), "answered");
  assert.equal(stateLabel(task({ resultSummary: "Verified" })), "answered");
  assert.equal(stateLabel(task({ lifecycle: { state: "completed" } })), "answered");
  assert.equal(stateLabel(task({ lifecycle: { state: "failed" } })), "failed");
  assert.equal(stateLabel(task({ receipt: receipt("uncertain") })), "outcome uncertain; inspect before retrying");
  assert.equal(stateLabel(task({ receipt: receipt("retryable") })), "retryable; waiting for delivery");
});

test("ordinary acceptance, approvals, and retirement keep their existing labels", () => {
  assert.equal(stateLabel(task()), "accepted by the session; waiting for a result");
  assert.equal(stateLabel(task({ approval: "pending" })), "awaiting approval");
  assert.equal(stateLabel(task({ approval: "denied" })), "denied");
  assert.equal(stateLabel(task({ approval: "expired" })), "lapsed");
  assert.equal(stateLabel(task({ retiredAt: at })), "retired from live delivery; history retained");
});
