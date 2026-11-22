import { createHash } from "node:crypto";

export interface InputStreamIdentity { readonly handle: string; readonly sessionId: string }
export interface InputStreamContext {
  readonly streamId: string;
  readonly sequence: number;
  readonly taskId: string;
  readonly kind: string;
  readonly queuedAt: number;
  readonly startedAt: number;
  readonly signal: AbortSignal;
}
export interface InputStreamSnapshot {
  readonly streamId: string;
  readonly agent: string;
  readonly nextSequence: number;
  readonly queued: number;
  readonly active?: { readonly taskId: string; readonly kind: string; readonly sequence: number };
}
export interface AgentInputStreams {
  run<T>(identity: InputStreamIdentity, request: { taskId: string; kind: string }, operation: (context: InputStreamContext) => Promise<T>): Promise<T>;
  cancelTask(identity: InputStreamIdentity, taskId: string, reason?: unknown): boolean;
  snapshot(): readonly InputStreamSnapshot[];
  close(): Promise<void>;
}

/** A session owns one ordered logical stream across tasks, windows and delivery modes. */
export function agentInputStreamId(identity: InputStreamIdentity): string {
  const handle = identity.handle.replace(/^@+/, "").trim().toLowerCase();
  if (!handle || !identity.sessionId.trim()) throw new Error("An input stream requires an authenticated agent session.");
  return `stream-${createHash("sha256").update(`${handle}\0${identity.sessionId}`).digest("hex").slice(0, 24)}`;
}

interface Entry {
  readonly context: Omit<InputStreamContext, "startedAt" | "signal">;
  readonly controller: AbortController;
  readonly operation: (context: InputStreamContext) => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  settled: boolean;
}
interface Stream {
  readonly id: string;
  readonly agent: string;
  sequence: number;
  readonly pending: Entry[];
  active?: Entry;
  draining?: Promise<void>;
}

/**
 * The owner broker owns these lanes. They order one agent's commands, never another
 * agent's work. Target conflict arbitration and the physical foreground lease are
 * separate, narrower resources. An idle stream survives task completion until broker
 * shutdown, so a follow-up task does not acquire a new input identity.
 */
export function createAgentInputStreams(now: () => number = Date.now): AgentInputStreams {
  const streams = new Map<string, Stream>();
  let closed = false;
  const drain = async (stream: Stream): Promise<void> => {
    try {
      while (stream.pending.length) {
        const entry = stream.pending.shift()!;
        if (entry.controller.signal.aborted) continue;
        stream.active = entry;
        try {
          const value = await entry.operation({ ...entry.context, startedAt: now(), signal: entry.controller.signal });
          if (!entry.settled) { entry.settled = true; entry.resolve(value); }
        } catch (error) {
          if (!entry.settled) { entry.settled = true; entry.reject(error); }
        } finally { if (stream.active === entry) stream.active = undefined; }
      }
    } finally { stream.draining = undefined; }
  };
  const pump = (stream: Stream): void => {
    if (!stream.draining) stream.draining = Promise.resolve().then(() => drain(stream));
  };
  const cancel = (entry: Entry, reason: unknown): void => {
    entry.controller.abort(reason);
    // Cancellation wakes the caller immediately. The lane remains occupied by an
    // active dispatch until it actually returns, so abort cannot introduce a race.
    if (!entry.settled) { entry.settled = true; entry.reject(reason); }
  };
  return {
    run<T>(identity: InputStreamIdentity, request: { taskId: string; kind: string }, operation: (context: InputStreamContext) => Promise<T>): Promise<T> {
      if (closed) return Promise.reject(new Error("The input-stream broker is closed."));
      const id = agentInputStreamId(identity);
      let stream = streams.get(id);
      if (!stream) {
        stream = { id, agent: identity.handle.replace(/^@+/, "").trim().toLowerCase(), sequence: 0, pending: [] };
        streams.set(id, stream);
      }
      const lane = stream;
      return new Promise<T>((resolve, reject) => {
        lane.pending.push({ context: { streamId: id, sequence: ++lane.sequence, taskId: request.taskId, kind: request.kind, queuedAt: now() },
          controller: new AbortController(), operation, resolve: (value) => resolve(value as T), reject, settled: false });
        pump(lane);
      });
    },
    cancelTask(identity, taskId, reason = new Error("The owner paused this task's input stream.")) {
      const stream = streams.get(agentInputStreamId(identity));
      if (!stream) return false;
      let canceled = false;
      for (const entry of [stream.active, ...stream.pending]) {
        if (entry?.context.taskId !== taskId) continue;
        cancel(entry, reason); canceled = true;
      }
      return canceled;
    },
    snapshot() {
      return [...streams.values()].map((stream) => ({ streamId: stream.id, agent: stream.agent,
        nextSequence: stream.sequence + 1, queued: stream.pending.filter((entry) => !entry.controller.signal.aborted).length,
        ...(stream.active ? { active: { taskId: stream.active.context.taskId, kind: stream.active.context.kind, sequence: stream.active.context.sequence } } : {}) }));
    },
    async close() {
      closed = true;
      for (const stream of streams.values()) for (const entry of [stream.active, ...stream.pending]) {
        if (entry) cancel(entry, new Error("The input-stream broker is closing."));
      }
      await Promise.all([...streams.values()].map((stream) => stream.draining));
      streams.clear();
    },
  };
}
