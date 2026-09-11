// Prevention Rules v0 — a small, DETERMINISTIC registry that maps existing
// RunLeak waste findings to concrete, reusable prevention rules.
//
// RunLeak should not only detect waste; it should output
//   Leak → Cause → Fix → Prevention Rule
// for each finding type, deterministically.
//
// STRICT RULES: This is NOT an AI/LLM recommendation system, NOT a policy engine,
// NOT CI gating, NOT hosted tracing. It makes no provider calls, invents no
// evidence, estimates no cost from tokens, and never treats energy/heat as
// measured. Rules are a fixed lookup keyed by finding type. Unknown stays unknown.

export type PreventionRule = {
  id: string;
  title: string;
  leakType: string;
  severity: "low" | "medium" | "high";
  cause: string;
  fixNow: string;
  promptFix: string;
  policyRule: string;
  evidenceNeeded: string[];
  limitations: string[];
};

// The canonical leak types this registry covers. Some are emitted by current
// detectors; others are kept available but only ever returned when a matching
// finding type is present (no finding ⇒ no rule).
export const PREVENTION_RULES: Record<string, PreventionRule> = {
  repeated_context: {
    id: "repeated_context",
    title: "Repeated context",
    leakType: "repeated_context",
    severity: "high",
    cause:
      "The same unchanged context block is resent across multiple model calls instead of being cached or referenced.",
    fixNow: "Replace repeated blocks with a cached summary or reference ID.",
    promptFix:
      "Before resending prior context, check whether the same block was already provided.",
    policyRule: "Block sending the same unchanged context block more than twice per run.",
    evidenceNeeded: [
      "Repeated/near-identical context block across steps",
      "Occurrence count and first-occurrence step",
    ],
    limitations: [
      "Qualitative unless the normalized trace carries explicit per-call token fields.",
      "No cost is implied; cost stays null unless explicit costUsd is present.",
    ],
  },
  redundant_file_read: {
    id: "redundant_file_read",
    title: "Redundant file read",
    leakType: "redundant_file_read",
    severity: "medium",
    cause:
      "The same file is re-read without an intervening edit, re-loading context that was already available.",
    fixNow: "Reuse the already-read file contents instead of re-reading the same file.",
    promptFix:
      "Before reading a file, check whether it was already read and not modified since.",
    policyRule:
      "Warn when a file is read more than once with no edit between reads in the same run.",
    evidenceNeeded: [
      "Repeated read of the same path",
      "No edit recorded between the reads",
    ],
    limitations: [
      "Detected from structured evidence only; not every redundant read is observable.",
      "No measured token/cost impact is claimed.",
    ],
  },
  build_fix_loop: {
    id: "build_fix_loop",
    title: "Build-fix loop",
    leakType: "build_fix_loop",
    severity: "high",
    cause:
      "Repeated broad edits and rebuilds without isolating the first failing file or root error.",
    fixNow: "Stop broad edits and isolate the first failing file/error.",
    promptFix: "After two failed builds, enter diagnostic mode before another edit.",
    policyRule:
      "After two failed build attempts, ban unrelated file edits until the root error is identified.",
    evidenceNeeded: [
      "Two or more failed build attempts",
      "Edits across unrelated files between builds",
    ],
    limitations: [
      "Loop count is read from structured evidence; latency/cost of the loop is not measured.",
    ],
  },
  ambiguous_edit_retry: {
    id: "ambiguous_edit_retry",
    title: "Ambiguous edit retry",
    leakType: "ambiguous_edit_retry",
    severity: "medium",
    cause:
      "An under-specified edit is retried multiple times because the target or intent was ambiguous.",
    fixNow: "Pin the exact target (file, symbol, line range) before retrying the edit.",
    promptFix:
      "If an edit fails to apply cleanly, restate the exact anchor text before retrying.",
    policyRule:
      "After a failed ambiguous edit, require an explicit unique anchor before the next attempt.",
    evidenceNeeded: [
      "Repeated edit attempts on the same target",
      "Evidence of ambiguous/missing anchor",
    ],
    limitations: [
      "Qualitative; the registry does not measure retry cost or latency.",
    ],
  },
  scope_creep: {
    id: "scope_creep",
    title: "Scope creep",
    leakType: "scope_creep",
    severity: "medium",
    cause:
      "The run expands beyond its stated objective, touching files or features outside the task.",
    fixNow: "Revert out-of-scope changes and keep the run focused on the stated objective.",
    promptFix:
      "Before editing a file, confirm it is required by the stated objective; otherwise defer it.",
    policyRule:
      "Flag edits to files unrelated to the declared objective for review before merge.",
    evidenceNeeded: [
      "Stated objective",
      "Files changed that fall outside that objective",
    ],
    limitations: [
      "Scope is inferred from declared objective vs files changed; not a semantic guarantee.",
    ],
  },
  claims_drift: {
    id: "claims_drift",
    title: "Claims drift",
    leakType: "claims_drift",
    severity: "high",
    cause:
      "Public copy or report text asserts claims that exceed what the measured/normalized fields support.",
    fixNow: "Remove or qualify unsupported public claims.",
    promptFix:
      "Only make claims supported by trace evidence or marked as future roadmap.",
    policyRule:
      "Block report/public-copy generation if claims exceed measured fields.",
    evidenceNeeded: [
      "Claim text in notes/summaries/copy",
      "Absence of measured fields supporting the claim",
    ],
    limitations: [
      "Heuristic over text; it flags risk, it does not verify factual accuracy.",
    ],
  },
  duplicate_copy: {
    id: "duplicate_copy",
    title: "Duplicate copy",
    leakType: "duplicate_copy",
    severity: "low",
    cause:
      "The same text/content is duplicated across files instead of being centralized in one source.",
    fixNow: "Centralize the duplicated content into one exported source and import it.",
    promptFix:
      "Before adding repeated copy, check whether a shared constant/component already exists.",
    policyRule:
      "Warn when identical copy blocks appear in more than one file in the same run.",
    evidenceNeeded: [
      "Identical/near-identical copy across multiple files",
    ],
    limitations: [
      "Detected from structured evidence; not a full cross-repo duplication scan.",
    ],
  },
  bloated_tool_output: {
    id: "bloated_tool_output",
    title: "Bloated tool output",
    leakType: "bloated_tool_output",
    severity: "medium",
    cause:
      "A tool returns a large unfiltered payload that is fed back into the model when only a slice is needed.",
    fixNow: "Filter, paginate, or summarize tool output before passing it to the model.",
    promptFix:
      "Request only the fields/range you need from a tool; avoid dumping full payloads.",
    policyRule:
      "Warn when tool output above a size threshold is passed back into a prompt unfiltered.",
    evidenceNeeded: [
      "Large tool-output payload",
      "Evidence it was passed back into a model call",
    ],
    limitations: [
      "Size is qualitative unless explicit token fields are present; no cost is implied.",
    ],
  },
  model_overkill: {
    id: "model_overkill",
    title: "Model overkill",
    leakType: "model_overkill",
    severity: "low",
    cause:
      "A high-capability model is used for a trivial step that a smaller/cheaper model could handle.",
    fixNow: "Route trivial steps to a smaller model; reserve the large model for hard steps.",
    promptFix:
      "Pick the model tier from task difficulty; default to the smallest sufficient model.",
    policyRule:
      "Flag large-model calls on steps classified as trivial for model-tier review.",
    evidenceNeeded: [
      "Model id per call",
      "Step difficulty signal indicating a trivial task",
    ],
    limitations: [
      "Difficulty is qualitative; no cost difference is claimed without explicit costUsd.",
    ],
  },
  missing_usage_metadata: {
    id: "missing_usage_metadata",
    title: "Missing usage metadata",
    leakType: "missing_usage_metadata",
    severity: "medium",
    cause:
      "Model calls lack explicit usage metadata, so exact tokens and cost cannot be reported.",
    fixNow: "Require provider usage metadata or mark cost/tokens unknown.",
    promptFix: "Do not summarize cost unless usage fields are present.",
    policyRule:
      "Fail cost reports when exact_token_count and exact_cost_usd are both null.",
    evidenceNeeded: [
      "Model calls with null token fields",
      "Null exact_cost_usd in the normalized trace",
    ],
    limitations: [
      "This rule enforces honesty about unknowns; it never estimates the missing values.",
    ],
  },
  retry_spiral: {
    id: "retry_spiral",
    title: "Retry spiral",
    leakType: "retry_spiral",
    severity: "high",
    cause:
      "The same action is retried repeatedly without isolating the root cause, wasting calls and time.",
    fixNow: "Stop retrying and isolate the smallest failing case before the next attempt.",
    promptFix:
      "After two failed attempts, switch to diagnostic mode instead of retrying the same action.",
    policyRule:
      "After two failed attempts at the same action, require a diagnosis step before another retry.",
    evidenceNeeded: [
      "Repeated retry/attempt language across the run",
      "Multiple correction loops or repeated failures",
    ],
    limitations: [
      "Qualitative; the registry does not measure retry cost or latency.",
    ],
  },
  repeated_tool_call: {
    id: "repeated_tool_call",
    title: "Repeated tool call",
    leakType: "repeated_tool_call",
    severity: "low",
    cause:
      "The same command/read/search is invoked more than once with unchanged input.",
    fixNow: "Reuse the prior result instead of re-running the same tool call.",
    promptFix:
      "Before invoking a tool, check whether the same call with the same input already ran.",
    policyRule:
      "Warn when an identical tool call (same command/input) repeats in the same run.",
    evidenceNeeded: [
      "Identical commands repeated in commands_run",
      "Repeated same read/search/grep with no new input",
    ],
    limitations: [
      "Detected from structured evidence; exact token/cost impact requires measured metadata.",
    ],
  },
};

// Aliases: detector/finding type strings (current and likely) → canonical rule id.
// Only confident, non-inventive mappings are included.
const TYPE_ALIASES: Record<string, string> = {
  repeated_context: "repeated_context",
  redundant_file_read: "redundant_file_read",
  build_fix_loop: "build_fix_loop",
  retry_loop: "build_fix_loop",
  ambiguous_edit_retry: "ambiguous_edit_retry",
  scope_creep: "scope_creep",
  claims_drift: "claims_drift",
  duplicate_copy: "duplicate_copy",
  tool_output_bloat: "bloated_tool_output",
  bloated_tool_output: "bloated_tool_output",
  model_overkill: "model_overkill",
  missing_usage_metadata: "missing_usage_metadata",
  retry_spiral: "retry_spiral",
  repeated_tool_call: "repeated_tool_call",
  duplicate_tool_call: "repeated_tool_call",
};

function canonicalId(raw?: string): string | undefined {
  if (!raw) return undefined;
  const key = raw.trim().toLowerCase();
  return TYPE_ALIASES[key];
}

// Deterministic mapping: each input finding's `type` (or `detector`) is resolved
// to a canonical rule via the alias table, then looked up in the registry.
// De-duplicated by rule id, returned in registry order for stable output.
// No LLM, no invented evidence. If nothing matches, returns an empty list.
export function getPreventionRulesForFindings(input: {
  findings: Array<{
    type?: string;
    detector?: string;
    title?: string;
    severity?: string;
    evidence?: unknown;
  }>;
}): PreventionRule[] {
  const matched = new Set<string>();
  for (const f of input.findings ?? []) {
    const id = canonicalId(f.type) ?? canonicalId(f.detector);
    if (id && PREVENTION_RULES[id]) matched.add(id);
  }
  // Return in the registry's declared order for stability.
  return Object.keys(PREVENTION_RULES)
    .filter((id) => matched.has(id))
    .map((id) => PREVENTION_RULES[id]);
}
