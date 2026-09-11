/**
 * Trace inspection — shared client-side validation for upload surfaces.
 * ----------------------------------------------------------------------------
 * One implementation powers both the full /traces/upload page and the embedded
 * dashboard QuickUpload, so validation, the metadata preview, and the size
 * limit never drift between them.
 *
 * The server remains the source of truth; this exists purely for instant,
 * trustworthy feedback as the user drops/pastes a trace.
 */

import { normalizeToTrace } from "@/lib/normalize-trace";
import { computeTraceMetrics } from "@/lib/trace-metrics";
import { normalizeRawSession } from "@/lib/raw-session-normalizer";
import {
  detectSessionInput,
  type SessionInputDetection,
} from "@/lib/session-input-detection";

// Keep in sync with MAX_TRACE_BYTES on the server (2 MB).
export const MAX_TRACE_BYTES = 2_000_000;
export const MAX_MB = MAX_TRACE_BYTES / 1_000_000;

/**
 * Session file types M9R accepts as first-class input. Markdown/raw exports
 * are behavioral evidence — not just JSON traces. Keep the `accept` attribute on
 * every upload control in sync with this list.
 */
export const ACCEPTED_SESSION_EXTENSIONS = [".json", ".jsonl", ".md", ".txt", ".log"] as const;
export const ACCEPT_ATTR = ".json,.jsonl,.md,.txt,.log,text/plain,application/json";

/**
 * Whether a chosen file is an accepted session input. Permissive by design:
 * raw text/markdown transcripts are valid, so anything text-like (or with no
 * type) is allowed and the parser decides quality. We only reject clearly
 * binary types (images, pdfs, archives).
 */
export function isAcceptedSessionFile(name: string, mimeType = ""): boolean {
  const lower = name.toLowerCase();
  if (ACCEPTED_SESSION_EXTENSIONS.some((ext) => lower.endsWith(ext))) return true;
  // Allow any text/* or JSON mime even with an unusual extension.
  if (mimeType.startsWith("text/") || mimeType === "application/json") return true;
  // Reject obviously-binary content types.
  if (/^(image|audio|video|application)\//.test(mimeType) && mimeType !== "application/json") {
    return false;
  }
  // No extension and no/unknown type — let the parser try (paste-from-file case).
  return mimeType === "";
}

export type Inspection =
  | { state: "idle" }
  | { state: "invalid"; message: string }
  | {
      state: "valid" | "warning";
      message: string;
      stepCount: number;
      sessionId: string | null;
      taskSummary: string | null;
      hasTokenUsage: boolean;
      sizeBytes: number;
      /** Real metrics from the report pipeline, so the preview matches the report. */
      totalTokens: number | null;
      /** Best-available cost (recorded or model-estimated), null when neither. */
      costUsd: number | null;
      /** True when costUsd is a model-pricing estimate, not a recorded value. */
      costIsEstimated: boolean;
      /** How the trace was obtained: structured JSON, or parsed from raw output. */
      source: "json" | "raw";
      /** Detected input format / source / source-quality for the UI + report. */
      detection: SessionInputDetection;
      /**
       * The JSON string to actually hand off to the report. For JSON input this
       * is the original text; for raw output it's the *parsed* trace JSON.
       */
      handoffJson: string;
    };

/** True when a trace is loaded and structurally usable. */
export function canGenerate(inspection: Inspection): boolean {
  return inspection.state === "valid" || inspection.state === "warning";
}

/**
 * Instant, client-side structural validation. Mirrors (loosely) the server's
 * checks and returns a friendly, specific message plus a metadata preview.
 */
export function inspectTraceInput(raw: string, fileName?: string | null): Inspection {
  if (!raw.trim()) return { state: "idle" };

  // Size is measured the same way the server does (UTF-8 byte length).
  const sizeBytes = new TextEncoder().encode(raw).length;
  if (sizeBytes > MAX_TRACE_BYTES) {
    return {
      state: "invalid",
      message: `Too large (${(sizeBytes / 1_000_000).toFixed(2)} MB). The limit is ${MAX_MB} MB.`,
    };
  }

  // One front door: detect the input format/source, then normalize into a
  // trace. This unifies JSON, JSONL, Claude Code markdown, and raw text without
  // forking the report logic. If JSON parsing fails, we DON'T hard-fail — the
  // normalizer falls back to raw-text handling.
  const detection = detectSessionInput(raw, fileName ?? null);
  const result = normalizeRawSession(raw, fileName ?? null, detection);

  if (!result.ok || !result.trace) {
    return {
      state: "invalid",
      message:
        result.note ||
        "This did not parse as structured JSON, so M9R analyzed it as raw session text — but no commands, edits, or tool activity were visible.",
    };
  }

  const handoffJson = JSON.stringify(result.trace);
  const trace = result.trace as { task_summary?: string; session_id?: string };
  const isJson = detection.format === "structured_json" || detection.format === "jsonl";
  const sessionId = trace.session_id ?? null;

  // Structured JSON with a session id is the "valid" happy path; everything
  // else is a soft "warning" so the user notices it was raw/markdown-parsed.
  const state: "valid" | "warning" = isJson && sessionId ? "valid" : "warning";
  const message = isJson
    ? sessionId
      ? "Looks like a valid trace."
      : "Valid — but no session_id, so a placeholder will be used."
    : result.note;

  return {
    state,
    message,
    stepCount: Array.isArray((result.trace as Record<string, unknown>).steps)
      ? ((result.trace as Record<string, unknown>).steps as unknown[]).length
      : 0,
    sessionId,
    taskSummary: trace.task_summary ?? null,
    sizeBytes,
    source: isJson ? "json" : "raw",
    detection,
    handoffJson,
    ...safeMetrics(result.trace),
  };
}

/**
 * Run the real metrics pipeline so the preview shows the same token totals and
 * (recorded or estimated) cost the report will. Defensive: never crash on an
 * odd-but-parseable shape.
 */
function safeMetrics(parsed: unknown): {
  hasTokenUsage: boolean;
  totalTokens: number | null;
  costUsd: number | null;
  costIsEstimated: boolean;
} {
  try {
    const m = computeTraceMetrics(normalizeToTrace(parsed));
    return {
      hasTokenUsage: m.hasTokenUsage,
      totalTokens: m.totalTokens,
      costUsd: m.effectiveCostUsd,
      costIsEstimated: m.costIsEstimated,
    };
  } catch {
    return { hasTokenUsage: false, totalTokens: null, costUsd: null, costIsEstimated: false };
  }
}

/** Human-friendly byte formatting shared across upload surfaces. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(2)} MB`;
}
