/**
 * Finding — OathLock V2 Phase 5 (Reviewed Findings)
 * ----------------------------------------------------------------------------
 * A structured observation derived from a Run. Findings do NOT become
 * reusable Workspace knowledge solely because an agent published them — a
 * human must review and approve one before later runs can see it (same
 * "agents cannot promote their own work" discipline as workspace-rules.ts).
 *
 * Lifecycle: observed → (human reviews) → available | retired.
 * A later run may cite an available Finding — that's an Adoption
 * (finding-service.ts). Adoption never implies causality (see
 * buildAdoptionSummary below): it means a later reviewed run used or cited
 * the Finding, not that the Finding caused that run's outcome.
 */

import { looksLikeSourceCode, SECRET_PATTERNS } from "./agent-run-core";
import { containsActiveContent } from "./agent-join";

export const FINDING_SCHEMA_VERSION = "m9r.finding.v1" as const;

export const FINDING_REVIEW_STATES = ["observed", "available", "retired"] as const;
export type FindingReviewState = (typeof FINDING_REVIEW_STATES)[number];

export const FINDING_EVIDENCE_LEVELS = ["inferred", "correlated", "command_tied"] as const;
export type FindingEvidenceLevel = (typeof FINDING_EVIDENCE_LEVELS)[number];

export interface FindingInput {
  workspaceId: string;
  originatingRunId: string;
  originatingSender: string;
  title: string;
  applicableEnvironment: string;
  observedBehavior: string;
  evidenceLevel: FindingEvidenceLevel;
  suggestedResponse: string;
  knownLimitations: string[];
}

const MAX_FIELD_LEN = 400;
const MAX_LIMITATIONS = 20;

export interface FindingValidationIssue {
  field: string;
  message: string;
}

export interface ValidatedFinding {
  schemaVersion: typeof FINDING_SCHEMA_VERSION;
  workspaceId: string;
  originatingRunId: string;
  originatingSender: string;
  title: string;
  applicableEnvironment: string;
  observedBehavior: string;
  evidenceLevel: FindingEvidenceLevel;
  suggestedResponse: string;
  knownLimitations: string[];
  reviewState: "observed";
}

export interface FindingValidationResult {
  ok: boolean;
  errors: FindingValidationIssue[];
  normalized: ValidatedFinding | null;
}

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

function requiredField(value: string, field: string, errors: FindingValidationIssue[]): string {
  const trimmed = (value ?? "").replace(/\s+/g, " ").trim();
  if (!trimmed) errors.push({ field, message: `${field} is required.` });
  if (trimmed.length > MAX_FIELD_LEN) errors.push({ field, message: `${field} exceeds ${MAX_FIELD_LEN} characters.` });
  return trimmed;
}

export function validateFinding(input: FindingInput): FindingValidationResult {
  const errors: FindingValidationIssue[] = [];

  if (!input.workspaceId) errors.push({ field: "workspaceId", message: "workspaceId is required." });
  if (!input.originatingRunId) errors.push({ field: "originatingRunId", message: "originatingRunId is required." });
  if (!input.originatingSender.trim()) errors.push({ field: "originatingSender", message: "originatingSender is required." });
  if (!FINDING_EVIDENCE_LEVELS.includes(input.evidenceLevel)) {
    errors.push({ field: "evidenceLevel", message: `evidenceLevel must be one of: ${FINDING_EVIDENCE_LEVELS.join(", ")}.` });
  }

  const title = requiredField(input.title, "title", errors);
  const applicableEnvironment = requiredField(input.applicableEnvironment, "applicableEnvironment", errors);
  const observedBehavior = requiredField(input.observedBehavior, "observedBehavior", errors);
  const suggestedResponse = requiredField(input.suggestedResponse, "suggestedResponse", errors);
  const knownLimitations = (input.knownLimitations ?? []).slice(0, MAX_LIMITATIONS);

  const unsafe = scanForUnsafeContent([title, applicableEnvironment, observedBehavior, suggestedResponse, ...knownLimitations]);
  if (unsafe) errors.push({ field: "$", message: `Rejected: ${unsafe} found in finding.` });

  if (errors.length > 0) return { ok: false, errors, normalized: null };

  return {
    ok: true,
    errors: [],
    normalized: {
      schemaVersion: FINDING_SCHEMA_VERSION,
      workspaceId: input.workspaceId,
      originatingRunId: input.originatingRunId,
      originatingSender: input.originatingSender,
      title,
      applicableEnvironment,
      observedBehavior,
      evidenceLevel: input.evidenceLevel,
      suggestedResponse,
      knownLimitations,
      reviewState: "observed",
    },
  };
}

export type AdoptionConfirmation = "confirmed" | "needs_review" | "contradicted";

export interface AdoptionSummaryInput {
  totalAdoptions: number;
  confirmed: number;
  contradicted: number;
}

/**
 * The only sentence allowed to describe Adoption counts. Enforces the claim
 * discipline from the master spec: Adoption is not an upvote and never
 * implies causality — "adopted in N later reviewed Runs," never "caused N
 * successful Runs."
 */
export function summarizeAdoptions(input: AdoptionSummaryInput): string {
  if (input.totalAdoptions === 0) return "Not yet adopted by a later reviewed run.";
  const parts = [`Adopted in ${input.totalAdoptions} later reviewed run${input.totalAdoptions === 1 ? "" : "s"}`];
  if (input.confirmed > 0) parts.push(`confirmed in ${input.confirmed}`);
  if (input.contradicted > 0) parts.push(`contradicted in ${input.contradicted}`);
  return parts.join(", ") + ".";
}
