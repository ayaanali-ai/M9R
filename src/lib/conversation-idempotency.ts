/**
 * The idempotency key identifies one exact message attempt, not merely a
 * conversation. A retry with the same key must be byte-for-byte equivalent in
 * every routing field that affects delivery, otherwise a client bug can make
 * a changed message silently replay the original row.
 */
export interface ConversationMessageIdempotencyIdentity {
  conversationId?: string | null;
  senderConnectionId?: string | null;
  senderUserId?: string | null;
  recipientConnectionId?: string | null;
  kind?: string | null;
  body?: string | null;
  parentMessageId?: string | null;
  outcome?: string | null;
  relatedRunId?: string | null;
}

function normalize(value: unknown): unknown {
  return value === undefined ? undefined : value ?? null;
}

export function idempotencyIdentityMatches(
  existing: Record<string, unknown>,
  expected: ConversationMessageIdempotencyIdentity,
): boolean {
  const fields: Array<[keyof ConversationMessageIdempotencyIdentity, string]> = [
    ["conversationId", "conversation_id"],
    ["senderConnectionId", "sender_connection_id"],
    ["senderUserId", "sender_user_id"],
    ["recipientConnectionId", "recipient_connection_id"],
    ["kind", "kind"],
    ["body", "body"],
    ["parentMessageId", "parent_message_id"],
    ["outcome", "outcome"],
    ["relatedRunId", "related_run_id"],
  ];

  return fields.every(([expectedField, existingField]) => {
    const expectedValue = expected[expectedField];
    return expectedValue === undefined || normalize(existing[existingField]) === normalize(expectedValue);
  });
}
