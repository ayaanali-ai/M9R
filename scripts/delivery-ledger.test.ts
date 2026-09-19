import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryLedger, LEDGER_RETENTION_MS } from "@/lib/bridge/delivery-ledger";
import { stateForTimingStage } from "@/lib/delivery-state";

function tempPath() {
  return join(mkdtempSync(join(tmpdir(), "m9r-ledger-")), "runtime", "delivery-ledger-codex.jsonl");
}

test("recording writes a line before returning true, creating the directory, and survives a restart", () => {
  const path = tempPath();
  const first = new DeliveryLedger(path);
  assert.equal(first.record("m1", "codex", "delivered_to_node"), true);
  assert.equal(first.record("m1", "codex", "delivered_to_session"), true);
  assert.match(readFileSync(path, "utf8"), /"state":"delivered_to_node"/);

  const restarted = new DeliveryLedger(path);
  restarted.load();
  assert.equal(restarted.stateOf("m1", "codex"), "delivered_to_session");
  assert.equal(restarted.stateOf("m1", "claude-code"), null, "state is per provider");
  assert.equal(restarted.stateOf("nope", "codex"), null);
});

test("repeats and older states are no-ops that still report the ledger holds the message", () => {
  const path = tempPath();
  const ledger = new DeliveryLedger(path);
  assert.equal(ledger.record("m1", "codex", "processing"), true);
  assert.equal(ledger.record("m1", "codex", "processing"), true);
  assert.equal(ledger.record("m1", "codex", "delivered_to_node"), true);
  assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 1, "nothing was appended for the repeat or the older state");
  assert.equal(ledger.stateOf("m1", "codex"), "processing");
});

test("a failed message may start again from delivered_to_node, and then complete", () => {
  const ledger = new DeliveryLedger(tempPath());
  ledger.record("m1", "codex", "delivered_to_node");
  ledger.record("m1", "codex", "failed");
  assert.equal(ledger.stateOf("m1", "codex"), "failed");
  ledger.record("m1", "codex", "delivered_to_node");
  assert.equal(ledger.stateOf("m1", "codex"), "delivered_to_node");
  ledger.record("m1", "codex", "completed");
  assert.equal(ledger.stateOf("m1", "codex"), "completed");
});

test("unfinished lists only messages that reached a session and never ended: what a restart must reconcile", () => {
  const ledger = new DeliveryLedger(tempPath());
  ledger.record("received-only", "codex", "delivered_to_node");
  ledger.record("in-session", "codex", "delivered_to_session");
  ledger.record("running", "codex", "processing");
  ledger.record("done", "codex", "completed");
  ledger.record("broke", "codex", "failed");
  assert.deepEqual(ledger.unfinished().map((entry) => entry.messageId).sort(), ["in-session", "running"]);
});

test("a corrupt or partial line is skipped and never breaks loading", () => {
  const path = tempPath();
  const ledger = new DeliveryLedger(path);
  ledger.record("m1", "codex", "delivered_to_node");
  appendFileSync(path, "{not json\n{\"messageId\":1}\n{\"messageId\":\"m2\",\"provider\":\"codex\",\"state\":\"bogus\",\"at\":1}\n", "utf8");
  ledger.record("m3", "codex", "delivered_to_node");
  const reloaded = new DeliveryLedger(path);
  reloaded.load();
  assert.equal(reloaded.stateOf("m1", "codex"), "delivered_to_node");
  assert.equal(reloaded.stateOf("m3", "codex"), "delivered_to_node");
  assert.equal(reloaded.stateOf("m2", "codex"), null);
});

test("entries older than the 7-day retention are dropped on load and the file is compacted", () => {
  const path = tempPath();
  const now = Date.now();
  const writer = new DeliveryLedger(path, () => now);
  writer.record("old", "codex", "delivered_to_node", now - LEDGER_RETENTION_MS - 1000);
  writer.record("fresh", "codex", "delivered_to_node", now - 1000);
  const reloaded = new DeliveryLedger(path, () => now);
  reloaded.load();
  assert.equal(reloaded.stateOf("old", "codex"), null);
  assert.equal(reloaded.stateOf("fresh", "codex"), "delivered_to_node");
  assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 1);
});

test("an unwritable ledger reports false so the receipt is never claimed as persisted, and nothing throws", () => {
  const path = tempPath();
  // A file where the directory should be makes mkdir/append fail on every platform.
  const parent = join(path, "..", "..");
  writeFileSync(join(parent, "runtime"), "not a directory", "utf8");
  const ledger = new DeliveryLedger(path);
  assert.equal(ledger.record("m1", "codex", "delivered_to_node"), false);
  assert.equal(ledger.stateOf("m1", "codex"), null);
});

test("the bridge maps timing stages to ledger states with the same table the server uses", () => {
  assert.equal(stateForTimingStage("message.received"), "delivered_to_node");
  assert.equal(stateForTimingStage("prompt.started"), "delivered_to_session");
  assert.equal(stateForTimingStage("provider.first_event"), "processing");
  assert.equal(stateForTimingStage("turn.completed", "ok"), "completed");
  assert.equal(stateForTimingStage("turn.completed", "failed"), "failed");
  assert.equal(stateForTimingStage("turn.failed"), "failed");
  assert.equal(stateForTimingStage("turn.rejected"), null, "a decline is not a delivery state");
  assert.equal(stateForTimingStage("session.ready"), null);
});
