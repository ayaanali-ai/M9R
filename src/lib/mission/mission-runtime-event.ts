/**
 * Bounded, redacted runtime-event records emitted by a provider execution.
 *
 * Provider adapters own normalization. This module owns the second safety
 * boundary before an event is retained: the event is re-redacted, reduced to
 * a known payload shape, and bounded so a provider cannot turn the runtime
 * journal into an unbounded transcript store.
 */

import { redactSession } from "../session-redaction";
import { activityFromProviderEvent, normalizeMissionRuntimeActivity, type MissionRuntimeActivity } from "./mission-runtime-activity";
import type { ProviderEvent, ProviderEventPayload, ProviderEventType } from "./mission-provider-adapter";

export const MISSION_RUNTIME_EVENT_MAX_SUMMARY_LENGTH = 2_048;
export const MISSION_RUNTIME_EVENT_MAX_PAYLOAD_BYTES = 8_192;

export interface MissionRuntimeEvent {
  workspaceId: string;
  missionId: string;
  executionId: string;
  participantId: string | null;
  assignmentId: string | null;
  eventId: string;
  turnId?: string | null;
  eventType: ProviderEventType;
  adapterId: string;
  providerSessionRef: string | null;
  correlationId: string;
  causationId: string | null;
  occurredAt: string;
  rawEventRef: string | null;
  redactionStatus: "redacted";
  summary: string;
  payload: Record<string, unknown>;
  /** Present only for a structured activity event; generic progress is never promoted. */
  activity?: MissionRuntimeActivity | null;
}

export interface MissionRuntimeEventJournal {
  append(events: readonly MissionRuntimeEvent[]): Promise<{ stored: number; duplicates: number }>;
}

const text = (value: unknown, maxLength: number): string => {
  const redacted = redactSession(typeof value === "string" ? value : String(value ?? "")).redactedText;
  return redacted.slice(0, maxLength);
};

const nullableText = (value: unknown, maxLength: number): string | null => value == null ? null : text(value, maxLength);

function payloadFor(event: ProviderEvent): { summary: string; payload: Record<string, unknown> } {
  const payload: ProviderEventPayload = event.payload;
  switch (payload.type) {
    case "provider.session_started":
      return { summary: "Provider session started.", payload: { providerSessionRef: nullableText(payload.providerSessionRef, 256) } };
    case "provider.progress":
      return { summary: text(payload.summary, MISSION_RUNTIME_EVENT_MAX_SUMMARY_LENGTH), payload: { summary: text(payload.summary, MISSION_RUNTIME_EVENT_MAX_SUMMARY_LENGTH) } };
    case "provider.output":
      return { summary: text(payload.text, MISSION_RUNTIME_EVENT_MAX_SUMMARY_LENGTH), payload: { text: text(payload.text, MISSION_RUNTIME_EVENT_MAX_SUMMARY_LENGTH) } };
    case "provider.tool_requested":
      return { summary: `Tool requested: ${text(payload.toolName, 256)}.`, payload: { toolName: text(payload.toolName, 256), toolCallId: text(payload.toolCallId, 256) } };
    case "provider.tool_completed":
      return { summary: `Tool ${payload.success ? "completed" : "failed"}.`, payload: { toolCallId: text(payload.toolCallId, 256), success: payload.success } };
    case "provider.approval_requested":
      return { summary: text(payload.summary, MISSION_RUNTIME_EVENT_MAX_SUMMARY_LENGTH), payload: { approvalId: text(payload.approvalId, 256), summary: text(payload.summary, MISSION_RUNTIME_EVENT_MAX_SUMMARY_LENGTH) } };
    case "provider.input_requested":
      return { summary: text(payload.prompt, MISSION_RUNTIME_EVENT_MAX_SUMMARY_LENGTH), payload: { prompt: text(payload.prompt, MISSION_RUNTIME_EVENT_MAX_SUMMARY_LENGTH) } };
    case "provider.usage_updated": {
      const usagePayload: Record<string, unknown> = { inputTokens: payload.inputTokens, outputTokens: payload.outputTokens };
      for (const key of ["totalTokens", "contextUsedTokens", "contextWindowTokens", "costUsd", "usageBasis"] as const) {
        if (key in payload) usagePayload[key] = payload[key];
      }
      return { summary: "Provider usage updated.", payload: usagePayload };
    }
    case "provider.activity": {
      const activity = activityFromProviderEvent(event);
      return activity
        ? { summary: activity.summary, payload: { ...activity } }
        : { summary: "Provider activity was not retained.", payload: { retained: false } };
    }
    case "provider.warning":
      return { summary: text(payload.message, MISSION_RUNTIME_EVENT_MAX_SUMMARY_LENGTH), payload: { message: text(payload.message, MISSION_RUNTIME_EVENT_MAX_SUMMARY_LENGTH) } };
    case "provider.completed":
      return { summary: text(payload.summary, MISSION_RUNTIME_EVENT_MAX_SUMMARY_LENGTH), payload: { summary: text(payload.summary, MISSION_RUNTIME_EVENT_MAX_SUMMARY_LENGTH) } };
    case "provider.failed":
      return { summary: text(payload.reason, MISSION_RUNTIME_EVENT_MAX_SUMMARY_LENGTH), payload: { reason: text(payload.reason, MISSION_RUNTIME_EVENT_MAX_SUMMARY_LENGTH) } };
  }
}

function boundedPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, "utf8") <= MISSION_RUNTIME_EVENT_MAX_PAYLOAD_BYTES) return payload;
  return { summary: text(payload.summary ?? "Runtime event payload exceeded the bounded retention limit.", MISSION_RUNTIME_EVENT_MAX_SUMMARY_LENGTH), truncated: true };
}

export function normalizeMissionRuntimeEvent(input: {
  event: ProviderEvent;
  workspaceId: string;
  missionId: string;
  executionId: string;
  participantId: string | null;
  assignmentId: string | null;
  eventId: string;
  correlationId: string;
  causationId: string | null;
}): MissionRuntimeEvent {
  const normalized = payloadFor(input.event);
  return {
    workspaceId: text(input.workspaceId, 256),
    missionId: text(input.missionId, 256),
    executionId: text(input.executionId, 256),
    participantId: input.participantId ? text(input.participantId, 256) : null,
    assignmentId: input.assignmentId ? text(input.assignmentId, 256) : null,
    eventId: text(input.eventId, 512),
    turnId: input.event.turnId ? text(input.event.turnId, 256) : null,
    eventType: input.event.type,
    adapterId: text(input.event.adapterId, 128),
    providerSessionRef: nullableText(input.event.providerSessionRef, 256),
    correlationId: text(input.correlationId, 256),
    causationId: input.causationId ? text(input.causationId, 256) : null,
    occurredAt: input.event.timestamp,
    rawEventRef: nullableText(input.event.rawEventRef, 512),
    redactionStatus: "redacted",
    summary: text(normalized.summary, MISSION_RUNTIME_EVENT_MAX_SUMMARY_LENGTH),
    payload: boundedPayload(normalized.payload),
    activity: normalizeMissionRuntimeActivity(input),
  };
}

/** Deterministic reference implementation for focused runtime tests. */
export class InMemoryMissionRuntimeEventJournal implements MissionRuntimeEventJournal {
  private readonly events = new Map<string, MissionRuntimeEvent>();

  async append(events: readonly MissionRuntimeEvent[]): Promise<{ stored: number; duplicates: number }> {
    let stored = 0;
    let duplicates = 0;
    for (const event of events) {
      const key = `${event.workspaceId}:${event.eventId}`;
      if (this.events.has(key)) {
        duplicates += 1;
        continue;
      }
      this.events.set(key, event);
      stored += 1;
    }
    return { stored, duplicates };
  }

  list(): MissionRuntimeEvent[] {
    return [...this.events.values()];
  }

  async listActivities(input: { workspaceId: string; missionId: string; participantId?: string | null; limit?: number }): Promise<MissionRuntimeActivity[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
    return [...this.events.values()]
      .flatMap((event) => event.activity ? [event.activity] : [])
      .filter((activity) => activity.workspaceId === input.workspaceId && activity.missionId === input.missionId && (input.participantId == null || activity.participantId === input.participantId))
      .slice(-limit)
      .reverse();
  }
}
