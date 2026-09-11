/**
 * Trusted planning-model registry — Phase 5C §3.
 * ----------------------------------------------------------------------------
 * Config-backed (in-memory). The capability profile here is the TRUSTED
 * source of truth for what a model configuration may be asked to do —
 * mirrors `mission-planning-capability.ts`'s rule for `RequestModelPlanning`
 * (capabilities are asserted by the trusted caller, never inferred from the
 * model's own output or a request-supplied provider name). A disabled config
 * or an unsupported schema version fails resolution BEFORE any model call is
 * attempted — the worker never even constructs a request in that case.
 */

import type { PlanningModelClient } from "./mission-planning-model-client";
import type { PlanningCapabilityRecord } from "./mission-planning-capability";

export interface PlanningRetryPolicy {
  maxTransportRetries: number;
  maxThrottleRetries: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}

export interface TrustedPlanningModelConfig {
  planningModelConfigId: string;
  client: PlanningModelClient;
  providerFamily: string;
  modelIdentifier: string;
  /** Trusted — never derived from anything the model itself claims. */
  capabilityProfile: PlanningCapabilityRecord;
  schemaVersionsSupported: string[];
  maxContextChars: number;
  maxOutputTokens: number;
  timeoutMs: number;
  retryPolicy: PlanningRetryPolicy;
  supportsCancellation: boolean;
  supportsDeterministicSampling: boolean;
  enabled: boolean;
}

export type ResolvePlanningModelResult =
  | { ok: true; config: TrustedPlanningModelConfig }
  | { ok: false; reason: "unknown_config"; planningModelConfigId: string }
  | { ok: false; reason: "disabled"; planningModelConfigId: string }
  | { ok: false; reason: "unsupported_schema_version"; planningModelConfigId: string; schemaVersion: string };

export class PlanningModelRegistry {
  private readonly configs = new Map<string, TrustedPlanningModelConfig>();

  register(config: TrustedPlanningModelConfig): void {
    this.configs.set(config.planningModelConfigId, config);
  }

  /** Resolution order matches the spec's fail-before-call rule: unknown → disabled → unsupported schema version → ok. */
  resolve(planningModelConfigId: string, requiredSchemaVersion: string): ResolvePlanningModelResult {
    const config = this.configs.get(planningModelConfigId);
    if (!config) return { ok: false, reason: "unknown_config", planningModelConfigId };
    if (!config.enabled) return { ok: false, reason: "disabled", planningModelConfigId };
    if (!config.schemaVersionsSupported.includes(requiredSchemaVersion)) {
      return { ok: false, reason: "unsupported_schema_version", planningModelConfigId, schemaVersion: requiredSchemaVersion };
    }
    return { ok: true, config };
  }
}
