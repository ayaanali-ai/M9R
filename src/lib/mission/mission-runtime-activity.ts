/**
 * Structured, source-labelled work activity for the Mission runtime feed.
 *
 * This is intentionally separate from provider progress text. A provider can
 * only produce an activity record when it emits a structured observation; the
 * runtime never promotes a sentence such as "reviewing a file" into a claim.
 */

import { redactSession } from "../session-redaction";
import type { ProviderEvent } from "./mission-provider-adapter";

export const RUNTIME_ACTIVITY_KINDS = [
  "session.started",
  "turn.started",
  "file.read",
  "file.changed",
  "diff.reviewed",
  "command.started",
  "command.completed",
  "test.started",
  "test.completed",
  "review.started",
  "review.completed",
  "permission.requested",
  "git.branch_changed",
  "git.commit_created",
  "verification.started",
  "verification.completed",
  "usage.updated",
  "message.posted",
  "finding.opened",
] as const;
export type RuntimeActivityKind = (typeof RUNTIME_ACTIVITY_KINDS)[number];

export const RUNTIME_ACTIVITY_STATUSES = ["started", "succeeded", "failed", "waiting"] as const;
export type RuntimeActivityStatus = (typeof RUNTIME_ACTIVITY_STATUSES)[number];

export const RUNTIME_ACTIVITY_SOURCES = [
  "provider_observed",
  "system_observed",
  "system_inference",
  "agent_claim",
  "human_action",
] as const;
export type RuntimeActivitySource = (typeof RUNTIME_ACTIVITY_SOURCES)[number];

/** Payload admitted from a provider's structured event stream. */
export interface ProviderActivityPayload {
  type: "provider.activity";
  activityKind: RuntimeActivityKind;
  status: RuntimeActivityStatus;
  summary: string;
  filePath?: string | null;
  command?: string | null;
  testName?: string | null;
  testPassed?: number | null;
  testFailed?: number | null;
  testSkipped?: number | null;
  reviewTarget?: string | null;
  gitRef?: string | null;
}

export interface MissionRuntimeActivity {
  workspaceId: string;
  missionId: string;
  executionId: string;
  participantId: string | null;
  assignmentId: string | null;
  activityId: string;
  eventId: string;
  kind: RuntimeActivityKind;
  source: RuntimeActivitySource;
  status: RuntimeActivityStatus;
  occurredAt: string;
  summary: string;
  filePath: string | null;
  command: string | null;
  testName: string | null;
  testPassed: number | null;
  testFailed: number | null;
  testSkipped: number | null;
  reviewTarget: string | null;
  gitRef: string | null;
}

export interface MissionRuntimeActivityView {
  activityId: string;
  kind: RuntimeActivityKind;
  title: string;
  detail: string;
  status: RuntimeActivityStatus;
  source: RuntimeActivitySource;
  sourceLabel: string;
  occurredAt: string;
}

const redactedText = (value: unknown, maxLength: number): string => {
  const redacted = redactSession(typeof value === "string" ? value : String(value ?? "")).redactedText;
  return redacted.slice(0, maxLength);
};

const nullableText = (value: unknown, maxLength: number): string | null => value == null ? null : redactedText(value, maxLength);

/** Only workspace-relative paths are retained. Absolute paths can expose a user's local machine identity. */
const workspaceRelativePath = (value: unknown): string | null => {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const normalized = value.trim().replaceAll("\\", "/");
  if (/^(?:[a-z]:\/|\/|\\\\)/i.test(normalized)) return null;
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) return null;
  return redactedText(normalized, 512);
};

const boundedCount = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1_000_000, Math.floor(value)));
};

function providerActivityPayload(event: ProviderEvent): ProviderActivityPayload | null {
  if (event.type !== "provider.activity" || event.payload.type !== "provider.activity") return null;
  return event.payload;
}

/** Returns null for generic output/progress so no activity is inferred from prose. */
export function activityFromProviderEvent(event: ProviderEvent): Omit<MissionRuntimeActivity, "workspaceId" | "missionId" | "executionId" | "participantId" | "assignmentId" | "activityId" | "eventId" | "occurredAt"> | null {
  const payload = providerActivityPayload(event);
  if (!payload) return null;
  return {
    kind: payload.activityKind,
    source: "provider_observed",
    status: payload.status,
    summary: redactedText(payload.summary, 2_048),
    filePath: workspaceRelativePath(payload.filePath),
    command: nullableText(payload.command, 512),
    testName: nullableText(payload.testName, 512),
    testPassed: boundedCount(payload.testPassed),
    testFailed: boundedCount(payload.testFailed),
    testSkipped: boundedCount(payload.testSkipped),
    reviewTarget: nullableText(payload.reviewTarget, 512),
    gitRef: nullableText(payload.gitRef, 256),
  };
}

export function normalizeMissionRuntimeActivity(input: {
  event: ProviderEvent;
  workspaceId: string;
  missionId: string;
  executionId: string;
  participantId: string | null;
  assignmentId: string | null;
  eventId: string;
}): MissionRuntimeActivity | null {
  const activity = activityFromProviderEvent(input.event);
  if (!activity) return null;
  return {
    workspaceId: redactedText(input.workspaceId, 256),
    missionId: redactedText(input.missionId, 256),
    executionId: redactedText(input.executionId, 256),
    participantId: input.participantId ? redactedText(input.participantId, 256) : null,
    assignmentId: input.assignmentId ? redactedText(input.assignmentId, 256) : null,
    activityId: redactedText(input.eventId, 512),
    eventId: redactedText(input.eventId, 512),
    occurredAt: input.event.timestamp,
    ...activity,
  };
}

const statusVerb = (activity: MissionRuntimeActivity): string => {
  if (activity.status === "waiting") return "Waiting for approval";
  if (activity.status === "failed") return "Failed";
  if (activity.status === "started") return "In progress";
  return "Completed";
};

function titleFor(activity: MissionRuntimeActivity): string {
  switch (activity.kind) {
    case "file.read": return activity.status === "succeeded" ? "Read" : "Reading";
    case "file.changed": return activity.status === "succeeded" ? "Edited" : "Editing";
    case "diff.reviewed": return "Reviewed diff";
    case "command.started": return "Running command";
    case "command.completed": return activity.status === "succeeded" ? "Command completed" : "Command failed";
    case "test.started": return "Running tests";
    case "test.completed": return activity.status === "succeeded" ? "Tests passed" : "Tests failed";
    case "review.started": return "Reviewing";
    case "review.completed": return activity.status === "succeeded" ? "Review completed" : "Review failed";
    case "permission.requested": return "Permission requested";
    case "git.branch_changed": return "Changed branch";
    case "git.commit_created": return "Created commit";
    case "verification.started": return "Verifying";
    case "verification.completed": return activity.status === "succeeded" ? "Verification passed" : "Verification failed";
    case "session.started": return "Session started";
    case "turn.started": return "Turn started";
    case "usage.updated": return "Usage updated";
    case "message.posted": return "Posted message";
    case "finding.opened": return "Opened finding";
  }
}

function subjectFor(activity: MissionRuntimeActivity): string | null {
  return activity.filePath ?? activity.command ?? activity.testName ?? activity.reviewTarget ?? activity.gitRef;
}

export function projectMissionRuntimeActivity(activity: MissionRuntimeActivity): MissionRuntimeActivityView {
  const subject = subjectFor(activity);
  const counts = activity.kind === "test.completed"
    ? [
        activity.testPassed == null ? null : `${activity.testPassed} passed`,
        activity.testFailed == null ? null : `${activity.testFailed} failed`,
        activity.testSkipped == null ? null : `${activity.testSkipped} skipped`,
      ].filter(Boolean).join(", ")
    : "";
  const detail = [subject, counts, subject || counts ? null : activity.summary].filter(Boolean).join(" · ");
  return {
    activityId: activity.activityId,
    kind: activity.kind,
    title: titleFor(activity),
    detail: detail || statusVerb(activity),
    status: activity.status,
    source: activity.source,
    sourceLabel: activity.source === "provider_observed" ? "Provider observed" : activity.source.replaceAll("_", " "),
    occurredAt: activity.occurredAt,
  };
}
