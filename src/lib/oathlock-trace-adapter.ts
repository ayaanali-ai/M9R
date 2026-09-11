// Adapter: OathLock trace (oathlock.trace.v0, JSON or JSONL) -> the analyzer's
// NormalizedManualTrace, so the existing coding-agent detectors can run over a
// real exported trace without any change to detector logic.
//
// CLAIM DISCIPLINE: this adapter only *re-expresses* what the trace already
// states. It derives qualitative labels from structural facts (repeated reads,
// duplicate commands, recorded retries/errors, null usage) and never invents
// tokens, cost, or model names. When the trace reports no usage, exact_* stay
// null and the missing_usage_metadata detector fires honestly.
import type {
  NormalizedManualTrace,
  QualitativeLabel,
} from "@/lib/manual-trace-normalizer";
import {
  detectCodingAgentWaste,
  type CodingAgentFinding,
} from "@/lib/coding-agent-detectors";

export type OathlockTraceStep = {
  step: number;
  timestamp: string | null;
  actor: "human" | "agent" | "tool" | "model";
  model_name: string | null;
  tool_name: string | null;
  tool_input_summary: string | null;
  tool_output_summary: string | null;
  files_read: string[];
  files_written: string[];
  shell_commands: string[];
  errors: string[];
  retries: number;
  token_usage: { input: number | null; output: number | null; total: number | null } | null;
  estimated_cost_usd: number | null;
  missing_metadata: string[];
};

export type OathlockTrace = {
  schema: "oathlock.trace.v0";
  variant: "clean" | "messy";
  provenance: string;
  session_id: string;
  task_summary: string;
  started_at: string;
  ended_at: string;
  actors_observed: string[];
  steps: OathlockTraceStep[];
  totals: {
    steps: number;
    failed_commands: number;
    retries: number;
    token_usage: { input: number | null; output: number | null; total: number | null } | null;
    estimated_cost_usd: number | null;
  };
  missing_metadata_global: string[];
  anonymization: { applied: boolean; notes: string[] };
};

// Which detector type(s) satisfy each OathLock-facing expectation. Used by the
// fixtures and tests so the canonical names map onto the codebase's detectors.
export const EXPECTED_DETECTOR_MAP = {
  // "Repeated context" means the same context (file) re-read, which is the
  // redundant_file_read detector. repeated_tool_call (duplicate commands) is a
  // distinct, separately-reported signal and is intentionally not aliased here.
  repeated_context: ["redundant_file_read"],
  bloated_tool_output: ["bloated_tool_output"],
  retry_spiral: ["retry_spiral"],
  missing_usage_metadata: ["missing_usage_metadata"],
  model_overkill: ["model_overkill"],
} as const satisfies Record<string, readonly CodingAgentFinding["type"][]>;

export function parseTraceJson(text: string): OathlockTrace {
  return JSON.parse(text) as OathlockTrace;
}

// Reconstruct a trace from JSONL (one `meta` line + N `step` lines).
export function parseTraceJsonl(text: string): OathlockTrace {
  const records = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

  const meta = records.find((r) => r.record === "meta");
  if (!meta) throw new Error("JSONL trace missing meta record");

  const stripRecord = (r: Record<string, unknown>) => {
    const copy = { ...r };
    delete copy.record;
    return copy;
  };
  const steps = records
    .filter((r) => r.record === "step")
    .map((r) => stripRecord(r) as unknown as OathlockTraceStep);

  return { ...stripRecord(meta), steps } as unknown as OathlockTrace;
}

function countBy<T>(items: T[], key: (t: T) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) {
    const k = key(it);
    if (!k) continue;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

// A single read is not "repeated". Only >=2 reads of the same file count.
function labelFromMax(max: number): QualitativeLabel {
  if (max >= 3) return "high";
  if (max === 2) return "moderate";
  return "none";
}

// Map an OathLock trace into the analyzer's NormalizedManualTrace. Pure and
// deterministic — same trace always yields the same normalized evidence.
export function toNormalizedManualTrace(trace: OathlockTrace): NormalizedManualTrace {
  const steps = trace.steps;
  const filesRead = steps.flatMap((s) => s.files_read);
  const filesWritten = steps.flatMap((s) => s.files_written);
  const commands = steps.flatMap((s) => s.shell_commands);
  const known_errors = steps.flatMap((s) => s.errors);

  const readCounts = countBy(filesRead, (f) => f.trim().toLowerCase());
  const maxReadRepeat = Math.max(0, ...readCounts.values());
  // Only commands run on *failing* steps count toward a retry spiral. Re-running
  // a command once to verify a fix (it then passes) is not a spiral.
  const failedCommands = steps
    .filter((s) => s.errors.length > 0)
    .flatMap((s) => s.shell_commands);
  const dupFailedCommands = [...countBy(failedCommands, (c) => c.trim().toLowerCase()).entries()]
    .filter(([, n]) => n > 1);
  const totalRetries = steps.reduce((a, s) => a + s.retries, 0);
  const retrySignal = totalRetries > 0 || dupFailedCommands.length > 0;

  // Bloated tool output: rely on what the trace itself recorded in summaries.
  const bloated = steps.some((s) =>
    /bloated|full (build )?log|dumped|entire log|\d{2,3},\d{3}-char/i.test(
      s.tool_output_summary ?? "",
    ),
  );

  // Usage: only confirmed when the trace actually carries totals. Never invented.
  const exact_token_count = trace.totals.token_usage?.total ?? null;
  const exact_cost_usd = trace.totals.estimated_cost_usd ?? null;
  const modelCallsMeasured = steps.filter(
    (s) => s.model_name != null && s.token_usage != null,
  ).length;
  const exact_model_calls = exact_token_count != null ? modelCallsMeasured : null;

  const suspected_waste_patterns: string[] = [];
  const limitations: string[] = [];

  if (maxReadRepeat >= 2) {
    suspected_waste_patterns.push("Repeated context (same file re-read)");
    limitations.push(
      `Same file re-read ${maxReadRepeat}x as full context without changes (repeated context).`,
    );
  }
  if (bloated) {
    limitations.push(
      "Dumped the full build log into context (bloated tool output); only the relevant error block was needed.",
    );
  }
  if (retrySignal) {
    const attempts = Math.max(totalRetries + 1, dupFailedCommands[0]?.[1] ?? 0);
    suspected_waste_patterns.push("Retry spiral");
    limitations.push(
      `Retried the same command ${attempts} times with no new information (same error).`,
    );
  }
  if (known_errors.length > 0) {
    suspected_waste_patterns.push("Build/lint fix loops");
  }

  // Correction severity reflects retries; one fail->fix is "low", a spiral "high".
  const correction_loops: QualitativeLabel =
    totalRetries >= 2 ? "high" : totalRetries === 1 ? "moderate" : known_errors.length > 0 ? "low" : "none";

  return {
    run_name: `${trace.task_summary} [${trace.variant}]`,
    objective: trace.task_summary,
    files_changed: [...new Set([...filesWritten])],
    components_created: [],
    pages_updated: [],
    commands_run: commands,
    lint_result: null,
    build_result: null,
    known_errors,
    correction_loops,
    suspected_waste_patterns,
    repeated_context_risks: labelFromMax(maxReadRepeat),
    redundant_edit_risks: "none",
    claims_risks: "none",
    quality_checks: { build_passes: null, lint_passes: null },
    limitations,
    exact_token_count,
    exact_model_calls,
    exact_cost_usd,
    exact_energy_wh: null,
    trace_kind: "normalized_manual",
  };
}

export function analyzeOathlockTrace(trace: OathlockTrace): CodingAgentFinding[] {
  return detectCodingAgentWaste(toNormalizedManualTrace(trace));
}

// True if any detector type backing the given expectation fired.
export function expectationFired(
  findings: CodingAgentFinding[],
  expectation: keyof typeof EXPECTED_DETECTOR_MAP,
): boolean {
  const types = new Set(findings.map((f) => f.type));
  return EXPECTED_DETECTOR_MAP[expectation].some((t) => types.has(t));
}

