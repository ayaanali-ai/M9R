// Trace Recorder Schema (v0) — the documented shape RunLeak will eventually
// capture from AI coding sessions. This is a SPEC + types only. No live
// recording, no SDK, no storage, no external API calls live here.
//
// CLAIM DISCIPLINE: A recorded session carries ONLY explicitly provided usage
// metadata. Nothing is estimated or invented. Energy/heat are never recorder-
// measured; they remain configurable estimates elsewhere. See docs/claims.md.

export type RecordedModelCall = {
  id: string;
  provider?: "openai" | "anthropic" | "google" | "xai" | "local" | "unknown";
  model?: string;
  startedAt?: string;
  endedAt?: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  costUsd?: number | null;
  latencyMs?: number | null;
  promptSummary?: string;
  outputSummary?: string;
  // Optional outcome. Missing = unknown/null. A failed call may set success
  // false + errorSummary; usage is NEVER inferred for failed calls.
  success?: boolean | null;
  errorSummary?: string;
};

export type RecordedToolCall = {
  id: string;
  toolName: string;
  startedAt?: string;
  endedAt?: string;
  latencyMs?: number | null;
  success?: boolean | null;
  inputSummary?: string;
  outputSummary?: string;
  errorSummary?: string;
};

export type RecordedCodingSession = {
  schemaVersion: "runleak.recorded.v0";
  runName: string;
  objective: string;
  source: "manual" | "claude_code" | "codex" | "opencode" | "generic";
  startedAt?: string;
  endedAt?: string;
  filesChanged: string[];
  commandsRun: string[];
  modelCalls: RecordedModelCall[];
  toolCalls: RecordedToolCall[];
  buildResult?: "pass" | "fail" | "unknown";
  lintResult?: "pass" | "fail" | "unknown";
  knownErrors: string[];
  notes: string[];
};

export const RECORDED_SCHEMA_VERSION = "runleak.recorded.v0" as const;
