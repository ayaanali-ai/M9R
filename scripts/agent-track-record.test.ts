import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAgentTrackRecord,
  trackRecordStandingLabel,
  MIN_DECIDED_FOR_STANDING,
  type TrackRecordPassport,
} from "../src/lib/agent-track-record.ts";

function passport(input: {
  runId: string;
  decision?: "reviewed" | "needs_follow_up" | "not_accepted" | null;
  reviewedAt?: string | null;
  submittedAt?: string | null;
  changedFiles?: string[];
  verification?: Array<"passed" | "failed">;
}): TrackRecordPassport {
  return {
    run_id: input.runId,
    submitted_at: input.submittedAt ?? null,
    human_review: { decision: input.decision ?? null, reviewed_at: input.reviewedAt ?? null },
    evidence: {
      verification_provenance: (input.verification ?? []).map((result) => ({ result })),
      changed_files: input.changedFiles,
    },
  };
}

test("an agent with no decisions reports an honest empty record", () => {
  const record = buildAgentTrackRecord([{ id: "r1" }, { id: "r2" }], []);
  assert.equal(record.runsTotal, 2);
  assert.equal(record.decided, 0);
  assert.equal(record.undecided, 2);
  assert.equal(record.approvalRate, null);
  assert.equal(record.standing, "no_record");
  assert.equal(record.lastDecision, null);
});

test("passports for other agents' runs are excluded by the run-id join", () => {
  const record = buildAgentTrackRecord(
    [{ id: "mine" }],
    [passport({ runId: "mine", decision: "reviewed" }), passport({ runId: "theirs", decision: "not_accepted" })],
  );
  assert.equal(record.decided, 1);
  assert.equal(record.reviewed, 1);
  assert.equal(record.notAccepted, 0);
});

test("standing stays at building below the decision threshold, even with perfect approvals", () => {
  const runs = [{ id: "r1" }, { id: "r2" }];
  const record = buildAgentTrackRecord(runs, [
    passport({ runId: "r1", decision: "reviewed" }),
    passport({ runId: "r2", decision: "reviewed" }),
  ]);
  assert.ok(record.decided < MIN_DECIDED_FOR_STANDING);
  assert.equal(record.approvalRate, 1);
  assert.equal(record.standing, "building");
});

test("enough clean decisions produce a consistent standing", () => {
  const runs = [{ id: "r1" }, { id: "r2" }, { id: "r3" }, { id: "r4" }, { id: "r5" }];
  const record = buildAgentTrackRecord(runs, [
    passport({ runId: "r1", decision: "reviewed", verification: ["passed", "passed"] }),
    passport({ runId: "r2", decision: "reviewed", verification: ["passed"] }),
    passport({ runId: "r3", decision: "reviewed" }),
    passport({ runId: "r4", decision: "needs_follow_up", verification: ["passed", "failed"] }),
  ]);
  assert.equal(record.decided, 4);
  assert.equal(record.standing, "consistent");
  assert.equal(record.verificationRan, 3);
  assert.equal(record.verificationClean, 2);
  assert.equal(record.undecided, 1);
});

test("a single rejection at threshold flips standing to attention", () => {
  const runs = [{ id: "r1" }, { id: "r2" }, { id: "r3" }];
  const record = buildAgentTrackRecord(runs, [
    passport({ runId: "r1", decision: "reviewed" }),
    passport({ runId: "r2", decision: "reviewed" }),
    passport({ runId: "r3", decision: "not_accepted" }),
  ]);
  assert.equal(record.standing, "attention");
  assert.equal(record.notAccepted, 1);
});

test("a low reviewed share is attention even with zero rejections", () => {
  const runs = [{ id: "r1" }, { id: "r2" }, { id: "r3" }];
  const record = buildAgentTrackRecord(runs, [
    passport({ runId: "r1", decision: "reviewed" }),
    passport({ runId: "r2", decision: "needs_follow_up" }),
    passport({ runId: "r3", decision: "needs_follow_up" }),
  ]);
  assert.equal(record.notAccepted, 0);
  assert.equal(record.standing, "attention");
});

test("the newest review decision wins lastDecision", () => {
  const runs = [{ id: "r1" }, { id: "r2" }];
  const record = buildAgentTrackRecord(runs, [
    passport({ runId: "r1", decision: "reviewed", reviewedAt: "2026-07-10T00:00:00Z" }),
    passport({ runId: "r2", decision: "needs_follow_up", reviewedAt: "2026-07-15T00:00:00Z" }),
  ]);
  assert.equal(record.lastDecision?.decision, "needs_follow_up");
  assert.equal(record.lastDecision?.reviewedAt, "2026-07-15T00:00:00Z");
});

test("a later run touching a reviewed run's files raises a rework signal", () => {
  const runs = [{ id: "mine" }];
  const record = buildAgentTrackRecord(runs, [
    passport({
      runId: "mine",
      decision: "reviewed",
      reviewedAt: "2026-07-10T00:00:00Z",
      changedFiles: ["src/lib/auth.ts", "src/app/page.tsx"],
    }),
    // Another agent's later run reworks one of the same files.
    passport({ runId: "theirs", submittedAt: "2026-07-12T00:00:00Z", changedFiles: ["src/lib/auth.ts"] }),
  ]);
  assert.equal(record.reworkSignals, 1);
});

test("earlier or file-disjoint runs never raise rework signals, and standing is unaffected", () => {
  const runs = [{ id: "r1" }, { id: "r2" }, { id: "r3" }];
  const record = buildAgentTrackRecord(runs, [
    passport({ runId: "r1", decision: "reviewed", reviewedAt: "2026-07-10T00:00:00Z", changedFiles: ["a.ts"] }),
    passport({ runId: "r2", decision: "reviewed", reviewedAt: "2026-07-10T00:00:00Z", changedFiles: ["b.ts"] }),
    passport({ runId: "r3", decision: "reviewed", reviewedAt: "2026-07-11T00:00:00Z", changedFiles: ["c.ts"] }),
    // Earlier than every review — not rework.
    passport({ runId: "old", submittedAt: "2026-07-01T00:00:00Z", changedFiles: ["a.ts", "b.ts", "c.ts"] }),
    // Later but disjoint files — not rework.
    passport({ runId: "elsewhere", submittedAt: "2026-07-14T00:00:00Z", changedFiles: ["d.ts"] }),
  ]);
  assert.equal(record.reworkSignals, 0);
  assert.equal(record.standing, "consistent");
});

test("missing timestamps or file manifests stay silent instead of guessing", () => {
  const runs = [{ id: "r1" }];
  const record = buildAgentTrackRecord(runs, [
    passport({ runId: "r1", decision: "reviewed", reviewedAt: null, changedFiles: ["a.ts"] }),
    passport({ runId: "later", submittedAt: "2026-07-14T00:00:00Z", changedFiles: ["a.ts"] }),
  ]);
  assert.equal(record.reworkSignals, 0);
});

test("standing labels never overclaim", () => {
  assert.equal(trackRecordStandingLabel("no_record"), "No reviewed runs yet");
  assert.equal(trackRecordStandingLabel("consistent"), "Consistent record");
  for (const standing of ["no_record", "building", "consistent", "attention"] as const) {
    const label = trackRecordStandingLabel(standing).toLowerCase();
    assert.ok(!label.includes("trusted"));
    assert.ok(!label.includes("score"));
    assert.ok(!label.includes("guarantee"));
  }
});
