export interface WorkspacePromptQueueItem {
  conversationId: string;
  topic: string;
  message: {
    id: string;
    body: string;
    created_at?: string;
    sender_display_name?: string | null;
    parent_message_id?: string | null;
  };
  queuedAt: number;
}

export type WorkspacePromptDeadLetterReason = "queue_overflow";

export interface WorkspacePromptDeadLetter extends WorkspacePromptQueueItem {
  id: string;
  sessionId: string;
  reason: WorkspacePromptDeadLetterReason;
  detail: string;
}

export interface WorkspacePromptQueueSnapshot {
  queued: number;
  sessions: number;
  deadLettered: number;
  bySession: Record<string, number>;
}

export type WorkspacePromptEnqueueResult =
  | { accepted: true; depth: number }
  | { accepted: false; reason: "duplicate" | WorkspacePromptDeadLetterReason; deadLetter?: WorkspacePromptDeadLetter };

const OVERFLOW_DETAIL = "The per-session workspace prompt queue reached its configured limit.";

/**
 * Bounded FIFO for workspace prompts. The bridge already owns durable source
 * messages in the workspace database; this class is only the in-process
 * handoff between a relay/poll event and one provider turn. Keeping that
 * boundary explicit prevents an outage from becoming an unbounded memory
 * queue, while preserving a small diagnostic dead-letter trail for operators.
 */
export class WorkspacePromptQueue {
  private readonly maxDepthPerSession: number;
  private readonly maxDeadLetters: number;
  private readonly queues = new Map<string, WorkspacePromptQueueItem[]>();
  private readonly deadLetterHistory: WorkspacePromptDeadLetter[] = [];

  constructor(options: { maxDepthPerSession?: number; maxDeadLetters?: number } = {}) {
    this.maxDepthPerSession = Math.max(1, Math.min(options.maxDepthPerSession ?? 50, 500));
    this.maxDeadLetters = Math.max(1, Math.min(options.maxDeadLetters ?? 128, 1_000));
  }

  enqueue(sessionId: string, item: WorkspacePromptQueueItem): WorkspacePromptEnqueueResult {
    const queue = this.queues.get(sessionId) ?? [];
    if (queue.some((queued) => queued.message.id === item.message.id)) {
      return { accepted: false, reason: "duplicate" };
    }
    if (queue.length >= this.maxDepthPerSession) {
      const deadLetter = {
        id: `queue-overflow:${sessionId}:${item.message.id}`,
        sessionId,
        ...item,
        reason: "queue_overflow" as const,
        detail: OVERFLOW_DETAIL,
      };
      this.deadLetterHistory.push(deadLetter);
      while (this.deadLetterHistory.length > this.maxDeadLetters) this.deadLetterHistory.shift();
      return { accepted: false, reason: "queue_overflow", deadLetter };
    }
    queue.push(item);
    this.queues.set(sessionId, queue);
    return { accepted: true, depth: queue.length };
  }

  dequeueBatch(sessionId: string, maxItems: number): WorkspacePromptQueueItem[] {
    const queue = this.queues.get(sessionId);
    if (!queue || queue.length === 0 || maxItems <= 0) return [];
    const batch = queue.splice(0, Math.max(1, Math.floor(maxItems)));
    if (queue.length === 0) this.queues.delete(sessionId);
    return batch;
  }

  snapshot(): WorkspacePromptQueueSnapshot {
    const bySession: Record<string, number> = {};
    let queued = 0;
    for (const [sessionId, queue] of this.queues) {
      if (queue.length === 0) continue;
      bySession[sessionId] = queue.length;
      queued += queue.length;
    }
    return { queued, sessions: Object.keys(bySession).length, deadLettered: this.deadLetterHistory.length, bySession };
  }

  deadLetters(): WorkspacePromptDeadLetter[] {
    return this.deadLetterHistory.map((entry) => ({ ...entry, message: { ...entry.message } }));
  }
}
