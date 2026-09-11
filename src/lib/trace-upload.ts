/**
 * Trace Upload Service — OathLock Phase 1
 *
 * Responsible for taking a raw agent execution trace (uploaded as a JSON file
 * or a raw JSON object), validating its basic structure, deriving lightweight
 * metadata, and persisting it to the `traces` table in Supabase.
 *
 * Design principles (Phase 1):
 * - Validate conservatively and fail with clear, typed errors.
 * - Never fabricate metadata: derived fields come only from what is present.
 * - Store the complete raw payload as JSONB for faithful re-processing.
 * - Keep the surface small: one `uploadTrace()` entry point plus a pure,
 *   easily-testable validation/extraction helper.
 */

import { supabase } from "@/lib/supabase";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Maximum accepted trace size in bytes (measured on the serialized JSON).
 * 2 MB is comfortable for Phase 1 traces while protecting the DB and the
 * JSONB column from abuse. Larger traces should move to object storage later.
 */
export const MAX_TRACE_BYTES = 2_000_000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Base error for the upload pipeline. Carries a machine-readable `code` and an
 * HTTP `status` so the API route can translate failures into responses without
 * leaking internal detail.
 */
export class TraceUploadError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "TraceUploadError";
    this.code = code;
    this.status = status;
  }
}

/** Input is structurally invalid (bad shape, missing fields, too large). */
export class TraceValidationError extends TraceUploadError {
  constructor(message: string) {
    super(message, "TRACE_VALIDATION_ERROR", 400);
    this.name = "TraceValidationError";
  }
}

/** Persistence failed (DB unavailable or insert rejected). */
export class TracePersistenceError extends TraceUploadError {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message, "TRACE_PERSISTENCE_ERROR", 500);
    this.name = "TracePersistenceError";
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Result + intermediate types
// ---------------------------------------------------------------------------

/** A single step as it may appear in a raw (snake or camel case) trace. */
interface RawStep {
  errors?: unknown;
  retries?: unknown;
  actor?: unknown;
  model?: unknown;
  token_usage?: unknown;
  tokenUsage?: unknown;
  estimated_cost_usd?: unknown;
  estimatedCostUsd?: unknown;
}

/** Lightweight, denormalized metadata derived from a validated trace. */
export interface TraceMetadata {
  sessionId: string | null;
  taskSummary: string | null;
  schema: string | null;
  variant: string | null;
  provenance: string | null;
  startedAt: string | null;
  endedAt: string | null;
  stepCount: number;
  failedStepCount: number;
  retryCount: number;
  distinctActors: string[];
  hasTokenUsage: boolean;
  hasCostData: boolean;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  /** Serialized byte size of the raw payload. */
  byteSize: number;
}

/** The record returned to callers after a successful upload. */
export interface UploadedTrace {
  id: string;
  sessionId: string | null;
  taskSummary: string | null;
  projectId: string | null;
  stepCount: number;
  hasTokenUsage: boolean;
  byteSize: number;
  createdAt: string;
}

/** Optional metadata about the originating file (multipart uploads). */
export interface TraceFileInfo {
  originalFilename?: string | null;
  contentType?: string | null;
}

// ---------------------------------------------------------------------------
// Internal helpers (snake_case / camelCase tolerant accessors)
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Return the first defined string among the provided values, trimmed. */
function firstString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return null;
}

/** Read a numeric field, tolerating numeric strings; null when absent. */
function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return null;
}

/** Extract a token-usage object (snake or camel) from a step. */
function stepTokenUsage(step: RawStep): Record<string, unknown> | null {
  const usage = step.token_usage ?? step.tokenUsage;
  return isPlainObject(usage) ? usage : null;
}

// ---------------------------------------------------------------------------
// Validation + metadata extraction (PURE — no I/O, safe to unit test)
// ---------------------------------------------------------------------------

/**
 * Validate the basic structure of a raw trace and derive denormalized metadata.
 *
 * Throws {@link TraceValidationError} when the payload is not a usable trace:
 * - not a JSON object
 * - missing/empty `steps` array
 * - missing a session identifier (`sessionId` or `session_id`)
 * - serialized size exceeds {@link MAX_TRACE_BYTES}
 *
 * This function performs NO persistence and has no external dependencies, which
 * keeps the rules of "what counts as a valid trace" in one testable place.
 */
export function validateAndExtractTraceMeta(data: unknown): TraceMetadata {
  // --- Shape checks --------------------------------------------------------
  if (!isPlainObject(data)) {
    throw new TraceValidationError(
      "Trace must be a JSON object (received " +
        (Array.isArray(data) ? "an array" : typeof data) +
        ").",
    );
  }

  const stepsRaw = (data.steps ?? data["steps"]) as unknown;
  if (!Array.isArray(stepsRaw)) {
    throw new TraceValidationError("Trace must contain a 'steps' array.");
  }
  if (stepsRaw.length === 0) {
    throw new TraceValidationError("Trace 'steps' array must not be empty.");
  }

  const sessionId = firstString(data.sessionId, data.session_id);
  if (!sessionId) {
    throw new TraceValidationError(
      "Trace must include a non-empty 'sessionId' (or 'session_id').",
    );
  }

  // --- Size guard ----------------------------------------------------------
  // Measure the serialized JSON; this is what we will store in JSONB.
  let byteSize: number;
  try {
    byteSize = Buffer.byteLength(JSON.stringify(data), "utf8");
  } catch {
    // Circular structures or values that cannot be serialized.
    throw new TraceValidationError("Trace payload is not serializable as JSON.");
  }
  if (byteSize > MAX_TRACE_BYTES) {
    throw new TraceValidationError(
      `Trace is too large (${byteSize} bytes). Limit is ${MAX_TRACE_BYTES} bytes.`,
    );
  }

  // --- Derive metadata (only from data that is actually present) -----------
  const steps = stepsRaw as RawStep[];

  let failedStepCount = 0;
  let hasTokenUsage = false;
  let hasCostData = false;
  let totalInputTokens: number | null = null;
  let totalOutputTokens: number | null = null;
  let summedRetries = 0;
  const actors = new Set<string>();

  for (const step of steps) {
    if (!isPlainObject(step)) continue;

    // Failed steps: any step carrying at least one error entry.
    if (Array.isArray(step.errors) && step.errors.length > 0) failedStepCount += 1;

    // Retries summed across steps (used only if totals.retries is absent).
    const stepRetries = asNumber(step.retries);
    if (stepRetries != null) summedRetries += stepRetries;

    // Distinct actors observed.
    if (typeof step.actor === "string" && step.actor.trim() !== "") {
      actors.add(step.actor.trim());
    }

    // Token usage presence + running totals.
    const usage = stepTokenUsage(step);
    if (usage) {
      hasTokenUsage = true;
      const input = asNumber(usage.input);
      const output = asNumber(usage.output);
      if (input != null) totalInputTokens = (totalInputTokens ?? 0) + input;
      if (output != null) totalOutputTokens = (totalOutputTokens ?? 0) + output;
    }

    // Cost presence.
    if (asNumber(step.estimated_cost_usd ?? step.estimatedCostUsd) != null) {
      hasCostData = true;
    }
  }

  // Prefer an explicit totals block when present (more authoritative than sums).
  const totals = isPlainObject(data.totals) ? data.totals : null;
  const totalsRetries = totals ? asNumber(totals.retries) : null;
  const totalsTokenUsage =
    totals && isPlainObject(totals.token_usage)
      ? totals.token_usage
      : totals && isPlainObject(totals.tokenUsage)
        ? totals.tokenUsage
        : null;
  if (totalsTokenUsage) {
    hasTokenUsage = hasTokenUsage || asNumber(totalsTokenUsage.total) != null;
    const ti = asNumber(totalsTokenUsage.input);
    const to = asNumber(totalsTokenUsage.output);
    if (ti != null) totalInputTokens = ti;
    if (to != null) totalOutputTokens = to;
  }

  // actorsObserved on the trace itself supplements per-step actors.
  const actorsObserved = data.actorsObserved ?? data.actors_observed;
  if (Array.isArray(actorsObserved)) {
    for (const a of actorsObserved) {
      if (typeof a === "string" && a.trim() !== "") actors.add(a.trim());
    }
  }

  return {
    sessionId,
    taskSummary: firstString(data.taskSummary, data.task_summary, data.task),
    schema: firstString(data.schema),
    variant: firstString(data.variant),
    provenance: firstString(data.provenance),
    startedAt: firstString(data.startedAt, data.started_at),
    endedAt: firstString(data.endedAt, data.ended_at),
    stepCount: steps.length,
    failedStepCount,
    retryCount: totalsRetries ?? summedRetries,
    distinctActors: [...actors],
    hasTokenUsage,
    hasCostData,
    totalInputTokens,
    totalOutputTokens,
    byteSize,
  };
}

// ---------------------------------------------------------------------------
// Public API: uploadTrace
// ---------------------------------------------------------------------------

/**
 * Validate and persist a raw agent trace.
 *
 * Flow:
 *   1. Validate `userId` (and `projectId` when supplied).
 *   2. Validate the trace structure + derive metadata (pure helper).
 *   3. Insert a row into `traces` with the raw payload stored as JSONB.
 *   4. Return the created trace id and basic metadata.
 *
 * @param data       The raw trace object (already JSON-parsed).
 * @param userId     The owning user id (required; the `traces.user_id` FK).
 * @param projectId  Optional project id. The Phase 1 schema marks
 *                   `traces.project_id` NOT NULL, so when omitted the insert is
 *                   rejected and a clear validation error is raised.
 * @param fileInfo   Optional originating-file metadata (multipart uploads).
 *
 * @throws {TraceValidationError}  invalid input.
 * @throws {TracePersistenceError} database unavailable or insert failed.
 */
export async function uploadTrace(
  data: unknown,
  userId: string,
  projectId?: string,
  fileInfo?: TraceFileInfo,
): Promise<UploadedTrace> {
  // --- 1. Caller-context validation ----------------------------------------
  if (typeof userId !== "string" || userId.trim() === "") {
    throw new TraceValidationError("userId is required and must be a non-empty string.");
  }
  if (projectId !== undefined && (typeof projectId !== "string" || projectId.trim() === "")) {
    throw new TraceValidationError("projectId, when provided, must be a non-empty string.");
  }
  if (!projectId) {
    // Surface the schema constraint explicitly rather than letting the DB
    // reject a NULL with an opaque error.
    throw new TraceValidationError(
      "projectId is required to upload a trace in Phase 1 (traces.project_id is NOT NULL).",
    );
  }

  // --- 2. Trace validation + metadata --------------------------------------
  const meta = validateAndExtractTraceMeta(data);

  // --- 3. Persist ----------------------------------------------------------
  if (!supabase) {
    throw new TracePersistenceError(
      "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    );
  }

  const insertPayload = {
    user_id: userId,
    project_id: projectId,
    session_id: meta.sessionId,
    task_summary: meta.taskSummary,
    schema: meta.schema,
    format: meta.schema, // Phase 1: format mirrors the declared schema.
    variant: meta.variant,
    provenance: meta.provenance,
    started_at: meta.startedAt,
    ended_at: meta.endedAt,
    step_count: meta.stepCount,
    failed_step_count: meta.failedStepCount,
    retry_count: meta.retryCount,
    distinct_actors: meta.distinctActors,
    has_token_usage: meta.hasTokenUsage,
    has_cost_data: meta.hasCostData,
    total_input_tokens: meta.totalInputTokens,
    total_output_tokens: meta.totalOutputTokens,
    raw_payload: data,
    original_filename: fileInfo?.originalFilename ?? null,
    content_type: fileInfo?.contentType ?? null,
    byte_size: meta.byteSize,
  };

  const { data: inserted, error } = await supabase
    .from("traces")
    .insert(insertPayload)
    .select("id, session_id, task_summary, project_id, step_count, has_token_usage, byte_size, created_at")
    .single();

  if (error || !inserted) {
    // Translate common DB failures into clear, actionable messages.
    // (Log only the DB error — never the trace content.)
    const code = (error as { code?: string } | null)?.code;
    if (code === "23503") {
      // Foreign-key violation: userId or projectId doesn't exist.
      throw new TracePersistenceError(
        "Couldn't save: the provided userId or projectId doesn't exist. " +
          "Use ids that already exist in your users and projects tables.",
        error?.message ?? error,
      );
    }
    if (code === "42P01") {
      throw new TracePersistenceError(
        "Couldn't save: the 'traces' table is missing. Run the Phase 1 schema (supabase-oathlock-phase1.sql).",
        error?.message ?? error,
      );
    }
    throw new TracePersistenceError(
      "Couldn't save the trace to the database. Report generation still works without saving.",
      error?.message ?? error,
    );
  }

  // --- 4. Return a clean, typed record -------------------------------------
  return {
    id: inserted.id as string,
    sessionId: (inserted.session_id as string) ?? null,
    taskSummary: (inserted.task_summary as string) ?? null,
    projectId: (inserted.project_id as string) ?? null,
    stepCount: (inserted.step_count as number) ?? meta.stepCount,
    hasTokenUsage: Boolean(inserted.has_token_usage),
    byteSize: (inserted.byte_size as number) ?? meta.byteSize,
    createdAt: (inserted.created_at as string) ?? new Date().toISOString(),
  };
}
