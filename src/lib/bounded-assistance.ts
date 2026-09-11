/**
 * Bounded Assistance — OathLock V2 Phase 8
 * ----------------------------------------------------------------------------
 * Pure helpers for HELP_REQUESTED / CHECK_REQUESTED coordination requests.
 * The actual DB writes (publish the Dispatch, atomically claim it, create the
 * Linked Run) live in the API routes — this module only computes usage
 * against a CoordinationPolicy (run-mode.ts) and validates a request payload.
 *
 * Guardrails this enforces (see master spec §13, §8 acceptance criteria):
 *  - Every request has a specific expected result (a required `need` string).
 *  - A Linked (supporting) Run gets its own identity and scope — never a full
 *    conversation dump (the request carries only `need`/`allowed`/`not_allowed`,
 *    same size/content discipline as Dispatch summaries).
 *  - Requests are counted against the ISSUING run's own budget — the current
 *    usage the caller passes in must be real counts read from real Dispatch
 *    rows, never assumed.
 */

import { looksLikeSourceCode, SECRET_PATTERNS } from "./agent-run-core";
import { containsActiveContent } from "./agent-join";
import { checkBudget, type CoordinationPolicy, type CoordinationUsage, type BudgetCheckResult } from "./run-mode";

export type BoundedRequestType = "HELP_REQUESTED" | "CHECK_REQUESTED";

export interface BoundedRequestInput {
  type: BoundedRequestType;
  need: string;
  allowed?: string;
  notAllowed?: string;
}

const MAX_FIELD_LEN = 300;

export interface BoundedRequestValidationResult {
  ok: boolean;
  errors: string[];
  summary: string | null;
}

/** Validate a request payload and render it into a Dispatch-safe summary string. */
export function validateBoundedRequest(input: BoundedRequestInput): BoundedRequestValidationResult {
  const errors: string[] = [];
  const need = (input.need ?? "").replace(/\s+/g, " ").trim();
  if (!need) errors.push("need is required — every request must have a specific expected result.");
  if (need.length > MAX_FIELD_LEN) errors.push(`need exceeds ${MAX_FIELD_LEN} characters.`);

  const allowed = (input.allowed ?? "").trim();
  const notAllowed = (input.notAllowed ?? "").trim();

  const strings = [need, allowed, notAllowed].filter(Boolean);
  for (const s of strings) {
    if (containsActiveContent(s)) errors.push("Rejected: active script or markup content in the request.");
    if (looksLikeSourceCode(s)) errors.push("Rejected: raw source code content in the request.");
    for (const [pattern] of SECRET_PATTERNS) {
      if (pattern.test(s)) errors.push("Rejected: secret-shaped content in the request.");
      pattern.lastIndex = 0;
    }
  }

  if (errors.length > 0) return { ok: false, errors, summary: null };

  const parts = [`need: ${need}`];
  if (allowed) parts.push(`allowed: ${allowed}`);
  if (notAllowed) parts.push(`not allowed: ${notAllowed}`);
  return { ok: true, errors: [], summary: parts.join(" · ") };
}

/** Same budget check as run-mode.ts, named for this call site's intent. */
export function canIssueRequest(policy: CoordinationPolicy, usage: CoordinationUsage): BudgetCheckResult {
  return checkBudget(policy, usage);
}
