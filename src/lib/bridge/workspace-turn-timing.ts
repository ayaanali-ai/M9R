import { randomUUID } from "node:crypto";

export type WorkspaceTurnTimingStage =
  | "message.received"
  | "message.enqueued"
  | "session.ready"
  | "ack.completed"
  | "prompt.started"
  | "provider.first_event"
  | "turn.completed"
  | "turn.failed"
  | "turn.rejected"
  | "report.observed"
  | "fallback_report.posted";

export type WorkspaceTurnTimingSource = "relay" | "poll";
export type WorkspaceTurnTimingOutcome = "ok" | "failed" | "observed" | "not_observed" | "rejected";

export interface WorkspaceTurnTimingContext {
  workspaceId: string;
  conversationId: string;
  messageId: string;
  source: WorkspaceTurnTimingSource;
  bridgeInstanceId?: string;
  sessionId?: string;
  provider?: string;
}

export interface WorkspaceTurnTimingMetadata {
  source?: WorkspaceTurnTimingSource;
  provider?: string;
  queueDepth?: number;
  batchSize?: number;
  providerEventType?: string;
  outcome?: WorkspaceTurnTimingOutcome;
}

export interface WorkspaceTurnTimingEvent extends WorkspaceTurnTimingMetadata {
  schema: "oathlock.workspace_timing.v1";
  timingId: string;
  eventId: string;
  correlationId: string;
  causationId: string | null;
  workspaceId: string;
  conversationId: string;
  messageId: string;
  bridgeInstanceId?: string;
  sessionId?: string;
  stage: WorkspaceTurnTimingStage;
  atMs: number;
  elapsedMs: number;
}

export interface WorkspaceTurnTimingDurations {
  receiptToEnqueueMs: number | null;
  receiptToAckMs: number | null;
  ackToPromptMs: number | null;
  promptToFirstProviderEventMs: number | null;
  promptToCompletionMs: number | null;
  receiptToCompletionMs: number | null;
  receiptToReportMs: number | null;
}

export interface WorkspaceTurnTimingSnapshot {
  timingId: string;
  correlationId: string;
  context: WorkspaceTurnTimingContext;
  stages: Partial<Record<WorkspaceTurnTimingStage, number>>;
  durations: WorkspaceTurnTimingDurations;
  firstProviderEventType: string | null;
  finalStage: WorkspaceTurnTimingStage | null;
}

export interface WorkspaceTurnTiming {
  mark(stage: WorkspaceTurnTimingStage, metadata?: WorkspaceTurnTimingMetadata): boolean;
  bindSession(input: { sessionId: string; provider?: string }): void;
  snapshot(): WorkspaceTurnTimingSnapshot;
}

export interface WorkspaceTurnLatencyAggregate {
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}

export type WorkspaceTurnLatencyKey = keyof WorkspaceTurnTimingDurations;

export interface WorkspaceTurnTelemetrySnapshot {
  schema: "oathlock.workspace_telemetry.v1";
  activeTurns: number;
  completedTurns: number;
  failedTurns: number;
  rejectedTurns: number;
  observedReports: number;
  fallbackReports: number;
  recent: WorkspaceTurnTimingSnapshot[];
  latency: Record<WorkspaceTurnLatencyKey, WorkspaceTurnLatencyAggregate>;
}

export interface WorkspaceTurnTelemetry {
  create(context: WorkspaceTurnTimingContext): WorkspaceTurnTiming;
  finish(timingId: string): boolean;
  snapshot(): WorkspaceTurnTelemetrySnapshot;
}

interface WorkspaceTurnTimingOptions {
  timingId?: string;
  context?: WorkspaceTurnTimingContext;
  now?: () => number;
  emit?: (event: WorkspaceTurnTimingEvent) => void;
}

interface WorkspaceTurnTimingState {
  timingId: string;
  correlationId: string;
  context: WorkspaceTurnTimingContext;
  stages: Map<WorkspaceTurnTimingStage, number>;
  firstProviderEventType: string | null;
  lastEventId: string | null;
}

function boundedText(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return undefined;
  return value.trim().slice(0, maxLength) || undefined;
}

function boundedCount(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(1_000_000, Math.trunc(value)));
}

function normalizedContext(input: WorkspaceTurnTimingContext | undefined, timingId: string): WorkspaceTurnTimingContext {
  const source = input?.source === "poll" ? "poll" : "relay";
  const workspaceId = boundedText(input?.workspaceId, 256) ?? "unknown-workspace";
  const conversationId = boundedText(input?.conversationId, 256) ?? "unknown-conversation";
  const messageId = boundedText(input?.messageId, 256) ?? timingId;
  const bridgeInstanceId = boundedText(input?.bridgeInstanceId, 256);
  const sessionId = boundedText(input?.sessionId, 256);
  const provider = boundedText(input?.provider, 64);
  return {
    workspaceId,
    conversationId,
    messageId,
    source,
    ...(bridgeInstanceId ? { bridgeInstanceId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(provider ? { provider } : {}),
  };
}

function stageDuration(stages: Map<WorkspaceTurnTimingStage, number>, from: WorkspaceTurnTimingStage, to: WorkspaceTurnTimingStage): number | null {
  const fromMs = stages.get(from);
  const toMs = stages.get(to);
  return fromMs === undefined || toMs === undefined || toMs < fromMs ? null : toMs - fromMs;
}

function normalizedMetadata(metadata: WorkspaceTurnTimingMetadata): WorkspaceTurnTimingMetadata {
  const provider = boundedText(metadata.provider, 64);
  const providerEventType = boundedText(metadata.providerEventType, 128);
  const queueDepth = boundedCount(metadata.queueDepth);
  const batchSize = boundedCount(metadata.batchSize);
  return {
    ...(metadata.source ? { source: metadata.source } : {}),
    ...(provider ? { provider } : {}),
    ...(queueDepth !== undefined ? { queueDepth } : {}),
    ...(batchSize !== undefined ? { batchSize } : {}),
    ...(providerEventType ? { providerEventType } : {}),
    ...(metadata.outcome ? { outcome: metadata.outcome } : {}),
  };
}

/**
 * Creates a non-blocking, redacted timing record for one workspace turn.
 *
 * Every event carries the workspace, channel, source message, provider
 * session, correlation, and causation identity needed to explain a delayed
 * response without retaining message bodies, command text, file paths,
 * tokens, or credentials.
 */
export function createWorkspaceTurnTiming(options: WorkspaceTurnTimingOptions = {}): WorkspaceTurnTiming {
  const timingId = boundedText(options.timingId, 128) ?? `workspace-turn-${randomUUID()}`;
  const state: WorkspaceTurnTimingState = {
    timingId,
    correlationId: `workspace-turn:${timingId}`,
    context: normalizedContext(options.context, timingId),
    stages: new Map<WorkspaceTurnTimingStage, number>(),
    firstProviderEventType: null,
    lastEventId: null,
  };
  const now = options.now ?? Date.now;
  const emit = options.emit ?? ((event: WorkspaceTurnTimingEvent) => {
    console.log(`[oathlock-timing] ${JSON.stringify(event)}`);
  });

  function mark(stage: WorkspaceTurnTimingStage, metadata: WorkspaceTurnTimingMetadata = {}): boolean {
    if (state.stages.has(stage)) return false;
    const atMs = Math.max(0, Math.trunc(now()));
    const receivedAtMs = state.stages.get("message.received") ?? atMs;
    const safeMetadata = normalizedMetadata({ source: state.context.source, provider: state.context.provider, ...metadata });
    const eventId = `workspace-timing-event-${randomUUID()}`;
    state.stages.set(stage, atMs);
    if (stage === "provider.first_event") state.firstProviderEventType = safeMetadata.providerEventType ?? null;
    const event: WorkspaceTurnTimingEvent = {
      schema: "oathlock.workspace_timing.v1",
      timingId: state.timingId,
      eventId,
      correlationId: state.correlationId,
      causationId: state.lastEventId,
      workspaceId: state.context.workspaceId,
      conversationId: state.context.conversationId,
      messageId: state.context.messageId,
      ...(state.context.bridgeInstanceId ? { bridgeInstanceId: state.context.bridgeInstanceId } : {}),
      ...(state.context.sessionId ? { sessionId: state.context.sessionId } : {}),
      stage,
      atMs,
      elapsedMs: Math.max(0, atMs - receivedAtMs),
      ...safeMetadata,
    };
    state.lastEventId = eventId;
    try {
      emit(event);
    } catch {
      // Timing must never change provider behavior.
    }
    return true;
  }

  function bindSession(input: { sessionId: string; provider?: string }): void {
    const sessionId = boundedText(input.sessionId, 256);
    const provider = boundedText(input.provider, 64);
    if (sessionId) state.context.sessionId = sessionId;
    if (provider) state.context.provider = provider;
  }

  function snapshot(): WorkspaceTurnTimingSnapshot {
    const orderedStages = [...state.stages.keys()];
    return {
      timingId: state.timingId,
      correlationId: state.correlationId,
      context: { ...state.context },
      stages: Object.fromEntries(state.stages.entries()),
      durations: {
        receiptToEnqueueMs: stageDuration(state.stages, "message.received", "message.enqueued"),
        receiptToAckMs: stageDuration(state.stages, "message.received", "ack.completed"),
        ackToPromptMs: stageDuration(state.stages, "ack.completed", "prompt.started"),
        promptToFirstProviderEventMs: stageDuration(state.stages, "prompt.started", "provider.first_event"),
        promptToCompletionMs: stageDuration(state.stages, "prompt.started", "turn.completed") ?? stageDuration(state.stages, "prompt.started", "turn.failed"),
        receiptToCompletionMs: stageDuration(state.stages, "message.received", "turn.completed") ?? stageDuration(state.stages, "message.received", "turn.failed"),
        receiptToReportMs: stageDuration(state.stages, "message.received", "report.observed") ?? stageDuration(state.stages, "message.received", "fallback_report.posted"),
      },
      firstProviderEventType: state.firstProviderEventType,
      finalStage: orderedStages.at(-1) ?? null,
    };
  }

  return { mark, bindSession, snapshot };
}

const LATENCY_KEYS: readonly WorkspaceTurnLatencyKey[] = [
  "receiptToEnqueueMs",
  "receiptToAckMs",
  "ackToPromptMs",
  "promptToFirstProviderEventMs",
  "promptToCompletionMs",
  "receiptToCompletionMs",
  "receiptToReportMs",
];

function emptyLatency(): WorkspaceTurnLatencyAggregate {
  return { count: 0, p50Ms: null, p95Ms: null, maxMs: null };
}

function aggregate(values: number[]): WorkspaceTurnLatencyAggregate {
  if (values.length === 0) return emptyLatency();
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (ratio: number) => sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
  return { count: sorted.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: sorted.at(-1) ?? null };
}

function emptyLatencyRecord(): Record<WorkspaceTurnLatencyKey, WorkspaceTurnLatencyAggregate> {
  return Object.fromEntries(LATENCY_KEYS.map((key) => [key, emptyLatency()])) as Record<WorkspaceTurnLatencyKey, WorkspaceTurnLatencyAggregate>;
}

/** Bounded in-process telemetry exposed by the bridge health surface. */
export function createWorkspaceTurnTelemetry(options: {
  maxRecentTurns?: number;
  now?: () => number;
  emit?: (event: WorkspaceTurnTimingEvent) => void;
} = {}): WorkspaceTurnTelemetry {
  const maxRecentTurns = Math.max(1, Math.min(Math.trunc(options.maxRecentTurns ?? 100), 500));
  const active = new Map<string, WorkspaceTurnTiming>();
  const recent: WorkspaceTurnTimingSnapshot[] = [];
  const emit = options.emit ?? ((event: WorkspaceTurnTimingEvent) => {
    console.log(`[oathlock-timing] ${JSON.stringify(event)}`);
  });

  function create(context: WorkspaceTurnTimingContext): WorkspaceTurnTiming {
    const timing = createWorkspaceTurnTiming({
      context,
      now: options.now,
      emit: (event) => {
        try {
          emit(event);
        } catch {
          // Observability must never change provider behavior.
        }
      },
    });
    active.set(timing.snapshot().timingId, timing);
    return timing;
  }

  function finish(timingId: string): boolean {
    const timing = active.get(timingId);
    if (!timing) return false;
    active.delete(timingId);
    recent.push(timing.snapshot());
    while (recent.length > maxRecentTurns) recent.shift();
    return true;
  }

  function snapshot(): WorkspaceTurnTelemetrySnapshot {
    const latencyValues = new Map<WorkspaceTurnLatencyKey, number[]>();
    for (const key of LATENCY_KEYS) latencyValues.set(key, []);
    let completedTurns = 0;
    let failedTurns = 0;
    let rejectedTurns = 0;
    let observedReports = 0;
    let fallbackReports = 0;
    for (const trace of recent) {
      if (trace.stages["turn.completed"] !== undefined) completedTurns += 1;
      if (trace.stages["turn.failed"] !== undefined) failedTurns += 1;
      if (trace.stages["turn.rejected"] !== undefined) rejectedTurns += 1;
      if (trace.stages["report.observed"] !== undefined) observedReports += 1;
      if (trace.stages["fallback_report.posted"] !== undefined) fallbackReports += 1;
      for (const key of LATENCY_KEYS) {
        const value = trace.durations[key];
        if (value !== null) latencyValues.get(key)!.push(value);
      }
    }
    const latency = emptyLatencyRecord();
    for (const key of LATENCY_KEYS) latency[key] = aggregate(latencyValues.get(key)!);
    return {
      schema: "oathlock.workspace_telemetry.v1",
      activeTurns: active.size,
      completedTurns,
      failedTurns,
      rejectedTurns,
      observedReports,
      fallbackReports,
      recent: recent.map((trace) => ({
        ...trace,
        context: { ...trace.context },
        stages: { ...trace.stages },
        durations: { ...trace.durations },
      })),
      latency,
    };
  }

  return { create, finish, snapshot };
}
