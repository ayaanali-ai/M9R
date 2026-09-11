// Coding-Agent Waste Detectors — turn a NormalizedManualTrace into qualitative,
// evidence-backed findings about common AI coding-agent waste patterns.
//
// CLAIM DISCIPLINE: These detectors read structured manual evidence only. They
// do NOT measure tokens, cost, latency, energy, or heat, and they invent no
// numbers. Findings are qualitative unless real measured trace data exists.
// Output is explicitly "detector findings from manual normalized evidence."

import type {
  NormalizedManualTrace,
  QualitativeLabel,
} from "@/lib/manual-trace-normalizer";

export type CodingAgentFinding = {
  id: string;
  type:
    | "redundant_file_read"
    | "build_fix_loop"
    | "ambiguous_edit_retry"
    | "scope_creep"
    | "claims_drift"
    | "duplicate_copy"
    | "bloated_tool_output"
    | "model_overkill"
    | "missing_usage_metadata"
    | "retry_spiral"
    | "repeated_tool_call";
  title: string;
  severity: "low" | "medium" | "high";
  summary: string;
  evidence: string[];
  affectedFields: string[];
  preventionPlan: string[];
  confidence: "low" | "medium" | "high";
};

// Map a qualitative risk label to a finding severity. "none"/"unknown" yield no
// severity (no finding fires from the label alone).
function severityFromLabel(label: QualitativeLabel): CodingAgentFinding["severity"] | null {
  switch (label) {
    case "high":
      return "high";
    case "moderate":
      return "medium";
    case "low":
      return "low";
    default:
      return null; // none | unknown
  }
}

function bump(
  s: CodingAgentFinding["severity"],
): CodingAgentFinding["severity"] {
  return s === "low" ? "medium" : "high";
}

function hasPattern(trace: NormalizedManualTrace, needle: string): boolean {
  return trace.suspected_waste_patterns.some((p) =>
    p.toLowerCase().includes(needle.toLowerCase()),
  );
}

function linesMatching(items: string[], re: RegExp): string[] {
  return items.filter((l) => re.test(l));
}

// 1. Redundant File Read Detector
function detectRedundantFileRead(
  trace: NormalizedManualTrace,
): CodingAgentFinding | null {
  const labelSeverity = severityFromLabel(trace.repeated_context_risks);
  const patternHit =
    hasPattern(trace, "Repeated context") || hasPattern(trace, "Redundant edits");
  const evidenceLines = linesMatching(
    [...trace.limitations, ...trace.known_errors],
    /re-?read|modified since read|repeated (file|context)|inspect/i,
  );

  if (!labelSeverity && !patternHit && evidenceLines.length === 0) return null;

  const severity = labelSeverity ?? (patternHit ? "medium" : "low");
  const evidence: string[] = [];
  if (trace.repeated_context_risks !== "none" && trace.repeated_context_risks !== "unknown") {
    evidence.push(`repeated_context_risks = ${trace.repeated_context_risks}`);
  }
  if (patternHit) evidence.push("suspected_waste_patterns mentions repeated/redundant reads");
  evidence.push(...evidenceLines);

  return {
    id: "ca-redundant-file-read",
    type: "redundant_file_read",
    title: "Redundant file reads",
    severity,
    summary:
      "The run shows signs of re-reading or re-inspecting files (including 'modified since read' churn) rather than reading once and editing decisively.",
    evidence,
    affectedFields: ["repeated_context_risks", "suspected_waste_patterns", "limitations"],
    preventionPlan: [
      "Read each file once in a tight window, then edit before anything else can touch it.",
      "Avoid broad re-reads; target only the lines you intend to change.",
      "When tools/linters edit files mid-task, re-read the minimal region, not the whole file.",
    ],
    confidence: labelSeverity ? "medium" : "low",
  };
}

// 2. Build-Fix Loop Detector
function detectBuildFixLoop(
  trace: NormalizedManualTrace,
): CodingAgentFinding | null {
  const buildFailed = trace.build_result === "fail";
  const lintFailed = trace.lint_result === "fail";
  const patternHit = hasPattern(trace, "Build/lint fix loops");
  const correction = severityFromLabel(trace.correction_loops);
  const errorEvidence = linesMatching(
    trace.known_errors,
    /error|failed|build|lint|type ?error|syntax/i,
  );

  if (!buildFailed && !lintFailed && !patternHit && !correction && errorEvidence.length === 0)
    return null;

  let severity: CodingAgentFinding["severity"] = correction ?? "low";
  if (buildFailed || lintFailed) severity = bump(severity);

  const evidence: string[] = [];
  if (buildFailed) evidence.push("build_result = fail");
  if (lintFailed) evidence.push("lint_result = fail");
  if (trace.correction_loops !== "none" && trace.correction_loops !== "unknown") {
    evidence.push(`correction_loops = ${trace.correction_loops}`);
  }
  if (patternHit) evidence.push("suspected_waste_patterns mentions build/lint fix loops");
  evidence.push(...errorEvidence.slice(0, 5));

  return {
    id: "ca-build-fix-loop",
    type: "build_fix_loop",
    title: "Build/lint fix loop",
    severity,
    summary:
      "Repeated build/lint failures or correction loops suggest edits were made without verifying they compile/lint, causing rework.",
    evidence,
    affectedFields: ["build_result", "lint_result", "correction_loops", "known_errors"],
    preventionPlan: [
      "Build/lint after each major section rather than only at the end.",
      "Fix the root cause of a failure before making further edits.",
      "Cap correction attempts; stop and re-plan if the same error recurs.",
    ],
    confidence: buildFailed || lintFailed ? "high" : "medium",
  };
}

// 3. Ambiguous Edit Retry Detector
function detectAmbiguousEditRetry(
  trace: NormalizedManualTrace,
): CodingAgentFinding | null {
  const labelSeverity = severityFromLabel(trace.redundant_edit_risks);
  const patternHit = hasPattern(trace, "Redundant edits");
  const evidenceLines = linesMatching(
    [...trace.limitations, ...trace.known_errors],
    /ambiguous|non-?unique|anchor|re-?anchor|multiple matches|patch (failed|retry)|retry/i,
  );

  if (!labelSeverity && !patternHit && evidenceLines.length === 0) return null;

  return {
    id: "ca-ambiguous-edit-retry",
    type: "ambiguous_edit_retry",
    title: "Ambiguous edit retries",
    severity: labelSeverity ?? "low",
    summary:
      "Edits appear to have failed or been retried due to non-unique anchors or ambiguous matches, requiring re-anchoring.",
    evidence: [
      ...(labelSeverity ? [`redundant_edit_risks = ${trace.redundant_edit_risks}`] : []),
      ...(patternHit ? ["suspected_waste_patterns mentions redundant edits"] : []),
      ...evidenceLines,
    ],
    affectedFields: ["redundant_edit_risks", "suspected_waste_patterns", "known_errors"],
    preventionPlan: [
      "Anchor edits on a unique surrounding context, not a string that repeats.",
      "Prefer reading the exact region first, then replacing a uniquely-identified block.",
      "When a match is ambiguous, add more context instead of retrying the same anchor.",
    ],
    confidence: labelSeverity ? "medium" : "low",
  };
}

// 4. Broad Rewrite / Scope Creep Detector
function detectScopeCreep(
  trace: NormalizedManualTrace,
): CodingAgentFinding | null {
  const fileCount = trace.files_changed.length;
  const patternHit =
    hasPattern(trace, "Redundant edits") || hasPattern(trace, "rewrite");
  const sweepEvidence = linesMatching(
    [...trace.limitations, ...trace.commands_run],
    /\bsed\b|broad (sweep|rewrite)|many files|unrelated/i,
  );

  // Threshold is directional, not a measurement: many files touched is a scope
  // signal, not proof of waste.
  const manyFiles = fileCount >= 8;
  if (!manyFiles && !patternHit && sweepEvidence.length === 0) return null;

  const severity: CodingAgentFinding["severity"] =
    fileCount >= 14 ? "high" : fileCount >= 8 ? "medium" : "low";

  return {
    id: "ca-scope-creep",
    type: "scope_creep",
    title: "Broad rewrite / scope creep",
    severity,
    summary:
      "A large or broad set of files was touched (or a sweep was used), which risks changes beyond the requested scope.",
    evidence: [
      `files_changed count = ${fileCount}`,
      ...(patternHit ? ["suspected_waste_patterns mentions rewrites/redundant edits"] : []),
      ...sweepEvidence,
    ],
    affectedFields: ["files_changed", "commands_run", "suspected_waste_patterns"],
    preventionPlan: [
      "Scope each change to the minimum files required by the request.",
      "Replace broad sweeps (e.g. sed across many files) with targeted edits where feasible.",
      "If a wide change is necessary, state why and confirm it is in scope.",
    ],
    confidence: manyFiles ? "medium" : "low",
  };
}

// 5. Claims Drift Detector
function detectClaimsDrift(
  trace: NormalizedManualTrace,
): CodingAgentFinding | null {
  const labelSeverity = severityFromLabel(trace.claims_risks);
  const haystack = [
    trace.objective,
    ...trace.suspected_waste_patterns,
    ...trace.limitations,
  ].join(" \n ");
  const driftEvidence = linesMatching(
    haystack.split("\n"),
    /guaranteed|production-proven|exact (energy|heat|mass)|customer savings|orbital|mars|converts heat|solves/i,
  );

  if (!labelSeverity && driftEvidence.length === 0) return null;

  return {
    id: "ca-claims-drift",
    type: "claims_drift",
    title: "Claims drift risk",
    severity: labelSeverity ?? "medium",
    summary:
      "Wording in the run risks overclaiming (e.g. guaranteed savings; exact energy/heat/mass; customer or production validation; orbital/space claims).",
    evidence: [
      ...(labelSeverity ? [`claims_risks = ${trace.claims_risks}`] : []),
      ...driftEvidence.map((l) => l.trim()).filter(Boolean),
    ],
    affectedFields: ["claims_risks", "objective", "limitations"],
    preventionPlan: [
      "Downgrade absolute claims to 'detected', 'estimated', or 'modeled'.",
      "Keep energy/heat/burden labeled as configurable estimates with the required caveat.",
      "Never assert customer savings, production validation, or exact physical figures.",
    ],
    confidence: labelSeverity ? "high" : "medium",
  };
}

// 6. Duplicate Copy / Repeated Caveat Detector
function detectDuplicateCopy(
  trace: NormalizedManualTrace,
): CodingAgentFinding | null {
  const evidence = linesMatching(
    [...trace.limitations, ...trace.known_errors],
    /caveat|duplicate|centraliz|repeated (copy|inline)|inline cop|fixture/i,
  );
  // Also flag if the same file path appears to host repeated copy concerns via
  // notes; keep simple and qualitative.
  if (evidence.length === 0) return null;

  return {
    id: "ca-duplicate-copy",
    type: "duplicate_copy",
    title: "Duplicate copy / repeated caveat",
    severity: "low",
    summary:
      "Evidence suggests repeated inline copies of caveats, claims text, sample numbers, or fixtures that should be centralized into one source.",
    evidence,
    affectedFields: ["limitations", "known_errors"],
    preventionPlan: [
      "Centralize the caveat/claims text into one exported constant and import it.",
      "Hold sample numbers in a single fixture module; derive dependent values.",
      "Avoid pasting the same block into multiple pages/components.",
    ],
    confidence: "low",
  };
}

// Shared text surface for the text-evidence detectors below. Reads only the
// structured manual fields; invents nothing.
function textLines(trace: NormalizedManualTrace): string[] {
  return [
    trace.objective,
    ...trace.suspected_waste_patterns,
    ...trace.limitations,
    ...trace.known_errors,
    ...trace.commands_run,
  ].filter((l): l is string => typeof l === "string" && l.length > 0);
}

// 7. Bloated Tool Output Detector
function detectBloatedToolOutput(
  trace: NormalizedManualTrace,
): CodingAgentFinding | null {
  const evidence = linesMatching(
    textLines(trace),
    /full output|entire log|large output|truncated|thousands of lines|dumped output|full build log|repeated stack trace|huge (output|log)|pasted (the )?(whole|entire)/i,
  );
  if (evidence.length === 0) return null;

  return {
    id: "ca-bloated-tool-output",
    type: "bloated_tool_output",
    title: "Bloated tool output",
    severity: evidence.length >= 2 ? "medium" : "low",
    summary:
      "Oversized tool/terminal output (full logs, repeated stack traces, dumped output) appears to have been carried into the run, which can bloat context. Only the relevant error block should be passed forward.",
    evidence,
    affectedFields: ["limitations", "known_errors", "commands_run"],
    preventionPlan: [
      "Pass only the relevant error block forward, not the full log.",
      "Filter, paginate, or summarize large tool output before feeding it to the model.",
      "Exact token waste is unknown unless explicit measured usage exists — do not estimate it.",
    ],
    confidence: "low",
  };
}

// 8. Model Overkill Detector (only when text explicitly implies a mismatch)
function detectModelOverkill(
  trace: NormalizedManualTrace,
): CodingAgentFinding | null {
  const evidence = linesMatching(
    textLines(trace),
    /(opus|strongest|premium|expensive|most capable|largest) model.*(format|lint|trivial|simple|mechanical|rename|typo)|used (opus|the strongest|a premium|an expensive).*(for|to).*(format|lint|simple|trivial|rename)|(format|lint fix|trivial change|simple edit).*(opus|strongest|premium|expensive) model/i,
  );
  if (evidence.length === 0) return null;

  return {
    id: "ca-model-overkill",
    type: "model_overkill",
    title: "Model overkill",
    severity: "low",
    summary:
      "Text suggests a strong/expensive model was used for a simple mechanical step (e.g. formatting or a lint fix). Model choice may be excessive for the task.",
    evidence,
    affectedFields: ["objective", "limitations", "suspected_waste_patterns"],
    preventionPlan: [
      "Route simple mechanical tasks (formatting, lint fixes, renames) to cheaper models.",
      "Reserve the strongest model for genuinely hard steps.",
      "Do not estimate savings — model-tier impact is not measured here.",
    ],
    confidence: "low",
  };
}

// 9. Missing Usage Metadata Detector
function detectMissingUsageMetadata(
  trace: NormalizedManualTrace,
): CodingAgentFinding | null {
  const noExactUsage =
    trace.exact_model_calls === null &&
    trace.exact_token_count === null &&
    trace.exact_cost_usd === null;
  const textEvidence = linesMatching(
    textLines(trace),
    /usage unknown|no token metadata|cost unknown|tokens not (provided|reported)|no usage metadata|usage not (provided|reported)/i,
  );

  if (!noExactUsage && textEvidence.length === 0) return null;

  const evidence: string[] = [];
  if (noExactUsage) {
    evidence.push("exact_model_calls = null", "exact_token_count = null", "exact_cost_usd = null");
  }
  evidence.push(...textEvidence);

  return {
    id: "ca-missing-usage-metadata",
    type: "missing_usage_metadata",
    title: "Missing usage metadata",
    severity: "medium",
    summary:
      "The trace has no explicit token/cost/model-call metadata, so cost and token reporting cannot be trusted. Unknown must stay unknown.",
    evidence,
    affectedFields: ["exact_model_calls", "exact_token_count", "exact_cost_usd"],
    preventionPlan: [
      "Require provider usage metadata or a strict runleak.recorded.v0 JSON.",
      "Leave cost and tokens null when usage is absent — never estimate them.",
      "Do not summarize cost unless explicit per-call usage exists.",
    ],
    confidence: noExactUsage ? "medium" : "low",
  };
}

// 10. Retry Spiral Detector (repeated attempts without diagnosis; distinct from
// build_fix_loop when retries are not specifically build/lint related)
function detectRetrySpiral(
  trace: NormalizedManualTrace,
): CodingAgentFinding | null {
  const correction = severityFromLabel(trace.correction_loops);
  const evidence = linesMatching(
    textLines(trace),
    /try again|retried?|failed again|same error|another attempt|after (several|multiple) attempts|kept (failing|retrying)|over and over/i,
  );
  // Require explicit retry language; correction_loops alone strengthens severity.
  if (evidence.length === 0) return null;

  const severity: CodingAgentFinding["severity"] =
    correction === "high" || evidence.length >= 3 ? "high" : correction ? "medium" : "low";

  return {
    id: "ca-retry-spiral",
    type: "retry_spiral",
    title: "Retry spiral",
    severity,
    summary:
      "Repeated attempts appear to have been made without isolating the root cause. Retrying without diagnosis wastes calls and time.",
    evidence: [
      ...(correction && trace.correction_loops !== "none"
        ? [`correction_loops = ${trace.correction_loops}`]
        : []),
      ...evidence,
    ],
    affectedFields: ["correction_loops", "known_errors", "limitations"],
    preventionPlan: [
      "After two failed attempts, switch to diagnostic mode before retrying.",
      "Isolate the root cause (smallest failing case) instead of repeating the same action.",
      "Cap retries; re-plan when the same error recurs.",
    ],
    confidence: correction ? "medium" : "low",
  };
}

// 11. Repeated Tool Call Detector (same command/read/search repeated with no new input)
function detectRepeatedToolCall(
  trace: NormalizedManualTrace,
): CodingAgentFinding | null {
  // Exact duplicate commands are a strong, deterministic signal.
  const seen = new Map<string, number>();
  for (const c of trace.commands_run) {
    const key = c.trim().toLowerCase();
    if (!key) continue;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const dupCommands = [...seen.entries()].filter(([, n]) => n > 1);

  const textEvidence = linesMatching(
    textLines(trace),
    /repeated (the )?(same )?(command|read|search|grep|list|tool call|web|lookup)|read .* again|same (grep|search|command) (again|repeatedly)|re-?ran the same/i,
  );

  if (dupCommands.length === 0 && textEvidence.length === 0) return null;

  const evidence: string[] = [
    ...dupCommands.map(([cmd, n]) => `command repeated ${n}x: ${cmd}`),
    ...textEvidence,
  ];

  return {
    id: "ca-repeated-tool-call",
    type: "repeated_tool_call",
    title: "Repeated tool call",
    severity: dupCommands.some(([, n]) => n >= 3) ? "medium" : "low",
    summary:
      "The same command/read/search appears to have been run more than once with unchanged input. Repeated tool calls should be cached or deduped.",
    evidence,
    affectedFields: ["commands_run", "limitations"],
    preventionPlan: [
      "Cache or reuse results when a tool's input is unchanged.",
      "Dedupe repeated reads/searches; only re-run when inputs actually change.",
      "Exact token/cost impact requires measured metadata — do not estimate it.",
    ],
    confidence: dupCommands.length > 0 ? "medium" : "low",
  };
}

const DETECTORS = [
  detectRedundantFileRead,
  detectBuildFixLoop,
  detectAmbiguousEditRetry,
  detectScopeCreep,
  detectClaimsDrift,
  detectDuplicateCopy,
  detectBloatedToolOutput,
  detectModelOverkill,
  detectMissingUsageMetadata,
  detectRetrySpiral,
  detectRepeatedToolCall,
];

export function detectCodingAgentWaste(
  trace: NormalizedManualTrace,
): CodingAgentFinding[] {
  return DETECTORS.map((d) => d(trace)).filter(
    (f): f is CodingAgentFinding => f !== null,
  );
}
