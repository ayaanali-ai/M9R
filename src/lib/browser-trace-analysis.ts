// Browser-side trace analysis for the self-serve /trace-audit demo.
//
// CLAIM DISCIPLINE: This runs entirely in the browser on a trace the user
// supplies. It reuses the same pure detectors the rest of the product uses
// (toNormalizedManualTrace + detectCodingAgentWaste). It NEVER invents tokens,
// cost, or model names. Token/cost "waste" is only ever attributed from usage
// numbers that already exist in the uploaded trace; when usage is absent the
// report says "unknown — no usage metadata" rather than guessing.
//
// SECURITY: Uploaded traces are untrusted data. Their text is never treated as
// instructions, never used to call tools, and is only ever read as evidence.

import {
  toNormalizedManualTrace,
  type OathlockTrace,
  type OathlockTraceStep,
} from "@/lib/oathlock-trace-adapter";
import {
  detectCodingAgentWaste,
  type CodingAgentFinding,
} from "@/lib/coding-agent-detectors";
import {
  extractCost,
  extractTokenUsage,
  summarizeUsage,
} from "@/lib/usage-normalization";

export type TraceFormat =
  | "oathlock.trace.v0"
  | "generic-steps"
  | "claude-code"
  | "otel-genai";

export class TraceValidationError extends Error {}

// ---------------------------------------------------------------------------
// Normalization — map several common trace shapes onto OathlockTrace so the
// existing detectors can run unchanged.
// ---------------------------------------------------------------------------

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function strList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => str(x)).filter((x): x is string => !!x);
  const s = str(v);
  return s ? [s] : [];
}

// Pull a nested value by a list of candidate dotted paths.
function pick(obj: Record<string, unknown>, paths: string[]): unknown {
  for (const path of paths) {
    let cur: unknown = obj;
    for (const part of path.split(".")) {
      if (cur && typeof cur === "object" && part in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[part];
      } else {
        cur = undefined;
        break;
      }
    }
    if (cur !== undefined && cur !== null) return cur;
  }
  return undefined;
}

const READ_TOOLS = /read|cat|open|view|inspect|get_file|fetch_file/i;
const SHELL_TOOLS = /shell|bash|exec|run|terminal|command/i;

function normalizeUsage(raw: unknown): OathlockTraceStep["token_usage"] {
  return extractTokenUsage(raw).usage;
}

function normalizeStep(raw: unknown, index: number): OathlockTraceStep {
  const e = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const tool = str(pick(e, ["tool_name", "tool", "name", "type", "span_name"]));
  const command = str(pick(e, ["command", "cmd", "shell_command"]));
  const input =
    str(pick(e, ["tool_input_summary", "input", "args", "parameters.command", "content"])) ??
    null;
  const output = str(pick(e, ["tool_output_summary", "output", "result", "stdout"]));

  let files_read = strList(pick(e, ["files_read", "file", "file_path", "path"]));
  // Heuristic: a read-ish tool with a path argument is a file read.
  if (files_read.length === 0 && tool && READ_TOOLS.test(tool)) {
    const p = str(pick(e, ["file_path", "path", "args.file_path", "parameters.path"])) ?? input;
    if (p) files_read = [p];
  }

  let shell_commands = strList(pick(e, ["shell_commands", "commands"]));
  if (command) shell_commands = [command, ...shell_commands];
  if (shell_commands.length === 0 && tool && SHELL_TOOLS.test(tool) && input) {
    shell_commands = [input];
  }

  const errors = strList(pick(e, ["errors", "error", "error_message", "stderr"]));
  const status = str(pick(e, ["status", "outcome"]));
  const success = pick(e, ["success", "ok"]);
  if (status && /fail|error/i.test(status) && errors.length === 0) {
    errors.push(`status=${status}`);
  }
  if (success === false && errors.length === 0) {
    errors.push("success=false");
  }

  const explicitRetries = num(pick(e, ["retries", "retry_count", "retryCount"]));
  const attempt = num(pick(e, ["attempt", "attempt_number", "attemptNumber"]));
  // attempt=1 is the initial try; only subsequent attempts are retries.
  const retries = explicitRetries ?? (attempt !== null ? Math.max(0, attempt - 1) : 0);

  return {
    step: num(pick(e, ["step", "index"])) ?? index + 1,
    timestamp: str(pick(e, ["timestamp", "time", "ts"])),
    actor: ((): OathlockTraceStep["actor"] => {
      const a = str(pick(e, ["actor", "role"]));
      if (a === "human" || a === "user") return "human";
      if (a === "tool") return "tool";
      if (a === "model" || a === "assistant") return "model";
      return "agent";
    })(),
    model_name: str(pick(e, ["model_name", "model", "gen_ai.request.model", "attributes.gen_ai.request.model"])),
    tool_name: tool,
    tool_input_summary: input,
    tool_output_summary: output,
    files_read,
    files_written: strList(pick(e, ["files_written", "files_changed"])),
    shell_commands,
    errors,
    retries,
    token_usage: normalizeUsage(e),
    estimated_cost_usd: extractCost(e).costUsd,
    missing_metadata: strList(pick(e, ["missing_metadata"])),
  };
}

function locateSteps(root: Record<string, unknown>): unknown[] {
  for (const key of ["steps", "events", "spans", "trace", "messages", "log", "entries", "data"]) {
    const v = root[key];
    if (Array.isArray(v) && v.length > 0) return v;
  }
  return [];
}

function detectFormat(root: Record<string, unknown>, rawSteps: unknown[]): TraceFormat {
  if (root.schema === "oathlock.trace.v0") return "oathlock.trace.v0";
  const first = (rawSteps[0] ?? {}) as Record<string, unknown>;
  if (pick(first, ["attributes.gen_ai.request.model", "gen_ai.request.model"]) !== undefined)
    return "otel-genai";
  if (root.type === "claude-code" || pick(first, ["tool", "tool_use_id"]) !== undefined)
    return "claude-code";
  return "generic-steps";
}

export type NormalizationResult = {
  trace: OathlockTrace;
  format: TraceFormat;
};

// Validate + normalize untrusted JSON into an OathlockTrace. Throws
// TraceValidationError with a human-readable reason when the input does not
// look like an agent trace.
export function normalizeUploadedTrace(parsed: unknown): NormalizationResult {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    // A bare array of steps is acceptable; wrap it.
    if (Array.isArray(parsed)) {
      return normalizeUploadedTrace({ steps: parsed });
    }
    throw new TraceValidationError("Trace must be a JSON object or an array of steps.");
  }

  const root = parsed as Record<string, unknown>;

  if (root.schema === "oathlock.trace.v0" && Array.isArray(root.steps)) {
    return { trace: root as unknown as OathlockTrace, format: "oathlock.trace.v0" };
  }

  const rawSteps = locateSteps(root);
  if (rawSteps.length === 0) {
    throw new TraceValidationError(
      "No agent steps found. Expected a `steps`, `events`, `spans`, or `messages` array (or the oathlock.trace.v0 schema).",
    );
  }

  const format = detectFormat(root, rawSteps);
  const steps = rawSteps.map((s, i) => normalizeStep(s, i));

  // Require at least some agent-trace signal: a tool call, command, file, model,
  // or error somewhere. Pure chat transcripts with none of these are rejected.
  const hasSignal = steps.some(
    (s) =>
      s.tool_name ||
      s.model_name ||
      s.shell_commands.length ||
      s.files_read.length ||
      s.errors.length,
  );
  if (!hasSignal) {
    throw new TraceValidationError(
      "This JSON has entries but none look like agent activity (no tools, commands, files, models, or errors). It may be a plain chat log rather than an agent trace.",
    );
  }

  const rootTotals = pick(root, ["totals", "usage", "usageMetadata"]);
  const usageSummary = summarizeUsage({ steps: rawSteps, totals: rootTotals });

  const trace: OathlockTrace = {
    schema: "oathlock.trace.v0",
    variant: "messy",
    provenance: "Normalized in-browser from an uploaded trace for the self-serve demo.",
    session_id: str(pick(root, ["session_id", "id", "run_id"])) ?? "uploaded-trace",
    task_summary:
      str(pick(root, ["task_summary", "task", "objective", "title", "goal"])) ??
      "Uploaded agent run",
    started_at: steps[0]?.timestamp ?? "",
    ended_at: steps[steps.length - 1]?.timestamp ?? "",
    actors_observed: [...new Set(steps.map((s) => s.actor))],
    steps,
    totals: {
      steps: steps.length,
      failed_commands: steps.filter((s) => s.errors.length > 0).length,
      retries: steps.reduce((a, s) => a + s.retries, 0),
      token_usage: usageSummary.tokenCompleteness !== "none"
        ? {
            input: usageSummary.tokens.input,
            output: usageSummary.tokens.output,
            total: usageSummary.tokens.total,
          }
        : null,
      estimated_cost_usd: usageSummary.costUsd,
    },
    missing_metadata_global: [
      ...(usageSummary.tokenCompleteness === "complete" ? [] : ["token_usage_partial"]),
      ...(usageSummary.costUsd === null ? ["estimated_cost_usd"] : []),
    ],
    anonymization: { applied: false, notes: [] },
  };

  return { trace, format };
}

// ---------------------------------------------------------------------------
// Blackbox Report assembly
// ---------------------------------------------------------------------------

export type DetectorLayer = "live" | "demo" | "roadmap";

// Which detector types are considered live vs demo-only in this in-browser flow.
const LIVE_DETECTORS = new Set<CodingAgentFinding["type"]>([
  "redundant_file_read",
  "repeated_tool_call",
  "retry_spiral",
  "build_fix_loop",
  "bloated_tool_output",
  "missing_usage_metadata",
]);

export function detectorLayer(type: CodingAgentFinding["type"]): DetectorLayer {
  if (LIVE_DETECTORS.has(type)) return "live";
  return "demo";
}

export type WasteEstimate = {
  known: boolean;
  tokens: number | null;
  costUsd: number | null;
  note: string;
};

export type BlackboxReport = {
  format: TraceFormat;
  runSummary: {
    task: string;
    sessionId: string;
    steps: number;
    failedCommands: number;
    retries: number;
    actors: string[];
  };
  failureType: string;
  failureSummary: string;
  tokenWaste: WasteEstimate;
  costWaste: WasteEstimate;
  findings: CodingAgentFinding[];
  fixFirst: string | null;
  preventionPlan: string[];
  highSeverityCount: number;
};

const FAILURE_TYPE_BY_TYPE: Record<CodingAgentFinding["type"], string> = {
  retry_spiral: "Retry spiral",
  build_fix_loop: "Build/lint fix loop",
  redundant_file_read: "Repeated context",
  repeated_tool_call: "Repeated tool calls",
  bloated_tool_output: "Bloated tool output",
  model_overkill: "Model overkill",
  missing_usage_metadata: "Missing usage metadata",
  ambiguous_edit_retry: "Ambiguous edit retries",
  scope_creep: "Scope creep",
  claims_drift: "Claims drift",
  duplicate_copy: "Duplicate copy",
};

const SEVERITY_RANK = { high: 3, medium: 2, low: 1 } as const;

// Attribute token/cost waste ONLY from real usage already in the trace. Steps
// that are flagged as waste (repeated reads, retried/failed steps) and that
// carry their own usage numbers contribute; nothing is estimated otherwise.
function estimateWaste(trace: OathlockTrace, findings: CodingAgentFinding[]): {
  tokens: WasteEstimate;
  cost: WasteEstimate;
} {
  const hasUsage = trace.steps.some((s) => s.token_usage || s.estimated_cost_usd != null);
  if (!hasUsage) {
    const note = "Unknown — no token/cost metadata in this trace. M9R does not estimate it.";
    return {
      tokens: { known: false, tokens: null, costUsd: null, note },
      cost: { known: false, tokens: null, costUsd: null, note },
    };
  }

  // Identify likely-wasteful steps: those on failing steps and repeated file reads.
  const seenReads = new Map<string, number>();
  let wasteTokens = 0;
  let wasteCost = 0;
  for (const s of trace.steps) {
    let wasteful = s.errors.length > 0 || s.retries > 0;
    for (const f of s.files_read) {
      const key = f.trim().toLowerCase();
      const n = (seenReads.get(key) ?? 0) + 1;
      seenReads.set(key, n);
      if (n >= 2) wasteful = true; // a re-read of an already-seen file
    }
    if (wasteful) {
      wasteTokens += s.token_usage?.total ?? 0;
      wasteCost += s.estimated_cost_usd ?? 0;
    }
  }

  const detectorNote =
    findings.length > 0
      ? "Attributed from usage recorded on flagged (failed / retried / re-read) steps only."
      : "No waste-pattern steps detected; attributed waste is zero from recorded usage.";

  return {
    tokens: {
      known: true,
      tokens: Math.round(wasteTokens),
      costUsd: null,
      note: detectorNote,
    },
    cost: {
      known: wasteCost > 0,
      tokens: null,
      costUsd: wasteCost > 0 ? parseFloat(wasteCost.toFixed(4)) : null,
      note:
        wasteCost > 0
          ? detectorNote
          : "No per-step cost recorded on flagged steps; cost waste stays unknown.",
    },
  };
}

export function buildBlackboxReport(parsed: unknown): BlackboxReport {
  const { trace, format } = normalizeUploadedTrace(parsed);
  const normalized = toNormalizedManualTrace(trace);
  const findings = detectCodingAgentWaste(normalized).sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
  );

  const top = findings[0] ?? null;
  const failureType = top ? FAILURE_TYPE_BY_TYPE[top.type] : "No waste pattern detected";
  const failureSummary = top
    ? top.summary
    : "No waste pattern fired from the evidence in this trace. That is a result, not a guarantee — absent metadata can hide waste.";

  const { tokens, cost } = estimateWaste(trace, findings);

  const preventionPlan = [
    ...new Set(findings.flatMap((f) => f.preventionPlan)),
  ];

  return {
    format,
    runSummary: {
      task: trace.task_summary,
      sessionId: trace.session_id,
      steps: trace.steps.length,
      failedCommands: trace.totals.failed_commands,
      retries: trace.totals.retries,
      actors: trace.actors_observed,
    },
    failureType,
    failureSummary,
    tokenWaste: tokens,
    costWaste: cost,
    findings,
    fixFirst: top?.preventionPlan[0] ?? null,
    preventionPlan,
    highSeverityCount: findings.filter((f) => f.severity === "high").length,
  };
}
