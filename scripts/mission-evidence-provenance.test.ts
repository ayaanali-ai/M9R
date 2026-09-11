/**
 * Evidence provenance model — Phase 4D Part 4 §7/§8 tests
 *
 * `RecordEvidence`/`SupersedeEvidence` through `applyMissionCommand`, plus
 * end-to-end reference enforcement for `evidence_notice`/`completion_notice`
 * against the new `MissionEvidenceRecord` store — never the flat,
 * unassociated `attachedEvidenceIds` array Phase 1 left behind.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { applyMissionCommand, type ApplyCommandInput } from "../src/lib/mission/mission-command-handler.ts";
import { resolveCommandContext, type MissionCommand } from "../src/lib/mission/mission-commands.ts";
import type { MissionProjection } from "../src/lib/mission/mission-projection.ts";

let idCounter = 0;
function mintEventId(): string {
  idCounter += 1;
  return `evt-${idCounter}`;
}
function ctx(actor: { kind: "human" | "agent" | "system"; id: string } = { kind: "system", id: "orchestrator" }) {
  return resolveCommandContext({ actor: actor as never, timestamp: "2026-09-01T00:00:00.000Z" });
}
function run(current: MissionProjection | null, command: MissionCommand, expectedVersion: number, actor: { kind: "human" | "agent" | "system"; id: string } = { kind: "system", id: "orchestrator" }, opts: Partial<ApplyCommandInput> = {}) {
  return applyMissionCommand({ current, command, context: ctx(actor), expectedVersion, priorOutcome: null, mintEventId, ...opts });
}

function addParticipant(missionId: string, participantId: string): MissionCommand {
  return {
    type: "AddParticipant",
    missionId,
    participantId,
    kind: "agent",
    role: "implementer",
    displayName: participantId,
    agentKind: null,
    provider: "codex",
    adapterId: "codex",
    capabilities: [],
    assignmentScope: { allowedPaths: ["."], prohibitedPaths: [] },
    workspacePermissions: { allowedPaths: ["."], prohibitedPaths: [] },
    communicationPermissions: { canBroadcast: false, canDelegate: true, maxDelegationDepth: 3 },
  };
}

function recordEvidenceCommand(missionId: string, evidenceId: string, overrides: Partial<Extract<MissionCommand, { type: "RecordEvidence" }>> = {}): MissionCommand {
  return {
    type: "RecordEvidence",
    missionId,
    evidenceId,
    assignmentId: "a-1",
    producerParticipantId: "p-1",
    producerKind: "agent",
    executionId: null,
    dispatchKey: null,
    provider: "codex",
    kind: "test_result",
    source: "ci run",
    lifecycle: "attached",
    availability: "available",
    integrity: null,
    ...overrides,
  };
}

function bootstrap(missionId: string): MissionProjection {
  let r = run(null, { type: "CreateMission", missionId, workspaceId: "ws-1", repository: "acme/app", goal: "goal", mode: "solo" }, 0);
  assert.ok(r.ok);
  if (!r.ok) throw new Error("unreachable");
  let projection = r.projection;

  for (const id of ["p-1", "p-2"]) {
    r = run(projection, addParticipant(missionId, id), projection.aggregateVersion);
    assert.ok(r.ok);
    if (!r.ok) throw new Error("unreachable");
    projection = r.projection;
    r = run(projection, { type: "ActivateParticipant", missionId, participantId: id }, projection.aggregateVersion);
    assert.ok(r.ok);
    if (!r.ok) throw new Error("unreachable");
    projection = r.projection;
  }

  for (const assignmentId of ["a-1", "a-2"]) {
    r = run(
      projection,
      { type: "CreateAssignment", missionId, assignmentId, title: "t", objective: "o", scope: { allowedPaths: ["."], prohibitedPaths: [] }, dependencies: [], requiredEvidence: [], approvalPolicy: "auto", budget: { maxDurationMs: null, maxEstimatedTokens: null } },
      projection.aggregateVersion,
    );
    assert.ok(r.ok);
    if (!r.ok) throw new Error("unreachable");
    projection = r.projection;
  }
  r = run(projection, { type: "AssignAssignment", missionId, assignmentId: "a-1", assigneeParticipantId: "p-1", dispatchKey: "primary" }, projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) throw new Error("unreachable");
  projection = r.projection;
  r = run(projection, { type: "StartAssignment", missionId, assignmentId: "a-1" }, projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) throw new Error("unreachable");
  return r.projection;
}

test("RecordEvidence creates a real evidence record, discoverable in the projection", () => {
  const projection = bootstrap("m-1");
  const result = run(projection, recordEvidenceCommand("m-1", "ev-1"), projection.aggregateVersion);
  assert.ok(result.ok);
  if (!result.ok) return;
  const record = result.projection.evidenceRecords["ev-1"];
  assert.ok(record);
  assert.equal(record.assignmentId, "a-1");
  assert.equal(record.missionId, "m-1");
  assert.equal(record.supersededByEvidenceId, null);
});

test("RecordEvidence refuses a duplicate evidenceId", () => {
  const projection = bootstrap("m-1");
  const first = run(projection, recordEvidenceCommand("m-1", "ev-1"), projection.aggregateVersion);
  assert.ok(first.ok);
  if (!first.ok) return;
  const second = run(first.projection, recordEvidenceCommand("m-1", "ev-1"), first.aggregateVersion);
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.error.code, "evidence_already_exists");
});

test("RecordEvidence refuses an assignmentId that doesn't exist in this Mission", () => {
  const projection = bootstrap("m-1");
  const result = run(projection, recordEvidenceCommand("m-1", "ev-1", { assignmentId: "ghost-assignment" }), projection.aggregateVersion);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "evidence_assignment_not_found");
});

// ---------------------------------------------------------------------------
// Dispatch/execution mutual-consistency (Phase 4D Part 4, closing the
// previously-stated gap: the fields existed on MissionEvidenceRecord but
// were never cross-validated against the referenced assignment's own
// current dispatchKey).
// ---------------------------------------------------------------------------

test("RecordEvidence accepts a dispatchKey that matches the referenced assignment's own current dispatchKey", () => {
  const projection = bootstrap("m-1"); // a-1 was dispatched with dispatchKey "primary"
  const result = run(projection, recordEvidenceCommand("m-1", "ev-1", { dispatchKey: "primary" }), projection.aggregateVersion);
  assert.ok(result.ok);
});

test("RecordEvidence refuses a dispatchKey that does NOT match the referenced assignment's own current dispatchKey", () => {
  const projection = bootstrap("m-1"); // a-1's real dispatchKey is "primary"
  const result = run(projection, recordEvidenceCommand("m-1", "ev-1", { dispatchKey: "a-stale-or-fabricated-dispatch-key" }), projection.aggregateVersion);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "evidence_dispatch_key_mismatch");
    if (result.error.code === "evidence_dispatch_key_mismatch") {
      assert.equal(result.error.expectedDispatchKey, "primary");
      assert.equal(result.error.actualDispatchKey, "a-stale-or-fabricated-dispatch-key");
    }
  }
});

test("RecordEvidence refuses a dispatchKey claimed against an assignment that was never dispatched at all", () => {
  const projection = bootstrap("m-1"); // a-2 exists but was never AssignAssignment'd — dispatchKey is null
  const result = run(projection, recordEvidenceCommand("m-1", "ev-1", { assignmentId: "a-2", dispatchKey: "primary" }), projection.aggregateVersion);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "evidence_dispatch_key_mismatch");
});

test("RecordEvidence with no dispatchKey claimed at all is never blocked by this check, regardless of the assignment's own dispatchKey", () => {
  const projection = bootstrap("m-1");
  const result = run(projection, recordEvidenceCommand("m-1", "ev-1", { dispatchKey: null }), projection.aggregateVersion);
  assert.ok(result.ok);
});

test("SupersedeEvidence marks the old record superseded and points it at the new one", () => {
  const projection = bootstrap("m-1");
  let r = run(projection, recordEvidenceCommand("m-1", "ev-1"), projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  r = run(r.projection, recordEvidenceCommand("m-1", "ev-2"), r.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  r = run(r.projection, { type: "SupersedeEvidence", missionId: "m-1", evidenceId: "ev-1", supersededByEvidenceId: "ev-2" }, r.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.projection.evidenceRecords["ev-1"].supersededByEvidenceId, "ev-2");
  assert.equal(r.projection.evidenceRecords["ev-2"].supersededByEvidenceId, null);
});

test("SupersedeEvidence refuses an unknown evidenceId", () => {
  const projection = bootstrap("m-1");
  const result = run(projection, { type: "SupersedeEvidence", missionId: "m-1", evidenceId: "ghost", supersededByEvidenceId: "also-ghost" }, projection.aggregateVersion);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "evidence_not_found");
});

test("an evidence_notice citing a real, correctly-assigned evidence record succeeds", () => {
  let projection = bootstrap("m-1");
  const r = run(projection, recordEvidenceCommand("m-1", "ev-1"), projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;

  const posted = run(
    projection,
    { type: "PostMessage", missionId: "m-1", messageId: "msg-1", senderParticipantId: "p-1", recipientParticipantIds: ["p-2"], assignmentId: "a-1", messageType: "evidence_notice", body: "attached", evidenceRefs: ["ev-1"], replyToMessageId: null, structuredPayload: { evidenceKind: "test_result" } },
    projection.aggregateVersion,
    { kind: "agent", id: "p-1" },
  );
  assert.ok(posted.ok);
});

test("an evidence_notice citing evidence belonging to a DIFFERENT assignment is rejected", () => {
  let projection = bootstrap("m-1");
  const r = run(projection, recordEvidenceCommand("m-1", "ev-1", { assignmentId: "a-2" }), projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;

  const result = run(
    projection,
    { type: "PostMessage", missionId: "m-1", messageId: "msg-1", senderParticipantId: "p-1", recipientParticipantIds: ["p-2"], assignmentId: "a-1", messageType: "evidence_notice", body: "attached", evidenceRefs: ["ev-1"], replyToMessageId: null, structuredPayload: {} },
    projection.aggregateVersion,
    { kind: "agent", id: "p-1" },
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "message_policy_violation");
    if (result.error.code === "message_policy_violation") assert.equal(result.error.violation.code, "evidence_wrong_assignment");
  }
});

test("an evidence_notice citing evidence recorded under a DIFFERENT Mission entirely is rejected (unknown reference, cross-Mission is structurally impossible)", () => {
  const projectionA = bootstrap("m-cross-a");
  const projectionB = bootstrap("m-cross-b");
  const r = run(projectionA, recordEvidenceCommand("m-cross-a", "ev-shared-id"), projectionA.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;

  // projectionB's own evidenceRecords never contain "ev-shared-id" — each
  // Mission's projection only ever holds its OWN records, so a cross-Mission
  // reference is unknown, never mistakenly resolved to another Mission's record.
  const result = run(
    projectionB,
    { type: "PostMessage", missionId: "m-cross-b", messageId: "msg-1", senderParticipantId: "p-1", recipientParticipantIds: ["p-2"], assignmentId: "a-1", messageType: "evidence_notice", body: "attached", evidenceRefs: ["ev-shared-id"], replyToMessageId: null, structuredPayload: {} },
    projectionB.aggregateVersion,
    { kind: "agent", id: "p-1" },
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "message_policy_violation");
    if (result.error.code === "message_policy_violation") assert.equal(result.error.violation.code, "evidence_notice_unknown_evidence_ref");
  }
});

test("an evidence_notice citing SUPERSEDED evidence is rejected as stale", () => {
  let projection = bootstrap("m-1");
  let r = run(projection, recordEvidenceCommand("m-1", "ev-1"), projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;
  r = run(projection, recordEvidenceCommand("m-1", "ev-2"), projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;
  r = run(projection, { type: "SupersedeEvidence", missionId: "m-1", evidenceId: "ev-1", supersededByEvidenceId: "ev-2" }, projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;

  const result = run(
    projection,
    { type: "PostMessage", missionId: "m-1", messageId: "msg-1", senderParticipantId: "p-1", recipientParticipantIds: ["p-2"], assignmentId: "a-1", messageType: "evidence_notice", body: "attached", evidenceRefs: ["ev-1"], replyToMessageId: null, structuredPayload: {} },
    projection.aggregateVersion,
    { kind: "agent", id: "p-1" },
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "message_policy_violation");
    if (result.error.code === "message_policy_violation") assert.equal(result.error.violation.code, "evidence_superseded");
  }
});

test("a completion_notice citing evidence belonging to a DIFFERENT assignment is rejected", () => {
  let projection = bootstrap("m-1");
  const r = run(projection, recordEvidenceCommand("m-1", "ev-1", { assignmentId: "a-2" }), projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;

  const result = run(
    projection,
    { type: "PostMessage", missionId: "m-1", messageId: "cn-1", senderParticipantId: "p-1", recipientParticipantIds: [], assignmentId: "a-1", messageType: "completion_notice", body: "done", evidenceRefs: ["ev-1"], replyToMessageId: null },
    projection.aggregateVersion,
    { kind: "agent", id: "p-1" },
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "message_policy_violation");
    if (result.error.code === "message_policy_violation") assert.equal(result.error.violation.code, "evidence_wrong_assignment");
  }
});

test("deterministic replay preserves evidence records and supersession relationships exactly", async () => {
  const { projectMission } = await import("../src/lib/mission/mission-projection.ts");
  const missionId = "m-replay-evidence";
  const allEvents: import("../src/lib/mission/mission-events.ts").MissionEvent[] = [];

  let r = run(null, { type: "CreateMission", missionId, workspaceId: "ws-1", repository: "acme/app", goal: "goal", mode: "solo" }, 0);
  assert.ok(r.ok);
  if (!r.ok) return;
  allEvents.push(...r.events);
  let projection = r.projection;

  r = run(projection, { type: "CreateAssignment", missionId, assignmentId: "a-1", title: "t", objective: "o", scope: { allowedPaths: ["."], prohibitedPaths: [] }, dependencies: [], requiredEvidence: [], approvalPolicy: "auto", budget: { maxDurationMs: null, maxEstimatedTokens: null } }, projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  allEvents.push(...r.events);
  projection = r.projection;

  r = run(projection, recordEvidenceCommand(missionId, "ev-1"), projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  allEvents.push(...r.events);
  projection = r.projection;

  r = run(projection, recordEvidenceCommand(missionId, "ev-2"), projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  allEvents.push(...r.events);
  projection = r.projection;

  r = run(projection, { type: "SupersedeEvidence", missionId, evidenceId: "ev-1", supersededByEvidenceId: "ev-2" }, projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  allEvents.push(...r.events);
  projection = r.projection;

  const rebuilt = projectMission(missionId, allEvents);
  assert.deepEqual(rebuilt, projection);
  assert.equal(rebuilt.evidenceRecords["ev-1"].supersededByEvidenceId, "ev-2");
});
