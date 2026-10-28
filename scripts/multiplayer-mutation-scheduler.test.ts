import assert from "node:assert/strict";
import test from "node:test";
import { createMultiplayerMutationScheduler } from "../src/lib/native/multiplayer-mutation-scheduler";
import type { MultiplayerOperation, MultiplayerRoster } from "../src/lib/native/multiplayer-contract";

const roster: MultiplayerRoster = {
  runId: "run-mutations",
  agents: [
    { agentId: "agent-1", branchId: "branch-1", provider: "codex" },
    { agentId: "agent-2", branchId: "branch-2", provider: "claude" },
    { agentId: "agent-3", branchId: "branch-3", provider: "opencode" },
  ],
};

function operation(operationId: string, agentId: string, branchId: string, surfaceId = "doc-1", regionId?: string, revision = 0): MultiplayerOperation {
  return { runId: roster.runId, branchId, agentId, operationId, surfaceId, ...(regionId === undefined ? {} : { regionId }), revision, kind: "mutate", createdAt: 100 };
}

test("independent regions lease concurrently while overlapping regions serialize", () => {
  const scheduler = createMultiplayerMutationScheduler(roster, { now: () => 200, leaseTtlMs: 1_000, idFactory: (() => { let i = 0; return () => `lease-${++i}`; })() });
  const first = scheduler.begin({ operation: operation("op-1", "agent-1", "branch-1", "doc-1", "header"), expectedRegionRevision: 0 });
  const second = scheduler.begin({ operation: operation("op-2", "agent-2", "branch-2", "doc-1", "body"), expectedRegionRevision: 0 });
  const overlap = scheduler.begin({ operation: operation("op-3", "agent-3", "branch-3", "doc-1", "header"), expectedRegionRevision: 0 });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(overlap.ok, false);
  if (!overlap.ok) assert.equal(overlap.code, "lease-unavailable");
  if (first.ok && !first.duplicate) assert.equal(first.transaction.commit().ok, true);
  if (second.ok && !second.duplicate) assert.equal(second.transaction.commit().ok, true);
  const nextHeader = scheduler.begin({ operation: operation("op-4", "agent-3", "branch-3", "doc-1", "header", 0), expectedRegionRevision: 1 });
  assert.equal(nextHeader.ok, true);
});

test("revision fencing makes a stale region operation rebase instead of mutating", () => {
  const scheduler = createMultiplayerMutationScheduler(roster, { now: () => 200 });
  const first = scheduler.begin({ operation: operation("op-1", "agent-1", "branch-1", "doc-1", "body"), expectedRegionRevision: 0 });
  assert.equal(first.ok, true);
  if (first.ok && !first.duplicate) assert.equal(first.transaction.commit().ok, true);
  const stale = scheduler.begin({ operation: operation("op-2", "agent-2", "branch-2", "doc-1", "body"), expectedRegionRevision: 0 });
  assert.equal(stale.ok, false);
  if (!stale.ok) {
    assert.equal(stale.code, "stale-revision");
    assert.equal(stale.retry.action, "rebase");
  }
});

test("surface-wide mutations conflict with region leases and advance the surface epoch", () => {
  const scheduler = createMultiplayerMutationScheduler(roster, { now: () => 200 });
  const region = scheduler.begin({ operation: operation("op-region", "agent-1", "branch-1", "doc-1", "body"), expectedRegionRevision: 0 });
  assert.equal(region.ok, true);
  const wholeSurface = scheduler.begin({ operation: operation("op-whole", "agent-2", "branch-2", "doc-1"), expectedRegionRevision: undefined, expectedSurfaceMutationRevision: 0 });
  assert.equal(wholeSurface.ok, false);
  if (!wholeSurface.ok) assert.equal(wholeSurface.code, "lease-unavailable");
  if (region.ok && !region.duplicate) assert.equal(region.transaction.commit().ok, true);
  const committed = scheduler.begin({ operation: operation("op-whole-2", "agent-2", "branch-2", "doc-1", undefined, 0), expectedSurfaceMutationRevision: 1 });
  assert.equal(committed.ok, true);
  if (committed.ok && !committed.duplicate) assert.equal(committed.transaction.commit().ok, true);
  const staleRegion = scheduler.begin({ operation: operation("op-region-stale", "agent-3", "branch-3", "doc-1", "body", 0), expectedRegionRevision: 1 });
  assert.equal(staleRegion.ok, false);
  if (!staleRegion.ok) assert.equal(staleRegion.code, "stale-revision");
});

test("expired leases become terminal receipts and cannot commit late", () => {
  let time = 100;
  const scheduler = createMultiplayerMutationScheduler(roster, { now: () => time, leaseTtlMs: 100 });
  const begun = scheduler.begin({ operation: operation("op-expire", "agent-1", "branch-1", "doc-1", "body"), expectedRegionRevision: 0 });
  assert.equal(begun.ok, true);
  time = 201;
  const expired = scheduler.sweepExpired();
  assert.equal(expired.length, 1);
  if (begun.ok && !begun.duplicate) {
    const late = begun.transaction.commit();
    assert.equal(late.ok, false);
    if (!late.ok) assert.equal(late.code, "expired");
  }
});
