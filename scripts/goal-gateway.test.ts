import assert from "node:assert/strict";
import test from "node:test";
import { authorizeGoal, createGoal, GoalApiError } from "@/lib/goal/goal-service";
import type { AuthedAgent } from "@/lib/agent-join-service";
import type { MissionPrincipal } from "@/lib/mission/mission-principal";

const agent: AuthedAgent = {
  connectionId: "agent-connection-1",
  workspaceId: "workspace-1",
  agentKind: "codex",
  scopes: [],
  repoHint: null,
  tokenId: "token-1",
};

function contract(principalId = agent.connectionId) {
  return {
    version: "m9r.goal.v1",
    goal: {
      clientRequestId: "request-1",
      principalId,
      principalKind: "personal_agent",
      title: "Investigate a report",
      objective: "Find the cause and produce a tested fix.",
      successConditions: ["Root cause identified"],
      constraints: ["Do not deploy"],
      allowedCapabilities: ["repository_reading", "testing"],
      providerPreferences: ["codex"],
      autonomyPolicy: "human_required",
      budget: { maxDurationMs: null, maxEstimatedTokens: null },
      deadline: null,
      parentGoalId: null,
      contextRefs: ["message:opaque-ref"],
    },
  };
}

test("Goal ingress rejects a principal that is not the authenticated connection", async () => {
  await assert.rejects(
    () => createGoal(agent, contract("different-agent")),
    (error: unknown) => error instanceof GoalApiError && error.code === "principal_mismatch" && error.status === 403,
  );
});

test("Goal ingress reports deterministic contract validation before backend access", async () => {
  await assert.rejects(
    () => createGoal(agent, { version: "m9r.goal.v1", goal: {} }),
    (error: unknown) => {
      if (!(error instanceof GoalApiError)) return false;
      if (error.code !== "validation_error" || error.status !== 400) return false;
      const issues = error.detail?.issues;
      return Array.isArray(issues) && issues.some((issue) => issue.path === "goal.title");
    },
  );
});

test("Goal authorization cannot be performed by a bearer agent", async () => {
  const principal: MissionPrincipal = {
    actor: { kind: "agent", id: agent.connectionId },
    workspaceId: agent.workspaceId,
    kind: "agent",
    userId: null,
    agent,
  };
  await assert.rejects(
    () => authorizeGoal(principal, "goal-1"),
    (error: unknown) => error instanceof GoalApiError && error.code === "human_required" && error.status === 403,
  );
});
