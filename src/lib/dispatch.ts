/**
 * Dispatch — OathLock V2 Phase 2
 * ----------------------------------------------------------------------------
 * A structured, idempotent work-update event, published to a workspace's Wire.
 *
 * Deliberately separate from `agent_run_events` (agent-run-core.ts /
 * agent-run-service.ts): that table is a redacted, short-string status log for
 * ONE run, has no idempotency guarantee, and is never read across runs. A
 * Dispatch is workspace-scoped, carries structured scope/visibility/resolution
 * fields, and is meant to be read cross-run (the Wire) — different shape,
 * different consumer, same "don't fabricate a signal that doesn't exist yet"
 * discipline as everywhere else in this codebase.
 *
 * Only the Dispatch types below have a real, deterministic trigger today.
 * SCOPE_ANNOUNCED and HUMAN_DECISION_REQUIRED are part of the spec's full type
 * list but have no signal to publish them from yet (no scope-declaration
 * mechanism, no outstanding-decision tracking) — they are typed here so the
 * schema is forward-compatible, but nothing in this codebase publishes them.
 */

import { createHash } from "node:crypto";
import { looksLikeSourceCode, SECRET_PATTERNS } from "./agent-run-core";
import { containsActiveContent } from "./agent-join";

export const DISPATCH_SCHEMA_VERSION = "oathlock.dispatch.v1" as const;

export const DISPATCH_TYPES = [
  "RUN_STARTED",
  "SCOPE_ANNOUNCED",
  "WORKING",
  "PHASE_CHANGED",
  "BLOCKED",
  "HUMAN_DECISION_REQUIRED",
  "EVIDENCE_READY",
  "RUN_COMPLETED",
  // Phase 8 (Bounded Assistance) additions — see bounded-assistance.ts.
  "HELP_REQUESTED",
  "CHECK_REQUESTED",
  "CHECK_RESULT_RETURNED",
] as const;

export type DispatchType = (typeof DISPATCH_TYPES)[number];

export function isDispatchType(value: unknown): value is DispatchType {
  return typeof value === "string" && (DISPATCH_TYPES as readonly string[]).includes(value);
}

export const DISPATCH_RESOLUTION_STATES = ["open", "resolved", "expired"] as const;
export type DispatchResolutionState = (typeof DISPATCH_RESOLUTION_STATES)[number];

export interface DispatchInput {
  workspaceId: string;
  runId: string;
  type: DispatchType;
  sender: string;
  /** Short, human-readable summary — same redaction discipline as run events. */
  summary: string;
  /** Optional structured detail (e.g. { phase: "editing files" }). Never raw content. */
  detail?: Record<string, string | number | boolean | null> | null;
  scope?: string[];
  visibility?: "workspace" | "run";
  expiresAt?: string | null;
}

const MAX_SUMMARY_LEN = 200;
const MAX_SCOPE_ITEMS = 50;

/**
 * Deterministic idempotency key: same (workspace, run, type, sender, scope,
 * summary) never produces a second Wire entry, even if the caller retries the
 * publish. Unlike agent_run_events (fire-and-forget, no dedup), this is the
 * whole point of a Dispatch.
 */
export function buildIdempotencyKey(input: {
  workspaceId: string;
  runId: string;
  type: DispatchType;
  sender: string;
  scope?: string[];
  summary: string;
}): string {
  const parts = [
    input.workspaceId,
    input.runId,
    input.type,
    input.sender,
    [...(input.scope ?? [])].sort().join(","),
    input.summary.trim(),
  ].join("|");
  return createHash("sha256").update(parts).digest("hex").slice(0, 32);
}

export interface DispatchValidationIssue {
  field: string;
  message: string;
}

export interface ValidatedDispatch {
  schemaVersion: typeof DISPATCH_SCHEMA_VERSION;
  workspaceId: string;
  runId: string;
  type: DispatchType;
  sender: string;
  summary: string;
  detail: Record<string, string | number | boolean | null> | null;
  scope: string[];
  visibility: "workspace" | "run";
  resolutionState: DispatchResolutionState;
  expiresAt: string | null;
  idempotencyKey: string;
}

export interface DispatchValidationResult {
  ok: boolean;
  errors: DispatchValidationIssue[];
  normalized: ValidatedDispatch | null;
}

/** Same secret/active-content scan as evidence-contract.ts, applied to Dispatch text fields. */
function scanForUnsafeContent(strings: string[]): string | null {
  for (const s of strings) {
    if (containsActiveContent(s)) return "active script or markup content";
    if (looksLikeSourceCode(s)) return "raw source code content";
    for (const [pattern] of SECRET_PATTERNS) {
      if (pattern.test(s)) return "secret-shaped content";
      pattern.lastIndex = 0;
    }
  }
  return null;
}

export function validateDispatch(input: DispatchInput): DispatchValidationResult {
  const errors: DispatchValidationIssue[] = [];

  if (!input.workspaceId) errors.push({ field: "workspaceId", message: "workspaceId is required." });
  if (!input.runId) errors.push({ field: "runId", message: "runId is required." });
  if (!isDispatchType(input.type)) errors.push({ field: "type", message: `Unknown dispatch type: ${String(input.type)}` });
  if (!input.sender.trim()) errors.push({ field: "sender", message: "sender is required." });

  const summary = (input.summary ?? "").replace(/\s+/g, " ").trim();
  if (!summary) errors.push({ field: "summary", message: "summary is required." });
  if (summary.length > MAX_SUMMARY_LEN) errors.push({ field: "summary", message: `summary exceeds ${MAX_SUMMARY_LEN} characters.` });

  const scope = (input.scope ?? []).slice(0, MAX_SCOPE_ITEMS);
  const visibility = input.visibility ?? "workspace";

  const detailStrings = input.detail
    ? Object.values(input.detail).filter((v): v is string => typeof v === "string")
    : [];
  const unsafe = scanForUnsafeContent([summary, ...scope, ...detailStrings]);
  if (unsafe) errors.push({ field: "$", message: `Rejected: ${unsafe} found in dispatch.` });

  if (errors.length > 0) return { ok: false, errors, normalized: null };

  const idempotencyKey = buildIdempotencyKey({
    workspaceId: input.workspaceId,
    runId: input.runId,
    type: input.type,
    sender: input.sender,
    scope,
    summary,
  });

  return {
    ok: true,
    errors: [],
    normalized: {
      schemaVersion: DISPATCH_SCHEMA_VERSION,
      workspaceId: input.workspaceId,
      runId: input.runId,
      type: input.type,
      sender: input.sender,
      summary,
      detail: input.detail ?? null,
      scope,
      visibility,
      resolutionState: "open",
      expiresAt: input.expiresAt ?? null,
      idempotencyKey,
    },
  };
}
