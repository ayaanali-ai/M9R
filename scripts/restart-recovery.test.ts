import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryLedger, type LedgerEntry } from "@/lib/bridge/delivery-ledger";
import { RESTART_INTERRUPTED_EVENT, RESTART_INTERRUPTED_NOTE, classifyRestartRecovery, restartInterruptedNotice } from "@/lib/bridge/restart-recovery";
import { deriveDelivery } from "@/lib/delivery-state";

const STARTED = 1_000_000;
const before = STARTED - 5_000;
const after = STARTED + 5_000;
const entry = (state: LedgerEntry["state"], at: number, note?: string): LedgerEntry => ({ messageId: "m1", provider: "claude-code", state, at, ...(note ? { note } : {}) });

test("no ledger entry means run: today's behavior, including a missing or deleted ledger", () => {
  assert.equal(classifyRestartRecovery(null, STARTED), "run");
});

test("a message a previous process handed to a session and never finished is interrupted, not re-run", () => {
  assert.equal(classifyRestartRecovery(entry("delivered_to_session", before), STARTED), "interrupted");
  assert.equal(classifyRestartRecovery(entry("processing", before), STARTED), "interrupted");
});

test("a message only received by a previous process is safe to run: no session ever saw it", () => {
  assert.equal(classifyRestartRecovery(entry("delivered_to_node", before), STARTED), "run");
});

test("a turn a previous process completed is skipped, so a missed cursor advance never repeats finished work", () => {
  assert.equal(classifyRestartRecovery(entry("completed", before), STARTED), "already_handled");
});

test("a genuine failure stays retryable, but one already reported as restart-interrupted is never re-run", () => {
  assert.equal(classifyRestartRecovery(entry("failed", before), STARTED), "run");
  assert.equal(classifyRestartRecovery(entry("failed", before, RESTART_INTERRUPTED_NOTE), STARTED), "already_handled");
});

test("this process's own in-flight work is never treated as interrupted, whatever its state", () => {
  for (const state of ["delivered_to_node", "delivered_to_session", "processing", "completed", "failed"] as const) {
    assert.equal(classifyRestartRecovery(entry(state, after), STARTED), "run", state);
    assert.equal(classifyRestartRecovery(entry(state, STARTED), STARTED), "run", `${state} at the exact start time`);
  }
});

test("the notice tells the human what happened and what to do, and contains no @ mention that could wake a Bridge", () => {
  const notice = restartInterruptedNotice("claude-code");
  assert.match(notice, /restarted while it was working/);
  assert.match(notice, /nothing was run again/);
  assert.match(notice, /Send the message again/);
  assert.doesNotMatch(notice, /@/);
});

test("the restart-interrupted note survives a restart in the ledger and drives the decision end to end", () => {
  const path = join(mkdtempSync(join(tmpdir(), "m9r-recovery-")), "ledger.jsonl");
  const firstProcess = new DeliveryLedger(path, () => before);
  firstProcess.record("m1", "claude-code", "delivered_to_node", before);
  firstProcess.record("m1", "claude-code", "delivered_to_session", before);
  firstProcess.record("m1", "claude-code", "processing", before);

  const secondProcess = new DeliveryLedger(path, () => after);
  secondProcess.load();
  assert.equal(classifyRestartRecovery(secondProcess.entryOf("m1", "claude-code"), STARTED), "interrupted");
  secondProcess.record("m1", "claude-code", "failed", after, RESTART_INTERRUPTED_NOTE);

  const thirdProcess = new DeliveryLedger(path, () => after + 10_000);
  thirdProcess.load();
  assert.equal(thirdProcess.entryOf("m1", "claude-code")?.note, RESTART_INTERRUPTED_NOTE);
  assert.equal(classifyRestartRecovery(thirdProcess.entryOf("m1", "claude-code"), STARTED + 10_000), "already_handled", "a later restart must not run it");
});

test("the delivery timeline reports the interruption as failed with the reason restart_interrupted", () => {
  const base = Date.parse("2026-09-19T05:00:00.000Z");
  const at = (s: number) => new Date(base + s * 1000).toISOString();
  const view = deriveDelivery({
    messageCreatedAt: at(0),
    recipient: { provider: "claude-code", address: "@claude-code", endpointId: "ep_1", live: true, fidelityLevel: "LIVE_NATIVE" },
    now: base + 120_000,
    timings: [
      { stage: "message.received", provider: "claude-code", occurred_at: at(1), at_ms: base + 1000 },
      { stage: "prompt.started", provider: "claude-code", occurred_at: at(2), at_ms: base + 2000 },
      { stage: "provider.first_event", provider: "claude-code", occurred_at: at(4), at_ms: base + 4000 },
      { stage: "message.received", provider: "claude-code", occurred_at: at(60), at_ms: base + 60_000 },
      { stage: "turn.failed", provider: "claude-code", occurred_at: at(61), at_ms: base + 61_000, metadata: { outcome: "failed", providerEventType: RESTART_INTERRUPTED_EVENT } },
    ],
  });
  assert.equal(view.state, "failed");
  assert.equal(view.failureCode, "restart_interrupted");
  assert.deepEqual(view.timeline.map((entry) => entry.state), ["accepted", "delivered_to_node", "delivered_to_session", "processing", "failed"]);
});

test("the Bridge checks recovery synchronously in all three delivery paths, before any session is started", () => {
  const src = readFileSync("services/mission-bridge/src/bridge-runtime.ts", "utf8");
  const calls = [...src.matchAll(/restartRecoveryFor\(workspaceMessage\.id\)/g)];
  assert.equal(calls.length, 3, "snapshot, relay event and poll paths each need the guard");
  for (const match of calls) {
    const index = match.index ?? 0;
    const nextEnsure = src.indexOf("ensureDynamicSessionForConversation(", index);
    const nextTiming = src.indexOf("workspaceTurnTimingPendingFor(", index);
    assert.ok(nextEnsure > index, "a session start follows the guard");
    assert.ok(nextTiming > index, "the pending timing mark follows the guard");
    const window = src.slice(index, Math.min(nextEnsure, nextTiming));
    assert.doesNotMatch(window, /\bawait\b/, "the guard must not add an await before the session start decision");
  }
});
