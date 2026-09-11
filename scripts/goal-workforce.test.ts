import assert from "node:assert/strict";
import test from "node:test";
import { buildGoalWorkforceProposal } from "@/lib/goal/goal-workforce";

test("workforce proposal ranks provider and capability matches deterministically", () => {
  const proposal = buildGoalWorkforceProposal(
    ["codex"],
    ["repository_reading", "testing"],
    [
      {
        connectionId: "claude-1",
        agentKind: "claude-code",
        model: null,
        availableModels: [],
        capabilities: ["repository_reading", "testing"],
        lastSeenAt: "2026-09-10T12:00:00.000Z",
      },
      {
        connectionId: "codex-1",
        agentKind: "codex",
        model: "gpt-5.6-codex",
        availableModels: ["gpt-5.6-codex"],
        capabilities: ["repository_reading"],
        lastSeenAt: "2026-09-10T11:00:00.000Z",
      },
    ],
  );

  assert.equal(proposal.selectionMode, "advisory");
  assert.equal(proposal.humanApprovalRequired, true);
  assert.deepEqual(proposal.recommendedConnectionIds, []);
  assert.equal(proposal.candidates[0]?.connectionId, "codex-1");
  assert.deepEqual(proposal.candidates[0]?.missingCapabilities, ["testing"]);
  assert.deepEqual(proposal.candidates[1]?.matchedCapabilities, ["repository_reading", "testing"]);
});

test("workforce proposal never recommends an unmatched provider when a preference is declared", () => {
  const proposal = buildGoalWorkforceProposal(
    ["codex"],
    [],
    [{
      connectionId: "claude-1",
      agentKind: "claude-code",
      model: null,
      availableModels: [],
      capabilities: [],
      lastSeenAt: "2026-09-10T12:00:00.000Z",
    }],
  );

  assert.equal(proposal.candidates[0]?.providerPreferenceMatch, false);
  assert.deepEqual(proposal.recommendedConnectionIds, []);
});
