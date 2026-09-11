/**
 * Planning-diagnostic redaction — Phase 5C §9.
 * ----------------------------------------------------------------------------
 * Thin, IO-free wrapper around `session-redaction.ts`'s `redactSession` —
 * that module already redacts the exact secret shapes this spec calls out
 * (API keys, bearer tokens, Authorization headers, DB connection strings,
 * PEM private-key blocks, `VAR=value` env assignments) and is already pure
 * and dependency-free, so it is reused rather than reimplemented. This
 * module adds only the planning-diagnostics-specific policy on top: a
 * content-status classification and a hard size cap, matching what
 * `mission-planning-diagnostics-store.ts` needs before it will persist
 * anything.
 */

import { redactSession, type RedactionResult } from "../session-redaction";

export type DiagnosticContentStatus = "not_stored" | "redacted" | "fully_removed" | "unavailable" | "rejected_unsafe";

export interface RedactForDiagnosticsResult {
  text: string;
  status: DiagnosticContentStatus;
  redaction: RedactionResult;
  truncated: boolean;
}

/** Bound applied to any redacted text before it is handed to the diagnostic store. */
export const MAX_DIAGNOSTIC_TEXT_CHARS = 2_000;

/**
 * Redact arbitrary text (a raw model response, a validation-error blob, a
 * repair-feedback string) for diagnostic storage. Never stores the input
 * verbatim; always bounds the result.
 */
export function redactForDiagnostics(input: string | null | undefined): RedactForDiagnosticsResult {
  if (input == null) {
    return { text: "", status: "not_stored", redaction: redactSession(""), truncated: false };
  }
  const redaction = redactSession(input);
  const truncated = redaction.redactedText.length > MAX_DIAGNOSTIC_TEXT_CHARS;
  const text = truncated ? `${redaction.redactedText.slice(0, MAX_DIAGNOSTIC_TEXT_CHARS)}…[truncated]` : redaction.redactedText;
  // `low` confidence (mostly heuristic hits on noisy input) is treated as
  // unsafe to persist as-is — the diagnostic store falls back to a status
  // marker rather than storing text it cannot vouch for.
  const status: DiagnosticContentStatus = redaction.confidence === "low" ? "rejected_unsafe" : "redacted";
  return { text: status === "rejected_unsafe" ? "" : text, status, redaction, truncated };
}
