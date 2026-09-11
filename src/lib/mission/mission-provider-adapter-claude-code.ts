/**
 * ClaudeCodeProviderAdapter — the second real `ProviderAdapter` (Phase 3C).
 * ----------------------------------------------------------------------------
 * Same shape as `CodexProviderAdapter` (mission-provider-adapter-codex.ts),
 * wrapping `buildClaudeCodeLaunchSpec`/`parseClaudeCodeResult`/`jsonLines`
 * (`resident-provider-adapters.ts`) and `redactSession`
 * (`session-redaction.ts`) — the SAME existing, tested implementation this
 * repo already has for Claude Code. Nothing here re-invokes the Claude CLI a
 * different way or re-parses its stream-json protocol.
 *
 * Runs through the exact same path Codex does — nothing Claude-specific
 * exists below the adapter boundary:
 *   MissionDispatchRuntime → RealExecutionHost → NodeProcessExecutionHost
 *   → ClaudeCodeProviderAdapter → buildClaudeCodeLaunchSpec/
 *     parseClaudeCodeResult/runProviderProcess.
 * There is no `ClaudeProcessExecutionHost`, no Claude-specific lease logic,
 * and no second worktree system — `NodeProcessExecutionHost.prepare` (git
 * worktree via `createGrantWorktree`) and its fencing/recovery behavior are
 * identical for both providers.
 *
 * Environment variables are allowlisted "for free" by reuse:
 * `buildClaudeCodeLaunchSpec` internally calls a curated allowlist
 * (`selectedEnvironment("claude-code")` in resident-provider-adapters.ts —
 * PATH/HOME/etc. plus only `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/
 * `ANTHROPIC_BASE_URL`/`CLAUDE_CODE_GIT_BASH_PATH`), never the full
 * `process.env`. This adapter does not maintain a second allowlist — it
 * would drift from the one `buildClaudeCodeLaunchSpec` actually enforces.
 *
 * Capabilities are declared statically — Claude Code's CLI (`--safe-mode
 * --no-session-persistence --disable-slash-commands`, see
 * `buildClaudeCodeLaunchSpec`) has no runtime handshake this adapter probes
 * before claiming support. Declared true only where the wrapped functions
 * demonstrably do that thing today:
 *   - non_interactive_execution: `--print` (non-interactive by construction).
 *   - structured_output: `--output-format stream-json` + `--json-schema`.
 *   - streaming_output: `NodeProcessExecutionHost`'s `onOutput` delivers
 *     output incrementally, and `parseEvent` normalizes each chunk as it
 *     arrives — the same treatment Codex gets.
 *   - usage_reporting: `parseClaudeCodeResult` extracts usage via the same
 *     `extractProviderUsage` Codex's parser reuses.
 *   - repository_editing: `--tools Read,Edit,Write,Grep,Glob` in
 *     `workspace_write` mode.
 * Declared FALSE, deliberately, because nothing in the wrapped
 * implementation does them: `interactive_session`/`session_resume`
 * (`--no-session-persistence` explicitly disables both),
 * `tool_event_reporting` (`parseClaudeCodeResult` never distinguishes a
 * tool call from ordinary output — see `parseEvent`'s doc comment for why
 * this adapter does not fabricate one either), `approval_requests`
 * (`--permission-mode dontAsk`/`acceptEdits` — neither ever asks),
 * `image_input` (never exercised by the wrapped spec builder).
 */

import { buildClaudeCodeLaunchSpec, jsonLines, parseClaudeCodeResult, type ProviderLaunchGrant } from "@/lib/resident-provider-adapters";
import { redactSession } from "@/lib/session-redaction";
import { composeTaskWithCollaborationContext } from "./mission-collaboration-bridge";
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
import type { EnvironmentKind, HostOutputEvent } from "./mission-process-host";
import type { ProviderActivityPayload, RuntimeActivityKind, RuntimeActivityStatus } from "./mission-runtime-activity";

const CLAUDE_CODE_ADAPTER_ID = "claude-code";

function grantIdFor(assignment: ProviderAssignment): string {
  const raw = `${assignment.missionId}-${assignment.dispatchKey}`.replace(/[^a-zA-Z0-9._:-]/g, "-");
  return raw.length >= 8 ? raw.slice(0, 100) : `${raw}${"0".repeat(8 - raw.length)}`;
}

/** Reads the adapter-specific fields this adapter expects from `DispatchInstruction.executionConstraints` — opaque to everything except this adapter. Identical shape to Codex's, by design: the two providers accept the same bounded execution-scope vocabulary. */
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

export class ClaudeCodeProviderAdapter implements ProviderAdapter {
  readonly id = CLAUDE_CODE_ADAPTER_ID;

  async discoverCapabilities(context: AdapterContext): Promise<ProviderCapabilities> {
    void context;
    return {
      ...allCapabilitiesFalse(),
      non_interactive_execution: true,
      structured_output: true,
      streaming_output: true,
      usage_reporting: true,
      repository_editing: true,
    };
  }

  async prepareInvocation(assignment: ProviderAssignment, environment: { workingDirectory: string; kind: EnvironmentKind }): Promise<ProviderInvocation> {
    const grant = grantFromAssignment(assignment, environment.workingDirectory);
    const spec = buildClaudeCodeLaunchSpec(grant);
    return { adapterId: this.id, payload: spec };
  }

  /**
   * Deliberately does NOT emit `provider.session_started`. Claude Code's
   * stream-json protocol (as reused via `parseClaudeCodeResult`) carries
   * `session_id` on many lines, not on one distinct "session started"
   * marker the way Codex's `thread.started` event works — and `parseEvent`
   * must stay pure/stateless (called independently per chunk, with no
   * memory of prior calls, so two calls with the SAME input always produce
   * the SAME output). Without a reliable one-shot marker, emitting
   * `provider.session_started` from every line carrying a `session_id`
   * would misrepresent an ongoing session as repeatedly "starting." Every
   * event this adapter DOES emit still carries `providerSessionRef` when
   * the line exposes one, satisfying "preserve safe session references
   * where available" without fabricating an event Claude Code's reused
   * parser gives no reliable signal for.
   *
   * Only maps what `parseClaudeCodeResult` itself already treats as
   * meaningful: a terminal `result` line (→ `provider.completed`/
   * `provider.failed`, redacted). Everything else becomes
   * `provider.progress` — never inferred as a tool call, per the
   * requirement not to infer tool activity from natural-language output.
   */
  parseEvent(event: HostOutputEvent): ProviderEvent[] {
    const raw = event.raw as { kind?: string; stream?: string; text?: string } | undefined;
    if (raw?.kind !== "output" || raw.stream !== "stdout" || typeof raw.text !== "string") return [];

    const envelope = (type: ProviderEvent["type"], providerSessionRef: string | null) => ({
      type,
      executionId: "unset", // populated by the caller composing this into a full domain event, per this adapter's documented seam
      adapterId: this.id,
      providerSessionRef,
      correlationId: `claude-code-${event.sequence}`,
      causationId: null,
      timestamp: event.emittedAt,
      rawEventRef: `raw-${event.sequence}`,
      redactionStatus: "not_required" as const,
    });

    const events: ProviderEvent[] = [];
    const emitActivity = (activity: Omit<ProviderActivityPayload, "type">, providerSessionRef: string | null) => {
      const redactedSummary = redactSession(activity.summary).redactedText;
      const redactedCommand = activity.command ? redactSession(activity.command).redactedText : activity.command;
      events.push({
        ...envelope("provider.activity", providerSessionRef),
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
      const sessionRef = typeof line.session_id === "string" ? line.session_id : null;
      if (line.type === "result") {
        const isError = line.is_error === true;
        const resultText = typeof line.result === "string" ? line.result : null;
        if (isError) {
          events.push({ ...envelope("provider.failed", sessionRef), payload: { type: "provider.failed", reason: resultText ?? "Claude Code reported an error." } });
        } else {
          const redaction = resultText ? redactSession(resultText) : null;
          events.push({
            ...envelope("provider.completed", sessionRef),
            redactionStatus: redaction ? "redacted" : "not_required",
            payload: { type: "provider.completed", summary: redaction?.redactedText ?? "" },
          });
        }
      } else if (line.type === "assistant" && line.message && typeof line.message === "object") {
        const message = line.message as Record<string, unknown>;
        const content = Array.isArray(message.content) ? message.content : [];
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          const tool = block as Record<string, unknown>;
          if (tool.type !== "tool_use") continue;
          const name = stringField(tool.name);
          const input = tool.input && typeof tool.input === "object" ? tool.input as Record<string, unknown> : {};
          let activityKind: RuntimeActivityKind | null = null;
          let summary = "Structured provider tool activity.";
          let filePath: string | null = null;
          let command: string | null = null;
          let status: RuntimeActivityStatus = "started";
          if (name === "Read" || name === "Grep" || name === "Glob") {
            activityKind = "file.read";
            filePath = stringField(input.file_path) ?? stringField(input.path) ?? stringField(input.pattern);
            summary = filePath ? `Reading ${filePath}.` : "Reading repository content.";
          } else if (name === "Edit" || name === "Write") {
            activityKind = "file.changed";
            filePath = stringField(input.file_path) ?? stringField(input.path);
            summary = filePath ? `Editing ${filePath}.` : "Editing a file.";
          } else if (name === "Bash") {
            activityKind = "command.started";
            command = stringField(input.command);
            summary = command ? `Running ${command}.` : "Running a command.";
          } else if (name === "AskUserQuestion" || name === "PermissionRequest") {
            activityKind = "permission.requested";
            status = "waiting";
            summary = "Permission requested.";
          }
          if (activityKind) emitActivity({ activityKind, status, summary, filePath, command }, sessionRef);
        }
      } else {
        events.push({ ...envelope("provider.progress", sessionRef), payload: { type: "provider.progress", summary: "assistant output" } });
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
    const parsed = parseClaudeCodeResult(raw);
    const redactedSummary = parsed.resultText ? redactSession(parsed.resultText).redactedText : null;

    return {
      success: output.exitCode === 0 && !parsed.providerReportedError && redactedSummary !== null,
      summary: redactedSummary ?? (parsed.providerReportedError ? "Claude Code reported an error." : "Claude Code produced no structured result."),
      redactionStatus: "redacted",
      providerSessionRef: parsed.sessionId,
      usage: parsed.usage ? { inputTokens: parsed.usage.inputTokens, outputTokens: parsed.usage.outputTokens } : null,
    };
  }

  // No `requestCancellation` — Claude Code's CLI has no cooperative
  // cancellation protocol beyond a hard process kill, which
  // `ProcessExecutionHost.terminate` already provides. Same as Codex.
}
