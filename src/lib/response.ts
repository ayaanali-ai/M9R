/**
 * Response — OathLock V2 Phase 3 (Run Rooms)
 * ----------------------------------------------------------------------------
 * A typed, scoped reaction to a Dispatch — the other half of the Run Room. A
 * Dispatch is a broadcast; a Response is scoped to one Dispatch/run and always
 * carries type/sender/recipient/scope/resolution_state so the Run Room can
 * never degrade into unrestricted chat (per the master spec's explicit
 * guardrail against exactly that).
 *
 * Deliberately distinct from the existing human_review decision mechanism
 * (run-review-decision-service.ts, HumanRunReview: reviewed/needs_follow_up/
 * not_accepted). That is the FINAL disposition of a Run, already built and
 * load-bearing (Run Passport, Approval Center). A Response is a mid-run
 * structured exchange — an agent asking for a decision, an Operator answering,
 * a clarification — that happens zero or more times before the final review.
 * They are not the same concept and this module does not touch that one.
 */

import { looksLikeSourceCode, SECRET_PATTERNS } from "./agent-run-core";
import { containsActiveContent } from "./agent-join";

export const RESPONSE_SCHEMA_VERSION = "oathlock.response.v1" as const;

export const RESPONSE_TYPES = [
  "acknowledgement",
  "clarification",
  "finding",
  "artifact",
  "scope_decision",
  "acceptance",
  "dispute",
  "human_instruction",
  "resolution",
] as const;

export type ResponseType = (typeof RESPONSE_TYPES)[number];

export function isResponseType(value: unknown): value is ResponseType {
  return typeof value === "string" && (RESPONSE_TYPES as readonly string[]).includes(value);
}

/** Response types that close out the Dispatch they answer. Everything else leaves it open. */
const RESOLVING_TYPES: ReadonlySet<ResponseType> = new Set(["acceptance", "dispute", "resolution", "scope_decision"]);

export function resolvesDispatch(type: ResponseType): boolean {
  return RESOLVING_TYPES.has(type);
}

export type ResponseSenderRole = "agent" | "operator";

export interface ResponseInput {
  workspaceId: string;
  runId: string;
  /** The Dispatch being responded to. Null for a freestanding run-level note. */
  dispatchId: string | null;
  type: ResponseType;
  senderRole: ResponseSenderRole;
  sender: string;
  /** Who this is addressed to — "operator", or a Callsign/sender identifier. */
  recipient: string;
  body: string;
  scope?: string[];
}

const MAX_BODY_LEN = 400;
const MAX_SCOPE_ITEMS = 50;

export interface ResponseValidationIssue {
  field: string;
  message: string;
}

export interface ValidatedResponse {
  schemaVersion: typeof RESPONSE_SCHEMA_VERSION;
  workspaceId: string;
  runId: string;
  dispatchId: string | null;
  type: ResponseType;
  senderRole: ResponseSenderRole;
  sender: string;
  recipient: string;
  body: string;
  scope: string[];
  resolutionState: "open" | "resolved";
}

export interface ResponseValidationResult {
  ok: boolean;
  errors: ResponseValidationIssue[];
  normalized: ValidatedResponse | null;
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

export function validateResponse(input: ResponseInput): ResponseValidationResult {
  const errors: ResponseValidationIssue[] = [];

  if (!input.workspaceId) errors.push({ field: "workspaceId", message: "workspaceId is required." });
  if (!input.runId) errors.push({ field: "runId", message: "runId is required." });
  if (!isResponseType(input.type)) errors.push({ field: "type", message: `Unknown response type: ${String(input.type)}` });
  if (input.senderRole !== "agent" && input.senderRole !== "operator") {
    errors.push({ field: "senderRole", message: `senderRole must be "agent" or "operator".` });
  }
  if (!input.sender.trim()) errors.push({ field: "sender", message: "sender is required." });
  if (!input.recipient.trim()) errors.push({ field: "recipient", message: "recipient is required." });

  const body = (input.body ?? "").replace(/\s+/g, " ").trim();
  if (!body) errors.push({ field: "body", message: "body is required." });
  if (body.length > MAX_BODY_LEN) errors.push({ field: "body", message: `body exceeds ${MAX_BODY_LEN} characters.` });

  const scope = (input.scope ?? []).slice(0, MAX_SCOPE_ITEMS);

  const unsafe = scanForUnsafeContent([body, ...scope]);
  if (unsafe) errors.push({ field: "$", message: `Rejected: ${unsafe} found in response.` });

  if (errors.length > 0) return { ok: false, errors, normalized: null };

  return {
    ok: true,
    errors: [],
    normalized: {
      schemaVersion: RESPONSE_SCHEMA_VERSION,
      workspaceId: input.workspaceId,
      runId: input.runId,
      dispatchId: input.dispatchId,
      type: input.type,
      senderRole: input.senderRole,
      sender: input.sender,
      recipient: input.recipient,
      body,
      scope,
      resolutionState: resolvesDispatch(input.type) ? "resolved" : "open",
    },
  };
}
