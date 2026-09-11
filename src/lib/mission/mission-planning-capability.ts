/**
 * Model planning capability profile — Phase 5B §5.
 * ----------------------------------------------------------------------------
 * DELIBERATELY SEPARATE from `ProviderCapabilities` (mission-provider-adapter.ts,
 * Phase 3A) — that profile describes what an EXECUTION provider (Codex,
 * Claude Code) can do while actually running an assignment
 * (non_interactive_execution, repository_editing, ...). A model used only
 * to GENERATE a Plan proposal never executes anything, so asking "can this
 * model edit a repository" is a category error. Conflating the two would
 * also let an execution provider's capability profile quietly stand in for
 * planning-model trust, which is exactly the "provider-name-based
 * capability assumption" this phase must never make.
 *
 * Capabilities here describe the MODEL CALL itself: can it be constrained
 * to strict JSON, what's its context/output budget, is sampling
 * deterministic, etc. — never inferred from a model or provider's name,
 * always read from trusted, human/operator-authored configuration. A model
 * can never declare its own capabilities: nothing in this module accepts a
 * capability claim from model output.
 */

export const PLANNING_CAPABILITIES = [
  "structured_output",
  "strict_json_schema",
  "deterministic_sampling",
  "tool_free_generation",
  "bounded_retry_support",
] as const;
export type PlanningCapability = (typeof PLANNING_CAPABILITIES)[number];

/** A boolean capability record — every key MUST be present (Partial is never accepted here, matching `allCapabilitiesFalse()`'s "honest default" discipline from Phase 3A). */
export type PlanningCapabilityRecord = Record<PlanningCapability, boolean>;

export function allPlanningCapabilitiesFalse(): PlanningCapabilityRecord {
  return { structured_output: false, strict_json_schema: false, deterministic_sampling: false, tool_free_generation: false, bounded_retry_support: false };
}

/**
 * Trusted, operator-authored configuration identity for a planning model —
 * NEVER constructed from anything a model call itself returns. `id` is
 * recorded on every planning request/result for auditability
 * (`PlanningRequestRecord.modelConfigurationId`).
 */
export interface PlanningModelConfiguration {
  id: string;
  capabilities: PlanningCapabilityRecord;
  maximumContextTokens: number;
  maximumOutputTokens: number;
  /** How many bounded repair attempts this configuration's policy allows — see mission-model-planner.ts §12. Zero is a valid, explicit policy. */
  maxRepairAttempts: number;
}

export type PlanningCapabilityErrorCode = "planning_model_capability_unresolved";

export interface PlanningCapabilityError {
  code: PlanningCapabilityErrorCode;
  modelConfigurationId: string;
  missingCapabilities: PlanningCapability[];
}

export type PlanningCapabilityCheckResult = { ok: true } | { ok: false; error: PlanningCapabilityError };

/**
 * The MINIMUM capability set every model-assisted planning request
 * requires, regardless of caller-specific requirements — strict, schema-
 * validated, tool-free, single-turn output is the entire safety model this
 * phase depends on to keep model output as pure untrusted data.
 */
export const REQUIRED_PLANNING_CAPABILITIES: readonly PlanningCapability[] = ["structured_output", "strict_json_schema", "tool_free_generation"];

/** Fails with a typed error — never silently proceeds with an under-capable configuration, and never asks the configuration itself whether it qualifies (a model cannot self-report). */
export function checkPlanningCapabilities(configuration: PlanningModelConfiguration, required: readonly PlanningCapability[] = REQUIRED_PLANNING_CAPABILITIES): PlanningCapabilityCheckResult {
  const missing = required.filter((capability) => configuration.capabilities[capability] !== true);
  if (missing.length > 0) {
    return { ok: false, error: { code: "planning_model_capability_unresolved", modelConfigurationId: configuration.id, missingCapabilities: missing } };
  }
  return { ok: true };
}
