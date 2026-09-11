// Manual Trace Normalizer — deterministic structuring of messy AI-agent run
// summaries into a RunLeak normalized trace artifact.
//
// CLAIM DISCIPLINE: This module DOES NOT measure tokens, cost, latency, energy,
// or heat. It only structures pasted evidence. Exact numeric fields are always
// null unless a real measured value is supplied by the caller. No external model
// is called; parsing is regex/heuristic only. See docs/claims.md.

export type QualitativeLabel = "none" | "low" | "moderate" | "high" | "unknown";

export type NormalizedManualTrace = {
  run_name: string;
  objective: string;
  files_changed: string[];
  components_created: string[];
  pages_updated: string[];
  commands_run: string[];
  lint_result: "pass" | "fail" | null;
  build_result: "pass" | "fail" | null;
  known_errors: string[];
  correction_loops: QualitativeLabel;
  suspected_waste_patterns: string[];
  repeated_context_risks: QualitativeLabel;
  redundant_edit_risks: QualitativeLabel;
  claims_risks: QualitativeLabel;
  quality_checks: {
    build_passes: boolean | null;
    lint_passes: boolean | null;
  };
  limitations: string[];
  exact_token_count: number | null;
  exact_model_calls: number | null;
  exact_cost_usd: number | null;
  exact_energy_wh: number | null;
  // Provenance marker so downstream consumers never mistake this for a measured
  // trace.
  trace_kind: "normalized_manual";
};

export type ManualTraceInput = {
  runName: string;
  objective: string;
  rawSummary: string;
  commandsRun?: string;
  filesChanged?: string;
  buildOutput?: string;
  lintOutput?: string;
  knownErrors?: string;
  notes?: string;
};

export const NORMALIZER_CAVEAT =
  "Manual normalization structures messy agent-run evidence. It does not create " +
  "measured token, cost, latency, energy, or heat data unless those values are " +
  "present in the source.";

const FILE_PATH_RE =
  /\b(?:src|docs|public|app|components|lib|pages|tests?|scripts)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+/g;
const BARE_FILE_RE = /\b[A-Za-z0-9_-]+\.(?:tsx?|jsx?|css|json|md|svg|txt|ya?ml)\b/g;
const ROUTE_RE = /(?:^|\s)(\/[a-z0-9][a-z0-9/_-]*)\b/g;
const COMMAND_RE = /\b(?:npm|npx|pnpm|yarn|git|node|tsc|eslint|next)\b[^\n]*/g;

function splitLines(text?: string): string[] {
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^[-*•\d.)\s]+/, "").trim())
    .filter(Boolean);
}

function uniq(items: string[]): string[] {
  return Array.from(new Set(items.map((s) => s.trim()).filter(Boolean)));
}

function matchAll(text: string, re: RegExp): string[] {
  return uniq(Array.from(text.matchAll(re)).map((m) => (m[1] ?? m[0]).trim()));
}

// Map a keyword hit count to a qualitative label. Never returns a number.
function labelFromCount(count: number): QualitativeLabel {
  if (count === 0) return "none";
  if (count <= 2) return "low";
  if (count <= 5) return "moderate";
  return "high";
}

function countMatches(haystack: string, terms: string[]): number {
  const lower = haystack.toLowerCase();
  let n = 0;
  for (const t of terms) {
    const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
    n += (lower.match(re) ?? []).length;
  }
  return n;
}

function resultFromOutput(output?: string): "pass" | "fail" | null {
  if (!output || !output.trim()) return null;
  const lower = output.toLowerCase();
  if (/\b(error|failed|exit\s*[1-9]|✖|cannot find|type error)\b/.test(lower)) {
    return "fail";
  }
  if (/\b(exit\s*0|pass(ed)?|compiled successfully|no (errors|problems)|✓|✔)\b/.test(lower)) {
    return "pass";
  }
  return null;
}

export function normalizeManualTrace(input: ManualTraceInput): NormalizedManualTrace {
  const raw = input.rawSummary ?? "";
  const combined = [raw, input.notes ?? ""].join("\n");

  // Files changed: explicit list + path-like tokens scanned from the summary.
  const explicitFiles = splitLines(input.filesChanged);
  const scannedFiles = [
    ...matchAll(combined, FILE_PATH_RE),
    ...matchAll(combined, BARE_FILE_RE),
  ];
  const files_changed = uniq([...explicitFiles, ...scannedFiles]);

  const components_created = files_changed.filter(
    (f) => /components\//.test(f) || /\bcomponent\b/i.test(f),
  );

  const pages_updated = uniq([
    ...files_changed.filter((f) => /app\/.*page\.(tsx?|jsx?)$/.test(f)),
    ...matchAll(combined, ROUTE_RE).filter(
      (r) => r.length > 1 && !/\.\w+$/.test(r),
    ),
  ]);

  const commands_run = uniq([
    ...splitLines(input.commandsRun),
    ...matchAll(combined, COMMAND_RE),
  ]);

  const lint_result = resultFromOutput(input.lintOutput);
  const build_result = resultFromOutput(input.buildOutput);

  const errorLines = [
    ...splitLines(input.knownErrors),
    ...splitLines(input.buildOutput).filter((l) => /error|failed/i.test(l)),
    ...splitLines(input.lintOutput).filter((l) => /error|warning/i.test(l)),
  ];
  const known_errors = uniq(errorLines);

  // Qualitative risk/waste signals — keyword heuristics only.
  const repeatedCtxCount = countMatches(combined, [
    "repeated context",
    "re-read",
    "reread",
    "resend",
    "full context",
    "duplicate context",
  ]);
  const redundantEditCount = countMatches(combined, [
    "rewrite",
    "re-edit",
    "redundant edit",
    "modified since read",
    "retry",
    "loop",
    "build-fix",
    "build fix",
  ]);
  const claimsCount = countMatches(combined, [
    "guaranteed",
    "production-proven",
    "exact energy",
    "exact heat",
    "customer savings",
    "solves orbital",
    "converts heat",
  ]);

  const wasteTerms: Record<string, string[]> = {
    "Retry / loop behavior": ["retry", "loop", "looping"],
    "Repeated context": ["repeated context", "resend", "full context", "re-read"],
    "Redundant edits": ["rewrite", "re-edit", "modified since read", "redundant edit"],
    "Tool-output bloat": ["bloat", "huge output", "dumped", "raw dump", "verbose output"],
    "Build/lint fix loops": ["build-fix", "build fix", "lint error", "build error"],
    "Planning overhead": ["over-planning", "overplanning", "re-plan", "replan", "planning loop"],
  };
  const suspected_waste_patterns = Object.entries(wasteTerms)
    .filter(([, terms]) => countMatches(combined, terms) > 0)
    .map(([label]) => label);

  const correctionCount = countMatches(combined, [
    "fix",
    "correction",
    "retry",
    "loop",
    "redo",
    "revert",
  ]);

  const quality_checks = {
    build_passes: build_result === null ? null : build_result === "pass",
    lint_passes: lint_result === null ? null : lint_result === "pass",
  };

  const limitations = uniq([
    "Structured from pasted evidence; not a measured trace.",
    "Token, cost, latency, energy, and heat are null unless supplied in the source.",
    "Risk/waste labels are qualitative heuristics over the pasted text, not detector findings.",
    ...splitLines(input.notes).map((n) => `Note: ${n}`),
  ]);

  return {
    run_name: input.runName.trim() || "Untitled run",
    objective: input.objective.trim(),
    files_changed,
    components_created,
    pages_updated,
    commands_run,
    lint_result,
    build_result,
    known_errors,
    correction_loops: correctionCount === 0 ? "none" : labelFromCount(correctionCount),
    suspected_waste_patterns,
    repeated_context_risks: raw ? labelFromCount(repeatedCtxCount) : "unknown",
    redundant_edit_risks: raw ? labelFromCount(redundantEditCount) : "unknown",
    claims_risks: labelFromCount(claimsCount),
    quality_checks,
    limitations,
    // Never invented. These stay null unless a real measured value is supplied.
    exact_token_count: null,
    exact_model_calls: null,
    exact_cost_usd: null,
    exact_energy_wh: null,
    trace_kind: "normalized_manual",
  };
}
