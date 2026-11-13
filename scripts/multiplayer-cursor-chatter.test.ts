import assert from "node:assert/strict";
import test from "node:test";
import type { A2AMessage, MultiplayerRoster } from "../src/lib/native/multiplayer-contract";
import { subscribeA2ACursorChatter, uniqueActiveCursorIdentity } from "../src/lib/native/multiplayer-cursor-chatter";

const roster: MultiplayerRoster = {
  runId: "run-1",
  agents: [
    { agentId: "agent-codex", branchId: "branch-codex", provider: "Codex", handle: "codex" },
    { agentId: "agent-claude", branchId: "branch-claude", provider: "Claude", handle: "claude" },
  ],
};

function message(overrides: Partial<A2AMessage> = {}): A2AMessage {
  return {
    schemaVersion: 1,
    runId: "run-1",
    branchId: "branch-codex",
    agentId: "agent-codex",
    taskId: "task-1",
    conversationId: "conversation-1",
    messageId: "message-1",
    recipient: { kind: "agent", agentId: "agent-claude" },
    kind: "delegate",
    priority: "normal",
    idempotencyKey: "key-1",
    createdAt: 1,
    summary: "Check the first paragraph",
    replyDepth: 0,
    ...overrides,
  };
}

test("accepted roster A2A summaries map to sender and recipient cursor handles", () => {
  let listener: ((accepted: A2AMessage) => void) | undefined;
  let unsubscribed = false;
  const rendered: Array<[string, string, string, string | undefined]> = [];
  const stop = subscribeA2ACursorChatter({
    multiplayer: { subscribe: (next) => { listener = next; return () => { unsubscribed = true; }; } },
    roster,
    sayAgentCursor: async (from, to, summary, taskId) => { rendered.push([from, to, summary, taskId]); return true; },
  });

  listener!(message());
  listener!(message({ agentId: "unknown-agent" }));
  listener!(message({ recipient: { kind: "agent", agentId: "unknown-recipient" } }));
  listener!(message({ summary: "   " }));
  listener!(message({ taskId: undefined }));

  // message.taskId ("task-1" here) is only presence-checked to gate task-scoped chatter; it is never
  // forwarded to sayAgentCursor, since it is the sender's own free-form A2A room label, not a real M9R
  // task id -- so the mock sees no fourth argument (undefined), not the message's own "task-1".
  assert.deepEqual(rendered, [["codex", "claude", "Check the first paragraph", undefined]]);
  stop();
  assert.equal(unsubscribed, true, "the broker can release the listener at shutdown");
});

test("one accepted broadcast can address each configured teammate without leaking unknown ids", () => {
  let listener: ((accepted: A2AMessage) => void) | undefined;
  const rendered: Array<[string, string]> = [];
  subscribeA2ACursorChatter({
    multiplayer: { subscribe: (next) => { listener = next; return () => {}; } },
    roster: { ...roster, agents: [...roster.agents, { agentId: "agent-gemini", branchId: "branch-gemini", provider: "Gemini", handle: "gemini" }] },
    sayAgentCursor: (from, to) => { rendered.push([from, to]); return true; },
  });
  listener!(message({ recipient: { kind: "group", agentIds: ["agent-claude", "agent-gemini", "agent-unknown"] } }));
  assert.deepEqual(rendered, [["codex", "claude"], ["codex", "gemini"]]);
});

test("cursor chatter resolves only one currently active session for a handle", () => {
  const first = { identity: { handle: "@codex", sessionId: "session-1" }, taskId: "task-1" };
  const inactive = { identity: { handle: "codex", sessionId: "session-old" }, taskId: "task-old" };
  assert.deepEqual(uniqueActiveCursorIdentity([first, inactive], " CODEX ", (taskId) => taskId === "task-1"), first.identity);
  assert.equal(uniqueActiveCursorIdentity([inactive], "codex", () => false), undefined);
  assert.equal(uniqueActiveCursorIdentity([first, { identity: { handle: "codex", sessionId: "session-2" }, taskId: "task-2" }],
    "codex", () => true), undefined, "two active sessions with one handle are ambiguous and fail closed");
  assert.deepEqual(uniqueActiveCursorIdentity([first, { identity: { handle: "codex", sessionId: "session-2" }, taskId: "task-2" }],
    "codex", () => true, "task-1"), first.identity, "task-scoped resolution picks only the exact task's active cursor");
  assert.equal(uniqueActiveCursorIdentity([first], "codex", () => true, "task-other"), undefined,
    "a message cannot be attached to a cursor from another task");
});
