/**
 * Raw session normalizer — OathLock
 * ----------------------------------------------------------------------------
 * Turns any supported session input (structured JSON, JSONL, Claude Code CLI
 * markdown export, Cursor/Codex transcript, or pasted raw text) into the single
 * trace shape the existing OathLock parser/report/rules pipeline already
 * consumes. It does NOT fork the Blackbox Report logic — it only normalizes the
 * front door, then hands a trace to normalizeToTrace() → generateBlackboxReport().
 *
 * Claim discipline (non-negotiable):
 *  - We extract only what the text literally shows.
 *  - Exact token/cost metadata is NEVER invented. When a session has no usage
 *    receipts, usage is marked unavailable — behavioral evidence still works.
 *  - Source quality is scored honestly by session-input-detection, and is
 *    embedded on the trace so the report header and rule generator can respect it.
 */

import {
  detectSessionInput,
  type SessionInputDetection,
} from "@/lib/session-input-detection";
import { parseRawOutput } from "@/lib/raw-trace-parser";

export interface NormalizedSession {
  ok: boolean;
  detection: SessionInputDetection;
  /** Parsed trace as a plain snake_case JSON object, or null when unusable. */
  trace: Record<string, unknown> | null;
  /** What was extracted, in honest plain language (for the report header). */
  extracted: string[];
  /** What could not be extracted / claimed (for the report header). */
  unavailable: string[];
  /** Short human note summarizing the parse. */
  note: string;
}

// --- Claude Code CLI export markers -----------------------------------------

const BANNER_VERSION_RE = /claude code\s+v?([0-9][\w.]*)/i;
const MODEL_LINE_RE =
  /\b(sonnet[\w.\s]*|opus[\w.\s]*|haiku[\w.\s]*)\b(?:\s*·\s*(claude pro|claude max|claude team|claude pro\/max))?/i;
const WORKING_DIR_RE =
  /(?:^|\s)([A-Za-z]:\\[^\s]+|\/(?:home|Users|var|opt|workspace|repo)[^\s]*|~\/[^\s]+)/m;
const PROMPT_RE = /^\s*[❯]\s+(.+)$/;
const READ_FILES_RE = /\bread\s+(\d+)\s+files?\b/i;
const RAN_CMD_RE = /\bran\s+(\d+)\s+shell commands?\b/i;
const UPDATED_FILE_RE = /\b(?:updated?|wrote to|edited)\b[^\n]*?([A-Za-z0-9_./\\-]+\.[A-Za-z]{1,5})\b/i;
const COMMITTED_RE = /\bcommitted\s+([0-9a-f]{6,40})\b/i;
const VERIFY_RE = /\b(npm test|npm run build|npx? tsc[^\n]*|all \d+ pass|verification:)/i;

/**
 * Normalize any supported session input into a trace-ready object.
 *
 * Dispatch by detected format:
 *  - structured_json / jsonl → preserve (parse, no fabrication).
 *  - markdown_export (Claude Code CLI) → dedicated extractor + raw parser.
 *  - raw_text → existing raw parser.
 */
export function normalizeRawSession(
  rawText: string,
  filename?: string | null,
  detectionHint?: SessionInputDetection,
): NormalizedSession {
  const detection = detectionHint ?? detectSessionInput(rawText, filename);
  const text = (rawText ?? "").trim();

  if (!text) {
    return {
      ok: false,
      detection,
      trace: null,
      extracted: [],
      unavailable: ["Everything — the input was empty."],
      note: "Nothing to parse — provide a session first.",
    };
  }

  // --- Structured JSON / JSONL: preserve existing behavior -----------------
  if (detection.format === "structured_json") {
    try {
      const parsed = JSON.parse(text);
      const trace = Array.isArray(parsed)
        ? ({ schema: "oathlock.trace.v0", steps: parsed } as Record<string, unknown>)
        : (parsed as Record<string, unknown>);
      return {
        ok: true,
        detection,
        trace: withInputProfile(trace, detection, jsonExtracted(trace), []),
        extracted: jsonExtracted(trace),
        unavailable: [],
        note: "Structured JSON trace — existing pipeline preserved.",
      };
    } catch {
      // Fall through to raw handling on malformed JSON (honest fallback).
    }
  }

  if (detection.format === "jsonl") {
    const trace = jsonlToTrace(text);
    if (trace) {
      const extracted = jsonExtracted(trace);
      return {
        ok: true,
        detection,
        trace: withInputProfile(trace, detection, extracted, []),
        extracted,
        unavailable: [],
        note: "JSONL transcript normalized to a structured trace.",
      };
    }
  }

  // --- Claude Code CLI markdown export -------------------------------------
  if (detection.format === "markdown_export" && detection.source === "claude_code_cli") {
    return normalizeClaudeCodeExport(text, filename, detection);
  }

  // --- Raw text / other markdown: existing raw parser ----------------------
  const raw = parseRawOutput(text);
  if (!raw.ok || !raw.trace) {
    return {
      ok: false,
      detection,
      trace: null,
      extracted: [],
      unavailable: [
        "Terminal commands, file edits, and tool activity — none were visible.",
      ],
      note: raw.note,
    };
  }
  const extracted = rawExtracted(raw.trace);
  return {
    ok: true,
    detection,
    trace: withInputProfile(raw.trace, detection, extracted, RAW_USAGE_UNAVAILABLE),
    extracted,
    unavailable: RAW_USAGE_UNAVAILABLE,
    note: raw.note,
  };
}

const RAW_USAGE_UNAVAILABLE = [
  "Exact token usage (no usage metadata in raw text)",
  "Exact cost (cannot be derived without token receipts)",
];

// ---------------------------------------------------------------------------
// Claude Code CLI export extraction
// ---------------------------------------------------------------------------

function normalizeClaudeCodeExport(
  text: string,
  filename: string | null | undefined,
  detection: SessionInputDetection,
): NormalizedSession {
  const lines = text.split(/\r?\n/);

  let model: string | null = null;
  let version: string | null = null;
  let workingDir: string | null = null;
  let firstPrompt: string | null = null;
  let committed: string | null = null;
  let verificationSeen = false;

  for (const line of lines) {
    if (!version) {
      const v = line.match(BANNER_VERSION_RE);
      if (v) version = v[1];
    }
    if (!model) {
      const m = line.match(MODEL_LINE_RE);
      if (m) model = m[0].trim();
    }
    if (!workingDir) {
      const w = line.match(WORKING_DIR_RE);
      if (w) workingDir = w[1].trim();
    }
    if (!firstPrompt) {
      const p = line.match(PROMPT_RE);
      if (p && p[1].trim().length > 2 && !p[1].startsWith("/")) {
        firstPrompt = p[1].trim();
      }
    }
    const c = line.match(COMMITTED_RE);
    if (c) committed = c[1];
    if (VERIFY_RE.test(line)) verificationSeen = true;
  }

  // Run the generic raw parser to capture commands / file ops / errors that ARE
  // visible (diff blocks, $ commands). The export's collapsed summaries are then
  // layered on top as additional behavioral steps.
  const raw = parseRawOutput(text);
  const baseTrace = (raw.ok && raw.trace ? raw.trace : {}) as Record<string, unknown>;
  const baseSteps = Array.isArray(baseTrace.steps)
    ? (baseTrace.steps as Record<string, unknown>[])
    : [];

  // Layer in collapsed tool-activity summaries as evidence steps.
  const summarySteps: Record<string, unknown>[] = [];
  let filesReadCount = 0;
  let shellRuns = 0;
  const updatedFiles = new Set<string>();

  for (const line of lines) {
    const rf = line.match(READ_FILES_RE);
    if (rf) {
      filesReadCount += Number(rf[1]);
      summarySteps.push({ actor: "agent", tool: "Read", tool_output_summary: line.trim() });
    }
    const rc = line.match(RAN_CMD_RE);
    if (rc) {
      shellRuns += Number(rc[1]);
      summarySteps.push({ actor: "agent", tool: "Bash", tool_output_summary: line.trim() });
    }
    const uf = line.match(UPDATED_FILE_RE);
    if (uf) {
      updatedFiles.add(uf[1]);
      summarySteps.push({ actor: "agent", tool: "Edit", files_written: [uf[1]] });
    }
  }

  const steps: Record<string, unknown>[] = [...baseSteps, ...summarySteps].map(
    (s, i) => ({ ...s, step: i + 1 }),
  );

  // Build the extraction / unavailable honesty lists.
  const extracted: string[] = [];
  if (model) extracted.push(`model (${model})`);
  if (version) extracted.push(`Claude Code version (${version})`);
  if (workingDir) extracted.push(`working directory (${workingDir})`);
  if (firstPrompt) extracted.push("user prompt");
  if (filesReadCount > 0) extracted.push(`file read activity (${filesReadCount} files)`);
  if (updatedFiles.size > 0) extracted.push(`file edits (${updatedFiles.size} files)`);
  if (shellRuns > 0) extracted.push(`shell command activity (${shellRuns} runs)`);
  if (verificationSeen) extracted.push("verification summary");
  if (committed) extracted.push(`commit (${committed})`);

  const unavailable = [
    "Exact token usage (not present in markdown export)",
    "Exact cost (no usage metadata to price against)",
  ];
  if (shellRuns > 0) {
    unavailable.push("Full terminal command output (collapsed behind tool summaries)");
  }

  const trace: Record<string, unknown> = {
    schema: "oathlock.trace.v0",
    variant: "messy",
    provenance: `Parsed from Claude Code CLI markdown export${
      version ? ` (Claude Code v${version})` : ""
    }. No measured token/cost data.`,
    session_id: `ccexport_${Date.now().toString(36)}`,
    task_summary: deriveExportTitle(firstPrompt, filename, committed),
    actors_observed: ["agent"],
    model: model ?? undefined,
    working_directory: workingDir ?? undefined,
    steps,
    totals: {
      steps: steps.length,
      failed_commands: steps.filter(
        (s) => Array.isArray(s.errors) && (s.errors as unknown[]).length > 0,
      ).length,
      retries: 0,
    },
    missing_metadata_global: [
      "token_usage not present in markdown export (cannot be measured)",
      "estimated_cost_usd not derivable without token receipts",
    ],
  };

  const ok = steps.length > 0;
  return {
    ok,
    detection,
    trace: ok ? withInputProfile(trace, detection, extracted, unavailable) : null,
    extracted,
    unavailable,
    note: ok
      ? `Parsed Claude Code CLI export: ${steps.length} behavioral step(s) from visible activity.`
      : "No behavioral evidence could be extracted from this Claude Code export.",
  };
}

/** Max length for a generated report title. */
export const MAX_TITLE_LENGTH = 80;

/**
 * Derive a short, readable report title for a Claude Code export — never a huge
 * quoted prompt body. Prefers a topic from the first prompt, else the filename
 * stem, else the commit. Always capped to MAX_TITLE_LENGTH.
 */
export function deriveExportTitle(
  firstPrompt: string | null,
  filename: string | null | undefined,
  committed: string | null,
): string {
  const base = "Claude Code export";
  let topic = "";

  if (firstPrompt) {
    // Take the first sentence/clause, drop markdown and quoted noise.
    topic = firstPrompt
      .replace(/[`*_>#]/g, "")
      .split(/(?<=[.?!:])\s|\n|—|—/)[0]
      .replace(/^(we need to|please|can you|i want to|help me|let'?s)\s+/i, "")
      .trim();
  }
  if (!topic && filename) {
    topic = filename.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim();
  }
  if (!topic && committed) topic = `commit ${committed.slice(0, 7)}`;

  let title = topic ? `${base} — ${topic}` : base;
  if (title.length > MAX_TITLE_LENGTH) {
    title = title.slice(0, MAX_TITLE_LENGTH - 1).replace(/\s+\S*$/, "").trimEnd() + "…";
  }
  return title;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert JSONL text into a single trace object (best-effort, no fabrication). */
function jsonlToTrace(text: string): Record<string, unknown> | null {
  const objs: Record<string, unknown>[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const parsed = JSON.parse(t);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        objs.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Skip non-JSON lines; honest partial parse.
    }
  }
  if (objs.length === 0) return null;
  // If each line already looks like a step, use them directly.
  return {
    schema: "oathlock.trace.jsonl.v0",
    session_id: `jsonl_${Date.now().toString(36)}`,
    steps: objs,
  };
}

function jsonExtracted(trace: Record<string, unknown>): string[] {
  const out: string[] = [];
  const steps = Array.isArray(trace.steps) ? (trace.steps as unknown[]) : [];
  out.push(`${steps.length} structured step(s)`);
  if (trace.totals && typeof trace.totals === "object") {
    const t = trace.totals as Record<string, unknown>;
    if (t.tokenUsage || t.token_usage || t.estimatedCostUsd || t.estimated_cost_usd) {
      out.push("usage metadata (tokens/cost)");
    }
  }
  return out;
}

function rawExtracted(trace: Record<string, unknown>): string[] {
  const steps = Array.isArray(trace.steps) ? (trace.steps as Record<string, unknown>[]) : [];
  const commands = steps.filter((s) => Array.isArray(s.shell_commands)).length;
  const reads = steps.filter((s) => Array.isArray(s.files_read)).length;
  const writes = steps.filter((s) => Array.isArray(s.files_written)).length;
  const errors = steps.filter((s) => Array.isArray(s.errors) && (s.errors as unknown[]).length).length;
  const out: string[] = [];
  if (commands) out.push(`${commands} shell command step(s)`);
  if (reads) out.push(`${reads} file read(s)`);
  if (writes) out.push(`${writes} file edit(s)`);
  if (errors) out.push(`${errors} error(s)`);
  if (out.length === 0) out.push(`${steps.length} step(s)`);
  return out;
}

/** Attach the input profile to a trace so the report header can show it. */
function withInputProfile(
  trace: Record<string, unknown>,
  detection: SessionInputDetection,
  extracted: string[],
  unavailable: string[],
): Record<string, unknown> {
  return {
    ...trace,
    input_profile: {
      format: detection.format,
      format_label: detection.formatLabel,
      source: detection.source,
      source_label: detection.sourceLabel,
      source_quality: detection.sourceQuality,
      source_quality_label: detection.sourceQualityLabel,
      extracted,
      unavailable,
      reasons: detection.reasons,
    },
  };
}
