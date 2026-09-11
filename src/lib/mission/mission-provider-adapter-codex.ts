/**
 * CodexProviderAdapter — the first real `ProviderAdapter` (Phase 3B).
 * ----------------------------------------------------------------------------
 * Wraps `buildCodexLaunchSpec`/`parseCodexResult`/`jsonLines`
 * (`resident-provider-adapters.ts`) and `redactSession`
 * (`session-redaction.ts`) — every one of them the existing, tested
 * implementation this phase's audit found. Nothing here re-parses Codex's
 * stream-json protocol a second way or reimplements redaction.
 *
 * Capabilities are declared statically, not probed: Codex's CLI has no
 * `--version`-style capability handshake this adapter checks before
 * claiming support, so these are an honest declaration of what
 * `buildCodexLaunchSpec`/`parseCodexResult` are actually known to support
 * today, not a fabricated superset. `interactive_session`, `session_resume`,
 * `image_input`, and `approval_requests` are left false because nothing in
 * the wrapped functions exercises them — declaring them true would be the
 * exact "fabricated support" the capability model exists to prevent.
 */

import {
  buildCodexLaunchSpec,
  jsonLines,
  parseCodexResult,
  type ProviderLaunchGrant,
} from "@/lib/resident-provider-adapters";
import { composeTaskWithCollaborationContext } from "./mission-collaboration-bridge";
import { redactSession } from "@/lib/session-redaction";
import {
  allCapabilitiesFalse,
  type AdapterContext,
  type ProviderAdapter,
  type ProviderAssignment,
  type ProviderCapabilities,
  type ProviderEvent,
  type ProviderInvocation,
  type ProviderResult,
} from "./mission-provider-adapter";
import type { ProviderActivityPayload, RuntimeActivityKind, RuntimeActivityStatus } from "./mission-runtime-activity";
import type { EnvironmentKind, HostOutputEvent } from "./mission-process-host";

const CODEX_ADAPTER_ID = "codex";

function grantIdFor(assignment: ProviderAssignment): string {
  const raw = `${assignment.missionId}-${assignment.dispatchKey}`.replace(/[^a-zA-Z0-9._:-]/g, "-");
  return raw.length >= 8 ? raw.slice(0, 100) : `${raw}${"0".repeat(8 - raw.length)}`;
}

/** Reads the adapter-specific fields this adapter expects from `DispatchInstruction.executionConstraints` — opaque to everything except this adapter. */
function grantFromAssignment(assignment: ProviderAssignment, workingDirectory: string): ProviderLaunchGrant {
  const constraints = assignment.executionConstraints as {
    allowedPaths?: string[];
    prohibitedPaths?: string[];
    executionMode?: "read_only" | "workspace_write";
    maxDurationMs?: number;
    modelTier?: ProviderLaunchGrant["modelTier"];
  };
  return {
    grantId: grantIdFor(assignment),
    repositoryRoot: workingDirectory,
    // Only invite collaboration when this dispatch has a real Mission
    // participant identity to attribute a directive to (mission-
    // collaboration-bridge.ts) — an ad-hoc, non-Mission dispatch just gets
    // its plain goal, unchanged from before this addition.
    task: assignment.participantId ? composeTaskWithCollaborationContext(assignment.goal, assignment.pendingMessagesContext) : assignment.goal,
    allowedPaths: constraints.allowedPaths ?? ["."],
    prohibitedPaths: constraints.prohibitedPaths ?? [],
    maxDurationMs: constraints.maxDurationMs ?? 10 * 60_000,
    executionMode: constraints.executionMode ?? "read_only",
    modelTier: constraints.modelTier,
  };
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export class CodexProviderAdapter implements ProviderAdapter {
  readonly id = CODEX_ADAPTER_ID;

  async discoverCapabilities(context: AdapterContext): Promise<ProviderCapabilities> {
    void context;
    return {
      ...allCapabilitiesFalse(),
      non_interactive_execution: true,
      structured_output: true,
      streaming_output: true,
      usage_reporting: true,
      repository_editing: true,
      // tool_event_reporting was previously declared true here without
      // parseEvent ever actually emitting provider.tool_requested/
      // provider.tool_completed — parseCodexResult (resident-provider-
      // adapters.ts) never distinguishes a tool call from a plain
      // agent_message. Corrected in Phase 3C's capability audit: false
      // until parseEvent genuinely maps a Codex tool-call event to those
      // types, not before.
    };
  }

  async prepareInvocation(assignment: ProviderAssignment, environment: { workingDirectory: string; kind: EnvironmentKind }): Promise<ProviderInvocation> {
    const grant = grantFromAssignment(assignment, environment.workingDirectory);
    const spec = buildCodexLaunchSpec(grant);
    return { adapterId: this.id, payload: spec };
  }

  /**
   * Incremental normalization of Codex's stream-json lines — reuses
   * `jsonLines` (the exact line-parsing `parseCodexResult` uses for the
   * final-state extraction) so a single event's shape is never interpreted
   * two different ways by two different code paths.
   */
  parseEvent(event: HostOutputEvent): ProviderEvent[] {
    const raw = event.raw as { kind?: string; stream?: string; text?: string } | undefined;
    if (raw?.kind !== "output" || raw.stream !== "stdout" || typeof raw.text !== "string") return [];

    const envelope = (type: ProviderEvent["type"], providerSessionRef: string | null = null) => ({
      type,
      executionId: "unset", // populated by the caller composing this into a full domain event, per this adapter's documented seam
      adapterId: this.id,
      providerSessionRef,
      correlationId: `codex-${event.sequence}`,
      causationId: null,
      timestamp: event.emittedAt,
      rawEventRef: `raw-${event.sequence}`,
      redactionStatus: "not_required" as const,
    });

    const events: ProviderEvent[] = [];
    const emitActivity = (activity: Omit<ProviderActivityPayload, "type">) => {
      const redactedSummary = redactSession(activity.summary).redactedText;
      const redactedCommand = activity.command ? redactSession(activity.command).redactedText : activity.command;
      events.push({
        ...envelope("provider.activity"),
        redactionStatus: "redacted",
        payload: {
          type: "provider.activity",
          ...activity,
          summary: redactedSummary,
          command: redactedCommand,
        },
      });
    };
    for (const line of jsonLines(raw.text)) {
      if (line.type === "thread.started" && typeof line.thread_id === "string") {
        events.push({ ...envelope("provider.session_started", line.thread_id), payload: { type: "provider.session_started", providerSessionRef: line.thread_id } });
      } else if (line.type === "error" || line.type === "turn.failed") {
        events.push({ ...envelope("provider.failed"), payload: { type: "provider.failed", reason: typeof line.message === "string" ? line.message : "Codex reported an error." } });
      } else if (line.type === "item.completed") {
        const item = line.item && typeof line.item === "object" ? (line.item as Record<string, unknown>) : null;
        if (item?.type === "agent_message" && typeof item.text === "string") {
          const redaction = redactSession(item.text);
          events.push({
            ...envelope("provider.output"),
            redactionStatus: "redacted",
            payload: { type: "provider.output", text: redaction.redactedText },
          });
        } else if (item?.type === "file_change") {
          const changes = Array.isArray(item.changes) ? item.changes : [item];
          for (const change of changes) {
            const record = change && typeof change === "object" ? change as Record<string, unknown> : item;
            const filePath = stringField(record.path) ?? stringField(record.file_path);
            emitActivity({
              activityKind: "file.changed",
              status: item.status === "failed" ? "failed" : "succeeded",
              summary: filePath ? `Changed ${filePath}.` : "Changed a file.",
              filePath,
            });
          }
        } else if (item?.type === "file_read" || item?.type === "file_opened") {
          const filePath = stringField(item.path) ?? stringField(item.file_path);
          emitActivity({
            activityKind: "file.read",
            status: item.status === "failed" ? "failed" : "succeeded",
            summary: filePath ? `Read ${filePath}.` : "Read a file.",
            filePath,
          });
        } else if (item?.type === "command_execution") {
          const command = stringField(item.command);
          const exitCode = numberField(item.exit_code);
          const explicitTestName = stringField(item.test_name) ?? stringField(item.testName);
          const activityKind: RuntimeActivityKind = explicitTestName ? "test.completed" : "command.completed";
          const status: RuntimeActivityStatus = exitCode == null || exitCode === 0 ? "succeeded" : "failed";
          emitActivity({
            activityKind,
            status,
            summary: explicitTestName ? `Test run ${status === "succeeded" ? "completed" : "failed"}.` : `Command ${status === "succeeded" ? "completed" : "failed"}.`,
            command,
            testName: explicitTestName,
            testPassed: numberField(item.test_passed) ?? numberField(item.testPassed),
            testFailed: numberField(item.test_failed) ?? numberField(item.testFailed),
            testSkipped: numberField(item.test_skipped) ?? numberField(item.testSkipped),
          });
        } else if (item?.type === "test_run") {
          emitActivity({
            activityKind: "test.completed",
            status: item.status === "failed" || item.success === false ? "failed" : "succeeded",
            summary: "Test run completed.",
            command: stringField(item.command),
            testName: stringField(item.name) ?? stringField(item.test_name),
            testPassed: numberField(item.passed),
            testFailed: numberField(item.failed),
            testSkipped: numberField(item.skipped),
          });
        } else if (item?.type === "review") {
          const status = item.status === "failed" || item.success === false ? "failed" : "succeeded";
          emitActivity({
            activityKind: "review.completed",
            status,
            summary: `Review ${status === "succeeded" ? "completed" : "failed"}.`,
            reviewTarget: stringField(item.target) ?? stringField(item.scope),
          });
        } else if (item?.type === "permission_request") {
          emitActivity({
            activityKind: "permission.requested",
            status: "waiting",
            summary: stringField(item.summary) ?? "Permission requested.",
          });
        } else if (item?.type === "git_commit") {
          emitActivity({
            activityKind: "git.commit_created",
            status: "succeeded",
            summary: "Created a Git commit.",
            gitRef: stringField(item.commit) ?? stringField(item.ref),
          });
        } else {
          events.push({ ...envelope("provider.progress"), payload: { type: "provider.progress", summary: typeof item?.type === "string" ? item.type : "progress" } });
        }
      }
    }
    return events;
  }

  async collectResult(output: { events: HostOutputEvent[]; exitCode: number | null }): Promise<ProviderResult> {
    const raw = output.events
      .map((event) => {
        const payload = event.raw as { kind?: string; stream?: string; text?: string } | undefined;
        return payload?.kind === "output" && payload.stream === "stdout" ? payload.text ?? "" : "";
      })
      .join("");
    const parsed = parseCodexResult(raw);
    const redactedSummary = parsed.resultText ? redactSession(parsed.resultText).redactedText : null;

    return {
      success: output.exitCode === 0 && !parsed.providerReportedError && redactedSummary !== null,
      summary: redactedSummary ?? (parsed.providerReportedError ? "Codex reported an error." : "Codex produced no structured result."),
      redactionStatus: "redacted",
      providerSessionRef: parsed.sessionId,
      usage: parsed.usage ? { inputTokens: parsed.usage.inputTokens, outputTokens: parsed.usage.outputTokens } : null,
    };
  }

  // No `requestCancellation` — Codex's CLI has no cooperative cancellation
  // protocol beyond a hard process kill, which `ProcessExecutionHost.terminate`
  // already provides. Declaring one here would be exactly the kind of
  // fabricated capability this SDK's model exists to prevent.
}
