/**
 * Collaboration bridge tests — the output-to-command translation piece
 * needed for agents to actually hand things to each other, plus the
 * pending-messages-into-launch-context direction.
 * ----------------------------------------------------------------------------
 * Every produced command is fed through the REAL command handler
 * (`applyMissionCommand`) in the "commands are accepted" tests — proving
 * this module produces commands the domain actually accepts, not just
 * commands that satisfy TypeScript.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  parseCollaborationDirectives,
  buildCollaborationCommands,
  pendingMessagesFor,
  renderPendingMessagesForLaunch,
  COLLABORATION_DIRECTIVE_INSTRUCTIONS,
  composeTaskWithCollaborationContext,
} from "../src/lib/mission/mission-collaboration-bridge.ts";
import { applyMissionCommand } from "../src/lib/mission/mission-command-handler.ts";
import { resolveCommandContext } from "../src/lib/mission/mission-commands.ts";
import type { MissionCommand } from "../src/lib/mission/mission-commands.ts";
import type { MissionProjection } from "../src/lib/mission/mission-projection.ts";
import type { MissionMessage } from "../src/lib/mission/mission-domain.ts";

const MISSION_ID = "m-1";

let idCounter = 0;
function mintEventId(): string {
  idCounter += 1;
  return `evt-${idCounter}`;
}

function ctx(actor: { kind: "human" | "agent" | "system"; id: string } = { kind: "system", id: "orchestrator" }) {
  return resolveCommandContext({ actor: actor as never, timestamp: "2026-07-28T00:00:00.000Z" });
}

function run(current: MissionProjection | null, command: MissionCommand, expectedVersion: number, actor: { kind: "human" | "agent" | "system"; id: string } = { kind: "system", id: "orchestrator" }) {
  return applyMissionCommand({ current, command, context: ctx(actor), expectedVersion, priorOutcome: null, mintEventId });
}

function addParticipant(participantId: string): MissionCommand {
  return {
    type: "AddParticipant",
    missionId: MISSION_ID,
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
    communicationPermissions: { canBroadcast: true, canDelegate: true, maxDelegationDepth: 3 },
  };
}

/** A Mission with two active participants and one assignment, ready for a PostMessage/OpenFinding to target. */
function bootstrap(): MissionProjection {
  let r = run(null, { type: "CreateMission", missionId: MISSION_ID, workspaceId: "ws-1", repository: "acme/app", goal: "goal", mode: "solo" }, 0);
  assert.ok(r.ok);
  if (!r.ok) throw new Error("unreachable");
  let projection = r.projection;

  for (const id of ["codex-1", "claude-1"]) {
    r = run(projection, addParticipant(id), projection.aggregateVersion);
    assert.ok(r.ok);
    if (!r.ok) throw new Error("unreachable");
    projection = r.projection;
    r = run(projection, { type: "ActivateParticipant", missionId: MISSION_ID, participantId: id }, projection.aggregateVersion);
    assert.ok(r.ok);
    if (!r.ok) throw new Error("unreachable");
    projection = r.projection;
  }

  r = run(
    projection,
    {
      type: "CreateAssignment",
      missionId: MISSION_ID,
      assignmentId: "a-1",
      title: "Implement",
      objective: "Do the thing",
      scope: { allowedPaths: ["."], prohibitedPaths: [] },
      dependencies: [],
      requiredEvidence: [],
      approvalPolicy: "auto",
      budget: { maxDurationMs: 600000, maxEstimatedTokens: 100000 },
    },
    projection.aggregateVersion,
  );
  assert.ok(r.ok);
  if (!r.ok) throw new Error("unreachable");
  projection = r.projection;

  // Delegation requires the sender to actually hold the assignment it's
  // delegating from (mission-communication-policy.ts's "delegation_outside_scope"
  // check) — assign it to codex-1 so the delegation tests below reflect a
  // real, in-scope delegation, not a synthetic bypass.
  r = run(projection, { type: "AssignAssignment", missionId: MISSION_ID, assignmentId: "a-1", assigneeParticipantId: "codex-1", dispatchKey: "primary" }, projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) throw new Error("unreachable");
  return r.projection;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test("parseCollaborationDirectives: no fenced block yields an empty, valid result", () => {
  const result = parseCollaborationDirectives("I implemented the thing and ran the tests. All green.");
  assert.deepEqual(result.directives, []);
  assert.deepEqual(result.parseErrors, []);
});

test("parseCollaborationDirectives: a well-formed message directive parses", () => {
  const summary = [
    "Done with my part.",
    "```oathlock-collaboration",
    JSON.stringify([{ type: "message", recipients: "broadcast", body: "Finished the auth module." }]),
    "```",
  ].join("\n");
  const result = parseCollaborationDirectives(summary);
  assert.equal(result.directives.length, 1);
  assert.equal(result.parseErrors.length, 0);
  assert.deepEqual(result.directives[0], { type: "message", recipients: "broadcast", body: "Finished the auth module.", evidenceRefs: [] });
});

test("parseCollaborationDirectives: a well-formed finding directive parses with recipients and evidence", () => {
  const summary = [
    "```oathlock-collaboration",
    JSON.stringify([
      { type: "finding", recipients: ["claude-1"], statement: "The migration is missing a rollback.", evidenceRefs: ["ev-1"], responsibleParticipantId: "claude-1" },
    ]),
    "```",
  ].join("\n");
  const result = parseCollaborationDirectives(summary);
  assert.equal(result.directives.length, 1);
  assert.deepEqual(result.directives[0], {
    type: "finding",
    recipients: ["claude-1"],
    statement: "The migration is missing a rollback.",
    responsibleParticipantId: "claude-1",
    evidenceRefs: ["ev-1"],
  });
});

test("parseCollaborationDirectives: malformed JSON in the block is reported, never thrown", () => {
  const summary = "```oathlock-collaboration\nnot json at all {{{\n```";
  assert.doesNotThrow(() => parseCollaborationDirectives(summary));
  const result = parseCollaborationDirectives(summary);
  assert.equal(result.directives.length, 0);
  assert.match(result.parseErrors.join(" "), /not valid JSON/);
});

test("parseCollaborationDirectives: one malformed directive in an array does not discard the well-formed ones", () => {
  const summary = [
    "```oathlock-collaboration",
    JSON.stringify([{ type: "message", recipients: "broadcast", body: "good one" }, { type: "message", recipients: "broadcast" }, { type: "nonsense" }]),
    "```",
  ].join("\n");
  const result = parseCollaborationDirectives(summary);
  assert.equal(result.directives.length, 1);
  assert.equal(result.directives[0].type, "message");
  assert.equal(result.parseErrors.length, 2);
});

test("parseCollaborationDirectives: an unclosed fence is reported, not thrown, and stops scanning", () => {
  const summary = "```oathlock-collaboration\n[{\"type\":\"message\"";
  assert.doesNotThrow(() => parseCollaborationDirectives(summary));
  const result = parseCollaborationDirectives(summary);
  assert.equal(result.directives.length, 0);
  assert.match(result.parseErrors.join(" "), /no closing/);
});

test("parseCollaborationDirectives: an agent with nothing to report needs no block at all — the common case stays free", () => {
  const summary = "Implemented the feature, all tests pass, no blockers.";
  const result = parseCollaborationDirectives(summary);
  assert.equal(result.directives.length, 0);
  assert.equal(result.parseErrors.length, 0);
});

// ---------------------------------------------------------------------------
// Directive -> commands, and those commands are ACCEPTED by the real handler
// ---------------------------------------------------------------------------

test("buildCollaborationCommands: a message directive becomes exactly one PostMessage, accepted by the real command handler", () => {
  // Directly-addressed, not broadcast — Mission-wide broadcast is
  // policy-gated off by default (DEFAULT_COMMUNICATION_POLICY.allowBroadcast
  // === false, mission-communication-policy.ts), separately from a
  // participant's own `canBroadcast` permission. That is real, intentional
  // domain behavior the bridge must respect, not fight — see the dedicated
  // broadcast-policy test below for that path specifically.
  const projection = bootstrap();
  const commands = buildCollaborationCommands({
    missionId: MISSION_ID,
    assignmentId: "a-1",
    senderParticipantId: "codex-1",
    directives: [{ type: "message", recipients: ["claude-1"], body: "Finished the auth module.", evidenceRefs: [] }],
    mintMessageId: () => "msg-1",
  });
  assert.equal(commands.length, 1);
  assert.equal(commands[0].type, "PostMessage");

  const result = run(projection, commands[0], projection.aggregateVersion, { kind: "agent", id: "codex-1" });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.projection.messages.length, 1);
});

test("buildCollaborationCommands: a 'broadcast' directive is refused by the Mission's own communication policy when broadcast is off by default — the bridge does not silently downgrade or bypass it", () => {
  const projection = bootstrap();
  const commands = buildCollaborationCommands({
    missionId: MISSION_ID,
    assignmentId: "a-1",
    senderParticipantId: "codex-1",
    directives: [{ type: "message", recipients: "broadcast", body: "Finished the auth module.", evidenceRefs: [] }],
    mintMessageId: () => "msg-1",
  });
  const result = run(projection, commands[0], projection.aggregateVersion, { kind: "agent", id: "codex-1" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "message_policy_violation");
});

test("buildCollaborationCommands: a finding directive becomes PostMessage THEN OpenFinding, with the finding's originatingMessageId pointing at the real posted message — both accepted by the real command handler", () => {
  const projection = bootstrap();
  const commands = buildCollaborationCommands({
    missionId: MISSION_ID,
    assignmentId: "a-1",
    senderParticipantId: "codex-1",
    directives: [{ type: "finding", recipients: ["claude-1"], statement: "Migration lacks a rollback.", responsibleParticipantId: "claude-1", evidenceRefs: [] }],
    mintMessageId: () => "msg-1",
    mintFindingId: () => "finding-1",
  });
  assert.equal(commands.length, 2);
  assert.equal(commands[0].type, "PostMessage");
  assert.equal(commands[1].type, "OpenFinding");
  assert.equal((commands[1] as { originatingMessageId: string }).originatingMessageId, "msg-1");

  let r = run(projection, commands[0], projection.aggregateVersion, { kind: "agent", id: "codex-1" });
  assert.equal(r.ok, true);
  if (!r.ok) throw new Error("unreachable");
  r = run(r.projection, commands[1], r.aggregateVersion, { kind: "agent", id: "codex-1" });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(Object.keys(r.projection.findings).length, 1);
    assert.equal(r.projection.openFindingsCount, 1);
  }
});

test("buildCollaborationCommands: a finding directive with no assignmentId posts only the message — OpenFinding requires a real assignmentId and is never guessed", () => {
  const commands = buildCollaborationCommands({
    missionId: MISSION_ID,
    assignmentId: null,
    senderParticipantId: "codex-1",
    directives: [{ type: "finding", recipients: "broadcast", statement: "Mission-level observation.", evidenceRefs: [] }],
  });
  assert.equal(commands.length, 1);
  assert.equal(commands[0].type, "PostMessage");
});

test("buildCollaborationCommands: multiple directives preserve order and each mint call is independent", () => {
  let n = 0;
  const commands = buildCollaborationCommands({
    missionId: MISSION_ID,
    assignmentId: "a-1",
    senderParticipantId: "codex-1",
    directives: [
      { type: "message", recipients: "broadcast", body: "first" },
      { type: "message", recipients: "broadcast", body: "second" },
    ],
    mintMessageId: () => { n += 1; return `msg-${n}`; },
  });
  assert.equal(commands.length, 2);
  assert.equal((commands[0] as { messageId: string }).messageId, "msg-1");
  assert.equal((commands[1] as { messageId: string }).messageId, "msg-2");
});

// ---------------------------------------------------------------------------
// Delegation: an agent proposes, another agent accepts, and a REAL child
// assignment gets created — no human, no system actor, no separate
// CreateAssignment/AssignAssignment call. This is the actual mechanism for
// autonomous agent-to-agent delegation the domain already supports.
// ---------------------------------------------------------------------------

test("parseCollaborationDirectives: delegation_request and delegation_response both parse", () => {
  const summary = [
    "```oathlock-collaboration",
    JSON.stringify([
      { type: "delegation_request", assignmentId: "a-1", recipients: ["claude-1"], body: "Please handle the frontend half." },
      { type: "delegation_response", replyToMessageId: "msg-req", recipients: ["codex-1"], accepted: true, childTitle: "Frontend work", childObjective: "Build the UI" },
    ]),
    "```",
  ].join("\n");
  const result = parseCollaborationDirectives(summary);
  assert.equal(result.parseErrors.length, 0);
  assert.equal(result.directives.length, 2);
  assert.equal(result.directives[0].type, "delegation_request");
  assert.equal(result.directives[1].type, "delegation_response");
});

test("parseCollaborationDirectives: delegation_request/response refuse 'broadcast' recipients", () => {
  const requestSummary = `\`\`\`oathlock-collaboration\n${JSON.stringify([{ type: "delegation_request", assignmentId: "a-1", recipients: "broadcast", body: "x" }])}\n\`\`\``;
  const responseSummary = `\`\`\`oathlock-collaboration\n${JSON.stringify([{ type: "delegation_response", replyToMessageId: "m", recipients: "broadcast", accepted: true }])}\n\`\`\``;
  assert.equal(parseCollaborationDirectives(requestSummary).directives.length, 0);
  assert.match(parseCollaborationDirectives(requestSummary).parseErrors.join(" "), /not "broadcast"/);
  assert.equal(parseCollaborationDirectives(responseSummary).directives.length, 0);
});

test("delegation end-to-end: a delegation_request from Codex, accepted by Claude, produces a REAL child assignment via the actual command handler — no separate CreateAssignment call", () => {
  const projection = bootstrap();

  const requestCommands = buildCollaborationCommands({
    missionId: MISSION_ID,
    assignmentId: "a-1",
    senderParticipantId: "codex-1",
    directives: [{ type: "delegation_request", assignmentId: "a-1", recipients: ["claude-1"], body: "Please handle the frontend half.", evidenceRefs: [] }],
    mintMessageId: () => "msg-request",
  });
  assert.equal(requestCommands.length, 1);
  assert.equal(requestCommands[0].type, "PostMessage");
  assert.equal((requestCommands[0] as { messageType: string }).messageType, "delegation_request");

  let r = run(projection, requestCommands[0], projection.aggregateVersion, { kind: "agent", id: "codex-1" });
  assert.equal(r.ok, true);
  if (!r.ok) throw new Error("unreachable");
  assert.equal(Object.keys(r.projection.assignments).length, 1); // no new assignment yet — a request alone commits nothing

  const responseCommands = buildCollaborationCommands({
    missionId: MISSION_ID,
    assignmentId: null,
    senderParticipantId: "claude-1",
    directives: [{ type: "delegation_response", replyToMessageId: "msg-request", recipients: ["codex-1"], accepted: true, childTitle: "Frontend work", childObjective: "Build the UI" }],
    mintMessageId: () => "msg-response",
  });
  assert.equal(responseCommands.length, 1);
  assert.equal((responseCommands[0] as { structuredPayload?: { accepted?: boolean } }).structuredPayload?.accepted, true);

  r = run(r.projection, responseCommands[0], r.aggregateVersion, { kind: "agent", id: "claude-1" });
  assert.equal(r.ok, true);
  if (r.ok) {
    const assignments = Object.values(r.projection.assignments);
    assert.equal(assignments.length, 2); // the original assignment PLUS the real new child assignment
    const child = assignments.find((a) => a.parentAssignmentId === "a-1");
    assert.ok(child, "a real child assignment must exist after acceptance");
    assert.equal(child!.assigneeParticipantId, "claude-1"); // assigned to whoever accepted, automatically
    assert.equal(child!.title, "Frontend work");
    assert.equal(child!.delegatorParticipantId, "codex-1");
  }
});

test("delegation end-to-end: a declined delegation_response is accepted as a message but creates NO child assignment", () => {
  const projection = bootstrap();
  const requestCommands = buildCollaborationCommands({
    missionId: MISSION_ID,
    assignmentId: "a-1",
    senderParticipantId: "codex-1",
    directives: [{ type: "delegation_request", assignmentId: "a-1", recipients: ["claude-1"], body: "Please handle the frontend half." }],
    mintMessageId: () => "msg-request",
  });
  let r = run(projection, requestCommands[0], projection.aggregateVersion, { kind: "agent", id: "codex-1" });
  assert.equal(r.ok, true);
  if (!r.ok) throw new Error("unreachable");

  const declineCommands = buildCollaborationCommands({
    missionId: MISSION_ID,
    assignmentId: null,
    senderParticipantId: "claude-1",
    directives: [{ type: "delegation_response", replyToMessageId: "msg-request", recipients: ["codex-1"], accepted: false }],
    mintMessageId: () => "msg-decline",
  });
  r = run(r.projection, declineCommands[0], r.aggregateVersion, { kind: "agent", id: "claude-1" });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(Object.keys(r.projection.assignments).length, 1); // still just the original — decline creates nothing
});

// ---------------------------------------------------------------------------
// Pending messages -> launch context
// ---------------------------------------------------------------------------

function message(overrides: Partial<MissionMessage>): MissionMessage {
  return {
    id: "m-x",
    missionId: MISSION_ID,
    senderParticipantId: "codex-1",
    recipientParticipantIds: "mission_broadcast",
    assignmentId: null,
    type: "information",
    body: "body",
    evidenceRefs: [],
    correlationId: "c-1",
    causationId: null,
    replyToMessageId: null,
    createdAt: "2026-07-28T00:00:00.000Z",
    structuredPayload: {},
    ...overrides,
  } as MissionMessage;
}

test("pendingMessagesFor: includes broadcast and directly-addressed messages, excludes the participant's own messages", () => {
  const messages = [
    message({ id: "m1", senderParticipantId: "codex-1", recipientParticipantIds: "mission_broadcast" }),
    message({ id: "m2", senderParticipantId: "claude-1", recipientParticipantIds: ["codex-1"] }),
    message({ id: "m3", senderParticipantId: "codex-1", recipientParticipantIds: ["codex-1"] }), // codex's own — never shown back to itself
    message({ id: "m4", senderParticipantId: "claude-1", recipientParticipantIds: ["grok-1"] }), // addressed to someone else
  ];
  const pending = pendingMessagesFor(messages, "codex-1", null);
  assert.deepEqual(pending.map((m) => m.messageId).sort(), ["m2"]); // m1 is codex-1's OWN broadcast — never shown back to its own sender
});

test("pendingMessagesFor: a `since` cutoff excludes messages posted at or before it", () => {
  const messages = [
    message({ id: "old", senderParticipantId: "claude-1", recipientParticipantIds: "mission_broadcast", createdAt: "2026-07-28T00:00:00.000Z" }),
    message({ id: "new", senderParticipantId: "claude-1", recipientParticipantIds: "mission_broadcast", createdAt: "2026-07-28T01:00:00.000Z" }),
  ];
  const pending = pendingMessagesFor(messages, "codex-1", "2026-07-28T00:30:00.000Z");
  assert.deepEqual(pending.map((m) => m.messageId), ["new"]);
});

test("renderPendingMessagesForLaunch: no pending messages renders nothing to inject", () => {
  assert.equal(renderPendingMessagesForLaunch([]), null);
});

test("renderPendingMessagesForLaunch: bounds how many messages are shown and reports the rest as omitted", () => {
  const pending = Array.from({ length: 5 }, (_, i) => ({ messageId: `m${i}`, senderParticipantId: "claude-1", type: "information", body: `body ${i}`, postedAt: "2026-07-28T00:00:00.000Z" }));
  const rendered = renderPendingMessagesForLaunch(pending, 2);
  assert.ok(rendered);
  assert.match(rendered!, /3 more message\(s\) not shown/);
  assert.equal((rendered!.match(/^- \[/gm) ?? []).length, 2);
});

test("COLLABORATION_DIRECTIVE_INSTRUCTIONS documents the exact fence parseCollaborationDirectives looks for", () => {
  assert.match(COLLABORATION_DIRECTIVE_INSTRUCTIONS, /```oathlock-collaboration/);
});

// ---------------------------------------------------------------------------
// composeTaskWithCollaborationContext — must never exceed the provider
// boundary's hard task-length ceiling (resident-provider-adapters.ts's
// validateGrant: 1000 chars), which is exactly what broke this the first
// time (caught by the existing mission-execution-event-ingestion suite,
// not by this file, until this test was added).
// ---------------------------------------------------------------------------

test("composeTaskWithCollaborationContext: a normal goal plus the instructions stays comfortably under the provider's 1000-char task ceiling", () => {
  const composed = composeTaskWithCollaborationContext("Implement OAuth login for the settings page.");
  assert.ok(composed.length <= 1000, `composed task is ${composed.length} chars, exceeds the provider ceiling`);
  assert.match(composed, /oathlock-collaboration/);
});

test("composeTaskWithCollaborationContext: drops pending-message context first when it would exceed the ceiling, keeping the instructions", () => {
  const hugePending = "x".repeat(2000);
  const composed = composeTaskWithCollaborationContext("Short goal.", hugePending);
  assert.ok(composed.length <= 1000);
  assert.match(composed, /oathlock-collaboration/);
  assert.doesNotMatch(composed, /xxxxxxxxxx/);
});

test("composeTaskWithCollaborationContext: drops the instructions entirely, never truncates them mid-JSON, when even goal+instructions alone would exceed the ceiling", () => {
  const hugeGoal = "y".repeat(950);
  const composed = composeTaskWithCollaborationContext(hugeGoal);
  assert.equal(composed, hugeGoal);
  assert.doesNotMatch(composed, /oathlock-collaboration/);
});
