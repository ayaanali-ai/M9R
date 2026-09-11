import { MISSION_RELAY_FRAME_VERSION, type RelayFrame } from "./mission-relay-protocol";

export interface MissionRelaySubscription {
  connectionId: string;
  /** Authenticated principal id, used only for recipient-aware workspace fan-out. */
  principalId?: string;
  workspaceId: string;
  missionId: string;
  scope?: "mission" | "workspace";
  send(frame: RelayFrame): void | Promise<void>;
}

/**
 * A relay subscriber must not be allowed to create an unbounded promise
 * backlog.  The browser/bridge can always reconnect and replay from its
 * durable cursor, so falling off the bounded live stream is recoverable — but
 * it must be explicit rather than silently dropping frames.
 */
export const DEFAULT_MAX_PENDING_RELAY_FRAMES = 128;

interface OrderedMailboxOptions {
  deliver: (frame: RelayFrame) => void | Promise<void>;
  maxPendingFrames: number;
  onOverflow: () => void;
  onFailure: (error: unknown) => void;
}

class OrderedMailbox {
  private readonly options: OrderedMailboxOptions;
  private readonly queue: RelayFrame[] = [];
  private draining = false;
  private closed = false;
  private overflowed = false;

  constructor(options: OrderedMailboxOptions) {
    this.options = options;
  }

  enqueue(frame: RelayFrame): boolean {
    if (this.closed || this.overflowed) return false;
    if (this.draining || this.queue.length > 0) {
      if (this.queue.length >= this.options.maxPendingFrames) {
        this.overflowed = true;
        this.queue.length = 0;
        this.options.onOverflow();
        return false;
      }
      this.queue.push(frame);
      return true;
    }

    this.draining = true;
    this.deliver(frame);
    return true;
  }

  close(): void {
    this.closed = true;
    this.queue.length = 0;
  }

  /** Replace the queued tail with the one explicit resync signal. */
  replaceWith(frame: RelayFrame): void {
    if (this.closed) return;
    this.queue.length = 0;
    this.queue.push(frame);
    if (!this.draining) {
      this.draining = true;
      this.deliver(this.queue.shift()!);
    }
  }

  private deliver(frame: RelayFrame): void {
    let result: void | Promise<void>;
    try {
      result = this.options.deliver(frame);
    } catch (error) {
      this.fail(error);
      return;
    }
    if (!result || typeof (result as Promise<void>).then !== "function") {
      this.drainSync();
      return;
    }
    void Promise.resolve(result).then(
      () => this.drainAsync(),
      (error) => this.fail(error),
    );
  }

  private drainSync(): void {
    while (!this.closed && this.queue.length > 0) {
      const next = this.queue.shift()!;
      let result: void | Promise<void>;
      try {
        result = this.options.deliver(next);
      } catch (error) {
        this.fail(error);
        return;
      }
      if (result && typeof (result as Promise<void>).then === "function") {
        void Promise.resolve(result).then(
          () => this.drainAsync(),
          (error) => this.fail(error),
        );
        return;
      }
    }
    this.draining = false;
  }

  private drainAsync(): void {
    if (this.closed) return;
    this.drainSync();
  }

  private fail(error: unknown): void {
    this.closed = true;
    this.queue.length = 0;
    this.draining = false;
    this.options.onFailure(error);
  }
}

interface RegisteredSubscription {
  subscription: MissionRelaySubscription;
  mailbox: OrderedMailbox;
}

function key(workspaceId: string, missionId: string): string {
  return `${workspaceId}:${missionId}`;
}

export class MissionRelaySubscriptionRegistry {
  private readonly subscriptions = new Map<string, Map<string, RegisteredSubscription>>();

  subscribe(subscription: MissionRelaySubscription): void {
    const channel = this.subscriptions.get(key(subscription.workspaceId, subscription.missionId)) ?? new Map<string, RegisteredSubscription>();
    channel.get(subscription.connectionId)?.mailbox.close();
    const mailbox = new OrderedMailbox({
      deliver: (frame) => subscription.send(frame),
      maxPendingFrames: DEFAULT_MAX_PENDING_RELAY_FRAMES,
      onOverflow: () => {
        const overflowFrame: RelayFrame = {
          version: MISSION_RELAY_FRAME_VERSION,
          frameId: `relay-backpressure-${subscription.connectionId}`.slice(0, 128),
          type: "relay.error",
          workspaceId: subscription.workspaceId,
          missionId: subscription.scope === "mission" ? subscription.missionId : undefined,
          channelId: subscription.scope === "workspace" ? subscription.missionId : undefined,
          correlationId: `relay-backpressure:${subscription.connectionId}`.slice(0, 256),
          causationId: null,
          idempotencyKey: null,
          sentAt: new Date().toISOString(),
          payload: {
            code: "subscriber_backpressure",
            message: "Live delivery fell behind. Reconnect to resync from the durable cursor.",
            retryable: true,
          },
        };
        // The mailbox is allowed to finish the already-running send before
        // this signal is delivered. Removing the subscription afterwards
        // prevents a permanently slow client from consuming memory.
        const current = channel.get(subscription.connectionId);
        if (current?.mailbox === mailbox) {
          mailbox.replaceWith(overflowFrame);
          channel.delete(subscription.connectionId);
          if (channel.size === 0) this.subscriptions.delete(key(subscription.workspaceId, subscription.missionId));
        }
      },
      onFailure: () => {
        const current = channel.get(subscription.connectionId);
        if (current?.mailbox === mailbox) {
          channel.delete(subscription.connectionId);
          if (channel.size === 0) this.subscriptions.delete(key(subscription.workspaceId, subscription.missionId));
        }
      },
    });
    channel.set(subscription.connectionId, { subscription, mailbox });
    this.subscriptions.set(key(subscription.workspaceId, subscription.missionId), channel);
  }

  unsubscribe(connectionId: string, workspaceId: string, missionId: string): boolean {
    const channel = this.subscriptions.get(key(workspaceId, missionId));
    if (!channel) return false;
    const removed = channel.get(connectionId);
    channel.delete(connectionId);
    if (removed) removed.mailbox.close();
    if (channel.size === 0) this.subscriptions.delete(key(workspaceId, missionId));
    return Boolean(removed);
  }

  publish(workspaceId: string, missionId: string, frame: RelayFrame, options?: { recipientPrincipalId?: string | null; senderConnectionId?: string | null }): number {
    const channel = this.subscriptions.get(key(workspaceId, missionId));
    if (!channel) return 0;
    let sent = 0;
    for (const entry of channel.values()) {
      const recipient = options?.recipientPrincipalId ?? null;
      const isRecipient = recipient === null || entry.subscription.principalId === recipient;
      const isSender = options?.senderConnectionId !== null && options?.senderConnectionId !== undefined && entry.subscription.connectionId === options.senderConnectionId;
      if (!isRecipient && !isSender) continue;
      entry.mailbox.enqueue(frame);
      sent += 1;
    }
    return sent;
  }

  /** Publish a workspace-level activity event to every authorized room subscriber. */
  publishWorkspace(workspaceId: string, frame: RelayFrame): number {
    let sent = 0;
    for (const [subscriptionKey, channel] of this.subscriptions) {
      if (!subscriptionKey.startsWith(`${workspaceId}:`)) continue;
      for (const entry of channel.values()) {
        if (entry.subscription.scope !== "workspace") continue;
        entry.mailbox.enqueue(frame);
        sent += 1;
      }
    }
    return sent;
  }

  count(workspaceId: string, missionId: string): number {
    return this.subscriptions.get(key(workspaceId, missionId))?.size ?? 0;
  }
}
