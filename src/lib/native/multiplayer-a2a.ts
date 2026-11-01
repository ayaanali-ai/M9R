import {
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
}

export interface MultiplayerA2ARouter {
  readonly runId: string;
  readonly roster: MultiplayerRoster;
  /** Validate and route one structured message without invoking a model. */
  send(message: A2AMessage): A2ARouteResult;
  /** Subscribe to accepted, delivered, duplicate, and expiry events. */
  subscribe(listener: (event: A2ARouterEvent) => void): () => void;
  /** Read recent accepted messages for a recipient without polling a provider. */
  historyFor(agentId: string): readonly A2AMessage[];
  /** Read all recent accepted messages in delivery order. */
  history(): readonly A2AMessage[];
  /** Read the latest progress-bearing sidecar events for a task room. */
  progressFor(taskId: string, agentId?: string): readonly A2AProgressRecord[];
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
  const listeners = new Set<(event: A2ARouterEvent) => void>();

  const emit = (event: A2ARouterEvent): void => {
    for (const listener of listeners) {
      try { listener(event); } catch { /* observers cannot break delivery */ }
    }
  };

  const trim = (): void => {
    while (order.length > maxMessages) {
      const oldestId = order.shift();
      if (!oldestId) continue;
      const stored = messages.get(oldestId);
      messages.delete(oldestId);
      if (stored) idempotency.delete(`${stored.message.agentId}:${stored.message.idempotencyKey}`);
    }
  };

  const router: MultiplayerA2ARouter = {
    runId: roster.runId,
    roster,

    send(input) {
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
      if (message.replyToMessageId && !messages.has(message.replyToMessageId)) return resultError("A2A reply references an unknown message");
      if (message.supersedesMessageId && !messages.has(message.supersedesMessageId)) return resultError("A2A supersede references an unknown message");

      const stored: StoredMessage = { message, fingerprint };
      messages.set(message.messageId, stored);
      idempotency.set(idempotencyKey, stored);
      order.push(message.messageId);
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
  };

  return router;
}
