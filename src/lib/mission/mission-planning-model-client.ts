/**
 * Provider-neutral planning-model client contract — Phase 5C §2.
 * ----------------------------------------------------------------------------
 * NOT `mission-provider-adapter.ts` (`ProviderAdapter`) — that contract spawns
 * and monitors CLI subprocesses (Codex/Claude Code/Devin) that edit a
 * repository. This contract calls a model to produce STRUCTURED PLAN TEXT
 * and nothing else: no filesystem access, no repository editing, no command
 * emission. A `PlanningModelClient` implementation must never receive a
 * Mission command handler, a scheduler store, or any mutable Mission
 * projection — see `mission-planning-worker.ts`'s narrow port for the
 * structural enforcement of that boundary.
 *
 * `FakePlanningModelClient` is the only implementation exercised by tests —
 * no live network call happens anywhere in this repo's test suite. A real
 * HTTP-backed client is intentionally NOT built here (see Phase 5C report).
 */

import type { BoundedPlanningContext } from "./mission-planning-context";
import type { PlanningCapabilityRecord } from "./mission-planning-capability";

export interface PlanningModelCapabilities {
  schemaVersionsSupported: string[];
  supportsCancellation: boolean;
  supportsDeterministicSampling: boolean;
  maxOutputTokens: number;
}

export interface GenerateStructuredPlanInput {
  planningModelConfigId: string;
  trustedCapabilities: PlanningCapabilityRecord;
  boundedContext: BoundedPlanningContext;
  schemaVersion: string;
  maxOutputTokens: number;
  /** Deterministic/bounded sampling — never "creative" defaults for a Mission-planning call. */
  sampling: { temperature: 0; topP: 1; seed?: number };
  timeoutMs: number;
  correlation: { missionId: string; planningRequestId: string; attempt: number; correlationId: string };
}

export interface RepairStructuredPlanInput extends GenerateStructuredPlanInput {
  originalRawOutput: string;
  validationErrors: string[];
  simulationErrors: string[];
  remainingAttempts: number;
}

export type PlanningModelOutcomeKind =
  | "success"
  | "transport_failure"
  | "throttled"
  | "provider_rejected"
  | "outcome_unknown";

export interface PlanningModelInvocationResult {
  outcome: PlanningModelOutcomeKind;
  /** Raw structured response text — present only when `outcome === "success"`. */
  rawOutputText: string | null;
  providerRequestId: string;
  modelIdentifier: string;
  usage?: { inputTokens: number; outputTokens: number };
  finishReason: string | null;
  requestedAt: string;
  respondedAt: string | null;
  /** Whether the diagnostics captured for this call are themselves redacted-safe. */
  redactionStatus: "not_stored" | "redacted" | "fully_removed" | "unavailable" | "rejected_unsafe";
  /** Bounded, non-secret detail for diagnostics — never a full prompt/transcript. */
  diagnosticSummary: string;
  /** Present only for retryable outcomes; how long the caller should wait before its next bounded retry. */
  retryAfterMs?: number;
}

export interface PlanningModelClient {
  discoverCapabilities(): Promise<PlanningModelCapabilities>;
  generateStructuredPlan(input: GenerateStructuredPlanInput): Promise<PlanningModelInvocationResult>;
  repairStructuredPlan(input: RepairStructuredPlanInput): Promise<PlanningModelInvocationResult>;
  /** Optional — not every provider supports in-flight cancellation. */
  cancel?(requestHandle: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// FakePlanningModelClient — test double, no network, fully scriptable.
// ---------------------------------------------------------------------------

export type ScriptedInvocation =
  | { outcome: "success"; rawOutputText: string; finishReason?: string }
  | { outcome: "transport_failure"; retryAfterMs?: number }
  | { outcome: "throttled"; retryAfterMs: number }
  | { outcome: "provider_rejected"; diagnosticSummary?: string }
  | { outcome: "outcome_unknown" };

export interface FakePlanningModelClientOptions {
  capabilities: PlanningModelCapabilities;
  modelIdentifier: string;
  /** Consumed in order, one per `generateStructuredPlan`/`repairStructuredPlan` call. Last entry repeats once exhausted. */
  script: ScriptedInvocation[];
  clock?: () => string;
  mintRequestId?: () => string;
}

/** Deterministic, network-free stand-in for a real model client — used by every Phase 5C test. */
export class FakePlanningModelClient implements PlanningModelClient {
  private callIndex = 0;
  private cancelled = new Set<string>();
  readonly calls: Array<{ kind: "generate" | "repair"; correlation: GenerateStructuredPlanInput["correlation"] }> = [];

  private readonly options: FakePlanningModelClientOptions;

  constructor(options: FakePlanningModelClientOptions) {
    this.options = options;
  }

  async discoverCapabilities(): Promise<PlanningModelCapabilities> {
    return this.options.capabilities;
  }

  private now(): string {
    return this.options.clock ? this.options.clock() : new Date().toISOString();
  }

  private mintId(): string {
    if (this.options.mintRequestId) return this.options.mintRequestId();
    this.callIndex += 1;
    return `fake-req-${this.callIndex}`;
  }

  private async invoke(kind: "generate" | "repair", input: GenerateStructuredPlanInput): Promise<PlanningModelInvocationResult> {
    this.calls.push({ kind, correlation: input.correlation });
    const idx = Math.min(this.calls.length - 1, this.options.script.length - 1);
    const scripted = this.options.script[Math.max(0, idx)];
    const providerRequestId = this.mintId();
    const requestedAt = this.now();

    if (this.cancelled.has(providerRequestId)) {
      return {
        outcome: "outcome_unknown",
        rawOutputText: null,
        providerRequestId,
        modelIdentifier: this.options.modelIdentifier,
        finishReason: "cancelled",
        requestedAt,
        respondedAt: null,
        redactionStatus: "not_stored",
        diagnosticSummary: "cancelled before response",
      };
    }

    switch (scripted.outcome) {
      case "success":
        return {
          outcome: "success",
          rawOutputText: scripted.rawOutputText,
          providerRequestId,
          modelIdentifier: this.options.modelIdentifier,
          usage: { inputTokens: 100, outputTokens: 200 },
          finishReason: scripted.finishReason ?? "stop",
          requestedAt,
          respondedAt: this.now(),
          redactionStatus: "redacted",
          diagnosticSummary: "structured plan produced",
        };
      case "transport_failure":
        return {
          outcome: "transport_failure",
          rawOutputText: null,
          providerRequestId,
          modelIdentifier: this.options.modelIdentifier,
          finishReason: null,
          requestedAt,
          respondedAt: this.now(),
          redactionStatus: "not_stored",
          diagnosticSummary: "transport error",
          retryAfterMs: scripted.retryAfterMs ?? 100,
        };
      case "throttled":
        return {
          outcome: "throttled",
          rawOutputText: null,
          providerRequestId,
          modelIdentifier: this.options.modelIdentifier,
          finishReason: null,
          requestedAt,
          respondedAt: this.now(),
          redactionStatus: "not_stored",
          diagnosticSummary: "rate limited",
          retryAfterMs: scripted.retryAfterMs,
        };
      case "provider_rejected":
        return {
          outcome: "provider_rejected",
          rawOutputText: null,
          providerRequestId,
          modelIdentifier: this.options.modelIdentifier,
          finishReason: "content_filter",
          requestedAt,
          respondedAt: this.now(),
          redactionStatus: "redacted",
          diagnosticSummary: scripted.diagnosticSummary ?? "provider rejected the request",
        };
      case "outcome_unknown":
        return {
          outcome: "outcome_unknown",
          rawOutputText: null,
          providerRequestId,
          modelIdentifier: this.options.modelIdentifier,
          finishReason: null,
          requestedAt,
          respondedAt: null,
          redactionStatus: "unavailable",
          diagnosticSummary: "no ack received before timeout",
        };
    }
  }

  async generateStructuredPlan(input: GenerateStructuredPlanInput): Promise<PlanningModelInvocationResult> {
    return this.invoke("generate", input);
  }

  async repairStructuredPlan(input: RepairStructuredPlanInput): Promise<PlanningModelInvocationResult> {
    return this.invoke("repair", input);
  }

  async cancel(requestHandle: string): Promise<void> {
    this.cancelled.add(requestHandle);
  }
}
