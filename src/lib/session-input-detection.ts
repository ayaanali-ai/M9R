/**
 * Session input detection — OathLock
 * ----------------------------------------------------------------------------
 * Classifies an uploaded/pasted session before it enters the trace/report
 * pipeline. It answers three questions, honestly and without IO:
 *
 *   1. What FORMAT is this? (structured JSON, JSONL, markdown export, raw text)
 *   2. What SOURCE produced it? (Claude Code CLI, Codex, Cursor, web chat, …)
 *   3. How STRONG is the resulting evidence likely to be? (source quality)
 *
 * Claim discipline: detection never invents structure. Source quality is scored
 * on what is actually visible (commands, errors, edits, tool summaries), so a
 * pasted prose summary is honestly labeled "limited"/"insufficient" rather than
 * dressed up as a strong trace.
 *
 * Pure module (no DOM/IO) so it is unit-testable and reusable by the upload UI,
 * the raw-session normalizer, and the report header.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InputFormat =
  | "structured_json"
  | "jsonl"
  | "markdown_export"
  | "raw_text"
  | "unknown";

export type SourceHint =
  | "claude_code_cli"
  | "codex_cli"
  | "cursor"
  | "claude_desktop_web"
  | "generic_agent"
  | "unknown";

/**
 * How strong the evidence from this input is expected to be. Drives both the
 * report header copy and whether active workspace rules may be generated.
 */
export type SourceQuality = "strong" | "medium" | "limited" | "insufficient";

export interface SessionInputDetection {
  format: InputFormat;
  source: SourceHint;
  sourceQuality: SourceQuality;
  /** Human-readable, honest reasons for the classification. */
  reasons: string[];
  /** Display labels for the report header / UI. */
  formatLabel: string;
  sourceLabel: string;
  sourceQualityLabel: string;
}

export const INPUT_FORMAT_LABELS: Record<InputFormat, string> = {
  structured_json: "JSON trace",
  jsonl: "JSONL transcript",
  markdown_export: "Claude Code CLI export",
  raw_text: "Raw text transcript",
  unknown: "Unknown",
};

export const SOURCE_HINT_LABELS: Record<SourceHint, string> = {
  claude_code_cli: "Claude Code CLI",
  codex_cli: "Codex CLI",
  cursor: "Cursor",
  claude_desktop_web: "Claude Desktop / web",
  generic_agent: "Generic coding agent",
  unknown: "Unknown",
};

export const SOURCE_QUALITY_LABELS: Record<SourceQuality, string> = {
  strong: "Strong",
  medium: "Medium",
  limited: "Limited",
  insufficient: "Insufficient",
};

// ---------------------------------------------------------------------------
// Marker regexes
// ---------------------------------------------------------------------------

// Claude Code CLI export banner / chrome.
const CLAUDE_CODE_BANNER_RE = /claude code(?:\s+v?\d|\b)/i;
const CLAUDE_MODEL_LINE_RE =
  /\b(sonnet|opus|haiku|claude pro|claude max|claude-(?:opus|sonnet|haiku|fable))\b/i;
const EXPORT_CMD_RE = /\/export\b/i;
// The CLI prints "❯" for prompts and "●"/"⏺" for assistant activity bullets.
const CLI_PROMPT_RE = /^[\s]*[❯>]\s+\S/m;
const CLI_BULLET_RE = /[⏺●]/;
// Collapsed tool-activity summaries Claude Code prints.
const TOOL_SUMMARY_RE =
  /\b(read \d+ files?|updated? \w|wrote to|ran \d+ shell command|ran shell command|committed [0-9a-f]{6,}|edited \w|created \w)\b/i;
const WORKING_DIR_RE =
  /(?:^|\s)(?:[A-Za-z]:\\[^\s]+|\/(?:home|Users|var|opt|workspace|repo)[^\s]*|~\/[^\s]+)/m;

// Cursor markers.
const CURSOR_RE = /\bcursor\b|composer|runterminalcmd|\.cursor\/rules/i;

// Codex markers.
const CODEX_RE = /\bcodex\b|openai codex/i;

// Markdown role headers / structure.
const MD_HEADING_RE = /^#{1,6}\s+\S/m;
const MD_ROLE_RE =
  /^\s*(?:#{1,6}\s*)?(?:\*\*)?\s*(user|human|assistant|ai|claude|cursor|system)\b\s*(?:\*\*)?\s*:?\s*$/im;

// Behavioral evidence in raw text (commands, errors, file edits).
const COMMAND_RE =
  /(?:^|\n)\s*(?:[$>#]\s+|PS[^>]*>\s+)?(npm|npx|pnpm|yarn|bun|git|node|tsc|eslint|next|vite|pytest|jest|vitest|cargo|go|make|docker|python3?|pip3?)\b/i;
const ERROR_RE =
  /\b(?:error|exception|traceback|failed|failure|ENOENT|not found|is not defined|panic|✗|✖|❌)\b/i;
const FILE_EDIT_RE =
  /\b(?:edit(?:ed|ing)?|wrote|updat(?:e|ed|ing)|creat(?:e|ed|ing)|modif(?:y|ied))\b[^\n]*\.[A-Za-z]{1,5}\b/i;

// ---------------------------------------------------------------------------
// JSON / JSONL detection
// ---------------------------------------------------------------------------

function isTraceLikeObject(obj: unknown): boolean {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const o = obj as Record<string, unknown>;
  return Array.isArray(o.steps) || Array.isArray(o.events) || Array.isArray(o.messages);
}

/** True when text is line-delimited JSON (2+ JSON object lines). */
function looksLikeJsonl(text: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return false;
  let jsonObjectLines = 0;
  for (const line of lines) {
    if (!(line.startsWith("{") && line.endsWith("}"))) return false;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") jsonObjectLines += 1;
    } catch {
      return false;
    }
  }
  return jsonObjectLines >= 2;
}

// ---------------------------------------------------------------------------
// Public detection
// ---------------------------------------------------------------------------

/**
 * Classify a raw session input. Deterministic and side-effect free.
 */
export function detectSessionInput(
  raw: string,
  filename?: string | null,
): SessionInputDetection {
  const text = (raw ?? "").trim();
  const reasons: string[] = [];

  if (!text) {
    return finalize("unknown", "unknown", "insufficient", [
      "Empty input — nothing to detect.",
    ]);
  }

  const ext = (filename ?? "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";

  // --- 1. Structured JSON --------------------------------------------------
  // A single JSON document with a steps/events/messages array is a structured
  // trace and must preserve the existing pipeline behavior.
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (isTraceLikeObject(parsed)) {
        reasons.push("Parsed as a single structured JSON trace with a steps/events array.");
        // Tool spans present → strong; otherwise still strong-structured.
        return finalize("structured_json", detectSourceFromText(text), "strong", reasons);
      }
      if (Array.isArray(parsed) && parsed.some(isTraceLikeObject)) {
        reasons.push("Parsed as a JSON array of trace-like objects.");
        return finalize("structured_json", detectSourceFromText(text), "strong", reasons);
      }
      // Valid JSON but not trace-shaped (e.g. a raw provider response). Fall
      // through to raw handling, but note it parsed.
      reasons.push("Valid JSON, but not a recognized trace shape — treated as raw.");
    } catch {
      reasons.push("Looked like JSON but did not parse — falling back to raw handling.");
    }
  }

  // --- 2. JSONL ------------------------------------------------------------
  if (looksLikeJsonl(text)) {
    reasons.push("Line-delimited JSON (JSONL) transcript detected.");
    const source = detectSourceFromText(text);
    return finalize("jsonl", source, "strong", reasons);
  }

  // --- 3. Claude Code CLI markdown / terminal export -----------------------
  const ccSignals = claudeCodeSignals(text);
  if (ccSignals.score >= 2) {
    reasons.push(...ccSignals.reasons);
    // Quality: visible tool summaries / commands → medium; commands+errors or
    // explicit verification → can reach strong.
    const hasExec = COMMAND_RE.test(text) || /\bran \d* ?shell command/i.test(text);
    const hasVerify = /\b(npm test|npm run build|tsc|verif(?:y|ication)|all \d+ pass)\b/i.test(text);
    const quality: SourceQuality =
      hasExec && (ERROR_RE.test(text) || hasVerify) ? "strong" : "medium";
    return finalize("markdown_export", "claude_code_cli", quality, reasons);
  }

  // --- 4. Other agent markdown / raw text ----------------------------------
  const source = detectSourceFromText(text);
  const isMarkdown =
    ext === "md" || MD_HEADING_RE.test(text) || MD_ROLE_RE.test(text);
  if (isMarkdown && source !== "unknown") {
    reasons.push("Markdown transcript with agent markers.");
  }

  const quality = scoreRawQuality(text, reasons);
  const format: InputFormat =
    isMarkdown && (source === "cursor" || source === "claude_code_cli")
      ? "markdown_export"
      : "raw_text";

  if (quality === "insufficient") {
    return finalize("unknown", source, quality, reasons.length ? reasons : [
      "No commands, errors, file edits, or tool activity could be detected.",
    ]);
  }
  return finalize(format, source, quality, reasons);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function claudeCodeSignals(text: string): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  if (CLAUDE_CODE_BANNER_RE.test(text)) {
    score += 2;
    reasons.push("Claude Code version banner present.");
  }
  if (EXPORT_CMD_RE.test(text)) {
    score += 1;
    reasons.push("/export command marker present.");
  }
  if (CLI_PROMPT_RE.test(text) && CLI_BULLET_RE.test(text)) {
    score += 1;
    reasons.push("Terminal prompt (❯) and assistant activity bullets (●/⏺) present.");
  }
  if (TOOL_SUMMARY_RE.test(text)) {
    score += 1;
    reasons.push("Tool-activity summaries (Read files / Ran command / Committed) present.");
  }
  if (CLAUDE_MODEL_LINE_RE.test(text) && WORKING_DIR_RE.test(text)) {
    score += 1;
    reasons.push("Model line and working-directory path present.");
  }
  return { score, reasons };
}

/** Best-effort source hint from text content (no quality judgment). */
export function detectSourceFromText(text: string): SourceHint {
  const t = text ?? "";
  if (CURSOR_RE.test(t)) return "cursor";
  if (
    CLAUDE_CODE_BANNER_RE.test(t) ||
    EXPORT_CMD_RE.test(t) ||
    (CLI_BULLET_RE.test(t) && (COMMAND_RE.test(t) || TOOL_SUMMARY_RE.test(t)))
  ) {
    return "claude_code_cli";
  }
  if (CODEX_RE.test(t)) return "codex_cli";
  // Generic Claude conversation without terminal/tool markers → desktop/web.
  if (CLAUDE_MODEL_LINE_RE.test(t) || /\bclaude\b|\banthropic\b/i.test(t)) {
    return "claude_desktop_web";
  }
  if (COMMAND_RE.test(t) || FILE_EDIT_RE.test(t)) return "generic_agent";
  return "unknown";
}

/**
 * Score raw/markdown text quality honestly:
 *  - commands + errors/edits → medium
 *  - some execution evidence → limited
 *  - no execution evidence (pure prose/summary) → insufficient
 */
function scoreRawQuality(text: string, reasons: string[]): SourceQuality {
  const hasCommand = COMMAND_RE.test(text);
  const hasError = ERROR_RE.test(text);
  const hasEdit = FILE_EDIT_RE.test(text);
  const signals = [hasCommand, hasError, hasEdit].filter(Boolean).length;

  if (hasCommand && (hasError || hasEdit)) {
    reasons.push("Visible commands plus errors and/or file edits.");
    return "medium";
  }
  if (signals >= 1) {
    reasons.push("Some execution evidence visible, but limited.");
    return "limited";
  }
  reasons.push("No execution evidence (commands/errors/edits) — likely a prose summary.");
  return "insufficient";
}

function finalize(
  format: InputFormat,
  source: SourceHint,
  sourceQuality: SourceQuality,
  reasons: string[],
): SessionInputDetection {
  return {
    format,
    source,
    sourceQuality,
    reasons,
    formatLabel: INPUT_FORMAT_LABELS[format],
    sourceLabel: SOURCE_HINT_LABELS[source],
    sourceQualityLabel: SOURCE_QUALITY_LABELS[sourceQuality],
  };
}

/**
 * Whether a given source quality may produce ACTIVE workspace rules.
 * - strong / medium → yes (subject to evidence support per finding)
 * - limited         → no active rules (downgrade to needs_review at most)
 * - insufficient    → no rules at all
 */
export function sourceQualityAllowsActiveRules(quality: SourceQuality): boolean {
  return quality === "strong" || quality === "medium";
}

/** Whether a given source quality may produce ANY rules at all. */
export function sourceQualityAllowsAnyRules(quality: SourceQuality): boolean {
  return quality !== "insufficient";
}
