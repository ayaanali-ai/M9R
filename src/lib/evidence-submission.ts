/**
 * Evidence submission — capture, attachment, and attestation as SEPARATE states
 * ----------------------------------------------------------------------------
 * The locked product principle:
 *
 *   Evidence is captured automatically. Trust is assigned by provenance and
 *   policy. Humans are interrupted only for material decisions.
 *
 * Three actions were previously collapsed into one boolean
 * (`human_approved_submission`), which made "an agent produced this" and "a
 * human vouched for this" indistinguishable. They are now distinct:
 *
 *   1. CAPTURE      — always automatic.
 *   2. ATTACHMENT   — automatic once the payload is structured AND clean,
 *                     governed by workspace policy. Never implies approval.
 *   3. ATTESTATION  — a human vouching. Only ever set by a human action.
 *
 * Critically: **risk does not decide whether valid evidence is attached.**
 * A failed test, a rule violation, and a scope deviation are all evidence
 * worth retaining — the record must preserve what actually happened. Risk
 * decides whether the run enters the single human-review queue, which is a
 * separate axis handled by the passport/review layer, not here.
 *
 * Every gate below is deterministic. None of them ask a model whether
 * something "looks safe."
 */

import { createHash } from "node:crypto";
import { EVIDENCE_CONTRACT_SCHEMA_VERSION } from "@/lib/evidence-contract";
import { looksLikeSourceCode, SECRET_PATTERNS } from "@/lib/agent-run-core";
import { redactSession, type RedactionConfidence } from "@/lib/session-redaction";

/** Who produced this submission. Replaces the overloaded approval boolean. */
export type SubmissionOrigin = "agent" | "human" | "system";

/** Where the evidence is in its journey to the durable record. */
export type EvidenceAttachmentStatus = "draft" | "validated" | "attached" | "rejected";

/** Whether a human has personally vouched. Never inferred from attachment. */
export type HumanAttestation = "not_requested" | "pending" | "attested" | "declined";

/**
 * Workspace policy. Only the first two are publicly supported today: fully
 * automatic submission of RAW session transcripts stays disabled until the
 * privacy and state-handling story is more mature.
 */
export type EvidenceSubmissionPolicy =
  /** Structured, validated contracts attach automatically; raw needs a human. */
  | "structured_auto"
  /** Everything waits for explicit human confirmation. */
  | "always_confirm";

export const DEFAULT_EVIDENCE_SUBMISSION_POLICY: EvidenceSubmissionPolicy = "structured_auto";

export interface SubmissionLinkage {
  /** The run this submission claims to belong to. */
  runId: string | null;
  /** The run the authenticated caller is actually bound to. */
  expectedRunId: string | null;
  /** True when the referenced assignment is expired/stale (caller-computed). */
  assignmentStale: boolean;
  /** True when this exact digest was already accepted (caller-computed). */
  alreadySubmitted: boolean;
}

export interface SubmissionInput {
  /** Parsed Evidence Contract, when the agent supplied one. */
  contract: unknown;
  /** Raw session transcript text, when supplied. */
  rawSessionText: string | null;
  /** True only when server-side redaction has actually run on this payload. */
  redactionCompleted: boolean;
  linkage: SubmissionLinkage;
}

export interface SubmissionClassification {
  /** Payload is a well-formed, version-matched, correctly-linked contract. */
  structured: boolean;
  /** Payload carries no secret-shaped or prohibited raw-source content. */
  clean: boolean;
  /** Payload includes a raw session transcript (a privacy-relevant input). */
  containsRawSession: boolean;
  /** Deterministic reasons, for display and for tests. */
  reasons: string[];
}

export interface AttachmentDecision {
  status: EvidenceAttachmentStatus;
  origin: SubmissionOrigin;
  attestation: HumanAttestation;
  /** Stable idempotency key — a retry of the same payload must not duplicate. */
  digest: string;
  /** Human-readable, deterministic explanation. */
  reasons: string[];
}

const MAX_RAW_SESSION_CHARS = 500_000;

/** Stable idempotency key over the meaningful payload, not incidental order. */
export function computeSubmissionDigest(input: {
  contract: unknown;
  rawSessionText: string | null;
  runId: string | null;
}): string {
  const canonical = JSON.stringify({
    contract: input.contract ?? null,
    raw: input.rawSessionText ?? null,
    run: input.runId ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Secret detection runs BOTH detectors, because they are complementary and
 * neither is sufficient alone — verified, not assumed:
 *
 *   - `SECRET_PATTERNS` (agent-run-core) catches OathLock's OWN credentials:
 *     `oak_` tokens, Bearer headers, claim URLs, setup codes, local.json.
 *     It does not know about provider keys.
 *   - `redactSession` (session-redaction) catches THIRD-PARTY provider keys:
 *     Anthropic, OpenAI, Stripe, GitHub, AWS, PEM private keys.
 *     It does not know about `oak_` tokens.
 *
 * The evidence-contract path previously used only the first set. While a human
 * eyeballed every submission via `--approved`, that gap was survivable. With
 * structured contracts attaching automatically it is not: a provider key
 * pasted into a `limitations` field is exactly the likely leak, and it would
 * have persisted straight into the durable record.
 */
function detectSecrets(value: string): { found: boolean; confidence: RedactionConfidence } {
  const redaction = redactSession(value);
  const thirdPartyHits = Object.values(redaction.countsByType).reduce((sum, n) => sum + n, 0);

  const oathlockHits = SECRET_PATTERNS.some(([pattern]) => {
    // Module-level regexes carry /g; reset so .test() is stateless.
    pattern.lastIndex = 0;
    return pattern.test(value);
  });

  return { found: thirdPartyHits > 0 || oathlockHits, confidence: redaction.confidence };
}

/**
 * Deterministic classification. "Structured" and "clean" are independent:
 * a contract can be well-formed but carry a leaked secret, and raw text can be
 * clean but still require consent because it is a whole transcript.
 */
export function classifySubmission(input: SubmissionInput): SubmissionClassification {
  const reasons: string[] = [];

  // ---- Structured -------------------------------------------------------
  let structured = true;
  const body = typeof input.contract === "object" && input.contract !== null
    ? (input.contract as Record<string, unknown>)
    : null;

  if (!body) {
    structured = false;
    reasons.push("No structured Evidence Contract supplied.");
  } else {
    if (body.schemaVersion !== EVIDENCE_CONTRACT_SCHEMA_VERSION) {
      structured = false;
      reasons.push(`Unrecognized evidence schema version (expected ${EVIDENCE_CONTRACT_SCHEMA_VERSION}).`);
    }
    const task = (body.task ?? null) as Record<string, unknown> | null;
    if (!task || typeof task.requested !== "string" || !task.requested.trim()) {
      structured = false;
      reasons.push("Contract is missing the requested task.");
    }
    if (!Array.isArray(body.verification)) {
      structured = false;
      reasons.push("Contract is missing provenance-bearing verification entries.");
    }
  }

  const { linkage } = input;
  if (linkage.expectedRunId && linkage.runId !== linkage.expectedRunId) {
    structured = false;
    reasons.push("Submission run identifier does not match the authenticated run.");
  }
  if (linkage.assignmentStale) {
    structured = false;
    reasons.push("Linked assignment is expired or stale.");
  }

  // ---- Clean ------------------------------------------------------------
  let clean = true;
  if (!input.redactionCompleted) {
    clean = false;
    reasons.push("Server-side redaction did not complete for this payload.");
  }

  const serializedContract = body ? JSON.stringify(body) : "";
  if (serializedContract) {
    const secrets = detectSecrets(serializedContract);
    if (secrets.found) {
      clean = false;
      reasons.push("Secret-shaped content detected in the evidence contract.");
    }
    // Low-confidence redaction is a deterministic review trigger, not a
    // judgement call: if the detector is unsure it cleaned the payload, a
    // human confirms rather than it attaching silently.
    if (secrets.confidence === "low") {
      structured = false;
      reasons.push("Redaction reported low confidence on this payload.");
    }
    if (looksLikeSourceCode(serializedContract)) {
      clean = false;
      reasons.push("Raw source code found in fields that prohibit it.");
    }
  }

  const containsRawSession = typeof input.rawSessionText === "string" && input.rawSessionText.trim().length > 0;
  if (containsRawSession && (input.rawSessionText as string).length > MAX_RAW_SESSION_CHARS) {
    clean = false;
    reasons.push("Raw session transcript exceeds the permitted size.");
  }

  return { structured, clean, containsRawSession, reasons };
}

/**
 * Decide what happens to a submission. Attachment is about VALIDITY and
 * CONSENT — never about whether the run went well. Evidence describing a
 * failure still attaches; the review queue is a separate concern.
 */
export function decideAttachment(input: {
  classification: SubmissionClassification;
  policy: EvidenceSubmissionPolicy;
  origin: SubmissionOrigin;
  /** True only when a human explicitly confirmed THIS submission. */
  humanConfirmed: boolean;
  digest: string;
}): AttachmentDecision {
  const { classification: c, policy, origin, humanConfirmed, digest } = input;

  // A human confirming a submission is an attestation; an agent or the system
  // submitting is never converted into one, no matter how clean the payload.
  const attestation: HumanAttestation = humanConfirmed ? "attested" : "not_requested";
  const reasons = [...c.reasons];

  // Invalid or unclean payloads never enter the durable record.
  if (!c.clean) {
    return { status: "rejected", origin, attestation, digest, reasons };
  }
  if (!c.structured && !c.containsRawSession) {
    return { status: "rejected", origin, attestation, digest, reasons };
  }

  // An explicit human confirmation always suffices.
  if (humanConfirmed) {
    reasons.push("Attached after explicit human confirmation.");
    return { status: "attached", origin, attestation: "attested", digest, reasons };
  }

  if (policy === "always_confirm") {
    reasons.push("Workspace policy requires human confirmation for all evidence.");
    return { status: "validated", origin, attestation: "pending", digest, reasons };
  }

  // structured_auto: a whole session transcript is a privacy-relevant upload
  // and needs consent even when it is clean and well-formed.
  if (c.containsRawSession) {
    reasons.push("Raw session transcripts require human confirmation before attachment.");
    return { status: "validated", origin, attestation: "pending", digest, reasons };
  }

  if (!c.structured) {
    reasons.push("Low-confidence payload requires human confirmation.");
    return { status: "validated", origin, attestation: "pending", digest, reasons };
  }

  reasons.push("Structured evidence validated and attached automatically.");
  return { status: "attached", origin, attestation: "not_requested", digest, reasons };
}
