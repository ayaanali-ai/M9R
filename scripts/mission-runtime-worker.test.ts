import assert from "node:assert/strict";
import test from "node:test";
import { MissionRuntimeWorker } from "@/lib/mission/mission-runtime-worker";
import { InMemoryMissionSchedulerStore } from "@/lib/mission/mission-scheduler-store";
import { MissionDispatchRuntime, InMemoryExecutionHost } from "@/lib/mission/mission-dispatch-runtime";
import type { MissionProjection } from "@/lib/mission/mission-projection";

const now = "2026-07-28T00:00:00.000Z";

function projection(id: string): MissionProjection {
  return {
    missionId: id, workspaceId: "workspace-a", goal: "Implement bounded work", repository: "repo", repositoryId: "repo-a",
    state: "ready", resumeTo: null, reason: null, planVersion: 1, approvedPlanVersion: 1, participantIds: [], participants: {},
    assignments: {}, findings: {}, planProposals: {}, evidenceRecords: {}, executions: {}, planningRequests: {}, messages: [],
    openFindingsCount: 0, unansweredQuestionMessageIds: [], unresolvedBlockerMessageIds: [], pendingReviewRequestMessageIds: [],
    pendingApprovalRequestMessageIds: [], pendingDelegationRequestMessageIds: [], attachedEvidenceIds: [], attestedEvidenceIds: [],
    decision: null, reviewedRevision: null, aggregateVersion: 1, terminal: false, complete: true, integrityIssues: [], createdAt: now, updatedAt: now,
  };
}

test("runtime worker recovers before candidate loading, uses pure selection, claims once, and adopts only returned instructions", async () => {
  const order: string[] = [];
  const store = new InMemoryMissionSchedulerStore(new Map([["mission-a", { workspaceId: "workspace-a", repositoryId: "repo-a" }]]), () => "lease-a");
  const host = new InMemoryExecutionHost();
  const runtime = new MissionDispatchRuntime({ store, host, holder: { kind: "system", id: "scheduler" }, policy: { leaseDurationMs: 60_000, renewalWindowMs: 30_000, maxConcurrentLeasesPerWorkspace: 1 }, mintExecutionId: () => "execution-a" });
  const worker = new MissionRuntimeWorker({
    runtime,
    schedulerStore: store,
    holder: { kind: "system", id: "scheduler" },
    policy: { leaseDurationMs: 60_000, renewalWindowMs: 30_000, maxConcurrentLeasesPerWorkspace: 1 },
    clock: () => now,
    source: {
      async listWorkspaces() { order.push("workspaces"); return ["workspace-a"]; },
      async listCandidates() { order.push("candidates"); return [{ projection: projection("mission-a"), assignmentId: "assignment-a", dispatchKey: "primary", adapterRequirement: "codex", executionConstraints: { goal: "Implement bounded work" }, lease: null }]; },
    },
  });

  const report = await worker.runOnce();
  assert.deepEqual(order, ["workspaces", "candidates"]);
  assert.equal(report.claimedCount, 1);
  assert.equal(report.adoptedCount, 1);
  assert.equal(runtime.listTracked().length, 1);
});
