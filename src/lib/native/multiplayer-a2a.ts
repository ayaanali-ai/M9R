import {
  MAX_A2A_REPLY_DEPTH,
  parseA2AMessage,
  type A2AProgressKind,
  type A2AMessage,
  type MultiplayerRoster,
} from "./multiplayer-contract";

export type A2ARouterEvent =
  | { readonly kind: "message-accepted"; readonly message: A2AMessage; readonly at: number }
  | { readonly kind: "message-delivered"; readonly message: A2AMessage; readonly recipientAgentId: string; readonly at: number }
  | { readonly kind: "message-duplicate"; readonly message: A2AMessage; readonly at: number }
  | { readonly kind: "message-expired"; readonly message: A2AMessage; readonly at: number };

export type A2ARouteResult =
  | {
    readonly ok: true;
    readonly duplicate: boolean;
    readonly message: A2AMessage;
    readonly recipientAgentIds: readonly string[];
  }
  | { readonly ok: false; readonly error: string; readonly expired?: boolean };

export interface A2ARouterOptions {
  readonly now?: () => number;
  /** Bounds in-memory history and retry keys; this is not a message-size limit. */
  readonly maxMessages?: number;
  /** Durable message ids restored by the owner broker so replies still resolve after restart. */
  readonly knownMessageIds?: readonly string[];
  /** Durable, sanitized envelopes restored by the owner broker for true retry dedupe after restart. */
  readonly knownMessages?: readonly A2AMessage[];
  /** Durable routing metadata restored with task-linked messages for safe in-thread replies. */
  readonly knownMessageReferences?: readonly A2AMessageReference[];
}

/** One bounded peer thread; the owner can start a fresh task when more turns are needed. */
export const MAX_A2A_CONVERSATION_MESSAGES = 32;

export interface A2AMessageReference {
  readonly messageId: string;
  readonly agentId: string;
  readonly recipientAgentIds: readonly string[];
  readonly taskId?: string;
  readonly conversationId?: string;
  readonly replyDepth: number;
}

export interface MultiplayerA2ARouter {
  readonly runId: string;
  readonly roster: MultiplayerRoster;
  /** Validate and route one structured message without invoking a model. */
  send(message: A2AMessage, options?: { allowSharedRoot?: boolean }): A2ARouteResult;
  /** Subscribe to accepted, delivered, duplicate, and expiry events. */
  subscribe(listener: (event: A2ARouterEvent) => void): () => void;
  /** Read recent accepted messages for a recipient without polling a provider. */
  historyFor(agentId: string): readonly A2AMessage[];
  /** Read all recent accepted messages in delivery order. */
  history(): readonly A2AMessage[];
  /** Read the latest progress-bearing sidecar events for a task room. */
  progressFor(taskId: string, agentId?: string): readonly A2AProgressRecord[];
  /** Resolve the routing identity needed to validate a reply, including restored durable messages. */
  referenceFor(messageId: string): A2AMessageReference | undefined;
}

export interface A2AProgressRecord {
  readonly taskId: string;
  readonly agentId: string;
  readonly messageId: string;
  readonly progressFingerprint: string;
  readonly progressKind?: A2AProgressKind;
  readonly at: number;
}

type StoredMessage = {
  readonly message: A2AMessage;
  readonly fingerprint: string;
};

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Retry identity is content identity, not transport-clock identity. A provider
 * may recreate the same idempotent message a few milliseconds later after a
 * lost owner-pipe response; the new `createdAt` must not turn that retry into
 * a conflicting message while all actionable fields remain identical.
 */
function messageFingerprint(message: A2AMessage): string {
  const { createdAt: _createdAt, ...retryStableMessage } = message;
  return canonicalize(retryStableMessage);
}

function routeRecipients(message: A2AMessage): readonly string[] {
  return message.recipient.kind === "agent"
    ? [message.recipient.agentId]
    : message.recipient.agentIds;
}

function resultError(error: string, expired = false): A2ARouteResult {
  return { ok: false, error, ...(expired ? { expired: true } : {}) };
}

/**
 * Create the bounded, provider-neutral A2A router for one multiplayer run.
 * It is intentionally transport-agnostic: providers subscribe to events and
 * the later collaboration view can project the same structured history.
 */
export function createMultiplayerA2ARouter(
  roster: MultiplayerRoster,
  options: A2ARouterOptions = {},
): MultiplayerA2ARouter {
  const now = options.now ?? Date.now;
  const maxMessages = options.maxMessages ?? 4096;
  if (!Number.isSafeInteger(maxMessages) || maxMessages < 1 || maxMessages > 16_384) {
    throw new Error("M9R A2A history bound must be between 1 and 16384 messages.");
  }

  const knownAgents = new Map(roster.agents.map((agent) => [agent.agentId, agent]));
  const messages = new Map<string, StoredMessage>();
  const idempotency = new Map<string, StoredMessage>();
  const order: string[] = [];
  const knownMessageIds = new Set<string>();
  const knownMessageOrder: string[] = [];
  const references = new Map<string, A2AMessageReference>();
  const conversationByTask = new Map<string, string>();
  const taskByConversation = new Map<string, string>();
  for (const candidate of (options.knownMessages ?? []).slice(-maxMessages)) {
    let message: A2AMessage;
    try { message = parseA2AMessage(candidate); }
    catch { continue; }
    const sender = knownAgents.get(message.agentId);
    const recipients = routeRecipients(message);
    if (message.runId !== roster.runId || !sender || sender.branchId !== message.branchId
      || recipients.some((agentId) => !knownAgents.has(agentId)) || messages.has(message.messageId)) continue;
    const stored: StoredMessage = { message, fingerprint: messageFingerprint(message) };
    messages.set(message.messageId, stored);
    idempotency.set(`${message.agentId}:${message.idempotencyKey}`, stored);
    order.push(message.messageId);
    knownMessageIds.add(message.messageId);
    knownMessageOrder.push(message.messageId);
    references.set(message.messageId, {
      messageId: message.messageId,
      agentId: message.agentId,
      recipientAgentIds: recipients,
      ...(message.taskId ? { taskId: message.taskId } : {}),
      ...(message.conversationId ? { conversationId: message.conversationId } : {}),
      replyDepth: message.replyDepth,
    });
    if (message.taskId && message.conversationId) {
      conversationByTask.set(message.taskId, message.conversationId);
      taskByConversation.set(message.conversationId, message.taskId);
    }
  }
  for (const reference of (options.knownMessageReferences ?? []).slice(-maxMessages)) {
    if (!reference.messageId || !reference.agentId || !Number.isSafeInteger(reference.replyDepth)
      || reference.replyDepth < 0 || reference.replyDepth > MAX_A2A_REPLY_DEPTH) continue;
    if (references.has(reference.messageId)) continue;
    const clean = { ...reference, recipientAgentIds: [...reference.recipientAgentIds] };
    references.set(clean.messageId, clean);
    if (clean.taskId && clean.conversationId) {
      conversationByTask.set(clean.taskId, clean.conversationId);
      taskByConversation.set(clean.conversationId, clean.taskId);
    }
    if (!knownMessageIds.has(clean.messageId)) {
      knownMessageIds.add(clean.messageId);
      knownMessageOrder.push(clean.messageId);
    }
  }
  for (const id of options.knownMessageIds ?? []) {
    if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:%-]{0,127}$/.test(id) || knownMessageIds.has(id)) continue;
    knownMessageIds.add(id);
    knownMessageOrder.push(id);
  }
  while (knownMessageOrder.length > maxMessages) {
    const old = knownMessageOrder.shift();
    if (old) {
      knownMessageIds.delete(old);
      references.delete(old);
    }
  }
  const listeners = new Set<(event: A2ARouterEvent) => void>();

  const emit = (event: A2ARouterEvent): void => {
    for (const listener of listeners) {
      try { listener(event); } catch { /* observers cannot break delivery */ }
    }
  };

  const forgetReference = (messageId: string): void => {
    const removed = references.get(messageId);
    references.delete(messageId);
    if (!removed?.taskId || !removed.conversationId) return;
    const stillUsed = [...references.values()].some((reference) => reference.taskId === removed.taskId && reference.conversationId === removed.conversationId);
    if (!stillUsed) {
      if (conversationByTask.get(removed.taskId) === removed.conversationId) conversationByTask.delete(removed.taskId);
      if (taskByConversation.get(removed.conversationId) === removed.taskId) taskByConversation.delete(removed.conversationId);
    }
  };
  for (const messageId of [...references.keys()]) if (!knownMessageIds.has(messageId)) forgetReference(messageId);

  const trim = (): void => {
    while (order.length > maxMessages) {
      const oldestId = order.shift();
      if (!oldestId) continue;
      const stored = messages.get(oldestId);
      messages.delete(oldestId);
      if (stored) idempotency.delete(`${stored.message.agentId}:${stored.message.idempotencyKey}`);
      forgetReference(oldestId);
      knownMessageIds.delete(oldestId);
      const knownIndex = knownMessageOrder.indexOf(oldestId);
      if (knownIndex >= 0) knownMessageOrder.splice(knownIndex, 1);
    }
    while (knownMessageOrder.length > maxMessages) {
      const oldestId = knownMessageOrder.shift();
      if (oldestId) {
        knownMessageIds.delete(oldestId);
        forgetReference(oldestId);
      }
    }
  };

  const router: MultiplayerA2ARouter = {
    runId: roster.runId,
    roster,

    send(input, sendOptions) {
      let message: A2AMessage;
      try { message = parseA2AMessage(input); }
      catch (error) { return resultError(error instanceof Error ? error.message : "invalid A2A message"); }
      if (message.runId !== roster.runId) return resultError("A2A message belongs to a different run");
      const sender = knownAgents.get(message.agentId);
      if (!sender) return resultError("A2A sender is not part of this run");
      if (sender.branchId !== message.branchId) return resultError("A2A sender branch does not match its run identity");
      const recipients = routeRecipients(message);
      if (recipients.some((agentId) => !knownAgents.has(agentId))) return resultError("A2A recipient is not part of this run");
      if (message.expiresAt !== undefined && message.expiresAt <= now()) {
        emit({ kind: "message-expired", message, at: now() });
        return resultError("A2A message has expired", true);
      }
      if (message.taskId && message.conversationId) {
        const taskConversation = conversationByTask.get(message.taskId);
        if (taskConversation && taskConversation !== message.conversationId) return resultError("An A2A task must keep the same conversation id for its lifetime.");
        const conversationTask = taskByConversation.get(message.conversationId);
        if (conversationTask && conversationTask !== message.taskId) return resultError("An A2A conversation cannot be reused for a different task.");
      } else if (message.conversationId && taskByConversation.has(message.conversationId)) {
        return resultError("A task-bound A2A conversation requires its task id on every message.");
      }

      const fingerprint = messageFingerprint(message);
      const existingById = messages.get(message.messageId);
      if (existingById) {
        if (existingById.fingerprint !== fingerprint) return resultError("A2A message ID is already bound to different content");
        emit({ kind: "message-duplicate", message: existingById.message, at: now() });
        return { ok: true, duplicate: true, message: existingById.message, recipientAgentIds: recipients };
      }
      const idempotencyKey = `${message.agentId}:${message.idempotencyKey}`;
      const existingByKey = idempotency.get(idempotencyKey);
      if (existingByKey) {
        if (existingByKey.fingerprint !== fingerprint) return resultError("A2A idempotency key is already bound to different content");
        emit({ kind: "message-duplicate", message: existingByKey.message, at: now() });
        return { ok: true, duplicate: true, message: existingByKey.message, recipientAgentIds: recipients };
      }
      if (message.conversationId) {
        const conversationMessages = [...references.values()].filter((reference) => reference.conversationId === message.conversationId).length;
        if (conversationMessages >= MAX_A2A_CONVERSATION_MESSAGES) {
          return resultError(`A2A conversation reached its ${MAX_A2A_CONVERSATION_MESSAGES}-message bound. Start a new owner task to continue.`);
        }
        if (conversationMessages > 0 && !message.replyToMessageId) {
          const senderAlreadyOpened = [...references.values()].some(reference => reference.conversationId === message.conversationId
            && reference.agentId === message.agentId && reference.replyDepth === 0);
          if (!sendOptions?.allowSharedRoot || senderAlreadyOpened) {
            return resultError("A2A follow-up must reply to an existing message in the same conversation; a new root would reset the loop bound.");
          }
        }
      }
      if (message.replyToMessageId && !knownMessageIds.has(message.replyToMessageId)) return resultError("A2A reply references an unknown message");
      if (message.supersedesMessageId && !knownMessageIds.has(message.supersedesMessageId)) return resultError("A2A supersede references an unknown message");
      if (message.replyToMessageId) {
        const parent = references.get(message.replyToMessageId);
        if (!parent) return resultError("A2A reply reference is known, but its routing metadata is unavailable; retrieve the stored conversation or start a new owner task.");
        if (parent.taskId !== message.taskId || parent.conversationId !== message.conversationId) {
          return resultError("A2A reply must stay in the parent message's task and conversation.");
        }
        if (parent.agentId === message.agentId) {
          if (message.recipient.kind !== "agent" || !parent.recipientAgentIds.includes(message.recipient.agentId)) {
            return resultError("A sender follow-up must stay addressed to a direct recipient of the parent message.");
          }
        } else {
          if (!parent.recipientAgentIds.includes(message.agentId)) return resultError("Only the sender or a recipient of the parent A2A message may continue its thread.");
          if (message.recipient.kind !== "agent" || message.recipient.agentId !== parent.agentId) {
            return resultError("A direct A2A reply must be addressed to the parent message's sender.");
          }
        }
        if (message.replyDepth !== parent.replyDepth + 1) return resultError("A2A reply depth must follow the referenced message.");
      }

      const stored: StoredMessage = { message, fingerprint };
      messages.set(message.messageId, stored);
      idempotency.set(idempotencyKey, stored);
      order.push(message.messageId);
      knownMessageIds.add(message.messageId);
      knownMessageOrder.push(message.messageId);
      references.set(message.messageId, {
        messageId: message.messageId,
        agentId: message.agentId,
        recipientAgentIds: routeRecipients(message),
        ...(message.taskId ? { taskId: message.taskId } : {}),
        ...(message.conversationId ? { conversationId: message.conversationId } : {}),
        replyDepth: message.replyDepth,
      });
      if (message.taskId && message.conversationId) {
        conversationByTask.set(message.taskId, message.conversationId);
        taskByConversation.set(message.conversationId, message.taskId);
      }
      trim();
      const acceptedAt = now();
      emit({ kind: "message-accepted", message, at: acceptedAt });
      for (const recipientAgentId of recipients) emit({ kind: "message-delivered", message, recipientAgentId, at: now() });
      return { ok: true, duplicate: false, message, recipientAgentIds: recipients };
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    historyFor(agentId) {
      if (!knownAgents.has(agentId)) return [];
      return order.flatMap((messageId) => {
        const message = messages.get(messageId)?.message;
        if (!message) return [];
        return message.recipient.kind === "agent"
          ? (message.recipient.agentId === agentId ? [message] : [])
          : (message.recipient.agentIds.includes(agentId) ? [message] : []);
      });
    },

    history() {
      return order.flatMap((messageId) => {
        const message = messages.get(messageId)?.message;
        return message ? [message] : [];
      });
    },

    progressFor(taskId, agentId) {
      if (!taskId.trim()) return [];
      const latest = new Map<string, A2AProgressRecord>();
      for (const messageId of order) {
        const message = messages.get(messageId)?.message;
        if (!message || message.taskId !== taskId || !message.progressFingerprint || (agentId && message.agentId !== agentId)) continue;
        latest.set(message.agentId, {
          taskId,
          agentId: message.agentId,
          messageId: message.messageId,
          progressFingerprint: message.progressFingerprint,
          ...(message.progressKind === undefined ? {} : { progressKind: message.progressKind }),
          at: message.createdAt,
        });
      }
      return [...latest.values()].sort((left, right) => left.agentId.localeCompare(right.agentId));
    },

    referenceFor(messageId) {
      const reference = references.get(messageId);
      return reference ? { ...reference, recipientAgentIds: [...reference.recipientAgentIds] } : undefined;
    },
  };

  return router;
}
