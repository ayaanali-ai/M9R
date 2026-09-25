import assert from "node:assert/strict";
import test from "node:test";
import { createFindingLedger, statusOf } from "@/lib/native/finding-ledger-core";

function ledger(required = 1) {
  let n = 0;
  let clock = 1_000;
  return createFindingLedger({ now: () => (clock += 10), newId: () => `f${++n}`, requiredConfirmations: required });
}

test("a fresh finding is unverified and cannot be relied on", () => {
  const l = ledger();
  const finding = l.report({ task: "search", reporter: "a1", claim: "code is UU35D3", evidence: "page /p/17" });
  assert.ok(finding.ok);
  assert.equal(statusOf(finding.value), "unverified");
  const decision = l.canRely("f1");
  assert.equal(decision.rely, false);
  assert.match(decision.reason, /independent confirmation/);
});

test("the reporter cannot verify its own finding, and nobody can verify twice", () => {
  const l = ledger();
  l.report({ task: "search", reporter: "a1", claim: "x" });
  const self = l.verify("f1", "a1", "confirmed");
  assert.equal(self.ok, false);
  assert.match(self.ok ? "" : self.error, /cannot be verified by the agent that reported it/);
  assert.ok(l.verify("f1", "a2", "confirmed").ok);
  const again = l.verify("f1", "a2", "confirmed");
  assert.equal(again.ok, false);
  assert.match(again.ok ? "" : again.error, /already verified/);
});

test("one independent confirmation makes a finding reliable and records who confirmed", () => {
  const l = ledger();
  l.report({ task: "search", reporter: "a1", claim: "x" });
  l.verify("f1", "a2", "confirmed", "same code on the detail page");
  assert.deepEqual(l.canRely("f1"), { rely: true, reason: "confirmed by a2" });
  assert.equal(l.get("f1")?.verifications[0].note, "same code on the detail page");
});

test("a rejection blocks a finding even after another agent confirmed it", () => {
  const l = ledger();
  l.report({ task: "search", reporter: "a1", claim: "x" });
  l.verify("f1", "a2", "confirmed");
  l.verify("f1", "a3", "rejected", "near-miss decoy, one character differs");
  const decision = l.canRely("f1");
  assert.equal(decision.rely, false);
  assert.match(decision.reason, /a3 rejected/);
  assert.equal(statusOf(l.get("f1") as never), "rejected");
});

test("a stricter ledger asks for more confirmations", () => {
  const l = ledger(2);
  l.report({ task: "trip", reporter: "a1", claim: "y" });
  l.verify("f1", "a2", "confirmed");
  assert.match(l.canRely("f1").reason, /needs 1 more/);
  l.verify("f1", "a3", "confirmed");
  assert.equal(l.canRely("f1").rely, true);
});

test("an agent is offered only teammates' findings it has not checked yet, per task", () => {
  const l = ledger();
  l.report({ task: "search", reporter: "a1", claim: "one" });
  l.report({ task: "search", reporter: "a2", claim: "two" });
  l.report({ task: "trip", reporter: "a1", claim: "other task" });
  assert.deepEqual(l.toVerify("a2", "search").map((f) => f.id), ["f1"]);
  l.verify("f1", "a2", "confirmed");
  assert.deepEqual(l.toVerify("a2", "search"), []);
  assert.deepEqual(l.toVerify("a3", "search").map((f) => f.id), ["f2"], "f1 is already reliable, so a third agent need not re-check it");
  const strict = ledger(2);
  strict.report({ task: "search", reporter: "a1", claim: "one" });
  strict.verify("f1", "a2", "confirmed");
  assert.deepEqual(strict.toVerify("a3", "search").map((f) => f.id), ["f1"], "a stricter ledger still wants another confirmation");
  strict.verify("f1", "a3", "rejected");
  assert.deepEqual(strict.toVerify("a4", "search"), [], "a rejected finding is not offered again");
});

test("bad input is refused and long text is capped", () => {
  const l = ledger();
  assert.equal(l.report({ task: "search", reporter: "a1", claim: "   " }).ok, false);
  assert.equal(l.report({ task: "", reporter: "a1", claim: "x" }).ok, false);
  const long = l.report({ task: "search", reporter: "a1", claim: "z".repeat(2000), evidence: "e".repeat(2000) });
  assert.ok(long.ok && long.value.claim.length === 500 && long.value.evidence.length === 500);
  assert.equal(l.verify("missing", "a2", "confirmed").ok, false);
  assert.equal(l.canRely("missing").rely, false);
});
