// CLI-compatible stub (pure function module) for importing a recorded session.
//
// This is NOT a wired executable — the repo has no CLI runner and Test Case 008
// is a spec + stub only. These pure functions are what a future CLI (or API
// route) would call. No filesystem, no process, no external calls here.

import {
  recordedSessionToNormalizedTrace,
} from "@/lib/recorded-session-adapter";
import {
  RECORDED_SCHEMA_VERSION,
  type RecordedCodingSession,
} from "@/lib/trace-recorder-schema";
import type { NormalizedManualTrace } from "@/lib/manual-trace-normalizer";

export type RecordedImportResult =
  | { ok: true; trace: NormalizedManualTrace }
  | { ok: false; error: string };

// Minimal structural validation — enough to fail loudly on the wrong shape
// without pulling in a schema-validation dependency.
export function parseRecordedSession(
  raw: string,
): { ok: true; session: RecordedCodingSession } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Input is not valid JSON." };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, error: "Recorded session must be a JSON object." };
  }
  const s = parsed as Record<string, unknown>;
  if (s.schemaVersion !== RECORDED_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `Expected schemaVersion "${RECORDED_SCHEMA_VERSION}".`,
    };
  }
  for (const arrayField of ["filesChanged", "commandsRun", "modelCalls", "toolCalls", "knownErrors", "notes"]) {
    if (!Array.isArray(s[arrayField])) {
      return { ok: false, error: `Field "${arrayField}" must be an array.` };
    }
  }
  if (typeof s.runName !== "string" || typeof s.objective !== "string") {
    return { ok: false, error: "runName and objective must be strings." };
  }
  return { ok: true, session: parsed as RecordedCodingSession };
}

// The function a CLI/API would call: raw JSON string -> normalized trace.
export function importRecordedSessionJson(raw: string): RecordedImportResult {
  const parsed = parseRecordedSession(raw);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, trace: recordedSessionToNormalizedTrace(parsed.session) };
}
