import test from "node:test";
import assert from "node:assert/strict";
import {
  CHAT_EVIDENCE_SCHEMA_VERSION,
  classifyEvidenceApprovalMessage,
  classifyEvidenceRequestDecision,
  evidenceDecisionMention,
  parseChatEvidenceContract,
  renderChatEvidenceMessage,
} from "../src/lib/bridge/chat-evidence-contract.ts";
import {
  buildMissionEvidenceSource,
  missionEvidenceIdForChatSubmission,
} from "../src/lib/bridge/chat-evidence-service.ts";

function validEvidence(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: CHAT_EVIDENCE_SCHEMA_VERSION,
    summary: "Fixed the reconnect cursor handling.",
    work: ["Preserved the last workspace cursor across Relay reconnects."],
    files: ["src/lib/mission/mission-relay-browser-client.ts"],
    verification: [{ command: "npm run test:phase1-relay", result: "12 tests passed" }],
    limitations: ["No live provider task was run."],
    ...overrides,
  };
}

test("structured chat evidence requires work, source paths, and verification output", () => {
  const parsed = parseChatEvidenceContract(validEvidence());
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.schemaVersion, CHAT_EVIDENCE_SCHEMA_VERSION);
    assert.deepEqual(parsed.value.verification, [{ command: "npm run test:phase1-relay", result: "12 tests passed" }]);
  }
});

test("a free-form completion claim is rejected as insufficient evidence", () => {
  const parsed = parseChatEvidenceContract({ summary: "Done, everything works." });
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.errors.join(" "), /verification|work|schema/i);
});

test("evidence with secrets is rejected before it can be shown as reviewable", () => {
  const parsed = parseChatEvidenceContract(validEvidence({ limitations: ["Used sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA"] }));
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.errors.join(" "), /secret/i);
});

test("approval language is explicit enough for in-channel human consent", () => {
  assert.equal(classifyEvidenceApprovalMessage("yes, submit the evidence"), "approved");
  assert.equal(classifyEvidenceApprovalMessage("okay"), "approved");
  assert.equal(classifyEvidenceApprovalMessage("not yet, hold off"), "rejected");
  assert.equal(classifyEvidenceApprovalMessage("the tests look good"), "unclear");
});

test("a qualified negative that merely starts with an affirmative word is not consent", () => {
  // The approval match is a PREFIX match, so "yes, but don't submit yet" and
  // "ok hold off until I've checked the tests" both used to classify as
  // approved and unlock a real evidence submission -- the exact opposite of
  // what the human asked for.
  assert.equal(classifyEvidenceApprovalMessage("yes, but don't submit yet"), "unclear");
  assert.equal(classifyEvidenceApprovalMessage("ok hold off"), "unclear");
  assert.equal(classifyEvidenceApprovalMessage("ok hold off until I've checked the tests"), "unclear");
  assert.equal(classifyEvidenceApprovalMessage("yes once the build is green"), "unclear");
  assert.equal(classifyEvidenceApprovalMessage("approve it after you rerun the tests"), "unclear");
});

test("ordinary short affirmations still read as consent", () => {
  assert.equal(classifyEvidenceApprovalMessage("yes"), "approved");
  assert.equal(classifyEvidenceApprovalMessage("ok"), "approved");
  assert.equal(classifyEvidenceApprovalMessage("yes."), "approved");
  assert.equal(classifyEvidenceApprovalMessage("yes!"), "approved");
  assert.equal(classifyEvidenceApprovalMessage("yes @codex"), "approved");
  assert.equal(classifyEvidenceApprovalMessage("yes, submit the evidence"), "approved");
  assert.equal(classifyEvidenceApprovalMessage("go ahead"), "approved");
  assert.equal(evidenceDecisionMention("yes @codex"), "codex");
});

test("a short approval only unlocks the request it replies to", () => {
  assert.equal(classifyEvidenceRequestDecision({ body: "okay", requestMessageId: "request-message", parentMessageId: null }), "unclear");
  assert.equal(classifyEvidenceRequestDecision({ body: "okay", requestMessageId: "request-message", parentMessageId: "request-message" }), "approved");
  assert.equal(classifyEvidenceRequestDecision({ body: "yes, submit the evidence", requestMessageId: "request-message", parentMessageId: null }), "approved");
});

test("an explicit evidence approval may name exactly one agent without turning that mention into a task", () => {
  assert.equal(evidenceDecisionMention("yes @codex"), "codex");
  assert.equal(evidenceDecisionMention("not yet @claude-code"), "claude-code");
  assert.equal(evidenceDecisionMention("@codex please review the test"), null);
  assert.equal(evidenceDecisionMention("yes @codex and @opencode"), null);
});

test("review message renders the submitted facts and verification without inventing results", () => {
  const parsed = parseChatEvidenceContract(validEvidence());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const message = renderChatEvidenceMessage(parsed.value);
  assert.match(message, /Fixed the reconnect cursor handling/);
  assert.match(message, /src\/lib\/mission\/mission-relay-browser-client\.ts/);
  assert.match(message, /npm run test:phase1-relay/);
  assert.match(message, /12 tests passed/);
  assert.doesNotMatch(message, /guaranteed|proved|everything works/i);
});

test("chat evidence has a stable canonical Mission identity and bounded provenance source", () => {
  const evidence = parseChatEvidenceContract(validEvidence());
  assert.equal(evidence.ok, true);
  if (!evidence.ok) return;
  assert.equal(missionEvidenceIdForChatSubmission("submission-123"), "chat-evidence:submission-123");
  const source = buildMissionEvidenceSource("submission-123", evidence.value);
  assert.match(source, /Chat evidence submission submission-123/);
  assert.match(source, /npm run test:phase1-relay/);
  assert.ok(source.length <= 2048);
});
