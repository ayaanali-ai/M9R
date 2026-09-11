/**
 * MTM (Model-to-Model) Security Signals — OathLock Phase 1
 * ----------------------------------------------------------------------------
 * Lightweight, conservative detection of suspicious model-to-model behavior in
 * a single agent run. These are *early* signals: structural heuristics over the
 * trace, never deep semantic analysis. Each signal is evidence-backed and
 * labelled `heuristic: true` because real intent cannot be proven from a trace.
 *
 * Phase 1 covers four patterns, designed to be extended:
 *  1. Model escalation        — a sudden switch to a stronger/more expensive
 *                               model (weak → frontier), the classic "overkill
 *                               for a simple task" / privilege-escalation shape.
 *  2. High-volume queries     — one model invoked an unusually high number of
 *                               times (possible scraping / abuse / DoS).
 *  3. Possible distillation   — many calls to a frontier model whose outputs are
 *                               captured, consistent with harvesting a stronger
 *                               model's responses.
 *  4. Missing credentials     — model calls lacking identity/credential
 *                               metadata, i.e. unauthorized-access blind spots.
 *
 * Output reuses the existing {@link SecuritySignal} type so signals render in
 * the report's security section with no view changes.
 */

import type { Trace, SecuritySignal, ModelHandoff } from "@/lib/oathlock";
import { getModelTier, tierLabel } from "@/lib/cost-model";

/** Tunable thresholds — kept in one place so they are easy to calibrate. */
export const MTM_THRESHOLDS = {
  /** Calls to a single model above this look like high-volume querying. */
  highVolumePerModel: 8,
  /** Frontier-model calls above this, with captured outputs, hint distillation. */
  distillationFrontierCalls: 6,
} as const;

let signalSeq = 0;
function signalId(): string {
  signalSeq += 1;
  return `mtm_${Date.now().toString(36)}_${signalSeq}`;
}

/** Steps that involve a model call (explicit model id or actor === "model"). */
function modelSteps(trace: Trace) {
  return trace.steps.filter((s) => (s.model && s.model.trim()) || s.actor === "model");
}

/**
 * 1. Model escalation — a handoff that jumps to a strictly stronger tier.
 *
 * Uses the cost-model tier ranks (1 light → 3 frontier). A weak→strong jump is
 * the signal builders care about ("why did a trivial step escalate to Opus?").
 * Strong→weak is normal (planner→executor) and is NOT flagged here.
 */
function detectEscalations(handoffs: ModelHandoff[]): SecuritySignal[] {
  const signals: SecuritySignal[] = [];
  for (const h of handoffs) {
    const from = getModelTier(h.fromModel);
    const to = getModelTier(h.toModel);
    if (from == null || to == null || to <= from) continue;

    // A jump of two tiers (light → frontier) is more notable than one.
    const severity: SecuritySignal["severity"] = to - from >= 2 ? "high" : "medium";
    signals.push({
      id: signalId(),
      kind: "unusual_model_switch",
      title: "Model escalation to a stronger model",
      description:
        `Step ${h.fromStep} used ${h.fromModel} (${tierLabel(from)}) but step ${h.toStep} ` +
        `escalated to ${h.toModel} (${tierLabel(to)}). Sudden escalation can mean an ` +
        `expensive model is doing work a cheaper one already handled, or an ` +
        `unintended privilege/cost increase.`,
      evidenceLevel: "Observed",
      affectedSteps: [h.fromStep, h.toStep],
      evidence: [`${h.fromModel} (${tierLabel(from)}) → ${h.toModel} (${tierLabel(to)})`],
      recommendedAction:
        "Confirm the escalation is intended. Pin a primary model and escalate only on explicit, logged criteria.",
      severity,
      heuristic: true,
    });
  }
  return signals;
}

/** 2 & 3. Per-model call volume → high-volume and distillation signals. */
function detectVolumeSignals(trace: Trace): SecuritySignal[] {
  const signals: SecuritySignal[] = [];
  const steps = modelSteps(trace);

  // Count invocations per model id.
  const callsByModel = new Map<string, number[]>(); // model -> step numbers
  for (const s of steps) {
    const model = s.model?.trim();
    if (!model) continue;
    const list = callsByModel.get(model) ?? [];
    list.push(s.step);
    callsByModel.set(model, list);
  }

  for (const [model, stepNums] of callsByModel) {
    const count = stepNums.length;

    // 2. High-volume querying of one model.
    if (count >= MTM_THRESHOLDS.highVolumePerModel) {
      signals.push({
        id: signalId(),
        kind: "high_volume_queries",
        title: "High-volume queries to a single model",
        description:
          `${model} was invoked ${count} times in one run. Unusually high call ` +
          `volume can indicate scraping, runaway loops, or abuse of a model endpoint.`,
        evidenceLevel: "Observed",
        affectedSteps: stepNums,
        evidence: [`${count} calls to ${model} (steps ${stepNums.slice(0, 12).join(", ")}${count > 12 ? "…" : ""})`],
        recommendedAction: "Rate-limit per-model calls and alert on volume spikes per session.",
        severity: count >= MTM_THRESHOLDS.highVolumePerModel * 2 ? "high" : "medium",
        heuristic: true,
      });
    }

    // 3. Possible distillation — many frontier-model calls whose outputs are
    // captured in the trace (outputs being recorded is what makes harvesting
    // plausible). Conservative: requires frontier tier + captured outputs.
    if (getModelTier(model) === 3 && count >= MTM_THRESHOLDS.distillationFrontierCalls) {
      const withOutputs = stepNums.filter((n) => {
        const step = trace.steps.find((s) => s.step === n);
        return !!step?.toolOutputSummary;
      });
      if (withOutputs.length >= MTM_THRESHOLDS.distillationFrontierCalls) {
        signals.push({
          id: signalId(),
          kind: "possible_distillation",
          title: "Possible model distillation pattern",
          description:
            `${withOutputs.length} calls to the frontier model ${model} captured outputs in ` +
            `this run. Repeatedly harvesting a stronger model's responses is consistent with ` +
            `distillation (training a cheaper model on a stronger one's outputs).`,
          evidenceLevel: "Correlated",
          affectedSteps: withOutputs,
          evidence: [`${withOutputs.length} frontier-model responses captured for ${model}`],
          recommendedAction:
            "Review whether bulk harvesting of model outputs is authorized; apply output-volume controls.",
          severity: "medium",
          heuristic: true,
        });
      }
    }
  }
  return signals;
}

/**
 * 4. Missing credentials on model calls — an unauthorized-access blind spot.
 *
 * We look for explicit credential/identity gaps the trace already flagged
 * (missing_metadata mentioning "credential" / "identity" / "auth"). This is an
 * auditability signal, not an accusation.
 */
function detectMissingCredentials(trace: Trace): SecuritySignal[] {
  const credRe = /credential|identity|auth|api[_-]?key/i;
  const affected = modelSteps(trace)
    .filter((s) => (s.missingMetadata ?? []).some((m) => credRe.test(m)))
    .map((s) => s.step);

  if (affected.length === 0) return [];

  return [
    {
      id: signalId(),
      kind: "missing_credentials",
      title: "Model calls missing credential metadata",
      description:
        `${affected.length} model-involved step(s) record no credential/identity metadata. ` +
        `Without it, unauthorized or impersonated model access cannot be ruled out.`,
      evidenceLevel: "Observed",
      affectedSteps: affected,
      evidence: [`Steps missing credential metadata: ${affected.join(", ")}`],
      recommendedAction:
        "Attach an authenticated caller identity to every model call and reject unauthenticated calls.",
      severity: "medium",
      heuristic: false,
    },
  ];
}

/**
 * Produce all MTM security signals for a trace. `handoffs` is passed in so we
 * reuse the report's already-computed model transitions (no recomputation).
 *
 * `modelMetadataReliable` gates model-call-volume and escalation/distillation
 * signals: for markdown/raw exports, model names are scraped from free text and
 * are NOT real model-call records, so high-volume/distillation must not fire.
 * Handoffs are already empty for those inputs (see detectModelHandoffs), which
 * disables escalation; we additionally skip per-model volume counting here.
 */
export function detectMtmSignals(
  trace: Trace,
  handoffs: ModelHandoff[],
  modelMetadataReliable = true,
): SecuritySignal[] {
  if (!modelMetadataReliable) {
    // Credential gaps still rely on explicit per-step missingMetadata, not text
    // mentions, so they remain valid.
    return [...detectMissingCredentials(trace)];
  }
  return [
    ...detectEscalations(handoffs),
    ...detectVolumeSignals(trace),
    ...detectMissingCredentials(trace),
  ];
}
