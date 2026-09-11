/**
 * Provider adapter contract, capability model, and normalized event model
 * (Phase 3A)
 * ----------------------------------------------------------------------------
 * `ProcessExecutionHost` (`mission-process-host.ts`) owns WHERE a process
 * runs and whether it's still alive. `ProviderAdapter` owns HOW to talk to
 * one specific provider (Codex, Claude Code, Devin, a browser-verifier,
 * ...): building its invocation, translating its raw output into a
 * provider-neutral event stream, and producing a normalized result.
 *
 * Neither this file nor any real adapter built against it may mutate
 * Mission or lease state directly — `ProviderAdapter` has no method that
 * takes a `Mission`, a `MissionCommand`, or a `MissionSchedulerStore`, and
 * that is enforced structurally by this interface's shape, not by
 * convention. Only `MissionDispatchRuntime.tick` (Phase 2D.2), after its own
 * fencing check, is allowed to turn a `ProviderResult` into anything that
 * reaches a Mission command handler.
 */

import type { EnvironmentKind, HostOutputEvent } from "./mission-process-host";
import type { ProviderActivityPayload } from "./mission-runtime-activity";

// ---------------------------------------------------------------------------
// Capabilities — discovered or declared honestly, never fabricated
// ---------------------------------------------------------------------------

export const PROVIDER_CAPABILITIES = [
  "non_interactive_execution",
  "interactive_session",
  "structured_output",
  "streaming_output",
  "cancellation",
  "session_resume",
  "usage_reporting",
  "tool_event_reporting",
  "approval_requests",
  "image_input",
  "repository_editing",
] as const;
export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number];

/** Every capability MUST be present with an explicit boolean — there is no "unspecified" state a caller could mistake for false. */
export type ProviderCapabilities = Record<ProviderCapability, boolean>;

export function allCapabilitiesFalse(): ProviderCapabilities {
  return Object.fromEntries(PROVIDER_CAPABILITIES.map((c) => [c, false])) as ProviderCapabilities;
}

/** True only when every capability the caller requires is explicitly declared true — never inferred from absence. */
export function supportsAllCapabilities(capabilities: ProviderCapabilities, required: readonly ProviderCapability[]): boolean {
  return required.every((capability) => capabilities[capability] === true);
}

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

export interface AdapterContext {
  workspaceId: string;
  /** Set when discovery itself needs to run something (e.g. `--version`) rather than return a static declaration. Optional — a purely-declarative adapter needs no environment. */
  environment?: { workingDirectory: string; kind: EnvironmentKind } | null;
}

export interface ProviderAssignment {
  missionId: string;
  dispatchKey: string;
  goal: string;
  /** Opaque, adapter-specific instructions — this is `DispatchInstruction.executionConstraints` (mission-scheduler-store.ts), not redefined here. */
  executionConstraints: Record<string, unknown>;
  /**
   * Phase 4A — Mission-native participant/assignment identity, threaded
   * through from `DispatchInstruction.executionConstraints.participantId`/
   * `.assignmentId` by `RealExecutionHost.start` (mission-real-execution-
   * host.ts). Null when the dispatch was never associated with a Mission
   * assignment (e.g. ad hoc dispatch predating Phase 4A). Not itself
   * Mission-mutating — an adapter may only read these, never use them to
   * construct a Mission command.
   */
  participantId?: string | null;
  assignmentId?: string | null;
  /**
   * Rendered output of `renderPendingMessagesForLaunch`
   * (mission-collaboration-bridge.ts) — plain text describing what other
   * participants have posted to this one since it was last dispatched.
   * Optional and null by default: nothing upstream of `RealExecutionHost`
   * populates this yet (that wiring is part of the still-open "accepted-
   * result bridge" work), so an adapter must treat its absence as "nothing
   * to inject," never as an error.
   */
  pendingMessagesContext?: string | null;
  /**
   * Human-chosen model override for this connection (set from the dashboard,
   * agent_connections.model, read by the bridge from /api/agent/whoami).
   * Null/absent means "use whatever the provider's own default is" -- an
   * adapter that doesn't support runtime model selection must ignore this
   * silently, never fail the session over it.
   */
  model?: string | null;
  /**
   * This workspace's active rules (title + body, from GET /api/agent/rules),
   * fetched once by the bridge at session start instead of leaving delivery
   * to the agent independently deciding to run `npx oathlock rules` mid-
   * conversation. Null/absent means no active rules or the fetch failed --
   * an adapter must never block a session over this, only lose the rule
   * text for that session. Providers whose ACP wrapper exposes a real
   * persistent-instructions mechanism (Claude Code's `_meta.systemPrompt`)
   * should set it once at session creation; providers that don't (Codex,
   * OpenCode, as of the currently installed ACP wrapper versions) fall back
   * to per-turn prompt injection instead -- see buildWorkspaceTurnPrompt.
   */
  activeRulesText?: string | null;
  /**
   * This connection's own file-path DENY-list (glob patterns, from GET
   * /api/agent/file-permissions), snapshotted once at session start same as
   * activeRulesText above. Enforced by acp-stdio-adapter.ts's
   * requestPermission -- a matching path is auto-denied before a human is
   * ever asked, not just filtered out of a UI. Absent/empty means no
   * restriction, never a default lockout.
   */
  deniedFilePatterns?: string[];
  /**
   * Item #16 Part A: this connection's assigned persona pack prompt text
   * (GET /api/agent/persona -> getAssignedPersona), snapshotted once at
   * session start same as activeRulesText above. Style/tone guidance, never
   * a directive that overrides rules -- acp-stdio-adapter.ts appends it
   * after activeRulesText specifically so rules win any conflict between
   * the two. Same two-path split as rules: Claude Code gets it once via
   * `_meta.systemPrompt`; Codex/OpenCode get it via buildWorkspaceTurnPrompt
   * every turn, since neither ACP wrapper exposes a persistent-instructions
   * mechanism.
   */
  personaText?: string | null;
}

/** What `prepareInvocation` hands to `ProcessExecutionHost.launch` as its opaque `invocation` payload — adapter-specific, never interpreted by the host or the Runtime. */
export interface ProviderInvocation {
  adapterId: string;
  /** e.g. argv for a CLI-backed provider. Opaque to everything except this same adapter's own process launch. */
  payload: unknown;
}

// ---------------------------------------------------------------------------
// Normalized events — every one preserves the same envelope
// ---------------------------------------------------------------------------

export const PROVIDER_EVENT_TYPES = [
  "provider.session_started",
  "provider.progress",
  "provider.output",
  "provider.tool_requested",
  "provider.tool_completed",
  "provider.approval_requested",
  "provider.input_requested",
  "provider.usage_updated",
  "provider.activity",
  "provider.warning",
  "provider.completed",
  "provider.failed",
] as const;
export type ProviderEventType = (typeof PROVIDER_EVENT_TYPES)[number];

/**
 * Fields every normalized event carries, regardless of type — this is what
 * makes a provider event traceable back to a specific execution and a
 * specific causal chain, the same discipline `MissionEventEnvelope`
 * (mission-events.ts) applies to domain events. `redactionStatus` is not
 * optional: an event whose `raw`/payload has not been through
 * `redactSession` (src/lib/session-redaction.ts) must say so explicitly
 * rather than silently default to "safe."
 */
export interface ProviderEventEnvelope {
  readonly type: ProviderEventType;
  readonly executionId: string;
  readonly adapterId: string;
  /** The provider's own session identifier, when it exposes one. Null otherwise. */
  readonly providerSessionRef: string | null;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly timestamp: string;
  /** A pointer to the retained raw HostOutputEvent this was parsed from, when one is kept — never the raw payload inline once redaction is required. */
  readonly rawEventRef: string | null;
  readonly redactionStatus: "redacted" | "not_required" | "pending";
  /**
   * Phase 4C — a stable identity for THIS normalized event, so a consumer
   * on the other side of a restart (or a repeated poll) can tell "have I
   * already seen this one" independent of `pollEvents`'s own in-memory
   * cursor. Left undefined by the adapter's own `parseEvent` (which has no
   * notion of an execution to scope it to); always set by
   * `RealExecutionHost.pollEvents` before an event is returned to a caller.
   */
  eventId?: string;
  /** Stable identity for one prompt turn, shared by its runtime events. */
  readonly turnId?: string | null;
  /**
   * Phase 4B — Mission-native identity, attached by the ingestion path
   * (`RealExecutionHost.pollEvents`, mission-real-execution-host.ts) AFTER
   * `adapter.parseEvent` returns, not by the adapter itself (an adapter has
   * no idea which Mission participant/assignment it's running under — that
   * knowledge lives one layer up, at the `DispatchInstruction`). Null when
   * the execution was never associated with a Mission assignment.
   */
  readonly participantId?: string | null;
  readonly assignmentId?: string | null;
}

export interface ProviderSessionStartedPayload {
  providerSessionRef: string | null;
}
export interface ProviderProgressPayload {
  summary: string;
}
export interface ProviderOutputPayload {
  /** Already redacted text when `redactionStatus === "redacted"`; never raw secret-bearing content. */
  text: string;
}
export interface ProviderToolRequestedPayload {
  toolName: string;
  toolCallId: string;
}
export interface ProviderToolCompletedPayload {
  toolCallId: string;
  success: boolean;
}
export interface ProviderApprovalRequestedPayload {
  approvalId: string;
  summary: string;
}
export interface ProviderInputRequestedPayload {
  prompt: string;
}
export interface ProviderUsagePayload {
  inputTokens: number | null;
  outputTokens: number | null;
  /** Exact total reported for the prompt turn, when the provider supplies one. */
  totalTokens?: number | null;
  /** Context occupancy is telemetry, not billable turn consumption. */
  contextUsedTokens?: number | null;
  contextWindowTokens?: number | null;
  costUsd?: number | null;
  usageBasis?: "prompt_turn" | "input_output" | "context_window";
}
export interface ProviderWarningPayload {
  message: string;
}
export interface ProviderCompletedPayload {
  summary: string;
}
export interface ProviderFailedPayload {
  reason: string;
}

export type ProviderEventPayload =
  | ({ type: "provider.session_started" } & ProviderSessionStartedPayload)
  | ({ type: "provider.progress" } & ProviderProgressPayload)
  | ({ type: "provider.output" } & ProviderOutputPayload)
  | ({ type: "provider.tool_requested" } & ProviderToolRequestedPayload)
  | ({ type: "provider.tool_completed" } & ProviderToolCompletedPayload)
  | ({ type: "provider.approval_requested" } & ProviderApprovalRequestedPayload)
  | ({ type: "provider.input_requested" } & ProviderInputRequestedPayload)
  | ({ type: "provider.usage_updated" } & ProviderUsagePayload)
  | ProviderActivityPayload
  | ({ type: "provider.warning" } & ProviderWarningPayload)
  | ({ type: "provider.completed" } & ProviderCompletedPayload)
  | ({ type: "provider.failed" } & ProviderFailedPayload);

export type ProviderEvent = ProviderEventEnvelope & { readonly payload: ProviderEventPayload };

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface ProviderResult {
  success: boolean;
  /** Already redacted — see `redactionStatus`. */
  summary: string;
  redactionStatus: "redacted" | "not_required";
  providerSessionRef: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
}

export interface ProviderCancellationContext {
  executionId: string;
  providerSessionRef: string | null;
  reason: string;
}

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

export interface ProviderAdapter {
  readonly id: string;

  /** Capabilities must be discovered or explicitly declared — never fabricated. An adapter that hasn't verified a capability must return `false` for it, not guess `true`. */
  discoverCapabilities(context: AdapterContext): Promise<ProviderCapabilities>;

  /** Build what this provider needs to be launched — argv, env, whatever the adapter requires. Does not launch anything itself; `ProcessExecutionHost.launch` does. */
  prepareInvocation(assignment: ProviderAssignment, environment: { workingDirectory: string; kind: EnvironmentKind }): Promise<ProviderInvocation>;

  /** Translate one raw host output event into zero or more normalized ProviderEvents. Pure with respect to this adapter's own parsing rules — no I/O. */
  parseEvent(event: HostOutputEvent): ProviderEvent[];

  /** Produce the final normalized result once the host reports the process has finished. */
  collectResult(output: { events: HostOutputEvent[]; exitCode: number | null }): Promise<ProviderResult>;

  /** Optional — not every provider supports cooperative cancellation beyond a hard process kill (`ProcessExecutionHost.terminate` always remains available regardless). */
  requestCancellation?(context: ProviderCancellationContext): Promise<void>;
}

// ---------------------------------------------------------------------------
// FakeProviderAdapter — a test double, NOT Codex or Claude Code
// ---------------------------------------------------------------------------

/**
 * Deterministic, fully scriptable, no process/provider of its own. Used to
 * exercise the adapter contract (capability gating, event normalization,
 * result collection, the "cannot mutate Mission state" structural
 * guarantee) without any real provider integration — see
 * IMPLEMENTATION_NOTES.md's Phase 3A section for the concrete Codex/Claude
 * Code adapter file plan this stands in for.
 */
export class FakeProviderAdapter implements ProviderAdapter {
  readonly id: string;
  private readonly capabilities: ProviderCapabilities;

  constructor(id: string, capabilities: Partial<ProviderCapabilities> = {}) {
    this.id = id;
    this.capabilities = { ...allCapabilitiesFalse(), ...capabilities };
  }

  async discoverCapabilities(context: AdapterContext): Promise<ProviderCapabilities> {
    void context;
    return this.capabilities;
  }

  async prepareInvocation(assignment: ProviderAssignment, environment: { workingDirectory: string; kind: EnvironmentKind }): Promise<ProviderInvocation> {
    void environment;
    return { adapterId: this.id, payload: { goal: assignment.goal } };
  }

  parseEvent(event: HostOutputEvent): ProviderEvent[] {
    const raw = event.raw as { kind?: string; text?: string } | undefined;
    const base = {
      executionId: "unset",
      adapterId: this.id,
      providerSessionRef: null,
      correlationId: `evt-${event.sequence}`,
      causationId: null,
      timestamp: event.emittedAt,
      rawEventRef: `raw-${event.sequence}`,
      redactionStatus: "not_required" as const,
    };
    if (raw?.kind === "output") {
      return [{ ...base, type: "provider.output", payload: { type: "provider.output", text: raw.text ?? "" } }];
    }
    return [{ ...base, type: "provider.progress", payload: { type: "provider.progress", summary: "progress" } }];
  }

  async collectResult(output: { events: HostOutputEvent[]; exitCode: number | null }): Promise<ProviderResult> {
    return {
      success: output.exitCode === 0,
      summary: output.exitCode === 0 ? "completed" : `exited with code ${output.exitCode}`,
      redactionStatus: "not_required",
      providerSessionRef: null,
      usage: null,
    };
  }
}
