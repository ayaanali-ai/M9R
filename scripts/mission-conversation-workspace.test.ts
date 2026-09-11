import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMissionThreads,
  extractMentionHandles,
  filterMissionMessages,
  mentionHandle,
  mentionedParticipantIds,
} from "@/lib/mission/mission-conversation-ui";

const participants = [
  { id: "p-human", displayName: "Human Principal" },
  { id: "p-codex", displayName: "Codex" },
  { id: "p-claude", displayName: "Claude Code" },
];

const messages = [
  {
    id: "m-root",
    senderParticipantId: "p-codex",
    recipientParticipantIds: "mission_broadcast" as const,
    type: "information",
    body: "I am reviewing src/lib/mission/mission-conversation-ui.ts",
    replyToMessageId: null,
    createdAt: "2026-08-01T12:00:00.000Z",
  },
  {
    id: "m-reply",
    senderParticipantId: "p-claude",
    recipientParticipantIds: ["p-codex"],
    type: "answer",
    body: "@codex the search helper is ready for review",
    replyToMessageId: "m-root",
    createdAt: "2026-08-01T12:01:00.000Z",
  },
];

test("mention handles are stable and resolve to active participant ids", () => {
  assert.equal(mentionHandle("Claude Code"), "claude-code");
  assert.deepEqual(extractMentionHandles("@codex please ask @claude-code to review"), ["codex", "claude-code"]);
  assert.deepEqual(mentionedParticipantIds("@codex please ask @claude-code to review", participants), ["p-codex", "p-claude"]);
});

test("mission messages become roots with durable reply threads", () => {
  const threads = buildMissionThreads(messages);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].root.id, "m-root");
  assert.deepEqual(threads[0].replies.map((message) => message.id), ["m-reply"]);
});

test("conversation search matches body and participant names without changing message order", () => {
  assert.deepEqual(filterMissionMessages(messages, participants, "conversation-ui").map((message) => message.id), ["m-root"]);
  assert.deepEqual(filterMissionMessages(messages, participants, "Claude").map((message) => message.id), ["m-reply"]);
  assert.deepEqual(filterMissionMessages(messages, participants, ""), messages);
});
