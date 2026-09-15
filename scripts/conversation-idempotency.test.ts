import assert from "node:assert/strict";
import test from "node:test";
import { idempotencyIdentityMatches } from "@/lib/conversation-idempotency";

const original = {
  conversation_id: "conversation-1",
  sender_connection_id: "connection-1",
  sender_user_id: null,
  recipient_connection_id: "connection-2",
  kind: "result",
  body: "The work is complete.",
  parent_message_id: "message-parent",
  outcome: "ok",
  related_run_id: "run-1",
};

test("idempotent retries match the complete message identity", () => {
  assert.equal(idempotencyIdentityMatches(original, {
    conversationId: "conversation-1",
    senderConnectionId: "connection-1",
    senderUserId: null,
    recipientConnectionId: "connection-2",
    kind: "result",
    body: "The work is complete.",
    parentMessageId: "message-parent",
    outcome: "ok",
    relatedRunId: "run-1",
  }), true);
});

test("idempotent retries reject changed body, routing, or actor data", () => {
  for (const changed of [
    { body: "A different result." },
    { recipientConnectionId: "connection-3" },
    { senderConnectionId: "connection-9" },
    { parentMessageId: null },
    { outcome: "failed" },
    { relatedRunId: "run-2" },
  ]) {
    assert.equal(idempotencyIdentityMatches(original, {
      conversationId: "conversation-1",
      senderConnectionId: "connection-1",
      senderUserId: null,
      recipientConnectionId: "connection-2",
      kind: "result",
      body: "The work is complete.",
      parentMessageId: "message-parent",
      outcome: "ok",
      relatedRunId: "run-1",
      ...changed,
    }), false);
  }
});

test("identity checks can intentionally omit fields that are not known yet", () => {
  assert.equal(idempotencyIdentityMatches(original, {
    conversationId: "conversation-1",
    senderConnectionId: "connection-1",
    kind: "result",
    body: "The work is complete.",
  }), true);
});
